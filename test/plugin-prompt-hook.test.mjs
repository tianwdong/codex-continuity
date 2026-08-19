import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPromptHookOutput,
  claimPromptCheck,
  markNativeTitleTurn,
  parsePromptHookInput,
} from "../src/plugin-prompt-hook.mjs";
import { ProgressLedger, saveProgressLedger } from "../src/progress-ledger.mjs";
import { threadStateCoordinate } from "../src/plugin-runtime.mjs";

function promptPayload({ sessionId = "thread-1", turnId = "turn-1", prompt = "继续修复自动标题。" } = {}) {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/rollout.jsonl",
    cwd: "/tmp/codex-continuity",
    hook_event_name: "UserPromptSubmit",
    model: "gpt-5.6",
    turn_id: turnId,
    prompt,
  };
}

test("accepts the official UserPromptSubmit payload without retaining the prompt", () => {
  assert.deepEqual(parsePromptHookInput(promptPayload()), {
    threadId: "thread-1",
    turnId: "turn-1",
    cwd: "/tmp/codex-continuity",
    hasDirectTaskLink: false,
    hasTaskHandoff: false,
  });
  const directLink = parsePromptHookInput(promptPayload({
    prompt: "codex://threads/019f5f2c-8598-79f3-ad71-4102989b991f，按照这个继续推进。",
  }));
  assert.equal(directLink.hasDirectTaskLink, true);
  assert.equal(directLink.hasTaskHandoff, true);
  const delegation = parsePromptHookInput(promptPayload({
    prompt: [
      "<codex_delegation>",
      "  <source_thread_id>019f5f2c-8598-79f3-ad71-4102989b991f</source_thread_id>",
      "  <input>继续推进。</input>",
      "</codex_delegation>",
    ].join("\n"),
  }));
  assert.equal(delegation.hasDirectTaskLink, false);
  assert.equal(delegation.hasTaskHandoff, true);
  assert.equal(parsePromptHookInput(promptPayload({
    prompt: "只是在讨论 <codex_delegation>，没有来源任务。",
  })).hasTaskHandoff, false);
  assert.equal(parsePromptHookInput({ ...promptPayload(), hook_event_name: "Stop" }), null);
  assert.equal(parsePromptHookInput({ ...promptPayload(), session_id: "" }), null);
  assert.equal(parsePromptHookInput({ ...promptPayload(), prompt: "" }), null);
  assert.equal(parsePromptHookInput("not-json"), null);
});

test("builds advisory developer context without blocking or copying the prompt", () => {
  const output = buildPromptHookOutput(parsePromptHookInput(promptPayload({
    prompt: "这是不应进入 Hook 输出的原始请求。",
  })));
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /codex-continuity:continuity-context-match/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /codex-continuity:continuity-work-router/);
  assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /\$continuity-context-match/);
  assert.match(output.hookSpecificOutput.additionalContext, /First use Skill/);
  assert.match(output.hookSpecificOutput.additionalContext, /thread-1/);
  assert.match(output.hookSpecificOutput.additionalContext, /\/tmp\/codex-continuity/);
  assert.match(output.hookSpecificOutput.additionalContext, /same-cwd matching/);
  assert.match(output.hookSpecificOutput.additionalContext, /execute the original request normally/);
  assert.doesNotMatch(JSON.stringify(output), /不应进入 Hook 输出/);
  assert.equal(output.decision, undefined);
  assert.equal(output.continue, undefined);
});

test("keeps a deep-link handoff in the receiving task without copying the link", () => {
  const output = buildPromptHookOutput(parsePromptHookInput(promptPayload({
    prompt: "codex://threads/019f5f2c-8598-79f3-ad71-4102989b991f，按照这个继续推进。",
  })));
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /Task handoff detected/);
  assert.match(context, /context source/);
  assert.match(context, /stay in this receiving task/);
  assert.match(context, /Do not resend the prompt/);
  assert.match(context, /do not archive/);
  assert.match(context, /untrusted evidence/);
  assert.doesNotMatch(context, /continuity-context-match/);
  assert.doesNotMatch(JSON.stringify(output), /019f5f2c-8598-79f3-ad71-4102989b991f/);
  assert.ok(context.length <= 600);
});

