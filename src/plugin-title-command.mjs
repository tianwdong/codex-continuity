import { fileURLToPath } from "node:url";
import path from "node:path";

import { AppServerClient } from "./app-server-client.mjs";
import {
  acquireThreadLock,
  childEnvironment,
  pluginDataDirectory,
  releaseThreadLock,
  resolveCodexExecutable,
  threadStateCoordinate,
} from "./plugin-runtime.mjs";
import { loadProgressLedger } from "./progress-ledger.mjs";
import { buildDoctorResult, readContinuitySnapshot } from "./plugin-diagnostics.mjs";
import { undoTitleChange } from "./title-maintainer.mjs";
import { loadTitleLedger, saveTitleLedger } from "./title-ledger.mjs";

export async function runTitleCommand(commandName, threadId, {
  appServer,
  titleLedger,
  progressLedger = null,
  nativeTitleUnavailableReason = "app_server_unavailable",
} = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) return { ok: false, error: "thread_id_unavailable" };
  if (commandName === "status") {
    let nativeTitle = null;
    try {
      const detail = await appServer?.readThread(normalizedThreadId, { includeTurns: false });
      if (detail?.thread?.name) nativeTitle = String(detail.thread.name);
    } catch (_) {}
    const status = titleLedger?.status(normalizedThreadId) ?? { locked: null, undoAvailable: null };
    const latestProgress = progressLedger?.current(normalizedThreadId) ?? null;
    const cachedTitle = titleLedger?.toJSON()?.threads?.[normalizedThreadId]?.observedTitle
      || latestProgress?.nativeTitle || "";
    return {
      ok: true,
      threadId: normalizedThreadId,
      title: nativeTitle ?? cachedTitle,
      nativeTitle: {
        state: nativeTitle === null ? "unavailable" : "available",
        source: nativeTitle === null ? cachedTitle ? "local_snapshot" : "none" : "app_server",
        reason: nativeTitle === null ? nativeTitleUnavailableReason : null,
      },
      progress: latestProgress ? {
        chapter: latestProgress.chapter,
        summary: latestProgress.progress,
        confidence: latestProgress.confidence,
        updatedAt: latestProgress.updatedAt,
        sourceTurnId: latestProgress.sourceTurnId,
        sourceMessageId: latestProgress.sourceMessageId,
      } : null,
      ...status,
    };
  }
  if (!["undo", "lock", "resume"].includes(commandName)) return { ok: false, error: "unknown_command" };
  const detail = await appServer.readThread(normalizedThreadId);
  titleLedger.observe(detail?.thread);
  if (["lock", "resume"].includes(commandName)) {
    titleLedger.setLocked(detail?.thread, commandName === "lock");
    return {
      ok: true,
      type: commandName === "lock" ? "title_locked" : "title_auto_resumed",
      threadId: normalizedThreadId,
      title: String(detail?.thread?.name || ""),
      ...titleLedger.status(normalizedThreadId),
    };
  }
  const result = await undoTitleChange(normalizedThreadId, { appServer, titleLedger });
  return result ? { ok: true, ...result } : { ok: false, error: "undo_unavailable" };
}

export async function runTitleOperation(commandName, threadId, {
  dataDirectory = pluginDataDirectory(),
  pluginRoot,
  resolveExecutable = resolveCodexExecutable,
  createAppServer = (options) => new AppServerClient(options),
  nativeTitleTimeoutMs = 2_000,
} = {}) {
  if (!threadId) return { ok: false, error: "thread_id_unavailable" };
  if (!["status", "doctor", "undo", "lock", "resume"].includes(commandName)) {
    return { ok: false, error: "unknown_command" };
  }
  const coordinate = threadStateCoordinate(dataDirectory, threadId);
  if (["status", "doctor"].includes(commandName)) {
    const snapshot = await readContinuitySnapshot(threadId, { coordinate, pluginRoot });
    if (commandName === "doctor") return buildDoctorResult(threadId, snapshot);
    let appServer;
    let timeout;
    let result;
    const nativeTitleUnavailableReason = {
      idle: "app_server_unavailable",
      held: "background_busy",
      stale: "background_lock_stale",
      unavailable: "background_lock_unavailable",
    }[snapshot.backgroundLock.state];
    const localStatus = () => runTitleCommand("status", threadId, {
      titleLedger: snapshot.titleLedger,
      progressLedger: snapshot.progressLedger,
      nativeTitleUnavailableReason,
    });
    try {
      if (snapshot.backgroundLock.state !== "idle") {
        result = await localStatus();
      } else {
        const command = await resolveExecutable();
        appServer = createAppServer({ command, env: childEnvironment() });
        result = await Promise.race([
          (async () => {
            await appServer.open();
            return runTitleCommand("status", threadId, {
              appServer,
              titleLedger: snapshot.titleLedger,
              progressLedger: snapshot.progressLedger,
            });
          })(),
          new Promise((resolve) => {
            timeout = setTimeout(() => resolve(localStatus()), nativeTitleTimeoutMs);
          }),
        ]);
      }
    } catch (_) {
      result = await localStatus();
    } finally {
      clearTimeout(timeout);
      try { appServer?.close(); } catch (_) {}
    }
    return {
      ...result,
      packageIntegrity: snapshot.packageIntegrity,
      coverage: snapshot.coverage,
      refresh: snapshot.refresh,
      progressFreshness: snapshot.progressFreshness,
      backgroundLock: snapshot.backgroundLock,
      ledgers: snapshot.ledgers,
    };
  }
  const lock = await acquireThreadLock(coordinate.lockPath);
  if (!lock) return { ok: false, error: "already_running", threadId };
  let appServer;
  try {
    const [titleLedger, progressLedger] = await Promise.all([
      loadTitleLedger(coordinate.statePath),
      loadProgressLedger(coordinate.progressPath),
    ]);
    const command = await resolveExecutable();
    appServer = createAppServer({ command, env: childEnvironment() });
    await appServer.open();
    const result = await runTitleCommand(commandName, threadId, {
      appServer,
      titleLedger,
      progressLedger,
    });
    if (titleLedger.dirty) await saveTitleLedger(coordinate.statePath, titleLedger);
    return result;
  } finally {
    try {
      appServer?.close();
    } finally {
      await releaseThreadLock(coordinate.lockPath, lock);
    }
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runTitleOperation(process.argv[2] || "status", process.argv[3] || process.env.CODEX_THREAD_ID)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: "title_command_unavailable" })}\n`);
      process.exitCode = 1;
    });
}
