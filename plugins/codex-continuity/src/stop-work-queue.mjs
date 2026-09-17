import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { acquireThreadLock, releaseThreadLock } from "./plugin-runtime.mjs";

export async function readPendingStop(filePath) {
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("stop_queue_unavailable");
  }
  if (value?.schemaVersion !== 1 || !value.threadId || !value.turnId
    || !Number.isFinite(Date.parse(value.receivedAt))
    || (value.retryBlockedAt !== undefined && !Number.isFinite(Date.parse(value.retryBlockedAt)))
    || (value.retryOwnerTurnId !== undefined
      && (!value.retryBlockedAt || value.retryOwnerTurnId !== value.turnId))) {
    throw new Error("stop_queue_unavailable");
  }
  return value;
}

async function writePendingStop(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function updatePendingStop(coordinate, update) {
  // This lock protects only a small metadata read/write, never a model request.
  const deadline = Date.now() + 5_000;
  let lock;
  while (!(lock = await acquireThreadLock(coordinate.stopQueueLockPath))) {
    if (Date.now() >= deadline) throw new Error("stop_queue_unavailable");
    await delay(20);
  }
  try {
    const previous = await readPendingStop(coordinate.pendingStopPath);
    const next = update(previous);
    if (next !== previous) await writePendingStop(coordinate.pendingStopPath, next);
    return next;
  } finally {
    await releaseThreadLock(coordinate.stopQueueLockPath, lock);
  }
}

export async function enqueueStopRequest(coordinate, event, receivedAt = new Date().toISOString()) {
  return updatePendingStop(coordinate, (previous) => {
    if (previous?.threadId === event.threadId) {
      if (previous.turnId === event.turnId) {
        if (!previous.handledAt && previous.retryBlockedAt
          && Date.parse(receivedAt) > Date.parse(previous.retryBlockedAt)) {
          // A new delivery may retry; a worker delayed before the failure may not.
          return { schemaVersion: 1, threadId: event.threadId, turnId: event.turnId, receivedAt };
        }
        return previous;
      }
      if (Date.parse(previous.receivedAt) > Date.parse(receivedAt)) return previous;
    }
    // Keep only coordinates. The assistant response stays in memory or in Codex.
    return { schemaVersion: 1, threadId: event.threadId, turnId: event.turnId, receivedAt };
  });
}

function sameRequest(left, right) {
  return left?.threadId === right?.threadId && left?.turnId === right?.turnId
    && left?.receivedAt === right?.receivedAt;
}

async function markHandled(coordinate, request) {
  return updatePendingStop(coordinate, (current) => {
    if (!sameRequest(current, request)) return current;
    const { retryBlockedAt, retryOwnerTurnId, ...handled } = current;
    return { ...handled, handledAt: new Date().toISOString() };
  });
}

async function blockRetry(coordinate, request, allowOriginalOwner = false) {
  return updatePendingStop(coordinate, (current) => {
    if (!sameRequest(current, request)) return current;
    const { retryOwnerTurnId, ...blocked } = current;
    return {
      ...blocked,
      retryBlockedAt: new Date(Math.max(Date.now(), Date.parse(current.receivedAt))).toISOString(),
      ...(allowOriginalOwner ? { retryOwnerTurnId: request.turnId } : {}),
    };
  });
}

export async function drainStopQueue(coordinate, {
  processStop,
  waitMs = 250,
  maxWaitMs = 330_000,
  releaseLock = releaseThreadLock,
  sourceTurnId = "",
} = {}) {
  const deadline = Date.now() + maxWaitMs;
  let result = { status: "ignored", reason: "already_evaluated" };
  while (true) {
    const pending = await readPendingStop(coordinate.pendingStopPath);
    if (!pending || pending.handledAt) return result;
    const lock = await acquireThreadLock(coordinate.lockPath);
    if (!lock) {
      // A title command may own the lock too; do not rely on another Stop
      // worker being present to consume this request.
      if (Date.now() >= deadline) throw new Error("stop_queue_timeout");
      await delay(waitMs);
      continue;
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      lock.handle.utimes(now, now).catch(() => {});
    }, 30_000);
    heartbeat.unref();
    try {
      while (true) {
        const request = await readPendingStop(coordinate.pendingStopPath);
        if (!request || request.handledAt) break;
        if (request.retryBlockedAt && request.retryOwnerTurnId !== sourceTurnId) {
          return {
            status: "ignored", reason: "retry_deferred", retryPending: true,
            threadId: request.threadId, turnId: request.turnId,
          };
        }
        try {
          result = await processStop(request);
        } catch (error) {
          const pendingAfterFailure = await blockRetry(coordinate, request);
          if (!sameRequest(pendingAfterFailure, request)) continue;
          throw error;
        }
        if (result?.retryPending) {
          const pendingAfterFailure = await blockRetry(coordinate, request,
            result.reason === "queued_result_unavailable" && sourceTurnId !== request.turnId);
          if (!sameRequest(pendingAfterFailure, request)) continue;
          return result;
        }
        await markHandled(coordinate, request);
      }
    } finally {
      clearInterval(heartbeat);
      await releaseLock(coordinate.lockPath, lock);
    }
    // Read again AFTER unlocking: an arrival between the last read and unlock
    // must be processed here, or by a worker that can now acquire the lock.
  }
}