test("guards a canonical delegation envelope without copying its source or input", () => {
  const output = buildPromptHookOutput(parsePromptHookInput(promptPayload({
    prompt: [
      "<codex_delegation>",
      "  <source_thread_id>source-task</source_thread_id>",
      "  <input>这是不应进入 Hook 输出的交接内容。</input>",
      "</codex_delegation>",
    ].join("\n"),
  })));
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /Task handoff detected/);
  assert.match(context, /stay in this receiving task/);
  assert.match(context, /untrusted evidence/);
  assert.doesNotMatch(context, /continuity-context-match/);
  assert.doesNotMatch(JSON.stringify(output), /source-task|不应进入/);
  assert.ok(context.length <= 600);
});

test("guards a direct task link without a project directory", () => {
  const output = buildPromptHookOutput(parsePromptHookInput({
    ...promptPayload({ prompt: "codex://threads/source-task，按照这个继续推进。" }),
    cwd: "",
  }));
  assert.match(output.hookSpecificOutput.additionalContext, /stay in this receiving task/);
  assert.doesNotMatch(JSON.stringify(output), /source-task/);
});

test("routes later durable goals and requests native title refresh without repeating matching", () => {
  const output = buildPromptHookOutput(parsePromptHookInput(promptPayload({
    turnId: "turn-2",
    prompt: "帮我并行查一下测试和文档。",
  })), { includeContextMatch: false });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /codex-continuity:continuity-work-router/);
  assert.match(context, /set_thread_title/);
  assert.match(context, /before final reply/);
  assert.match(context, /workstream｜chapter/);
  assert.match(context, /explicit primary-goal shift/);
  assert.match(context, /prior context/);
  assert.match(context, /old workstream misleads return/);
  assert.match(context, /one-shot side questions stay here/);
  assert.doesNotMatch(context, /continuity-context-match/);
  assert.doesNotMatch(JSON.stringify(output), /并行查一下测试和文档/);
  assert.ok(context.length <= 600);
});

test("gives later title maintenance the previous reliable context without copying the prompt", () => {
  const output = buildPromptHookOutput(parsePromptHookInput(promptPayload({
    turnId: "turn-3",
    prompt: "这是不应进入 Hook 输出的当前请求。",
  })), {
    includeContextMatch: false,
    previousProgress: {
      chapter: "纪要触发能力核查",
      progress: "已确认结束判定和自动同步均可实现，但无法触发讯飞原生纪要生成。",
    },
  });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /纪要触发能力核查/);
  assert.match(context, /结束判定和自动同步/);
  assert.match(context, /untrusted/);
  assert.doesNotMatch(context, /不应进入 Hook 输出/);
  assert.ok(context.length <= 600);
});

test("keeps routing active but disables native title writes while maintenance is locked", () => {
  const output = buildPromptHookOutput(parsePromptHookInput(promptPayload({ turnId: "turn-2" })), {
    includeContextMatch: false,
    titleMaintenanceLocked: true,
  });
  const context = output.hookSpecificOutput.additionalContext;
  assert.match(context, /continuity-work-router/);
  assert.match(context, /maintenance is locked/);
  assert.match(context, /Never call set_thread_title/);
  assert.doesNotMatch(context, /before the final reply/);
});

