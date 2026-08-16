import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { startAppServer } from "./app-server-client.mjs";
import { loadAttentionLedger, saveAttentionLedger } from "./attention-ledger.mjs";
import { buildAttentionItems, latestCompletedSnapshot } from "./continuity-data.mjs";
import { decideTitlesWithCodex } from "./semantic-organizer.mjs";
import { applyTitleDecision, undoTitleChange } from "./title-maintainer.mjs";
import { loadTitleLedger, saveTitleLedger } from "./title-ledger.mjs";

export { applyTitleDecision, undoTitleChange } from "./title-maintainer.mjs";

const ATTENTION_REFRESH_MS = 5_000;
const supportDirectory = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Codex Continuity",
);
const attentionStatePath = path.join(supportDirectory, "attention-state.json");
const titleStatePath = path.join(supportDirectory, "title-state.json");

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  throw error;
});

function isRootThread(thread) {
  return !Boolean(
    thread?.source?.subAgent?.thread_spawn
    || thread?.threadSource?.subAgent?.thread_spawn,
  );
}

function childEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_INSPECTOR_IPC;
  delete environment.CODEX_THREAD_ID;
  return environment;
}

function semanticEnvironment() {
  const keys = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
  ];
  return Object.fromEntries(
    keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
}

async function resolveAppServerExecutable() {
  const taskHome = os.homedir();
  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(taskHome, "Applications/Codex.app/Contents/Resources/codex"),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    path.join(taskHome, "Applications/ChatGPT.app/Contents/Resources/codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error("未找到可用的 Codex App Server runtime");
}

async function settleWithConcurrency(values, worker, concurrency = 8) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await worker(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

export function buildNotificationEvent(item) {
  const threadId = String(item?.threadId || "").trim();
  const turnId = String(item?.turnId || "").trim();
  if (!threadId || !turnId) return null;
  return {
    type: "attention",
    threadId,
    turnId,
    project: String(item?.project || "Codex").trim() || "Codex",
    nativeTitle: String(item?.nativeTitle || "Codex 任务").trim() || "Codex 任务",
    chapter: String(item?.chapter || "").trim(),
    excerpt: String(item?.chapterEvidence || item?.excerpt || "Codex 已返回新结果。")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220),
    deepLink: `codex://threads/${encodeURIComponent(threadId)}`,
    updatedAt: new Date().toISOString(),
  };
}

function emitEvent(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const appServerExecutable = await resolveAppServerExecutable();
  const attentionLedger = await loadAttentionLedger(attentionStatePath);
  const titleLedger = await loadTitleLedger(titleStatePath);
  const appServer = await startAppServer({
    command: appServerExecutable,
    env: childEnvironment(),
  });
  const detailsById = new Map();
  const chapterByTurn = new Map();
  let stopping = false;
  let announcedUndoCandidate = false;
  let attentionSaveError = "";
  let titleSaveError = "";

  const persistLedger = async () => {
    if (!attentionLedger.dirty) return;
    try {
      await saveAttentionLedger(attentionStatePath, attentionLedger);
      attentionSaveError = "";
    } catch (error) {
      const message = String(error?.message || error);
      if (message !== attentionSaveError) {
        attentionSaveError = message;
        console.error(`注意力账本暂时无法保存：${message}`);
      }
    }
  };

  const persistTitleLedger = async () => {
    if (!titleLedger.dirty) return;
    try {
      await saveTitleLedger(titleStatePath, titleLedger);
      titleSaveError = "";
    } catch (error) {
      const message = String(error?.message || error);
      if (message !== titleSaveError) {
        titleSaveError = message;
        console.error(`标题账本暂时无法保存：${message}`);
      }
    }
  };

  const scan = async () => {
    const threads = (await appServer.listThreads({
      limit: 50,
      sourceKinds: ["cli", "vscode"],
    })).filter(isRootThread);
    for (const thread of threads) titleLedger.observe(thread);
    await persistTitleLedger();
    if (!announcedUndoCandidate) {
      const existingChange = titleLedger.latestUndoCandidate();
      if (existingChange) emitEvent({ type: "title_changed", ...existingChange });
      announcedUndoCandidate = true;
    }
    const threadIds = attentionLedger.scan(threads, {
      loadedThreadIds: [...detailsById.keys()],
    });
    await persistLedger();

    for (const threadId of threadIds) detailsById.delete(threadId);
    const results = await settleWithConcurrency(threadIds, (threadId) => appServer.readThread(threadId));
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status !== "fulfilled") continue;
      const threadId = String(result.value?.thread?.id || threadIds[index] || "");
      if (!threadId) continue;
      detailsById.set(threadId, result.value);
      attentionLedger.record(threadById.get(threadId) ?? result.value.thread, result.value);
    }
    await persistLedger();

    const attentionItems = buildAttentionItems(threads, {
      attentionThreadIds: attentionLedger.pendingThreadIds(),
      detailsById,
    });
    const displayItems = attentionItems.slice(0, 3).map((item) => ({
      ...item,
      ...(chapterByTurn.get(`${item.threadId}:${item.turnId}`) ?? {}),
    }));
    emitEvent({
      type: "attention_snapshot",
      items: displayItems.map(buildNotificationEvent).filter(Boolean),
    });
    const newItems = attentionItems
      .filter((item) => attentionLedger.shouldNotify(item.threadId, item.turnId))
      .slice(0, 3)
      .map((item) => ({
        ...item,
        ...latestCompletedSnapshot(detailsById.get(item.threadId)?.thread),
      }));
    if (!newItems.length) return;

    const codexAvailable = await appServer.hasManagedAccount();
    const titleCandidates = newItems.filter((item) => titleLedger.shouldEvaluate(
      threadById.get(item.threadId),
      item.turnId,
    ));
    const decidedItems = await decideTitlesWithCodex(titleCandidates, {
      command: appServerExecutable,
      cwd: os.tmpdir(),
      env: semanticEnvironment(),
      codexAvailable,
      timeoutMs: 30_000,
    });
    const decisionById = new Map(decidedItems.map((item) => [item.threadId, item]));
    for (const originalItem of newItems) {
      const decidedItem = decisionById.get(originalItem.threadId) ?? originalItem;
      const { item, change } = titleCandidates.some((candidate) => candidate.threadId === originalItem.threadId)
        ? await applyTitleDecision(decidedItem, { appServer, titleLedger })
        : { item: originalItem, change: null };
      if (change) emitEvent(change);
      const event = buildNotificationEvent(item);
      if (!event) continue;
      chapterByTurn.set(`${item.threadId}:${item.turnId}`, {
        chapter: item.chapter || "",
        chapterEvidence: item.chapterEvidence || "",
        chapterConfidence: item.chapterConfidence || "",
      });
      emitEvent(event);
      attentionLedger.markNotified(item.threadId, item.turnId);
    }
    await persistLedger();
    await persistTitleLedger();
    emitEvent({
      type: "attention_snapshot",
      items: attentionItems.slice(0, 3).map((item) => buildNotificationEvent({
        ...item,
        ...(chapterByTurn.get(`${item.threadId}:${item.turnId}`) ?? {}),
      })).filter(Boolean),
    });
  };

  const commands = readline.createInterface({ input: process.stdin });
  let commandChain = Promise.resolve();
  commands.on("line", (line) => {
    commandChain = commandChain.then(async () => {
      let command;
      try {
        command = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (command?.type !== "undo_title" || !command.threadId) return;
      try {
        const event = await undoTitleChange(command.threadId, { appServer, titleLedger });
        await persistTitleLedger();
        emitEvent(event ?? { type: "title_undo_failed", threadId: String(command.threadId) });
      } catch (_) {
        emitEvent({ type: "title_undo_failed", threadId: String(command.threadId) });
      }
    });
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    commands.close();
    appServer.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  console.log("Codex Continuity 已作为原生标题维护层启动；不会启动第二个 Codex 窗口。");
  while (!stopping) {
    try {
      await scan();
    } catch (error) {
      console.error(`结果检查暂时失败：${String(error?.message || error)}`);
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, ATTENTION_REFRESH_MS));
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
