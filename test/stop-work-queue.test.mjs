import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  acquireThreadLock,
  releaseThreadLock,
  threadStateCoordinate,
} from "../src/plugin-runtime.mjs";
import {
  drainStopQueue,
  enqueueStopRequest,
  readPendingStop,
} from "../src/stop-work-queue.mjs";

const FIRST_TIME = "2026-09-08T01:00:00.000Z";
const SECOND_TIME = "2026-09-08T01:00:01.000Z";
const THIRD_TIME = "2026-09-08T01:00:02.000Z";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function temporaryQueue(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-stop-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, coordinate: threadStateCoordinate(directory, "queue-test-thread") };
}

function event(turnId) {
  return { threadId: "queue-test-thread", turnId };
}

function drain(coordinate, options) {
  return drainStopQueue(coordinate, { waitMs: 1, maxWaitMs: 2_000, ...options });
}

function afterBlocked(request) {
  return new Date(Date.parse(request.retryBlockedAt) + 1).toISOString();
}

test("concurrent Stop workers finish A and coalesce waiting B/C into C", { timeout: 5_000 }, async (t) => {
  const { coordinate } = await temporaryQueue(t);
  const startedA = deferred();
  const finishA = deferred();
  const processed = [];
  let active = 0;
  let maximumActive = 0;
  const processStop = async ({ turnId }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    processed.push(turnId);
    try {
      if (turnId === "A") {
        startedA.resolve();
        await finishA.promise;
      }
      return { status: "completed", turnId };
    } finally {
      active -= 1;
    }
  };
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const workers = [drain(coordinate, { processStop })];
  try {
    await startedA.promise;
    await enqueueStopRequest(coordinate, event("B"), SECOND_TIME);
    workers.push(drain(coordinate, { processStop }));
    await enqueueStopRequest(coordinate, event("C"), THIRD_TIME);
    workers.push(drain(coordinate, { processStop }));
    finishA.resolve();
    await Promise.all(workers);
    assert.deepEqual(processed, ["A", "C"]);
    assert.equal(maximumActive, 1);
    const pending = await readPendingStop(coordinate.pendingStopPath);
    assert.equal(pending.turnId, "C");
    assert.ok(pending.handledAt);
  } finally {
    finishA.resolve();
    await Promise.allSettled(workers);
  }
});

test("completing A cannot mark a newly pending B as handled", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const processed = [];
  await drain(coordinate, { processStop: async (request) => {
    processed.push(request.turnId);
    if (request.turnId === "A") {
      await enqueueStopRequest(coordinate, event("B"), SECOND_TIME);
    } else {
      const pending = await readPendingStop(coordinate.pendingStopPath);
      assert.equal(pending.turnId, "B");
      assert.equal(pending.receivedAt, SECOND_TIME);
      assert.equal(pending.handledAt, undefined);
    }
    return { status: "completed" };
  } });
  assert.deepEqual(processed, ["A", "B"]);
  assert.ok((await readPendingStop(coordinate.pendingStopPath)).handledAt);
});

test("the draining worker consumes an arrival between its last queue read and lock release", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const processed = [];
  let releases = 0;
  await drain(coordinate, {
    processStop: async ({ turnId }) => {
      processed.push(turnId);
      return { status: "completed" };
    },
    releaseLock: async (lockPath, lock) => {
      releases += 1;
      try {
        if (releases === 1) await enqueueStopRequest(coordinate, event("B"), SECOND_TIME);
      } finally {
        await releaseThreadLock(lockPath, lock);
      }
    },
  });
  assert.deepEqual(processed, ["A", "B"]);
  assert.equal(releases, 2);
  const pending = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(pending.turnId, "B");
  assert.ok(pending.handledAt);
});

test("repeating an already handled turn does not run it again", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  const processed = [];
  const processStop = async ({ turnId }) => {
    processed.push(turnId);
    return { status: "completed" };
  };
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  await drain(coordinate, { processStop });
  const handled = await readPendingStop(coordinate.pendingStopPath);
  await enqueueStopRequest(coordinate, event("A"), THIRD_TIME);
  await Promise.all([drain(coordinate, { processStop }), drain(coordinate, { processStop })]);
  assert.deepEqual(processed, ["A"]);
  assert.deepEqual(await readPendingStop(coordinate.pendingStopPath), handled);
});