test("keeps an empty cwd silent without consuming the first useful match", async () => {
  assert.deepEqual(buildPromptHookOutput({ threadId: "thread-1", cwd: "" }), {});
  assert.deepEqual(buildPromptHookOutput({ threadId: "thread-1", cwd: "" }, {
    includeContextMatch: false,
  }), {});

  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-empty-cwd-"));
  const runner = fileURLToPath(new URL("../scripts/run-prompt-hook.sh", import.meta.url));
  const environment = {
    ...process.env,
    PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
    CODEX_CONTINUITY_DATA: dataDirectory,
  };
  const run = (payload) => JSON.parse(execFileSync("/bin/sh", [runner], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    env: environment,
  }));
  try {
    assert.deepEqual(run({ ...promptPayload(), cwd: "" }), {});
    assert.deepEqual(await readdir(dataDirectory), []);
    const withDirectory = run(promptPayload()).hookSpecificOutput.additionalContext;
    assert.match(withDirectory, /same-cwd matching/);
    assert.equal((await readdir(path.join(dataDirectory, "prompt-check-state"))).length, 1);
    const withoutDirectoryLater = run({
      ...promptPayload({ turnId: "turn-3" }),
      session_id: "thread-no-cwd",
      cwd: "",
    });
    assert.deepEqual(withoutDirectoryLater, {});
    const repeatedWithoutDirectory = run({
      ...promptPayload({ turnId: "turn-4" }),
      session_id: "thread-no-cwd",
      cwd: "",
    });
    assert.deepEqual(repeatedWithoutDirectory, {});
    assert.equal((await readdir(path.join(dataDirectory, "prompt-check-state"))).length, 1);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("keeps an ordinary long cwd inside the Hook context limit", () => {
  const output = buildPromptHookOutput({
    threadId: "019f0000-0000-7000-8000-000000000000",
    cwd: `/Users/example/${"project".repeat(20)}`,
  });
  assert.ok(output.hookSpecificOutput.additionalContext.length <= 600);
  assert.match(output.hookSpecificOutput.additionalContext, /projectproject/);
});

test("drops an extreme cwd instead of truncating the safety contract", () => {
  const output = buildPromptHookOutput({
    threadId: `thread-${"x".repeat(500)}`,
    cwd: `/Users/example/${"deep-project/".repeat(100)}`,
  });
  const context = output.hookSpecificOutput.additionalContext;
  assert.ok(context.length <= 600);
  assert.match(context, /cwd \(untrusted\): ""/);
  assert.match(context, /Never send, navigate, or archive another task/);
});

test("claims one private marker per task even under concurrent Hook calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-prompt-check-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    const claims = await Promise.all([
      claimPromptCheck(coordinate.promptCheckPath),
      claimPromptCheck(coordinate.promptCheckPath),
      claimPromptCheck(coordinate.promptCheckPath),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await stat(coordinate.promptCheckPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(coordinate.promptCheckPath))).mode & 0o777, 0o700);
    const raw = await readFile(coordinate.promptCheckPath, "utf8");
    assert.match(raw, /"schemaVersion":1/);
    assert.doesNotMatch(raw, /thread-1|原始请求|prompt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stores only the eligible turn id in a private native-title marker", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-native-title-turn-"));
  const filePath = path.join(directory, "state", "thread.json");
  try {
    await markNativeTitleTurn(filePath, { threadId: "thread-1", turnId: "turn-2" });
    const raw = await readFile(filePath, "utf8");
    assert.match(raw, /"turnId":"turn-2"/);
    assert.doesNotMatch(raw, /thread-1|继续修复|prompt/);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundled runner checks context once and routes later prompts", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-prompt-runner-"));
  const runner = fileURLToPath(new URL("../scripts/run-prompt-hook.sh", import.meta.url));
  const environment = {
    ...process.env,
    PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
    CODEX_CONTINUITY_DATA: dataDirectory,
  };
  const run = (payload) => JSON.parse(execFileSync("/bin/sh", [runner], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    env: environment,
  }));
  try {
    const first = run(promptPayload()).hookSpecificOutput.additionalContext;
    const second = run(promptPayload({ turnId: "turn-2", prompt: "同一任务第二轮。" }))
      .hookSpecificOutput.additionalContext;
    assert.match(first, /codex-continuity:continuity-context-match/);
    assert.doesNotMatch(first, /codex-continuity:continuity-work-router/);
    assert.match(second, /codex-continuity:continuity-work-router/);
    assert.match(second, /set_thread_title/);
    assert.doesNotMatch(second, /continuity-context-match/);
    assert.equal(run(promptPayload({ sessionId: "thread-2" })).hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.deepEqual(run({ hook_event_name: "SessionEnd" }), {});

    const markerDirectory = path.join(dataDirectory, "prompt-check-state");
    const markers = await readdir(markerDirectory);
    assert.equal(markers.length, 2);
    for (const marker of markers) {
      assert.doesNotMatch(await readFile(path.join(markerDirectory, marker), "utf8"), /继续修复|同一任务第二轮/);
    }
    const nativeMarkers = await readdir(path.join(dataDirectory, "native-title-turn"));
    assert.equal(nativeMarkers.length, 1);
    assert.match(await readFile(path.join(dataDirectory, "native-title-turn", nativeMarkers[0]), "utf8"), /turn-2/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the bundled runner consumes matching after a deep-link handoff", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-link-handoff-"));
  const runner = fileURLToPath(new URL("../scripts/run-prompt-hook.sh", import.meta.url));
  const environment = {
    ...process.env,
    PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
    CODEX_CONTINUITY_DATA: dataDirectory,
  };
  const run = (payload) => JSON.parse(execFileSync("/bin/sh", [runner], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    env: environment,
  }));
  try {
    const handoff = run(promptPayload({
      prompt: "codex://threads/source-task，按照这个继续推进。",
    })).hookSpecificOutput.additionalContext;
    assert.match(handoff, /Task handoff detected/);
    assert.doesNotMatch(handoff, /continuity-context-match/);

    const nextTurn = run(promptPayload({
      turnId: "turn-2",
      prompt: "继续处理刚才的工作。",
    })).hookSpecificOutput.additionalContext;
    assert.match(nextTurn, /continuity-work-router/);
    assert.doesNotMatch(nextTurn, /continuity-context-match/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the bundled runner consumes matching after a canonical delegation envelope", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-envelope-handoff-"));
  const runner = fileURLToPath(new URL("../scripts/run-prompt-hook.sh", import.meta.url));
  const environment = {
    ...process.env,
    PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
    CODEX_CONTINUITY_DATA: dataDirectory,
  };
  const run = (payload) => JSON.parse(execFileSync("/bin/sh", [runner], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    env: environment,
  }));
  try {
    const handoff = run(promptPayload({
      prompt: "<codex_delegation><source_thread_id>source-task</source_thread_id><input>继续。</input></codex_delegation>",
    })).hookSpecificOutput.additionalContext;
    assert.match(handoff, /Task handoff detected/);
    assert.doesNotMatch(handoff, /continuity-context-match/);

    const nextTurn = run(promptPayload({ turnId: "turn-2", prompt: "继续处理。" }))
      .hookSpecificOutput.additionalContext;
    assert.match(nextTurn, /continuity-work-router/);
    assert.doesNotMatch(nextTurn, /continuity-context-match/);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("a handoff guard survives prompt-marker storage failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-handoff-storage-failure-"));
  const blockedDataPath = path.join(directory, "not-a-directory");
  await writeFile(blockedDataPath, "blocked", "utf8");
  const runner = fileURLToPath(new URL("../scripts/run-prompt-hook.sh", import.meta.url));
  try {
    const output = JSON.parse(execFileSync("/bin/sh", [runner], {
      input: `${JSON.stringify(promptPayload({
        prompt: "<codex_delegation><source_thread_id>source-task</source_thread_id><input>继续。</input></codex_delegation>",
      }))}\n`,
      encoding: "utf8",
      env: {
        ...process.env,
        PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
        CODEX_CONTINUITY_DATA: blockedDataPath,
      },
    }));
    assert.match(output.hookSpecificOutput.additionalContext, /Task handoff detected/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /continuity-context-match/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the bundled runner injects stored prior progress into later title maintenance", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-prior-progress-"));
  const runner = fileURLToPath(new URL("../scripts/run-prompt-hook.sh", import.meta.url));
  const environment = {
    ...process.env,
    PLUGIN_ROOT: fileURLToPath(new URL("../", import.meta.url)),
    CODEX_CONTINUITY_DATA: dataDirectory,
  };
  const run = (payload) => JSON.parse(execFileSync("/bin/sh", [runner], {
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    env: environment,
  }));
  try {
    run(promptPayload());
    const coordinate = threadStateCoordinate(dataDirectory, "thread-1");
    const progressLedger = new ProgressLedger();
    progressLedger.recordProgress({
      threadId: "thread-1",
      turnId: "turn-1",
      nativeTitle: "评估 Slonaide 语音集成｜讯飞纪要未生成诊断",
      chapter: "纪要触发能力核查",
      progress: "已确认结束判定和自动同步均可实现",
      confidence: "high",
    });
    await saveProgressLedger(coordinate.progressPath, progressLedger);

    const context = run(promptPayload({ turnId: "turn-2" }))
      .hookSpecificOutput.additionalContext;
    assert.match(context, /纪要触发能力核查/);
    assert.match(context, /结束判定和自动同步/);
    assert.ok(context.length <= 600);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("plugin package includes the prompt Hook, matching Skill, work router, and subagent dispatch", async () => {
  const hooks = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url)));
  const manifest = JSON.parse(await readFile(new URL("../.codex-plugin/plugin.json", import.meta.url)));
  const runner = await readFile(new URL("../scripts/run-prompt-hook.sh", import.meta.url), "utf8");
  const buildScript = await readFile(new URL("../scripts/build-plugin.sh", import.meta.url), "utf8");
  const actionRunner = await readFile(new URL("../scripts/run-action-command.sh", import.meta.url), "utf8");
  const windowsRunner = await readFile(new URL("../scripts/run-plugin-node.ps1", import.meta.url), "utf8");
  const matchingSkill = await readFile(new URL("../skills/continuity-context-match/SKILL.md", import.meta.url), "utf8");
  const matchingSkillPrompt = await readFile(new URL("../skills/continuity-context-match/agents/openai.yaml", import.meta.url), "utf8");
  const dispatchSkill = await readFile(new URL("../skills/continuity-subagent-dispatch/SKILL.md", import.meta.url), "utf8");
  const dispatchSkillPrompt = await readFile(new URL("../skills/continuity-subagent-dispatch/agents/openai.yaml", import.meta.url), "utf8");
  const dispatchScript = await readFile(new URL("../skills/continuity-subagent-dispatch/scripts/select-profile.mjs", import.meta.url), "utf8");
  const routerSkill = await readFile(new URL("../skills/continuity-work-router/SKILL.md", import.meta.url), "utf8");
  const routerSkillPrompt = await readFile(new URL("../skills/continuity-work-router/agents/openai.yaml", import.meta.url), "utf8");
  const titleSkillPrompt = await readFile(new URL("../skills/continuity-title/agents/openai.yaml", import.meta.url), "utf8");
  const privacy = await readFile(new URL("../PRIVACY.md", import.meta.url), "utf8");
  const handler = hooks.hooks.UserPromptSubmit[0].hooks[0];

  assert.equal(handler.async, false);
  assert.equal(handler.timeout, 5);
  assert.equal(handler.additionalContextLimit, 600);
  assert.equal(handler.statusMessage, undefined);
  assert.match(handler.command, /run-prompt-hook\.sh/);
  assert.match(handler.commandWindows, /powershell\.exe/);
  assert.match(handler.commandWindows, /-WindowStyle Hidden/);
  assert.match(handler.commandWindows, /run-plugin-node\.ps1/);
  assert.match(handler.commandWindows, /-Mode prompt/);
  assert.match(handler.commandWindows, /\$\{PLUGIN_ROOT\}/);
  assert.doesNotMatch(handler.commandWindows, /\$env:PLUGIN_ROOT/);
  assert.match(runner, /plugin-prompt-hook\.mjs/);
  assert.match(actionRunner, /task-action-command\.mjs/);
  assert.match(windowsRunner, /-Mode action|-eq "action"|action = "src\\task-action-command\.mjs"/);
  assert.match(windowsRunner, /ActionOperation/);
  assert.match(buildScript, /skills\/continuity-context-match\/SKILL\.md/);
  assert.match(buildScript, /skills\/continuity-context-match\/agents\/openai\.yaml/);
  assert.match(buildScript, /skills\/continuity-subagent-dispatch\/SKILL\.md/);
  assert.match(buildScript, /skills\/continuity-subagent-dispatch\/agents\/openai\.yaml/);
  assert.match(buildScript, /skills\/continuity-subagent-dispatch\/scripts\/select-profile\.mjs/);
  assert.match(buildScript, /skills\/continuity-work-router\/SKILL\.md/);
  assert.match(buildScript, /skills\/continuity-work-router\/agents\/openai\.yaml/);
  assert.match(buildScript, /skills\/continuity-title\/agents\/openai\.yaml/);
  assert.match(buildScript, /assets\/icon\.png/);
  assert.match(buildScript, /assets\/logo\.png/);
  assert.match(buildScript, /plugin-prompt-hook\.mjs/);
  assert.match(buildScript, /run-action-command\.sh/);
  assert.match(buildScript, /task-action-command\.mjs/);
  assert.match(buildScript, /task-action-ledger\.mjs/);
  assert.match(manifest.description, /smallest fitting native container/);
  assert.doesNotMatch(JSON.stringify(manifest.interface), /[\u3400-\u9fff]/);
  assert.doesNotMatch(matchingSkillPrompt, /[\u3400-\u9fff]/);
  assert.doesNotMatch(dispatchSkillPrompt, /[\u3400-\u9fff]/);
  assert.doesNotMatch(routerSkillPrompt, /[\u3400-\u9fff]/);
  assert.doesNotMatch(titleSkillPrompt, /[\u3400-\u9fff]/);
  assert.equal(manifest.interface.brandColor, "#2563EB");
  assert.equal(manifest.interface.composerIcon, "./assets/icon.png");
  assert.equal(manifest.interface.logo, "./assets/logo.png");
  assert.match(matchingSkillPrompt, /display_name: "Find where to continue"/);
  assert.match(titleSkillPrompt, /display_name: "Review task progress"/);
  assert.match(routerSkillPrompt, /display_name: "Choose a work path"/);
  assert.match(dispatchSkillPrompt, /display_name: "Choose a subagent"/);
  for (const skillPrompt of [matchingSkillPrompt, titleSkillPrompt, routerSkillPrompt, dispatchSkillPrompt]) {
    assert.match(skillPrompt, /icon_small: "\.\.\/\.\.\/assets\/icon\.png"/);
    assert.match(skillPrompt, /icon_large: "\.\.\/\.\.\/assets\/logo\.png"/);
    assert.match(skillPrompt, /brand_color: "#2563EB"/);
  }
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  assert.deepEqual(manifest.interface.defaultPrompt, [
    "Check whether an existing Codex task already matches my new goal.",
    "Show the latest reliable progress for this task.",
    "Quietly route this new durable goal into the smallest fitting Codex path.",
  ]);
  assert.match(manifest.interface.longDescription, /For each later durable goal, quietly use the current Codex model/);
  assert.match(manifest.interface.longDescription, /use the current Codex host to refresh the native title/);
  assert.match(manifest.interface.longDescription, /clearly changes its durable workstream/);
  assert.doesNotMatch(manifest.interface.longDescription, /only when the user explicitly asks/);
  assert.match(routerSkillPrompt, /policy:\s*[\s\S]*allow_implicit_invocation:\s*true/);
  assert.match(dispatchSkillPrompt, /policy:\s*[\s\S]*allow_implicit_invocation:\s*false/);
  assert.match(privacy, /https:\/\/modeldial\.com\/api\/v1\/radar\/latest\.json/);
  assert.doesNotMatch(privacy, /agent-profile\.json/);
  assert.match(privacy, /不含 turns 的线程元数据/);
  assert.match(privacy, /不会读取完整任务历史/);
  assert.match(privacy, /UserPromptSubmit.*固定的工作路由与原生标题维护规则/);
  assert.match(privacy, /不复制或保存原始 prompt/);
  assert.match(privacy, /当前 Codex 才会调用一次原生标题工具/);
  assert.match(privacy, /不另外调用分类模型/);
  assert.match(privacy, /留在当前任务和低置信判断不产生提示/);
  assert.match(privacy, /聊天支线、新任务、回传和归档始终需要用户明确确认/);
  assert.match(privacy, /最小动作回执/);
  assert.match(privacy, /不保存原始 prompt、任务标题、摘要、代码或对话正文/);
  assert.match(privacy, /状态不确定时停止而不是自动重放/);
  assert.match(matchingSkill, /never require a matching title or summary before reading recent context/);
  assert.match(matchingSkill, /Write every user-facing response in the language of the user's latest request/);
  assert.match(matchingSkill, /ranking hints rather than a gate/);
  assert.match(matchingSkill, /reported working directory exactly equals the Hook working directory/);
  assert.match(matchingSkill, /Never expand an automatic check to another directory/);
  assert.match(matchingSkill, /cross directories only when the user explicitly requests that wider scope/);
  assert.match(matchingSkill, /`turnLimit: 2`/);
  assert.match(matchingSkill, /`includeOutputs: false`/);
  assert.match(matchingSkill, /`userMessage`/);
  assert.match(matchingSkill, /`final_answer`/);
  assert.match(matchingSkill, /subAgentThreadSpawn/);
  assert.match(matchingSkill, /current system role or native task metadata identifies this task as delegated or subagent work/);
  assert.match(matchingSkill, /A direct `codex:\/\/threads\/` link or canonical `<codex_delegation>` envelope is context lineage/);
  assert.match(matchingSkill, /never equivalent to choosing “Continue the old task”/);
  assert.match(matchingSkill, /immediately preceding assistant response in this same task/);
  assert.match(matchingSkill, /Never send the same prompt back to the source task/);
  assert.match(matchingSkill, /Use the private action receipt/);
  assert.match(matchingSkill, /run-action-command\.sh/);
  assert.match(matchingSkill, /decision `perform`/);
  assert.match(matchingSkill, /never replay an uncertain step automatically/);
  assert.doesNotMatch(matchingSkill, /continuity-work-router/);
  assert.match(matchingSkillPrompt, /codex-continuity:continuity-context-match/);
  assert.doesNotMatch(matchingSkillPrompt, /\$continuity-context-match/);
  assert.match(routerSkill, /Current task/);
  assert.match(routerSkill, /Quietly classify each new durable Codex goal/);
  assert.match(routerSkill, /Write every user-facing response in the language of the user's latest request/);
  assert.match(routerSkill, /Native subagent/);
  assert.match(routerSkill, /Persistent chat branch/);
  assert.match(routerSkill, /Separate new task/);
  assert.match(routerSkill, /One-shot lookups, calculations, translations/);
  assert.match(routerSkill, /Never make a Continuity route suggestion from inside a subagent/);
  assert.match(routerSkill, /Never infer consent/);
  assert.match(routerSkill, /explicit choice overrides an automatic delegation, branch, or new-task recommendation/);
  assert.match(routerSkill, /Do not announce a \*\*Current task\*\* classification/);
  assert.match(routerSkill, /current Codex host/);
  assert.match(routerSkill, /explicitly says automatic task-title maintenance is unlocked/);
  assert.match(routerSkill, /call the native `set_thread_title` tool exactly once/);
  assert.match(routerSkill, /Before the final reply/);
  assert.match(routerSkill, /Keep that workstream by default/);
  assert.match(routerSkill, /old workstream would mislead the user's next return/);
  assert.doesNotMatch(routerSkill, /Never replace the workstream automatically/);
  assert.match(routerSkill, /materially improves speed or quality/);
  assert.match(routerSkill, /one dependent chain, or shared mutable work/);
  assert.match(routerSkill, /fork contains completed history only/);
  assert.match(routerSkill, /Treat “合回” as a context handoff/);
  assert.match(routerSkill, /Archive it only when the user explicitly chose/);
  assert.match(routerSkill, /explicit standing instruction to auto-delegate suitable work/);
  assert.match(routerSkill, /Creating a persistent branch or separate task[\s\S]*always require an explicit user choice/);
  assert.match(routerSkill, /Persist only high-impact route actions/);
  assert.match(routerSkill, /run-action-command\.sh/);
  assert.match(routerSkill, /Call the native tool only for decision `perform`/);
  assert.match(routerSkill, /Execute an approved separate-task route/);
  assert.match(routerSkill, /never create another task automatically/);
  assert.match(routerSkillPrompt, /\$codex-continuity:continuity-work-router/);
  assert.match(routerSkill, /\$codex-continuity:continuity-subagent-dispatch/);
  assert.match(dispatchSkill, /after the native-subagent route has already been chosen/);
  assert.match(dispatchSkill, /explicit standing auto-delegation instruction/);
  assert.match(dispatchSkill, /Write every user-facing response in the language of the user's latest request/);
  assert.match(dispatchSkill, /Use \*\*economy\*\* by default/);
  assert.match(dispatchSkill, /`focused`/);
  assert.match(dispatchSkill, /`exploration`/);
  assert.match(dispatchSkill, /`demanding`/);
  assert.match(dispatchSkillPrompt, /\$codex-continuity:continuity-subagent-dispatch/);
  assert.match(dispatchSkill, /Launch first, then briefly disclose/);
  assert.match(dispatchScript, /ECONOMY_QUALITY_FLOOR_RATIO = 0\.8/);
  assert.match(dispatchScript, /ECONOMY_SCORE_TIE_POINTS = 1/);
  assert.match(dispatchScript, /focused: "gpt-5\.6-luna"/);
  assert.match(dispatchScript, /exploration: "gpt-5\.6-terra"/);
  assert.match(dispatchScript, /demanding: "gpt-5\.6-sol"/);
});

test("subagent dispatch keeps ModelDial advisory, private, dynamic, and failure-closed", async () => {
  const routerSkill = await readFile(new URL("../skills/continuity-work-router/SKILL.md", import.meta.url), "utf8");
  const dispatchSkill = await readFile(new URL("../skills/continuity-subagent-dispatch/SKILL.md", import.meta.url), "utf8");

  assert.doesNotMatch(routerSkill, /agent-profile\.json/);
  assert.match(routerSkill, /dispatch Skill alone owns ModelDial reads/);
  assert.match(routerSkill, /ModelDial may inform configuration only after this Skill has chosen the native-subagent container/);
  assert.match(dispatchSkill, /https:\/\/modeldial\.com\/api\/v1\/radar\/latest\.json/);
  assert.match(dispatchSkill, /sends no request text, task title, code, working directory/);
  assert.match(dispatchSkill, /`recommendationMode: advisory_only`/);
  assert.match(dispatchSkill, /`pairedAgentBenchmark: false`/);
  assert.match(dispatchSkill, /Official model roles only define the eligible family/);
  assert.match(dispatchSkill, /\[ModelDial Radar\]\(https:\/\/modeldial\.com\/radar\)/);
  assert.match(dispatchSkill, /Always show the selector's `mainAgent`/);
  assert.match(dispatchSkill, /`保持当前`/);
  assert.match(dispatchSkill, /`需手动切换`/);
  assert.match(dispatchSkill, /`需手动确认`/);
  assert.match(dispatchSkill, /never switch it automatically/);
  assert.match(dispatchSkill, /Never rebuild the result from memory/);
  assert.match(dispatchSkill, /never change the main agent/);
});
