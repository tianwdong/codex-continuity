import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStopHookOutput,
  buildHookCandidate,
  hasStableWorkspace,
  isSubagentThread,
  launchStopHookWorker,
  maintainContinuityForStop,
  parseStopHookInput,
  queuedStopInput,
  runStopHookWorker,
} from "../src/plugin-stop-hook.mjs";
import { threadStateCoordinate } from "../src/plugin-runtime.mjs";
import { enqueueStopRequest, readPendingStop } from "../src/stop-work-queue.mjs";
import { runTitleCommand, runTitleOperation } from "../src/plugin-title-command.mjs";
import { ProgressLedger } from "../src/progress-ledger.mjs";
import { TitleLedger } from "../src/title-ledger.mjs";
import { APP_SERVER_CLIENT_VERSION } from "../src/app-server-client.mjs";

function completedTurn(id, userText, assistantText) {
  return {
    id,
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: userText }] },
      { id: `message-${id}`, type: "agentMessage", phase: "final_answer", text: assistantText },
    ],
  };
}

function threadFixture() {
  return {
    id: "thread-1",
    name: "接入 Google Analytics",
    cwd: "/tmp/modeldial",
    source: "cli",
    turns: [
      completedTurn("turn-1", "接入 GA。", "GA 已经接入。"),
      completedTurn("turn-2", "继续排查费用。", "Cloudflare 费用止损已经验证。"),
    ],
  };
}

function stopPayload({
  turnId = "turn-2",
  assistantMessage = "Cloudflare 费用止损已经验证。",
  stopHookActive = false,
  cwd = "/tmp/modeldial",
} = {}) {
  return {
    session_id: "thread-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd,
    hook_event_name: "Stop",
    model: "gpt-5.6",
    turn_id: turnId,
    stop_hook_active: stopHookActive,
    last_assistant_message: assistantMessage,
  };
}

test("busy Stop worker catches up to the latest exact final without persisting Hook text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-stop-drain-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let firstStarted;
  const enteredFirst = new Promise((resolve) => { firstStarted = resolve; });
  const evaluated = [];
  const thread = {
    ...threadFixture(),
    turns: [1, 2, 3].map((id) => completedTurn(`turn-${id}`, `user ${id}`, `verified result ${id}`)),
  };
  try {
    const worker = runStopHookWorker(JSON.stringify(stopPayload({
      turnId: "turn-1", assistantMessage: "verified result 1",
    })), {
      dataDirectory: directory,
      receivedAt: "2026-09-08T00:00:01.000Z",
      resolveCommand: async () => "mock-codex",
      startServer: async () => ({ readThread: async () => ({ thread }), close() {} }),
      decideTitles: async ([candidate]) => {
        evaluated.push([candidate.turnId, candidate.assistantMessage]);
        if (candidate.turnId === "turn-1") {
          firstStarted();
          await firstBlocked;
        }
        return [{ ...candidate, titleDecision: "keep", progressDecision: "update",
          progressChapter: "Verified result", progressSummary: candidate.assistantMessage,
          progressConfidence: "high" }];
      },
    });
    await enteredFirst;
    await enqueueStopRequest(coordinate, { threadId: "thread-1", turnId: "turn-2" }, "2026-09-08T00:00:02.000Z");
    await enqueueStopRequest(coordinate, { threadId: "thread-1", turnId: "turn-3" }, "2026-09-08T00:00:03.000Z");
    releaseFirst();
    await worker;
    assert.deepEqual(evaluated, [["turn-1", "verified result 1"], ["turn-3", "verified result 3"]]);
    const progress = JSON.parse(await readFile(coordinate.progressPath, "utf8"));
    assert.equal(progress.sourceTurnId, "turn-3");
    assert.equal(progress.progress, "verified result 3");
    assert.ok((await readPendingStop(coordinate.pendingStopPath)).handledAt);
    for (const filePath of [coordinate.pendingStopPath, coordinate.diagnosticPath, path.join(directory, "continuity.log")]) {
      assert.doesNotMatch(await readFile(filePath, "utf8"), /verified result|user [123]|last_assistant_message/);
    }
    const diagnostic = JSON.parse(await readFile(coordinate.diagnosticPath, "utf8"));
    assert.equal(diagnostic.turnId, "turn-3");
    assert.equal(diagnostic.status, "progress_updated");
    assert.equal(diagnostic.stage, "completed");
    assert.equal(diagnostic.workerVersion, APP_SERVER_CLIENT_VERSION);
  } finally {
    releaseFirst();
    await rm(directory, { recursive: true, force: true });
  }
});

test("queued recovery rejects another turn, partial output, or delegated identity", () => {
  const request = { threadId: "thread-1", turnId: "turn-2" };
  assert.equal(queuedStopInput(request, { ...threadFixture(), id: "another-thread" }), null);
  assert.equal(queuedStopInput({ ...request, turnId: "missing" }, threadFixture()), null);
  assert.equal(queuedStopInput(request, { ...threadFixture(), source: "subAgent" }), null);
  for (const status of ["inProgress", "interrupted", "failed"]) {
    const thread = threadFixture();
    thread.turns[1].status = status;
    assert.equal(queuedStopInput(request, thread), null);
  }
  const thread = threadFixture();
  thread.turns[1].items.at(-1).phase = "commentary";
  assert.equal(queuedStopInput(request, thread), null);
  assert.equal(queuedStopInput(request, threadFixture()).last_assistant_message, "Cloudflare 费用止损已经验证。");
});

