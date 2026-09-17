import { spawn as nodeSpawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBuildIntegrity } from "./build-integrity.mjs";
import { APP_SERVER_CLIENT_VERSION, startAppServer } from "./app-server-client.mjs";
import {
  childEnvironment,
  pluginDataDirectory,
  resolveCodexExecutable,
  semanticEnvironment,
  threadStateCoordinate,
} from "./plugin-runtime.mjs";
import { decideTitlesWithCodex } from "./plugin-title-decision.mjs";
import { loadProgressLedger, ProgressLedger, saveProgressLedger } from "./progress-ledger.mjs";
import { applyTitleDecision } from "./title-maintainer.mjs";
import { loadTitleLedger, saveTitleLedger } from "./title-ledger.mjs";
import { drainStopQueue, enqueueStopRequest } from "./stop-work-queue.mjs";

function nativeTitle(thread) {
  return String(thread?.name || "")
    .split("\n", 1)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function projectName(cwd) {
  const base = path.basename(String(cwd || "").replace(/[\\/]+$/, ""));
  return base.replaceAll("_", " ").replaceAll("-", " ").trim() || "Codex";
}

function currentTurnUserMessage(thread, turnId) {
  const turn = (Array.isArray(thread?.turns) ? thread.turns : [])
    .find((item) => String(item?.id || "").trim() === String(turnId || "").trim());
  const userItem = (Array.isArray(turn?.items) ? turn.items : [])
    .find((item) => item?.type === "userMessage");
  const content = Array.isArray(userItem?.content)
    ? userItem.content
      .filter((part) => typeof part === "string" || part?.type === "text")
      .map((part) => typeof part === "string" ? part : part.text)
      .join("\n")
    : userItem?.text;
  return String(content || "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/gi, "")
    .trim();
}

export function isSubagentThread(thread) {
  if (String(thread?.parentThreadId || "").trim()) return true;
  return [thread?.source, thread?.threadSource].some((source) => {
    if (!source) return false;
    if (typeof source === "string") {
      return /sub[_-]?agent|thread[_-]?spawn/i.test(source);
    }
    try {
      return /sub[_-]?agent|thread[_-]?spawn/i.test(JSON.stringify(source));
    } catch (_) {
      return false;
    }
  });
}

function hasKnownRootSource(thread) {
  const source = thread?.source;
  if (typeof source === "string") {
    return ["cli", "vscode", "exec", "appServer"].includes(source);
  }
  return Boolean(source && typeof source === "object" && typeof source.custom === "string");
}

function hasStopThreadMetadata(thread, threadId) {
  return Boolean(
    thread
    && typeof thread === "object"
    && String(thread.id || "").trim() === String(threadId || "").trim()
    && hasKnownRootSource(thread),
  );
}

export function parseStopHookInput(value) {
  let input = value;
  if (typeof value === "string") {
    try {
      input = JSON.parse(value);
    } catch (_) {
      return null;
    }
  }
  const threadId = String(input?.session_id || "").trim();
  const turnId = String(input?.turn_id || "").trim();
  if (input?.hook_event_name !== "Stop" || !threadId || !turnId) return null;
  return {
    threadId,
    turnId,
    stopHookActive: input?.stop_hook_active === true,
    assistantMessage: String(input?.last_assistant_message || "").trim(),
    cwd: String(input?.cwd || "").trim(),
  };
}

export function buildStopHookOutput() {
  return {};
}

export function hasStableWorkspace(event) {
  return Boolean(String(event?.cwd || "").trim());
}

export async function launchStopHookWorker(rawInput, {
  spawnImpl = nodeSpawn,
  nodeExecutable = process.execPath,
  scriptPath = fileURLToPath(import.meta.url),
  env = childEnvironment(),
  receivedAt = new Date().toISOString(),
} = {}) {
  const event = parseStopHookInput(rawInput);
  if (!event) return { status: "ignored", reason: "invalid_event" };
  if (event.stopHookActive) {
    return { status: "ignored", reason: "continued_stop", ...event };
  }
  if (!hasStableWorkspace(event)) {
    return { status: "ignored", reason: "workspace_unavailable", ...event };
  }

  return new Promise((resolve) => {
    let child;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (reason) => {
      try { child?.kill?.(); } catch (_) {}
      finish({ status: "error", reason, threadId: event.threadId, turnId: event.turnId });
    };

    try {
      child = spawnImpl(nodeExecutable, [scriptPath, "--worker", "--received-at", receivedAt], {
        detached: true,
        env,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
    } catch (_) {
      fail("worker_spawn_failed");
      return;
    }

    child.once("error", () => fail("worker_spawn_failed"));
    child.once("spawn", () => {
      if (!child.stdin) {
        fail("worker_stdin_unavailable");
        return;
      }
      child.stdin.once("error", () => fail("worker_input_failed"));
      child.stdin.end(rawInput, () => {
        try { child.unref(); } catch (_) {}
        finish({ status: "launched", threadId: event.threadId, turnId: event.turnId });
      });
    });
  });
}

export function buildHookCandidate(event, thread, fallbackTitle = "") {
  if (!event?.threadId || !event?.turnId || !event?.assistantMessage) return null;
  const observedTitle = nativeTitle(thread);
  const title = observedTitle || nativeTitle({ name: fallbackTitle }) || projectName(event.cwd);
  const turnIds = new Set(
    (Array.isArray(thread?.turns) ? thread.turns : [])
      .map((turn) => String(turn?.id || "").trim())
      .filter(Boolean),
  );
  turnIds.add(event.turnId);
  const metadataTurnCount = Number(thread?.turnCount);
  const turnCount = Number.isInteger(metadataTurnCount) && metadataTurnCount > 0
    ? Math.max(metadataTurnCount, turnIds.size)
    : turnIds.size;
  return {
    threadId: event.threadId,
    turnId: event.turnId,
    sourceMessageId: "",
    project: projectName(event.cwd || thread?.cwd),
    nativeTitle: title,
    userMessage: currentTurnUserMessage(thread, event.turnId),
    assistantMessage: event.assistantMessage,
    turnCount,
    titleMetadataAvailable: Boolean(observedTitle),
  };
}

function initialTitleFromProgress(item) {
  if (item?.progressDecision !== "update" || item?.progressConfidence !== "high") return "";
  const title = String(item?.progressChapter || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (title.length < 2 || title.includes("｜") || /[\n\r]/.test(title)) return "";
  return title;
}

async function initializeMissingNativeTitle(item, { appServer, titleLedger }) {
  const title = initialTitleFromProgress(item);
  if (!title || !appServer?.readThread || !appServer?.setThreadName) return null;

  const fresh = await appServer.readThread(item.threadId, { includeTurns: false });
  if (!fresh?.thread || nativeTitle(fresh.thread)) return null;

  await appServer.setThreadName(item.threadId, title);
  const verified = await appServer.readThread(item.threadId, { includeTurns: false });
  if (nativeTitle(verified?.thread) !== title) return null;

  titleLedger.observe(verified.thread);
  titleLedger.recordEvaluated(verified.thread, item.turnId);
  return {
    type: "initial_title_set",
    decision: "initialize",
    threadId: item.threadId,
    turnId: item.turnId,
    previousTitle: "",
    title,
  };
}

export async function maintainContinuityForStop(input, {
  appServer,
  titleLedger,
  progressLedger = new ProgressLedger(),
  nativeTitleTurnId = "",
  command,
  decideTitles = decideTitlesWithCodex,
  codexAvailable = true,
  threadSnapshot = null,
  onStage = async () => {},
} = {}) {
  const event = parseStopHookInput(input);
  if (!event) return { status: "ignored", reason: "invalid_event" };
  if (event.stopHookActive) return { status: "ignored", reason: "continued_stop", ...event };
  if (!hasStableWorkspace(event)) {
    return { status: "ignored", reason: "workspace_unavailable", ...event };
  }
  if (!event.assistantMessage) {
    return { status: "ignored", reason: "assistant_message_unavailable", ...event };
  }

  if (!appServer?.readThread) {
    return { status: "ignored", reason: "thread_metadata_unavailable", ...event };
  }
  await onStage("thread_read");
  let thread = threadSnapshot;
  if (!thread) {
    try {
      thread = (await appServer.readThread(event.threadId, { includeTurns: true }))?.thread ?? null;
    } catch (_) {}
  }
  if (thread && isSubagentThread(thread)) {
    return { status: "ignored", reason: "subagent_thread", ...event };
  }
  if (!hasStopThreadMetadata(thread, event.threadId)) {
    return { status: "ignored", reason: "thread_metadata_unavailable", ...event };
  }
  const nativeTitleChange = String(nativeTitleTurnId || "") === event.turnId
    ? titleLedger.recordNativeTitleChange(thread, event.turnId)
    : null;
  let change = nativeTitleChange ? {
    type: "title_changed",
    ...nativeTitleChange,
    decision: `native_${nativeTitleChange.decision}`,
  } : null;
  const correctableNativeChapter = nativeTitleChange?.decision === "update_chapter";
  const previousProgress = progressLedger.current(event.threadId);
  const candidate = buildHookCandidate(event, thread, previousProgress?.nativeTitle);
  const hasPriorTurn = candidate.turnCount >= 2
    || Boolean(previousProgress?.sourceTurnId && previousProgress.sourceTurnId !== event.turnId);
  const titleEligible = candidate.titleMetadataAvailable
    && hasPriorTurn
    && (correctableNativeChapter || titleLedger.shouldEvaluate(thread, event.turnId));
  const progressEligible = progressLedger.shouldEvaluate(event.threadId, event.turnId);
  if (!titleEligible && !progressEligible) {
    return change
      ? { status: "renamed", change, progress: null, ...event }
      : { status: "ignored", reason: "already_evaluated", ...event };
  }
  if (!codexAvailable) {
    return change
      ? { status: "renamed", reason: "account_unavailable", change, progress: null, ...event }
      : { status: "ignored", reason: "account_unavailable", ...event };
  }

  const semanticCandidate = {
    ...candidate,
    previousChapter: previousProgress?.chapter || "",
    previousProgress: previousProgress?.progress || "",
  };
  await onStage("semantic");
  const [decided = semanticCandidate] = await decideTitles([semanticCandidate], {
    command,
    cwd: os.tmpdir(),
    env: semanticEnvironment(),
    codexAvailable,
    timeoutMs: 150_000,
  });
  if (!decided.titleDecision && !decided.progressDecision) {
    const reason = decided.semanticFailure || "semantic_decision_unavailable";
    return change
      ? { status: "renamed", reason, change, progress: null, ...event }
      : { status: "ignored", reason, ...event };
  }

  if (!candidate.titleMetadataAvailable && !change) {
    try {
      change = await initializeMissingNativeTitle(decided, { appServer, titleLedger });
      if (change) candidate.nativeTitle = change.title;
    } catch (_) {}
  }

  let progressChanged = false;
  if (progressEligible && decided.progressDecision === "update") {
    progressChanged = progressLedger.recordProgress({
      threadId: event.threadId,
      turnId: event.turnId,
      sourceMessageId: candidate.sourceMessageId,
      nativeTitle: candidate.nativeTitle,
      chapter: decided.progressChapter,
      progress: decided.progressSummary,
      confidence: decided.progressConfidence,
    });
  } else if (progressEligible && decided.progressDecision === "keep") {
    progressLedger.recordEvaluated({
      threadId: event.threadId,
      turnId: event.turnId,
      nativeTitle: candidate.nativeTitle,
    });
  }

  const shouldApplyTitleDecision = !correctableNativeChapter
    || decided.titleDecision === "replace_workstream";
  if (titleEligible && decided.titleDecision && shouldApplyTitleDecision && appServer) {
    try {
      const titleAppServer = {
        readThread: (threadId) => appServer.readThread(threadId, { includeTurns: false }),
        setThreadName: (...args) => appServer.setThreadName(...args),
      };
      const applied = await applyTitleDecision(decided, {
        appServer: titleAppServer,
        titleLedger,
        allowCurrentTurnCorrection: correctableNativeChapter,
      });
      if (applied.change) change = applied.change;
    } catch (_) {
      titleLedger.recordEvaluated(thread, event.turnId);
    }
  }
  return {
    status: change ? "renamed" : progressChanged ? "progress_updated" : "kept",
    change,
    progress: progressChanged ? progressLedger.current(event.threadId) : null,
    ...event,
  };
}

const packageIntegrityAtStart = verifyBuildIntegrity(fileURLToPath(new URL("../", import.meta.url)));

async function writeDiagnostic(dataDirectory, result) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const line = [
    new Date().toISOString(),
    String(result?.status || "error"),
    String(result?.reason || result?.change?.type || ""),
    String(result?.threadId || ""),
    String(result?.turnId || ""),
  ].join(" ").trim();
  await appendFile(path.join(dataDirectory, "continuity.log"), `${line}\n`, { mode: 0o600 });
  if (result?.threadId && result?.turnId) {
    const filePath = threadStateCoordinate(dataDirectory, result.threadId).diagnosticPath;
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({
      schemaVersion: 1,
      workerVersion: APP_SERVER_CLIENT_VERSION,
      packageDigest: (await packageIntegrityAtStart).state === "verified" ? (await packageIntegrityAtStart).digest : null,
      threadId: result.threadId,
      turnId: result.turnId,
      status: result.status,
      reason: result.reason || "",
      stage: result.stage || "completed",
      updatedAt: new Date().toISOString(),
      durationMs: result.durationMs ?? 0,
    })}\n`, { mode: 0o600 });
    await rename(temporaryPath, filePath);
  }
}

async function readHookInput() {
  process.stdin.setEncoding("utf8");
  let rawInput = "";
  for await (const chunk of process.stdin) rawInput += chunk;
  return rawInput;
}

async function nativeTitleTurnId(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Number(value?.schemaVersion) === 1 ? String(value?.turnId || "") : "";
  } catch (_) {
    return "";
  }
}

export function queuedStopInput(request, thread) {
  if (!hasStopThreadMetadata(thread, request.threadId) || isSubagentThread(thread)) return null;
  const turn = thread.turns?.find((item) => item.id === request.turnId);
  if (turn?.status !== "completed") return null;
  const final = turn.items?.findLast((item) => item.type === "agentMessage" && item.phase === "final_answer");
  if (!String(final?.text || "").trim() || !String(thread.cwd || "").trim()) return null;
  return {
    hook_event_name: "Stop",
    session_id: request.threadId,
    turn_id: request.turnId,
    cwd: thread.cwd,
    last_assistant_message: final.text,
  };
}

export async function runStopHookWorker(rawInput, {
  dataDirectory = pluginDataDirectory(),
  receivedAt = new Date().toISOString(),
  resolveCommand = resolveCodexExecutable,
  startServer = startAppServer,
  decideTitles = decideTitlesWithCodex,
} = {}) {
  const event = parseStopHookInput(rawInput);
  if (!event) return { status: "ignored", reason: "invalid_event" };
  if (event.stopHookActive) return { status: "ignored", reason: "continued_stop", ...event };
  if (!hasStableWorkspace(event)) {
    return { status: "ignored", reason: "workspace_unavailable", ...event };
  }
  const coordinate = threadStateCoordinate(dataDirectory, event.threadId);
  try {
    await enqueueStopRequest(coordinate, event, receivedAt);
    return await drainStopQueue(coordinate, { sourceTurnId: event.turnId, processStop: async (request) => {
      const startedAt = Date.now();
      let stage = "runtime";
      let appServer;
      const report = (result) => writeDiagnostic(dataDirectory, {
        ...result, threadId: request.threadId, turnId: request.turnId,
        stage, durationMs: Date.now() - startedAt,
      });
      const onStage = async (nextStage) => {
        stage = nextStage;
        await report({ status: "running" });
      };
      try {
        await onStage("runtime");
        const command = await resolveCommand();
        const [titleLedger, progressLedger] = await Promise.all([
          loadTitleLedger(coordinate.statePath), loadProgressLedger(coordinate.progressPath),
        ]);
        appServer = await startServer({ command, env: childEnvironment() });
        let input = rawInput;
        let threadSnapshot = null;
        if (request.turnId !== event.turnId) {
          await onStage("thread_read");
          threadSnapshot = (await appServer.readThread(request.threadId, { includeTurns: true }))?.thread;
          input = queuedStopInput(request, threadSnapshot);
          if (!input) {
            const result = { status: "error", reason: "queued_result_unavailable", retryPending: true };
            await report(result);
            return result;
          }
        }
        const result = await maintainContinuityForStop(input, {
          appServer, titleLedger, progressLedger, threadSnapshot,
          nativeTitleTurnId: await nativeTitleTurnId(coordinate.nativeTitleTurnPath),
          command, decideTitles, onStage,
        });
        if (result.reason && !["already_evaluated", "subagent_thread", "invalid_event", "continued_stop", "workspace_unavailable"].includes(result.reason)) {
          result.retryPending = true;
        }
        const resultStage = stage;
        await onStage("persist");
        await Promise.all([
          titleLedger.dirty ? saveTitleLedger(coordinate.statePath, titleLedger) : null,
          progressLedger.dirty ? saveProgressLedger(coordinate.progressPath, progressLedger) : null,
        ]);
        stage = result.reason && result.reason !== "already_evaluated" ? resultStage : "completed";
        await report(result);
        return result;
      } catch (_) {
        const result = { status: "error", reason: `stop_${stage}_failed`, retryPending: true };
        await report(result);
        return result;
      } finally {
        appServer?.close();
      }
    } });
  } catch (error) {
    const reason = ["stop_queue_unavailable", "stop_queue_timeout"].includes(error?.message)
      ? error.message : "stop_worker_failed";
    const result = { status: "error", reason, threadId: event.threadId, turnId: event.turnId, stage: "queued" };
    await writeDiagnostic(dataDirectory, result);
    return result;
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  readHookInput()
    .then(async (rawInput) => {
      if (process.argv.includes("--launch")) {
        const result = await launchStopHookWorker(rawInput);
        if (result.status === "error") {
          await writeDiagnostic(pluginDataDirectory(), result);
        }
        return result;
      }
      const receivedAt = process.argv[process.argv.indexOf("--received-at") + 1];
      return runStopHookWorker(rawInput, {
        receivedAt: Number.isFinite(Date.parse(receivedAt)) ? receivedAt : new Date().toISOString(),
      });
    })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(buildStopHookOutput(result))}\n`);
    })
    .catch(async () => {
      try {
        await writeDiagnostic(pluginDataDirectory(), {
          status: "error",
          reason: "stop_worker_failed",
        });
      } catch (_) {}
      process.stdout.write("{}\n");
    });
}
