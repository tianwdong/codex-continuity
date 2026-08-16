import { fileURLToPath } from "node:url";
import path from "node:path";

import { startAppServer } from "./app-server-client.mjs";
import {
  acquireThreadLock,
  childEnvironment,
  pluginDataDirectory,
  releaseThreadLock,
  resolveCodexExecutable,
  threadStateCoordinate,
} from "./plugin-runtime.mjs";
import { loadProgressLedger } from "./progress-ledger.mjs";
import { undoTitleChange } from "./title-maintainer.mjs";
import { loadTitleLedger, saveTitleLedger } from "./title-ledger.mjs";

export async function runTitleCommand(commandName, threadId, {
  appServer,
  titleLedger,
  progressLedger = null,
} = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) return { ok: false, error: "thread_id_unavailable" };
  const detail = await appServer.readThread(normalizedThreadId);
  titleLedger.observe(detail?.thread);

  if (commandName === "status") {
    const status = titleLedger.status(normalizedThreadId);
    const latestProgress = progressLedger?.current(normalizedThreadId) ?? null;
    return {
      ok: true,
      threadId: normalizedThreadId,
      title: String(detail?.thread?.name || ""),
      progress: latestProgress ? {
        chapter: latestProgress.chapter,
        summary: latestProgress.progress,
        confidence: latestProgress.confidence,
        updatedAt: latestProgress.updatedAt,
      } : null,
      ...status,
    };
  }
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
  if (commandName !== "undo") return { ok: false, error: "unknown_command" };
  const result = await undoTitleChange(normalizedThreadId, { appServer, titleLedger });
  return result ? { ok: true, ...result } : { ok: false, error: "undo_unavailable" };
}

async function main() {
  const commandName = process.argv[2] || "status";
  const threadId = process.argv[3] || process.env.CODEX_THREAD_ID;
  if (!threadId) return { ok: false, error: "thread_id_unavailable" };
  const coordinate = threadStateCoordinate(pluginDataDirectory(), threadId);
  const lock = await acquireThreadLock(coordinate.lockPath);
  if (!lock) return { ok: false, error: "already_running", threadId };
  let appServer;
  try {
    const [titleLedger, progressLedger] = await Promise.all([
      loadTitleLedger(coordinate.statePath),
      loadProgressLedger(coordinate.progressPath),
    ]);
    const command = await resolveCodexExecutable();
    appServer = await startAppServer({ command, env: childEnvironment() });
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
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error) })}\n`);
      process.exitCode = 1;
    });
}