test("worker records a safe failure stage without writing runtime error contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-stop-failure-"));
  try {
    const result = await runStopHookWorker(JSON.stringify(stopPayload()), {
      dataDirectory: directory,
      resolveCommand: async () => { throw new Error("secret-runtime-path-and-token"); },
    });
    assert.equal(result.reason, "stop_runtime_failed");
    const diagnostic = await readFile(threadStateCoordinate(directory, "thread-1").diagnosticPath, "utf8");
    assert.doesNotMatch(diagnostic, /secret-runtime|last_assistant_message|cwd/);
    assert.equal(JSON.parse(diagnostic).stage, "runtime");
    assert.equal(JSON.parse(diagnostic).status, "error");
    assert.equal((await readPendingStop(threadStateCoordinate(directory, "thread-1").pendingStopPath)).handledAt, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("waiting workers do not amplify a failed semantic request or replace its diagnostic", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-failure-coalescing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  let runtimeStarts = 0;
  let modelCalls = 0;
  const options = {
    dataDirectory: directory,
    receivedAt: "2000-01-01T00:00:00.000Z",
    resolveCommand: async () => "mock-codex",
    startServer: async () => {
      runtimeStarts += 1;
      return { readThread: async () => ({ thread: threadFixture() }), close() {} };
    },
    decideTitles: async ([candidate]) => {
      modelCalls += 1;
      return [{ ...candidate, semanticFailure: "semantic_nonzero_exit" }];
    },
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    runStopHookWorker(JSON.stringify(stopPayload()), options)
  )));
  assert.equal(runtimeStarts, 1);
  assert.equal(modelCalls, 1);
  assert.equal(results.filter((result) => result.reason === "retry_deferred").length, 7);
  const pending = await readPendingStop(coordinate.pendingStopPath);
  assert.equal(pending.handledAt, undefined);
  assert.ok(pending.retryBlockedAt);
  const doctor = await runTitleOperation("doctor", "thread-1", { dataDirectory: directory });
  assert.equal(doctor.refresh.state, "failed");
  assert.equal(doctor.diagnostic.reason, "semantic_nonzero_exit");
  assert.equal(doctor.lastWorkerVersion, APP_SERVER_CLIENT_VERSION);
});

test("the original Stop payload can finish a queued turn whose native final is not readable yet", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-owner-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  const thread = threadFixture();
  thread.turns[1].items.pop();
  let modelCalls = 0;
  const options = {
    dataDirectory: directory,
    resolveCommand: async () => "mock-codex",
    startServer: async () => ({ readThread: async () => ({ thread }), close() {} }),
    decideTitles: async ([candidate]) => {
      modelCalls += 1;
      assert.equal(candidate.assistantMessage, "Cloudflare 费用止损已经验证。");
      return [{ ...candidate, titleDecision: "keep", progressDecision: "update",
        progressChapter: "Verified", progressSummary: candidate.assistantMessage, progressConfidence: "high" }];
    },
  };
  await enqueueStopRequest(coordinate, { threadId: "thread-1", turnId: "turn-2" }, "2000-01-01T00:00:02.000Z");
  const waiting = await runStopHookWorker(JSON.stringify(stopPayload({ turnId: "turn-1" })), {
    ...options, receivedAt: "2000-01-01T00:00:01.000Z",
  });
  assert.equal(waiting.reason, "queued_result_unavailable");
  assert.equal(modelCalls, 0);
  const owner = await runStopHookWorker(JSON.stringify(stopPayload()), {
    ...options, receivedAt: "2000-01-01T00:00:02.000Z",
  });
  assert.equal(owner.status, "progress_updated");
  assert.equal(modelCalls, 1);
  assert.ok((await readPendingStop(coordinate.pendingStopPath)).handledAt);
  assert.equal(JSON.parse(await readFile(coordinate.progressPath, "utf8")).sourceTurnId, "turn-2");
});

