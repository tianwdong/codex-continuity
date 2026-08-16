import { appendFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startAppServer } from "./app-server-client.mjs";
import {
  acquireThreadLock,
  childEnvironment,
  pluginDataDirectory,
  releaseThreadLock,
  resolveCodexExecutable,
  semanticEnvironment,
  threadStateCoordinate,
} from "./plugin-runtime.mjs";
import { decideTitlesWithCodex } from "./plugin-title-decision.mjs";
import { loadProgressLedger, ProgressLedger, saveProgressLedger } from "./progress-ledger.mjs";
import { applyTitleDecision } from "./title-maintainer.mjs";
import { loadTitleLedger, saveTitleLedger } from "./title-ledger.mjs";

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
    userMessage: "",
    assistantMessage: event.assistantMessage,
    turnCount,
    titleMetadataAvailable: Boolean(observedTitle),
  };
}

export async function maintainContinuityForStop(input, {
  appServer,
  titleLedger,
  progressLedger = new ProgressLedger(),
  command,
  decideTitles = decideTitlesWithCodex,
  codexAvailable = true,
} = {}) {
  const event = parseStopHookInput(input);
  if (!event) return { status: "ignored", reason: "invalid_event" };
  if (event.stopHookActive) return { status: "ignored", reason: "continued_stop", ...event };
  if (!event.assistantMessage) {
    return { status: "ignored", reason: "assistant_message_unavailable", ...event };
  }

  if (!appServer?.readThread) {
    return { status: "ignored", reason: "thread_metadata_unavailable", ...event };
  }
  let thread = null;
  try {
    thread = (await appServer.readThread(event.threadId, { includeTurns: false }))?.thread ?? null;
  } catch (_) {}
  if (thread && isSubagentThread(thread)) {
    return { status: "ignored", reason: "subagent_thread", ...event };
  }
  if (!hasStopThreadMetadata(thread, event.threadId)) {
    return { status: "ignored", reason: "thread_metadata_unavailable", ...event };
  }
  const previousProgress = progressLedger.current(event.threadId);
  const candidate = buildHookCandidate(event, thread, previousProgress?.nativeTitle);
  const hasPriorTurn = candidate.turnCount >= 2
    || Boolean(previousProgress?.sourceTurnId && previousProgress.sourceTurnId !== event.turnId);
  const titleEligible = candidate.titleMetadataAvailable
    && hasPriorTurn
    && titleLedger.shouldEvaluate(thread, event.turnId);
  const progressEligible = progressLedger.shouldEvaluate(event.threadId, event.turnId);
  if (!titleEligible && !progressEligible) {
    return { status: "ignored", reason: "already_evaluated", ...event };
  }
  if (!codexAvailable) return { status: "ignored", reason: "account_unavailable", ...event };

  const semanticCandidate = {
    ...candidate,
    previousChapter: previousProgress?.chapter || "",
    previousProgress: previousProgress?.progress || "",
  };
  const [decided = semanticCandidate] = await decideTitles([semanticCandidate], {
    command,
    cwd: os.tmpdir(),
    env: semanticEnvironment(),
    codexAvailable,
    timeoutMs: 30_000,
  });
  if (!decided.titleDecision && !decided.progressDecision) {
    return { status: "ignored", reason: "semantic_decision_unavailable", ...event };
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

  let change = null;
  if (titleEligible && decided.titleDecision && appServer) {
    try {
      const titleAppServer = {
        readThread: (threadId) => appServer.readThread(threadId, { includeTurns: false }),
        setThreadName: (...args) => appServer.setThreadName(...args),
      };
      ({ change } = await applyTitleDecision(decided, {
        appServer: titleAppServer,
        titleLedger,
      }));
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
}

async function main() {
  process.stdin.setEncoding("utf8");
  let rawInput = "";
  for await (const chunk of process.stdin) rawInput += chunk;
  const event = parseStopHookInput(rawInput);
  if (!event) return { status: "ignored", reason: "invalid_event" };
  if (event.stopHookActive) return { status: "ignored", reason: "continued_stop", ...event };
  const dataDirectory = pluginDataDirectory();
  const coordinate = threadStateCoordinate(dataDirectory, event.threadId);
  const lock = await acquireThreadLock(coordinate.lockPath);
  if (!lock) return { status: "ignored", reason: "already_running", ...event };

  let appServer;
  try {
    const command = await resolveCodexExecutable();
    const [titleLedger, progressLedger] = await Promise.all([
      loadTitleLedger(coordinate.statePath),
      loadProgressLedger(coordinate.progressPath),
    ]);
    try {
      appServer = await startAppServer({ command, env: childEnvironment() });
    } catch (_) {}
    const result = await maintainContinuityForStop(rawInput, {
      appServer,
      titleLedger,
      progressLedger,
      command,
      codexAvailable: true,
    });
    await Promise.all([
      titleLedger.dirty ? saveTitleLedger(coordinate.statePath, titleLedger) : null,
      progressLedger.dirty ? saveProgressLedger(coordinate.progressPath, progressLedger) : null,
    ]);
    await writeDiagnostic(dataDirectory, result);
    return result;
  } finally {
    appServer?.close();
    await releaseThreadLock(coordinate.lockPath, lock);
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(buildStopHookOutput(result))}\n`);
    })
    .catch(async (error) => {
      try {
        await writeDiagnostic(pluginDataDirectory(), {
          status: "error",
          reason: String(error?.message || error).replace(/\s+/g, "_").slice(0, 120),
        });
      } catch (_) {}
      process.stdout.write("{}\n");
    });
}