test("an earlier receivedAt cannot replace the newer queued turn", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("C"), THIRD_TIME);
  await enqueueStopRequest(coordinate, event("B"), SECOND_TIME);
  const pending = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(pending.turnId, "C");
  assert.equal(pending.receivedAt, THIRD_TIME);
  const processed = [];
  await drain(coordinate, { processStop: async ({ turnId }) => {
    processed.push(turnId);
    return { status: "completed" };
  } });
  assert.deepEqual(processed, ["C"]);
});

test("a Stop worker waits for a non-Stop owner and drains after that owner releases", { timeout: 5_000 }, async (t) => {
  const { coordinate } = await temporaryQueue(t);
  const commandLock = await acquireThreadLock(coordinate.lockPath);
  assert.ok(commandLock);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const processed = [];
  let finished = false;
  const worker = drain(coordinate, { processStop: async ({ turnId }) => {
    processed.push(turnId);
    return { status: "completed" };
  } }).finally(() => { finished = true; });
  try {
    await delay(20);
    assert.equal(finished, false);
    assert.deepEqual(processed, []);
    assert.equal((await readPendingStop(coordinate.pendingStopPath)).handledAt, undefined);
  } finally {
    await releaseThreadLock(coordinate.lockPath, commandLock);
    await worker;
  }
  assert.deepEqual(processed, ["A"]);
  assert.ok((await readPendingStop(coordinate.pendingStopPath)).handledAt);
});

test("queued result failure permits the original final owner to take over while other workers defer", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const retry = { status: "error", reason: "queued_result_unavailable", retryPending: true };
  assert.deepEqual(await drain(coordinate, { sourceTurnId: "older-turn", processStop: async () => retry }), retry);
  const pending = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(pending.turnId, "A");
  assert.equal(pending.handledAt, undefined);
  assert.ok(pending.retryBlockedAt);
  assert.equal(pending.retryOwnerTurnId, "A");
  const deferredResult = await drain(coordinate, {
    sourceTurnId: "another-turn", processStop: () => assert.fail("only the original final owner may retry"),
  });
  assert.equal(deferredResult.reason, "retry_deferred");
  const nextOwner = await acquireThreadLock(coordinate.lockPath);
  assert.ok(nextOwner, "retry must release the writer lock");
  await releaseThreadLock(coordinate.lockPath, nextOwner);
  const processed = [];
  await drain(coordinate, { sourceTurnId: "A", processStop: async ({ turnId }) => {
    processed.push(turnId);
    return { status: "completed" };
  } });
  assert.deepEqual(processed, ["A"]);
  const handled = await readPendingStop(coordinate.pendingStopPath);
  assert.ok(handled.handledAt);
  assert.equal(handled.retryBlockedAt, undefined);
  assert.equal(handled.retryOwnerTurnId, undefined);
});

test("a processor exception releases the lock and preserves a blocked request until a new delivery", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  await assert.rejects(drain(coordinate, { processStop: async () => {
    throw new Error("processor_failed");
  } }), /processor_failed/);
  const blocked = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(blocked.handledAt, undefined);
  assert.ok(blocked.retryBlockedAt);
  const nextOwner = await acquireThreadLock(coordinate.lockPath);
  assert.ok(nextOwner, "exceptions must release the writer lock");
  await releaseThreadLock(coordinate.lockPath, nextOwner);
  const deferredResult = await drain(coordinate, {
    processStop: () => assert.fail("a waiting worker must not retry an exception"),
  });
  assert.equal(deferredResult.reason, "retry_deferred");
  await enqueueStopRequest(coordinate, event("A"), afterBlocked(blocked));
  const processed = [];
  await drain(coordinate, { processStop: async ({ turnId }) => {
    processed.push(turnId);
    return { status: "completed" };
  } });
  assert.deepEqual(processed, ["A"]);
});