test("a failed worker can retry the same turn and doctor never calls the failed read current", async () => {
  for (const failure of ["runtime", "thread_read", "semantic"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `continuity-retry-${failure}-`));
    const coordinate = threadStateCoordinate(directory, "thread-1");
    const payload = JSON.stringify(stopPayload());
    let fail = true;
    let successfulEvaluations = 0;
    const options = {
      dataDirectory: directory,
      resolveCommand: async () => {
        if (fail && failure === "runtime") throw new Error("temporary failure");
        return "mock-codex";
      },
      startServer: async () => ({
        async readThread() {
          if (fail && failure === "thread_read") throw new Error("temporary failure");
          return { thread: threadFixture() };
        }, close() {},
      }),
      decideTitles: async ([candidate]) => {
        if (fail && failure === "semantic") return [{ ...candidate, semanticFailure: "semantic_timeout" }];
        successfulEvaluations += 1;
        return [{ ...candidate, titleDecision: "keep", progressDecision: "update",
          progressChapter: "Verified", progressSummary: candidate.assistantMessage, progressConfidence: "high" }];
      },
    };
    try {
      const first = await runStopHookWorker(payload, options);
      assert.equal(first.retryPending, true, failure);
      assert.equal((await readPendingStop(coordinate.pendingStopPath)).handledAt, undefined, failure);
      const doctor = await runTitleOperation("doctor", "thread-1", { dataDirectory: directory });
      assert.equal(doctor.refresh.state, "failed", failure);
      assert.equal(doctor.refresh.latestStopHandled, false, failure);
      assert.doesNotMatch(doctor.nextStep, /No local refresh action/, failure);

      fail = false;
      const blocked = await readPendingStop(coordinate.pendingStopPath);
      await runStopHookWorker(payload, {
        ...options, receivedAt: new Date(Date.parse(blocked.retryBlockedAt) + 1).toISOString(),
      });
      assert.equal(successfulEvaluations, 1, failure);
      assert.ok((await readPendingStop(coordinate.pendingStopPath)).handledAt, failure);
      assert.equal(JSON.parse(await readFile(coordinate.progressPath)).sourceTurnId, "turn-2", failure);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("accepts the official Stop payload as the semantic source", () => {
  assert.deepEqual(parseStopHookInput(stopPayload()), {
    threadId: "thread-1",
    turnId: "turn-2",
    stopHookActive: false,
    assistantMessage: "Cloudflare 费用止损已经验证。",
    cwd: "/tmp/modeldial",
  });
  assert.deepEqual(parseStopHookInput(stopPayload({ stopHookActive: true })), {
    threadId: "thread-1",
    turnId: "turn-2",
    stopHookActive: true,
    assistantMessage: "Cloudflare 费用止损已经验证。",
    cwd: "/tmp/modeldial",
  });
  assert.equal(parseStopHookInput({ hook_event_name: "SessionEnd" }), null);
  assert.equal(parseStopHookInput("not-json"), null);
});

test("recognizes App Server subagent source variants", () => {
  assert.equal(isSubagentThread({ source: { subAgent: { thread_spawn: { parent_thread_id: "parent-1" } } } }), true);
  assert.equal(isSubagentThread({ threadSource: "subAgentReview" }), true);
  assert.equal(isSubagentThread({ source: "cli" }), false);
  assert.equal(isSubagentThread({ source: { vscode: {} } }), false);
});

test("keeps projectless Stop events outside the App Server path", async () => {
  assert.equal(hasStableWorkspace(parseStopHookInput(stopPayload())), true);
  assert.equal(hasStableWorkspace(parseStopHookInput(stopPayload({ cwd: "" }))), false);

  let spawnCalls = 0;
  const launchResult = await launchStopHookWorker(JSON.stringify(stopPayload({ cwd: "" })), {
    spawnImpl() {
      spawnCalls += 1;
      throw new Error("must not spawn");
    },
  });
  assert.equal(launchResult.reason, "workspace_unavailable");
  assert.equal(spawnCalls, 0);

  let reads = 0;
  const maintainResult = await maintainContinuityForStop(stopPayload({ cwd: "" }), {
    appServer: {
      async readThread() {
        reads += 1;
        return { thread: threadFixture() };
      },
    },
  });
  assert.equal(maintainResult.reason, "workspace_unavailable");
  assert.equal(reads, 0);
});

test("never creates a continuation prompt for sidebar refresh", () => {
  assert.deepEqual(buildStopHookOutput({ status: "kept" }), {});
  assert.deepEqual(buildStopHookOutput({ status: "progress_updated" }), {});
  assert.deepEqual(buildStopHookOutput({
    status: "renamed",
    change: { title: "Codex Continuity 开源发布准备" },
  }), {});
});

test("launches Stop maintenance as a detached worker without losing the Hook payload", async () => {
  let received = "";
  let unrefCalled = false;
  let spawnCall = null;
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      received += chunk.toString();
      callback();
    },
  });
  child.unref = () => { unrefCalled = true; };
  const spawnImpl = (command, args, options) => {
    spawnCall = { command, args, options };
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const rawInput = JSON.stringify(stopPayload());

  const result = await launchStopHookWorker(rawInput, {
    spawnImpl,
    nodeExecutable: "/test/node",
    scriptPath: "/plugin/plugin-stop-hook.mjs",
    env: { PATH: "/test/bin" },
    receivedAt: "2026-09-08T00:00:00.000Z",
  });

  assert.deepEqual(result, {
    status: "launched",
    threadId: "thread-1",
    turnId: "turn-2",
  });
  assert.deepEqual(spawnCall, {
    command: "/test/node",
    args: ["/plugin/plugin-stop-hook.mjs", "--worker", "--received-at", "2026-09-08T00:00:00.000Z"],
    options: {
      detached: true,
      env: { PATH: "/test/bin" },
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    },
  });
  assert.equal(received, rawInput);
  assert.equal(unrefCalled, true);
});

test("ignores a Stop already continued by another hook", async () => {
  const result = await maintainContinuityForStop(stopPayload({ stopHookActive: true }), {
    appServer: { async readThread() { throw new Error("must not read"); } },
    titleLedger: new TitleLedger(),
  });
  assert.equal(result.reason, "continued_stop");
});

test("does not maintain titles or progress for a delegated subagent task", async () => {
  let evaluated = false;
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer: {
      async readThread() {
        return {
          thread: {
            ...threadFixture(),
            source: { subAgent: { thread_spawn: { parent_thread_id: "parent-1" } } },
          },
        };
      },
    },
    titleLedger: new TitleLedger(),
    progressLedger: new ProgressLedger(),
    decideTitles: async () => {
      evaluated = true;
      return [];
    },
  });
  assert.equal(result.reason, "subagent_thread");
  assert.equal(evaluated, false);
});

test("fails closed when the official Stop payload has no assistant message", async () => {
  const result = await maintainContinuityForStop(stopPayload({ assistantMessage: "" }), {
    appServer: { async readThread() { throw new Error("must not read"); } },
    titleLedger: new TitleLedger(),
    decideTitles: async () => { throw new Error("must not evaluate"); },
  });
  assert.equal(result.reason, "assistant_message_unavailable");
});

test("builds a candidate from the Stop message without reading turn completion", () => {
  const thread = threadFixture();
  const event = parseStopHookInput(stopPayload({
    turnId: "turn-3",
    assistantMessage: "官方 Stop payload 已成为唯一的语义正文来源。",
  }));
  const candidate = buildHookCandidate(event, {
    ...thread,
    turns: [...thread.turns, { id: "turn-3", status: "inProgress", items: [] }],
  });
  assert.equal(candidate.turnCount, 3);
  assert.equal(candidate.assistantMessage, "官方 Stop payload 已成为唯一的语义正文来源。");
  assert.equal(candidate.sourceMessageId, "");
});

test("adds only the matching turn's user goal to the semantic candidate", () => {
  const event = parseStopHookInput(stopPayload());
  const candidate = buildHookCandidate(event, {
    ...threadFixture(),
    turns: [
      completedTurn("turn-1", "不要使用这条旧目标。", "旧回复。"),
      completedTurn(
        "turn-2",
        "<in-app-browser-context source=\"ambient-ui-state\">忽略这段界面状态</in-app-browser-context>\n现在切换到 Windows Hook 信任说明检查。",
        "Windows Hook 信任说明检查已完成。",
      ),
    ],
  });

  assert.equal(candidate.userMessage, "现在切换到 Windows Hook 信任说明检查。");
  assert.doesNotMatch(JSON.stringify(candidate), /不要使用这条旧目标|界面状态/);
});

