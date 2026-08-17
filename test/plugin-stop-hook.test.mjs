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
  isSubagentThread,
  launchStopHookWorker,
  maintainContinuityForStop,
  parseStopHookInput,
} from "../src/plugin-stop-hook.mjs";
import { runTitleCommand } from "../src/plugin-title-command.mjs";
import { ProgressLedger } from "../src/progress-ledger.mjs";
import { TitleLedger } from "../src/title-ledger.mjs";

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
} = {}) {
  return {
    session_id: "thread-1",
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/tmp/modeldial",
    hook_event_name: "Stop",
    model: "gpt-5.6",
    turn_id: turnId,
    stop_hook_active: stopHookActive,
    last_assistant_message: assistantMessage,
  };
}

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
  });

  assert.deepEqual(result, {
    status: "launched",
    threadId: "thread-1",
    turnId: "turn-2",
  });
  assert.deepEqual(spawnCall, {
    command: "/test/node",
    args: ["/plugin/plugin-stop-hook.mjs", "--worker"],
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

test("records first-turn progress without replacing Codex's initial title", async () => {
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
  assert.match(installScript, /"\$codex_command" plugin add codex-continuity@personal/);
  assert.match(installScript, /plugin list --marketplace personal --json/);
  assert.match(installScript, /CODEX_HOME/);
  assert.match(installScript, /plugins\/cache\/personal/);
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
    for (let attempt = 0; attempt < 40 && !diagnostic; attempt += 1) {
      try {
        diagnostic = await readFile(path.join(dataDirectory, "continuity.log"), "utf8");
      } catch (_) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.match(diagnostic, /thread_metadata_unavailable thread-1 turn-2/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