test("eight waiting drainers attempt the same failed latest Stop only once", { timeout: 5_000 }, async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("C"), THIRD_TIME);
  const commandLock = await acquireThreadLock(coordinate.lockPath);
  let attempts = 0;
  const workers = Array.from({ length: 8 }, (_, index) => drain(coordinate, {
    sourceTurnId: `old-${index}`,
    processStop: async ({ turnId }) => {
      attempts += 1;
      assert.equal(turnId, "C");
      return { status: "ignored", reason: "semantic_nonzero_exit", retryPending: true };
    },
  }));
  await delay(20);
  await releaseThreadLock(coordinate.lockPath, commandLock);
  const results = await Promise.all(workers);
  assert.equal(attempts, 1);
  assert.equal(results.filter(({ reason }) => reason === "semantic_nonzero_exit").length, 1);
  assert.equal(results.filter(({ reason }) => reason === "retry_deferred").length, 7);
  assert.ok(results.every(({ retryPending }) => retryPending));
  const blocked = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(blocked.turnId, "C");
  assert.equal(blocked.receivedAt, THIRD_TIME);
  assert.ok(blocked.retryBlockedAt);
  assert.equal(blocked.handledAt, undefined);
  assert.equal(blocked.retryOwnerTurnId, undefined);
});

test("only a new receipt after the failure unblocks a failed turn for one new attempt", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  let attempts = 0;
  const processStop = async () => {
    attempts += 1;
    return { status: "ignored", reason: "semantic_timeout", retryPending: true };
  };
  await drain(coordinate, { processStop });
  const blocked = await readPendingStop(coordinate.pendingStopPath);
  for (const receipt of [FIRST_TIME, blocked.retryBlockedAt]) {
    await enqueueStopRequest(coordinate, event("A"), receipt);
    assert.equal((await drain(coordinate, { processStop })).reason, "retry_deferred");
    assert.deepEqual(await readPendingStop(coordinate.pendingStopPath), blocked);
  }
  assert.equal(attempts, 1);
  const newerReceipt = afterBlocked(blocked);
  await enqueueStopRequest(coordinate, event("A"), newerReceipt);
  const retried = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(retried.receivedAt, newerReceipt);
  assert.equal(retried.retryBlockedAt, undefined);
  assert.equal(retried.retryOwnerTurnId, undefined);
  await Promise.all(Array.from({ length: 4 }, () => drain(coordinate, { processStop })));
  assert.equal(attempts, 2);
  const blockedAgain = await readPendingStop(coordinate.pendingStopPath);
  await enqueueStopRequest(coordinate, event("A"), newerReceipt);
  assert.deepEqual(await readPendingStop(coordinate.pendingStopPath), blockedAgain);
  assert.equal((await drain(coordinate, { processStop })).reason, "retry_deferred");
  assert.equal(attempts, 2);
});

test("the original owner loses its retry permission if its takeover also fails", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("C"), THIRD_TIME);
  await drain(coordinate, {
    sourceTurnId: "A",
    processStop: async () => ({ status: "ignored", reason: "queued_result_unavailable", retryPending: true }),
  });
  let ownerAttempts = 0;
  const results = await Promise.all(Array.from({ length: 4 }, () => drain(coordinate, {
    sourceTurnId: "C",
    processStop: async () => {
      ownerAttempts += 1;
      return { status: "ignored", reason: "queued_result_unavailable", retryPending: true };
    },
  })));
  assert.equal(ownerAttempts, 1);
  assert.equal(results.filter(({ reason }) => reason === "retry_deferred").length, 3);
  const blocked = await readPendingStop(coordinate.pendingStopPath);
  assert.ok(blocked.retryBlockedAt);
  assert.equal(blocked.retryOwnerTurnId, undefined);
  assert.equal(blocked.handledAt, undefined);
});

test("an already waiting original owner finishes the latest turn after an older drainer cannot read its final", { timeout: 5_000 }, async (t) => {
  const { coordinate } = await temporaryQueue(t);
  const startedA = deferred();
  const finishA = deferred();
  const attempts = [];
  const processFor = (owner) => async ({ turnId }) => {
    attempts.push(`${owner}/${turnId}`);
    if (turnId === "A") {
      startedA.resolve();
      await finishA.promise;
    }
    return owner === turnId
      ? { status: "completed" }
      : { status: "ignored", reason: "queued_result_unavailable", retryPending: true };
  };
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const workers = [drain(coordinate, { sourceTurnId: "A", processStop: processFor("A") })];
  try {
    await startedA.promise;
    await enqueueStopRequest(coordinate, event("B"), SECOND_TIME);
    workers.push(drain(coordinate, { sourceTurnId: "B", processStop: processFor("B") }));
    await enqueueStopRequest(coordinate, event("C"), THIRD_TIME);
    workers.push(drain(coordinate, { sourceTurnId: "C", processStop: processFor("C") }));
    finishA.resolve();
    await Promise.all(workers);
    assert.deepEqual(attempts, ["A/A", "A/C", "C/C"]);
    const handled = await readPendingStop(coordinate.pendingStopPath);
    assert.equal(handled.turnId, "C");
    assert.ok(handled.handledAt);
    assert.equal(handled.retryBlockedAt, undefined);
    assert.equal(handled.retryOwnerTurnId, undefined);
  } finally {
    finishA.resolve();
    await Promise.allSettled(workers);
  }
});