test("never uses the thread preview as semantic title input", () => {
  const event = parseStopHookInput(stopPayload({
    assistantMessage: "The release boundary is verified.",
  }));
  const candidate = buildHookCandidate(event, {
    ...threadFixture(),
    name: "",
    preview: "A private user prompt that must stay out of semantic input",
  }, "Plugin release｜Privacy review");
  assert.equal(candidate.nativeTitle, "Plugin release｜Privacy review");
  assert.doesNotMatch(JSON.stringify(candidate), /private user prompt/);
});

test("records first-turn progress without replacing Codex's existing initial title", async () => {
  const thread = { ...threadFixture(), turns: threadFixture().turns.slice(0, 1) };
  const progressLedger = new ProgressLedger();
  const result = await maintainContinuityForStop(stopPayload({
    turnId: "turn-1",
    assistantMessage: "GA 已经接入。",
  }), {
    appServer: { async readThread() { return { thread }; } },
    titleLedger: new TitleLedger(),
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "rename",
      proposedTitle: "不应替换的首次标题",
      titleConfidence: "high",
      progressDecision: "update",
      progressChapter: "Google Analytics 接入",
      progressSummary: "Google Analytics 已经接入",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "progress_updated");
  assert.equal(thread.name, "接入 Google Analytics");
  assert.equal(progressLedger.current("thread-1").sourceTurnId, "turn-1");
});

test("initializes a blank CLI root title from high-confidence first-turn progress", async () => {
  let thread = {
    ...threadFixture(),
    name: "",
    turns: threadFixture().turns.slice(0, 1),
  };
  let writes = 0;
  const progressLedger = new ProgressLedger();
  const titleLedger = new TitleLedger();
  const result = await maintainContinuityForStop(stopPayload({
    turnId: "turn-1",
    assistantMessage: "Windows Hook 信任说明检查已完成。",
  }), {
    appServer: {
      async readThread() { return { thread }; },
      async setThreadName(_threadId, name) {
        writes += 1;
        thread = { ...thread, name };
      },
    },
    titleLedger,
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "keep",
      progressDecision: "update",
      progressChapter: "Windows Hook 信任说明",
      progressSummary: "Windows Hook 信任说明检查已完成",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "renamed");
  assert.equal(result.change.type, "initial_title_set");
  assert.equal(thread.name, "Windows Hook 信任说明");
  assert.equal(writes, 1);
  assert.equal(progressLedger.current("thread-1").nativeTitle, "Windows Hook 信任说明");
  assert.equal(titleLedger.status("thread-1").undoAvailable, false);
});

test("keeps a blank CLI root title when first-turn progress confidence is not high", async () => {
  const thread = {
    ...threadFixture(),
    name: "",
    turns: threadFixture().turns.slice(0, 1),
  };
  let writes = 0;
  const result = await maintainContinuityForStop(stopPayload({ turnId: "turn-1" }), {
    appServer: {
      async readThread() { return { thread }; },
      async setThreadName() { writes += 1; },
    },
    titleLedger: new TitleLedger(),
    progressLedger: new ProgressLedger(),
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "keep",
      progressDecision: "update",
      progressChapter: "仍需确认的进展",
      progressSummary: "当前证据还不足以形成稳定首标题",
      progressConfidence: "medium",
    })),
  });

  assert.equal(result.status, "progress_updated");
  assert.equal(result.change, null);
  assert.equal(thread.name, "");
  assert.equal(writes, 0);
});

test("does not overwrite a native title that appears before blank-title fallback writes", async () => {
  let thread = {
    ...threadFixture(),
    name: "",
    turns: threadFixture().turns.slice(0, 1),
  };
  let reads = 0;
  let writes = 0;
  const result = await maintainContinuityForStop(stopPayload({ turnId: "turn-1" }), {
    appServer: {
      async readThread() {
        reads += 1;
        if (reads === 2) thread = { ...thread, name: "Codex 原生标题" };
        return { thread };
      },
      async setThreadName() { writes += 1; },
    },
    titleLedger: new TitleLedger(),
    progressLedger: new ProgressLedger(),
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "keep",
      progressDecision: "update",
      progressChapter: "不应覆盖的标题",
      progressSummary: "本轮结果已经可靠完成",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "progress_updated");
  assert.equal(thread.name, "Codex 原生标题");
  assert.equal(writes, 0);
});

test("uses the Stop message immediately when App Server has not stored the turn", async () => {
  const pending = { ...threadFixture(), turns: threadFixture().turns.slice(0, 1) };
  let reads = 0;
  const progressLedger = new ProgressLedger();
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer: {
      async readThread() {
        reads += 1;
        return { thread: pending };
      },
    },
    titleLedger: new TitleLedger(),
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      progressDecision: "update",
      progressChapter: "Cloudflare 费用止损",
      progressSummary: "费用止损已经验证",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "progress_updated");
  assert.equal(reads, 1);
  assert.equal(progressLedger.current("thread-1").sourceTurnId, "turn-2");
});

test("records progress even when task metadata is temporarily unavailable", async () => {
  const progressLedger = new ProgressLedger();
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer: { async readThread() { throw new Error("metadata unavailable"); } },
    titleLedger: new TitleLedger(),
    progressLedger,
    decideTitles: async () => { throw new Error("must not evaluate"); },
  });

  assert.equal(result.reason, "thread_metadata_unavailable");
  assert.equal(progressLedger.current("thread-1"), null);
});

test("reports a semantic timeout without writing title or progress", async () => {
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer: { async readThread() { return { thread: threadFixture() }; } },
    titleLedger: new TitleLedger(), progressLedger: new ProgressLedger(),
    decideTitles: async (items, options) => {
      assert.equal(options.timeoutMs, 150_000);
      return items.map((item) => ({ ...item, semanticFailure: "semantic_timeout" }));
    },
  });
  assert.equal(result.status, "ignored");
  assert.equal(result.reason, "semantic_timeout");
});

test("reads current turn context once before semantic evaluation", async () => {
  const progressLedger = new ProgressLedger();
  const titleLedger = new TitleLedger();
  const readOptions = [];
  let evaluated = false;
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer: {
      async readThread(_threadId, options) {
        readOptions.push(options);
        return { thread: { ...threadFixture(), turns: [] } };
      },
    },
    titleLedger,
    progressLedger,
    decideTitles: async (items) => {
      evaluated = true;
      return items.map((item) => ({
        ...item,
        progressDecision: "update",
        progressChapter: "Cloudflare 费用止损",
        progressSummary: "费用止损已经验证",
        progressConfidence: "high",
      }));
    },
  });

  assert.equal(readOptions.length, 1);
  assert.deepEqual(readOptions[0], { includeTurns: true });
  assert.equal(evaluated, true);
  assert.equal(result.status, "progress_updated");
});

test("fails closed when root metadata is missing or unknown", async () => {
  for (const thread of [null, { id: "thread-1", name: "Task" }, { id: "thread-1", source: "unknown" }]) {
    let evaluated = false;
    const progressLedger = new ProgressLedger();
    const result = await maintainContinuityForStop(stopPayload(), {
      appServer: { async readThread() { return { thread }; } },
      titleLedger: new TitleLedger(),
      progressLedger,
      decideTitles: async () => {
        evaluated = true;
        return [];
      },
    });
    assert.equal(result.reason, "thread_metadata_unavailable");
    assert.equal(evaluated, false);
    assert.equal(progressLedger.current("thread-1"), null);
  }
});

test("a title presentation failure cannot erase a semantic progress result", async () => {
  const thread = threadFixture();
  let reads = 0;
  const progressLedger = new ProgressLedger();
  const titleLedger = new TitleLedger();
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer: {
      async readThread() {
        reads += 1;
        if (reads === 1) return { thread };
        throw new Error("title adapter unavailable");
      },
      async setThreadName() { throw new Error("must not write"); },
    },
    titleLedger,
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "replace_workstream",
      proposedTitle: "Cloudflare费用｜止损验证",
      proposedWorkstream: "Cloudflare费用",
      proposedTitleChapter: "止损验证",
      titleConfidence: "high",
      progressDecision: "update",
      progressChapter: "Cloudflare 费用止损",
      progressSummary: "费用止损已经验证",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "progress_updated");
  assert.equal(progressLedger.current("thread-1").progress, "费用止损已经验证");
  assert.equal(titleLedger.shouldEvaluate(thread, "turn-2"), false);
});

test("persists a high-confidence title proposal and records an undo", async () => {
  let thread = threadFixture();
  const appServer = {
    async readThread() { return { thread }; },
    async setThreadName(_threadId, name) { thread = { ...thread, name }; },
  };
  const titleLedger = new TitleLedger();
  const progressLedger = new ProgressLedger();
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer,
    titleLedger,
    progressLedger,
    command: "codex",
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "replace_workstream",
      proposedTitle: "Cloudflare费用｜止损验证",
      proposedWorkstream: "Cloudflare费用",
      proposedTitleChapter: "止损验证",
      titleConfidence: "high",
      progressDecision: "update",
      progressChapter: "Cloudflare 费用止损",
      progressSummary: "费用止损已经验证",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "renamed");
  assert.equal(thread.name, "Cloudflare费用｜止损验证");
  assert.equal(titleLedger.status("thread-1").undoAvailable, true);
  assert.equal(progressLedger.current("thread-1").progress, "费用止损已经验证");

  const repeated = await maintainContinuityForStop(stopPayload(), {
    appServer,
    titleLedger,
    progressLedger,
    command: "codex",
    decideTitles: async () => { throw new Error("must not evaluate twice"); },
  });
  assert.equal(repeated.reason, "already_evaluated");
  assert.deepEqual(buildStopHookOutput(repeated), {});
});