test("a failure cannot block a newer turn and the lock owner continues draining it", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, event("A"), FIRST_TIME);
  const processed = [];
  await drain(coordinate, { sourceTurnId: "A", processStop: async ({ turnId }) => {
    processed.push(turnId);
    if (turnId === "A") {
      await enqueueStopRequest(coordinate, event("B"), SECOND_TIME);
      return { status: "ignored", reason: "semantic_nonzero_exit", retryPending: true };
    }
    const pending = await readPendingStop(coordinate.pendingStopPath);
    assert.equal(pending.retryBlockedAt, undefined);
    assert.equal(pending.retryOwnerTurnId, undefined);
    return { status: "completed" };
  } });
  assert.deepEqual(processed, ["A", "B"]);
  const handled = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(handled.turnId, "B");
  assert.equal(handled.receivedAt, SECOND_TIME);
  assert.ok(handled.handledAt);
  assert.equal(handled.retryBlockedAt, undefined);
});

test("retry metadata contains only coordinates and times and is removed after successful owner takeover", async (t) => {
  const { coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, {
    ...event("C"), prompt: "PRIVATE_PROMPT", last_assistant_message: "PRIVATE_RESPONSE",
  }, THIRD_TIME);
  await drain(coordinate, {
    sourceTurnId: "A",
    processStop: async () => ({
      status: "ignored", reason: "queued_result_unavailable", retryPending: true,
      stderr: "PRIVATE_ERROR", cwd: "/private/path", transcript: "PRIVATE_TRANSCRIPT",
    }),
  });
  const blocked = await readPendingStop(coordinate.pendingStopPath);
  assert.deepEqual(Object.keys(blocked).sort(), ["receivedAt", "retryBlockedAt", "retryOwnerTurnId", "schemaVersion", "threadId", "turnId"]);
  assert.ok(Number.isFinite(Date.parse(blocked.retryBlockedAt)));
  assert.equal(blocked.retryOwnerTurnId, "C");
  assert.doesNotMatch(await readFile(coordinate.pendingStopPath, "utf8"), /PRIVATE|private|stderr|transcript|reason/);
  await drain(coordinate, { sourceTurnId: "C", processStop: async () => ({ status: "completed" }) });
  assert.deepEqual(Object.keys(await readPendingStop(coordinate.pendingStopPath)).sort(), ["handledAt", "receivedAt", "schemaVersion", "threadId", "turnId"]);
});

test("the private queue persists only task and turn coordinates with timestamps", async (t) => {
  const { directory, coordinate } = await temporaryQueue(t);
  await enqueueStopRequest(coordinate, {
    ...event("A"),
    cwd: "/private/user-project",
    prompt: "PRIVATE_PROMPT_SENTINEL",
    last_assistant_message: "PRIVATE_RESPONSE_SENTINEL",
    title: "PRIVATE_TITLE_SENTINEL",
  }, FIRST_TIME);
  assert.deepEqual(await readPendingStop(coordinate.pendingStopPath), {
    schemaVersion: 1,
    threadId: "queue-test-thread",
    turnId: "A",
    receivedAt: FIRST_TIME,
  });
  await drain(coordinate, { processStop: async () => ({ status: "completed" }) });
  const persisted = await readPendingStop(coordinate.pendingStopPath);
  assert.deepEqual(Object.keys(persisted).sort(), ["handledAt", "receivedAt", "schemaVersion", "threadId", "turnId"]);
  assert.ok(Number.isFinite(Date.parse(persisted.handledAt)));
  assert.equal((await stat(coordinate.pendingStopPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(coordinate.pendingStopPath))).mode & 0o777, 0o700);
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile());
  assert.equal(files.length, 1, "completed queue must not leave extra snapshots or lock files");
  assert.doesNotMatch(await readFile(coordinate.pendingStopPath, "utf8"),
    /PRIVATE_|private\/user-project|last_assistant_message|prompt|title/);
});