test("records a current-host chapter rename and does not rewrite it through the detached App Server", async () => {
  const thread = {
    ...threadFixture(),
    name: "接入 Google Analytics｜原生标题刷新",
  };
  let writes = 0;
  const appServer = {
    async readThread() { return { thread }; },
    async setThreadName() { writes += 1; },
  };
  const titleLedger = new TitleLedger();
  titleLedger.observe({ ...thread, name: "接入 Google Analytics｜费用排查" });
  const progressLedger = new ProgressLedger();

  const result = await maintainContinuityForStop(stopPayload(), {
    appServer,
    titleLedger,
    progressLedger,
    nativeTitleTurnId: "turn-2",
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "keep",
      proposedTitle: item.nativeTitle,
      titleConfidence: "high",
      progressDecision: "update",
      progressChapter: "原生标题刷新",
      progressSummary: "当前 Codex 主机已经刷新任务标题",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "renamed");
  assert.equal(result.change.decision, "native_update_chapter");
  assert.equal(writes, 0);
  assert.deepEqual(titleLedger.undoCandidate("thread-1"), {
    threadId: "thread-1",
    previousTitle: "接入 Google Analytics｜费用排查",
    title: "接入 Google Analytics｜原生标题刷新",
  });
  assert.equal(progressLedger.current("thread-1").progress, "当前 Codex 主机已经刷新任务标题");
});

test("corrects a stale workstream when the current host only updates the chapter", async () => {
  let thread = {
    ...threadFixture(),
    name: "评估 Slonaide 语音集成｜自动纪要触发机制评估",
  };
  let writes = 0;
  const appServer = {
    async readThread() { return { thread }; },
    async setThreadName(_threadId, name) {
      writes += 1;
      thread = { ...thread, name };
    },
  };
  const titleLedger = new TitleLedger();
  titleLedger.observe({
    ...thread,
    name: "评估 Slonaide 语音集成｜讯飞纪要未生成诊断",
  });
  const progressLedger = new ProgressLedger();
  progressLedger.recordProgress({
    threadId: "thread-1",
    turnId: "turn-1",
    nativeTitle: "评估 Slonaide 语音集成｜讯飞纪要未生成诊断",
    chapter: "纪要触发能力核查",
    progress: "已确认结束判定和自动同步均可实现",
    confidence: "high",
  });

  const result = await maintainContinuityForStop(stopPayload({
    assistantMessage: "自动纪要触发机制已落地并通过回归验证。",
  }), {
    appServer,
    titleLedger,
    progressLedger,
    nativeTitleTurnId: "turn-2",
    decideTitles: async (items) => {
      assert.equal(items[0].previousChapter, "纪要触发能力核查");
      assert.equal(items[0].previousProgress, "已确认结束判定和自动同步均可实现");
      return items.map((item) => ({
        ...item,
        titleDecision: "replace_workstream",
        proposedTitle: "知识库语音链路｜自动纪要触发机制落地",
        proposedWorkstream: "知识库语音链路",
        proposedTitleChapter: "自动纪要触发机制落地",
        titleConfidence: "high",
        progressDecision: "update",
        progressChapter: "自动纪要触发机制",
        progressSummary: "自动纪要触发机制已落地并通过回归验证",
        progressConfidence: "high",
      }));
    },
  });

  assert.equal(result.status, "renamed");
  assert.equal(result.change.decision, "replace_workstream");
  assert.equal(thread.name, "知识库语音链路｜自动纪要触发机制落地");
  assert.equal(writes, 1);
  assert.deepEqual(titleLedger.undoCandidate("thread-1"), {
    threadId: "thread-1",
    previousTitle: "评估 Slonaide 语音集成｜自动纪要触发机制评估",
    title: "知识库语音链路｜自动纪要触发机制落地",
  });
});

test("records a current-host workstream replacement without a detached rewrite", async () => {
  const thread = {
    ...threadFixture(),
    name: "知识库语音链路｜报告呈现与证据门收尾",
  };
  let writes = 0;
  const appServer = {
    async readThread() { return { thread }; },
    async setThreadName() { writes += 1; },
  };
  const titleLedger = new TitleLedger();
  titleLedger.observe({
    ...thread,
    name: "评估 Slonaide 语音集成｜完整转写评估",
  });
  const progressLedger = new ProgressLedger();

  const result = await maintainContinuityForStop(stopPayload(), {
    appServer,
    titleLedger,
    progressLedger,
    nativeTitleTurnId: "turn-2",
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "keep",
      proposedTitle: item.nativeTitle,
      titleConfidence: "high",
      progressDecision: "update",
      progressChapter: "报告呈现与证据门收尾",
      progressSummary: "报告呈现与证据校验已经收敛",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "renamed");
  assert.equal(result.change.decision, "native_replace_workstream");
  assert.equal(writes, 0);
  assert.deepEqual(titleLedger.undoCandidate("thread-1"), {
    threadId: "thread-1",
    previousTitle: "评估 Slonaide 语音集成｜完整转写评估",
    title: "知识库语音链路｜报告呈现与证据门收尾",
  });
  assert.equal(progressLedger.current("thread-1").progress, "报告呈现与证据校验已经收敛");
});

test("a separate-task suggestion protects the current title without writing it", async () => {
  const thread = {
    ...threadFixture(),
    name: "自动标题｜双层语义设计",
  };
  let writes = 0;
  const appServer = {
    async readThread() { return { thread }; },
    async setThreadName() { writes += 1; },
  };
  const titleLedger = new TitleLedger();
  const progressLedger = new ProgressLedger();
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer,
    titleLedger,
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "suggest_new_thread",
      proposedTitle: item.nativeTitle,
      proposedWorkstream: "自动标题",
      proposedTitleChapter: "双层语义设计",
      titleConfidence: "high",
      progressDecision: "keep",
    })),
  });

  assert.equal(result.status, "kept");
  assert.equal(writes, 0);
  assert.equal(titleLedger.shouldEvaluate(thread, "turn-2"), false);
});

test("a one-shot side answer leaves the existing title and progress unchanged", async () => {
  const thread = {
    ...threadFixture(),
    name: "自动标题｜双层语义设计",
    turns: [
      ...threadFixture().turns,
      completedTurn("turn-3", "看看今天宁波天气。", "宁波今天多云，最高气温 34℃。"),
    ],
  };
  let writes = 0;
  const appServer = {
    async readThread() { return { thread }; },
    async setThreadName() { writes += 1; },
  };
  const titleLedger = new TitleLedger();
  const progressLedger = new ProgressLedger();
  progressLedger.recordProgress({
    threadId: "thread-1",
    turnId: "turn-2",
    nativeTitle: thread.name,
    chapter: "双层语义标题",
    progress: "自动标题已采用工作线和当前章节双层结构",
    confidence: "high",
  });

  const result = await maintainContinuityForStop(stopPayload({
    turnId: "turn-3",
    assistantMessage: "宁波今天多云，最高气温 34℃。",
  }), {
    appServer,
    titleLedger,
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "keep",
      proposedTitle: item.nativeTitle,
      proposedWorkstream: "自动标题",
      proposedTitleChapter: "双层语义设计",
      titleConfidence: "high",
      progressDecision: "keep",
    })),
  });

  assert.equal(result.status, "kept");
  assert.equal(writes, 0);
  assert.equal(progressLedger.current("thread-1").sourceTurnId, "turn-2");
  assert.equal(progressLedger.current("thread-1").progress, "自动标题已采用工作线和当前章节双层结构");
  assert.equal(progressLedger.shouldEvaluate("thread-1", "turn-3"), false);
  assert.equal(titleLedger.shouldEvaluate(thread, "turn-3"), false);
});

test("does not consume a turn when the Codex account is unavailable", async () => {
  const thread = threadFixture();
  const appServer = { async readThread() { return { thread }; } };
  const titleLedger = new TitleLedger();
  const progressLedger = new ProgressLedger();
  const result = await maintainContinuityForStop(stopPayload(), {
    appServer,
    titleLedger,
    progressLedger,
    command: "codex",
    codexAvailable: false,
  });

  assert.equal(result.reason, "account_unavailable");
  assert.equal(titleLedger.shouldEvaluate(thread, "turn-2"), true);
  assert.equal(progressLedger.shouldEvaluate("thread-1", "turn-2"), true);
});

test("an explicit title lock does not stop semantic progress updates", async () => {
  const thread = {
    ...threadFixture(),
    turns: [
      ...threadFixture().turns,
      completedTurn("turn-3", "继续检查标题。", "标题刷新机制已经核对。"),
    ],
  };
  const titleLedger = new TitleLedger();
  const progressLedger = new ProgressLedger();
  titleLedger.setLocked(thread, true);
  const result = await maintainContinuityForStop(stopPayload({
    turnId: "turn-3",
    assistantMessage: "标题刷新机制已经核对。",
  }), {
    appServer: { async readThread() { return { thread }; } },
    titleLedger,
    progressLedger,
    decideTitles: async (items) => items.map((item) => ({
      ...item,
      titleDecision: "rename",
      proposedTitle: "不应应用的标题",
      titleConfidence: "high",
      progressDecision: "update",
      progressChapter: "标题机制核对",
      progressSummary: "标题刷新机制已经核对",
      progressConfidence: "high",
    })),
  });

  assert.equal(result.status, "progress_updated");
  assert.equal(progressLedger.current("thread-1").progress, "标题刷新机制已经核对");
});

test("status, undo, lock, and resume commands stay scoped to the current task", async () => {
  let title = "Cloudflare 费用止损验证";
  const appServer = {
    async readThread(threadId) { return { thread: { id: threadId, name: title } }; },
    async setThreadName(_threadId, name) { title = name; },
  };
  const titleLedger = new TitleLedger();
  const progressLedger = new ProgressLedger();
  titleLedger.observe({ id: "thread-1", name: "接入 Google Analytics" });
  titleLedger.recordApplied({
    threadId: "thread-1",
    previousTitle: "接入 Google Analytics",
    title,
    turnId: "turn-2",
    sourceMessageId: "message-turn-2",
    confidence: "high",
  });
  progressLedger.recordProgress({
    threadId: "thread-1",
    turnId: "turn-2",
    sourceMessageId: "message-turn-2",
    nativeTitle: title,
    chapter: "Cloudflare 费用止损",
    progress: "费用止损已经验证",
    confidence: "high",
  });

  const status = await runTitleCommand("status", "thread-1", {
    appServer,
    titleLedger,
    progressLedger,
  });
  assert.equal(status.ok, true);
  assert.equal(status.title, "Cloudflare 费用止损验证");
  assert.deepEqual(status.progress, {
    chapter: "Cloudflare 费用止损",
    summary: "费用止损已经验证",
    confidence: "high",
    updatedAt: progressLedger.current("thread-1").updatedAt,
    sourceTurnId: "turn-2",
    sourceMessageId: "message-turn-2",
  });
  assert.deepEqual({
    ok: status.ok,
    threadId: status.threadId,
    title: status.title,
    locked: status.locked,
    undoAvailable: status.undoAvailable,
  }, {
    ok: true,
    threadId: "thread-1",
    title: "Cloudflare 费用止损验证",
    locked: false,
    undoAvailable: true,
  });
  assert.equal((await runTitleCommand("undo", "thread-1", { appServer, titleLedger })).ok, true);
  assert.equal(title, "接入 Google Analytics");
  assert.equal(titleLedger.status("thread-1").locked, false);

  const locked = await runTitleCommand("lock", "thread-1", { appServer, titleLedger });
  assert.equal(locked.ok, true);
  assert.equal(locked.locked, true);
  assert.equal(titleLedger.shouldEvaluate({ id: "thread-1", name: title }, "turn-3"), false);

  const resumed = await runTitleCommand("resume", "thread-1", { appServer, titleLedger });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.locked, false);
  assert.equal(titleLedger.shouldEvaluate({ id: "thread-1", name: title }, "turn-3"), true);
});

test("plugin package uses the default bundled Hook location", async () => {
  const manifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url)));
  const hooks = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  const runner = await readFile(new URL("../scripts/run-stop-hook.sh", import.meta.url), "utf8");
  const windowsRunner = await readFile(new URL("../scripts/run-plugin-node.ps1", import.meta.url), "utf8");
  const appServerClient = await readFile(new URL("../src/app-server-client.mjs", import.meta.url), "utf8");
  const titleDecision = await readFile(new URL("../src/plugin-title-decision.mjs", import.meta.url), "utf8");
  const buildScript = await readFile(new URL("../scripts/build-plugin.sh", import.meta.url), "utf8");
  const installScript = await readFile(new URL("../scripts/install-plugin-dev.sh", import.meta.url), "utf8");
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(manifest.name, "codex-continuity");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.hooks, undefined);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].async, false);
  assert.notEqual(hooks.hooks.Stop[0].hooks[0].async, true);
  assert.equal(hooks.hooks.Stop[0].hooks[0].statusMessage, "Updating task status…");
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /PLUGIN_ROOT/);
  assert.match(hooks.hooks.Stop[0].hooks[0].commandWindows, /powershell\.exe/);
  assert.doesNotMatch(hooks.hooks.Stop[0].hooks[0].commandWindows, /-WindowStyle/);
  assert.match(hooks.hooks.Stop[0].hooks[0].commandWindows, /\$\{PLUGIN_ROOT\}/);
  assert.doesNotMatch(hooks.hooks.Stop[0].hooks[0].commandWindows, /\$env:PLUGIN_ROOT/);
  assert.match(hooks.hooks.Stop[0].hooks[0].commandWindows, /run-plugin-node\.ps1/);
  assert.match(runner, /cua_node\/bin\/node/);
  assert.match(runner, /plugin-stop-hook\.mjs/);
  assert.match(runner, /--launch/);
  assert.match(windowsRunner, /resources\\cua_node\\bin\\node\.exe/i);
  assert.match(windowsRunner, /resources\\codex\.exe/i);
  assert.match(windowsRunner, /CODEX_CONTINUITY_CODEX/);
  assert.match(windowsRunner, /CODEX_CLI_PATH/);
  assert.match(windowsRunner, /Get-Command codex -All/);
  assert.match(windowsRunner, /node_modules\\@openai\\codex\\node_modules/);
  assert.match(windowsRunner, /Find-UsableRuntime/);
  assert.match(windowsRunner, /& \$candidate --version/);
  assert.ok(
    windowsRunner.indexOf('Get-Process -Name "ChatGPT"')
      < windowsRunner.indexOf("Add-NpmCodexCandidates $codexCandidates"),
  );
  assert.ok(
    windowsRunner.indexOf("Add-NpmCodexCandidates $codexCandidates")
      < windowsRunner.indexOf('Get-Process -Name "Codex"'),
  );
  assert.match(windowsRunner, /plugin-stop-hook\.mjs/);
  assert.match(windowsRunner, /\$Mode -eq "stop"[\s\S]*?--launch/);
  assert.match(windowsRunner, /select-profile\.mjs/);
  assert.match(windowsRunner, /Codex Continuity Plugin/);
  assert.match(appServerClient, /windowsHide:\s*true/);
  assert.equal(titleDecision.match(/windowsHide:\s*true/g)?.length, 2);
  assert.equal(packageJson.scripts.start, "npm run build:plugin");
  assert.equal(packageJson.scripts["install:plugin:dev"], "bash scripts/install-plugin-dev.sh");
  assert.match(buildScript, /runtime_files=/);
  assert.match(buildScript, /Plugin and package versions must match/);
  assert.match(buildScript, /plugin-title-decision\.mjs/);
  assert.match(buildScript, /progress-ledger\.mjs/);
  assert.match(buildScript, /run-plugin-node\.ps1/);
  assert.doesNotMatch(buildScript, /completed-turn\.mjs/);
  assert.match(buildScript, /copy_file LICENSE/);
  assert.doesNotMatch(buildScript, /semantic-chapter\.schema|semantic-goal-match\.schema|semantic-return-point\.schema/);
  assert.doesNotMatch(buildScript, /macos\/|prototype\/|output\//);
  assert.match(installScript, /--wait/);
  assert.match(installScript, /main_app_running\(\)/);
  assert.match(installScript, /ps -ax -o command=/);
  assert.match(installScript, /\/Applications\/Codex\.app\/Contents\/MacOS\/Codex/);
  assert.match(installScript, /\/Applications\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT/);
  assert.match(installScript, /\$HOME\/Applications\/Codex\.app\/Contents\/MacOS\/Codex/);
  assert.match(installScript, /\$HOME\/Applications\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT/);
  assert.doesNotMatch(installScript, /pgrep/);
  assert.doesNotMatch(installScript, /\/Applications\/ChatGPT\.app\/Contents\/Frameworks/);
  assert.match(installScript, /while main_app_running/);
  assert.equal(installScript.match(/ensure_main_app_stopped/g)?.length, 3);
  assert.match(installScript, /marketplace_name="codex-continuity-dev"/);
  assert.match(installScript, /stage_dev_marketplace\(\)/);
  assert.match(installScript, /ditto "\$plugin_source" "\$plugin_target"/);
  assert.match(installScript, /plugin marketplace add "\$marketplace_root"/);
  assert.match(installScript, /"\$codex_command" plugin add "\$plugin_selector"/);
  assert.match(installScript, /plugin list --marketplace "\$marketplace_name" --json/);
  assert.match(installScript, /CODEX_HOME/);
  assert.match(installScript, /plugins\/cache\/\$marketplace_name/);
  assert.doesNotMatch(installScript, /codex-continuity@personal|marketplace personal|cache\/personal/);
  assert.match(installScript, /shasum -a 256/);
  assert.match(installScript, /cache manifest/);
});

test("the bundled shell runner accepts Hook JSON on stdin", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-hook-test-"));
  try {
    const output = execFileSync("/bin/sh", [fileURLToPath(new URL("../scripts/run-stop-hook.sh", import.meta.url))], {
      input: '{"hook_event_name":"SessionEnd"}\n',
      encoding: "utf8",
      env: {
        ...process.env,
        PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
        CODEX_CONTINUITY_DATA: dataDirectory,
      },
    });
    assert.equal(output.trim(), "{}");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the shell runner returns before detached Stop maintenance completes", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-hook-worker-test-"));
  try {
    const output = execFileSync("/bin/sh", [fileURLToPath(new URL("../scripts/run-stop-hook.sh", import.meta.url))], {
      input: `${JSON.stringify(stopPayload())}\n`,
      encoding: "utf8",
      env: {
        ...process.env,
        PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
        CODEX_CONTINUITY_CODEX: "/usr/bin/false",
        CODEX_CONTINUITY_DATA: dataDirectory,
      },
    });
    assert.equal(output.trim(), "{}");

    let diagnostic = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        diagnostic = await readFile(path.join(dataDirectory, "continuity.log"), "utf8");
        if (/error stop_runtime_failed/.test(diagnostic)) {
          try {
            await readFile(threadStateCoordinate(dataDirectory, "thread-1").lockPath);
          } catch (error) {
            if (error.code === "ENOENT") break;
          }
        }
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(diagnostic, /error stop_runtime_failed thread-1 turn-2/);
    assert.equal((await readPendingStop(threadStateCoordinate(dataDirectory, "thread-1").pendingStopPath)).handledAt, undefined);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
