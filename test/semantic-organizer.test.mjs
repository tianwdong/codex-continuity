import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  applyChapterLabels,
  applyGoalMatch,
  applySemanticResults,
  applyTitleDecisions,
  buildChapterPayload,
  buildGoalMatchPayload,
  buildSemanticPayload,
  buildTitleDecisionPayload,
  decideTitlesWithCodex,
  labelAttentionWithCodex,
  matchGoalWithCodex,
  organizeSnapshotWithCodex,
  parseMcpListOutput,
  withRulesOrganization,
} from "../src/semantic-organizer.mjs";

function goalMatchFixture() {
  return {
    worklines: [
      {
        id: "style-workline",
        threadId: "style-thread",
        project: "ModelDial",
        threadTitle: "网页端优化",
        userMessage: "继续调整首页样式。",
        assistantMessage: "首页间距已经统一，移动端断点仍需核对。",
        sourceMessageId: "style-message",
      },
      {
        id: "billing-workline",
        threadId: "billing-thread",
        project: "ModelDial",
        threadTitle: "接入 Google Analytics",
        userMessage: "排查 Cloudflare Container 费用。",
        assistantMessage: "**累计账单仍为 `$0.94`，Live Instances = 0**，Workflow 没有运行项。",
        sourceMessageId: "billing-message",
      },
    ],
  };
}

function snapshotFixture() {
  return {
    state: "ready",
    activeId: "candidate-workline",
    worklines: [
      {
        id: "confirmed-workline",
        threadId: "confirmed-thread",
        project: "Product",
        threadTitle: "Goal",
        checkpoint: "Goal checkpoint",
        nextAction: "Finish the active Goal",
        returnPointConfidence: "confirmed",
        userMessage: "Keep going.",
        assistantMessage: "The active Goal remains authoritative.",
        evidence: ["goal source"],
      },
      {
        id: "explicit-workline",
        threadId: "explicit-thread",
        project: "Product",
        threadTitle: "Explicit",
        checkpoint: "This is an incomplete introduction:",
        nextAction: "is the dominant upgrade:",
        returnPointConfidence: "explicit",
        userMessage: "Use the current benchmark as the comparison baseline.",
        assistantMessage: "The plan is defined. Next, implement the provider adapter.",
        evidence: ["explicit source"],
      },
      {
        id: "candidate-workline",
        threadId: "candidate-thread",
        project: "Product",
        threadTitle: "Candidate",
        checkpoint: "Rules checkpoint",
        nextAction: "Rules action",
        returnPointConfidence: "candidate",
        userMessage: "Please continue the audit.",
        assistantMessage: "The source audit is complete. Production verification still needs approval.",
        sourceMessageId: "message-1",
        evidence: ["candidate source"],
      },
      {
        id: "unknown-workline",
        threadId: "unknown-thread",
        project: "Private path must not appear",
        threadTitle: "Unknown",
        checkpoint: "Unknown checkpoint",
        nextAction: "Unknown action",
        returnPointConfidence: "unknown",
        userMessage: "Find a reliable stopping point.",
        assistantMessage: "No verified next action is present.",
        evidence: [],
      },
    ],
    projectReturnPoints: [
      {
        project: "Product",
        worklineId: "candidate-workline",
        threadId: "candidate-thread",
        checkpoint: "Rules checkpoint",
        nextAction: "Rules action",
        confidence: "candidate",
        sourceMeta: "Candidate · now",
      },
    ],
  };
}

function fakeSpawn(value, { exitCode = 0, neverClose = false, stderrText = "" } = {}) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    let input = "";
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        input += String(chunk);
        callback();
      },
      final(callback) {
        callback();
        if (neverClose) return;
        queueMicrotask(() => {
          assert.doesNotThrow(() => JSON.parse(input));
          child.stdout.end(typeof value === "string" ? value : JSON.stringify(value));
          child.stderr.end(stderrText);
          child.emit("close", exitCode, null);
        });
      },
    });
    child.kill = () => {
      child.killed = true;
      return true;
    };
    return child;
  };
}

test("builds a bounded payload for every non-Goal workline", () => {
  const payload = buildSemanticPayload(snapshotFixture());

  assert.deepEqual(payload.items.map((item) => item.threadId), [
    "explicit-thread",
    "candidate-thread",
    "unknown-thread",
  ]);
  assert.equal(JSON.stringify(payload).includes("/Users/"), false);
  assert.equal("workspaceMeta" in payload.items[0], false);
  assert.equal("tasks" in payload.items[0], false);
});

test("ranks concrete goal context and accepts only a source-backed high-confidence match", () => {
  const snapshot = goalMatchFixture();
  const payload = buildGoalMatchPayload(snapshot, "继续检查 ModelDial 的 Cloudflare 费用");
  assert.equal(payload.items[0].threadId, "billing-thread");
  assert.equal(payload.items[0].assistantMessage.includes("$0.94"), true);

  const accepted = applyGoalMatch(snapshot, payload.goal, {
    matched: true,
    threadId: "billing-thread",
    chapter: "Cloudflare 费用止损已验证",
    evidence: "**累计账单仍为 `$0.94`，Live Instances = 0**",
    confidence: "high",
  });
  assert.equal(accepted.threadId, "billing-thread");
  assert.equal(accepted.nativeTitle, "接入 Google Analytics");
  assert.equal(accepted.excerpt, "累计账单仍为 $0.94，Live Instances = 0");

  assert.equal(applyGoalMatch(snapshot, payload.goal, {
    matched: true,
    threadId: "billing-thread",
    chapter: "Cloudflare 费用止损已验证",
    evidence: "这段证据并不存在",
    confidence: "high",
  }), null);
  assert.equal(applyGoalMatch(snapshot, payload.goal, {
    matched: true,
    threadId: "billing-thread",
    chapter: "Cloudflare 费用止损已验证",
    evidence: "**累计账单仍为 `$0.94`",
    confidence: "medium",
  }), null);
});

test("classifies source-backed states, suppresses unknown work, and preserves active Goals", () => {
  const input = snapshotFixture();
  const result = applySemanticResults(input, {
    items: [
      {
        threadId: "explicit-thread",
        state: "ready_to_continue",
        checkpoint: "The plan has been defined.",
        nextAction: "Implement the provider adapter.",
        nextActor: "codex",
        checkpointEvidence: "The plan is defined.",
        nextActionEvidence: "Next, implement the provider adapter.",
        confidence: "high",
      },
      {
        threadId: "candidate-thread",
        state: "waiting_for_user",
        checkpoint: "The audit is complete.",
        nextAction: "Request approval for production verification.",
        nextActor: "user",
        checkpointEvidence: "The source audit is complete.",
        nextActionEvidence: "Production verification still needs approval.",
        confidence: "high",
      },
      {
        threadId: "unknown-thread",
        state: "no_reliable_state",
        checkpoint: "",
        nextAction: "",
        nextActor: "none",
        checkpointEvidence: "",
        nextActionEvidence: "",
        confidence: "high",
      },
      {
        threadId: "confirmed-thread",
        state: "ready_to_continue",
        checkpoint: "Do not apply",
        nextAction: "Do not apply",
        nextActor: "codex",
        checkpointEvidence: "The active Goal remains authoritative.",
        nextActionEvidence: "Keep going.",
        confidence: "high",
      },
    ],
  });

  assert.equal(result.organization.state, "ready");
  assert.equal(result.organization.enhancedCount, 3);
  assert.equal(result.organization.fallbackCount, 0);
  assert.equal(result.snapshot.worklines[0], input.worklines[0]);
  assert.equal(result.snapshot.worklines[1].returnPointConfidence, "derived");
  assert.equal(result.snapshot.worklines[1].semanticState, "ready_to_continue");
  assert.equal(result.snapshot.worklines[2].semanticState, "waiting_for_user");
  assert.equal(result.snapshot.worklines[2].nextActionLabel, "等你");
  assert.equal(result.snapshot.worklines[2].sourceMessageId, "message-1");
  assert.equal(result.snapshot.worklines[3].returnPointConfidence, "unknown");
  assert.equal(result.snapshot.worklines[3].nextAction, "");
  assert.equal(result.snapshot.projectReturnPoints[0].confidence, "derived");
  assert.equal(result.snapshot.projectReturnPoints[0].sourceMeta, "Candidate · now");
});

test("rejects incomplete model fragments instead of promoting them", () => {
  const input = snapshotFixture();
  const result = applySemanticResults(input, {
    items: [{
      threadId: "explicit-thread",
      state: "ready_to_continue",
      checkpoint: "The plan is:",
      nextAction: "Implement:",
      nextActor: "codex",
      checkpointEvidence: "The plan is defined.",
      nextActionEvidence: "Next, implement the provider adapter.",
      confidence: "high",
    }],
  });

  assert.equal(result.organization.state, "partial");
  assert.equal(result.organization.enhancedCount, 0);
  assert.equal(result.snapshot.worklines[1], input.worklines[1]);
});

test("marks a completed turn as non-actionable instead of inventing a next step", () => {
  const input = snapshotFixture();
  const result = applySemanticResults(input, {
    items: [{
      threadId: "explicit-thread",
      state: "completed",
      checkpoint: "The plan has been defined.",
      nextAction: "",
      nextActor: "none",
      checkpointEvidence: "The plan is defined.",
      nextActionEvidence: "",
      confidence: "high",
    }],
  });

  assert.equal(result.snapshot.worklines[1].semanticState, "completed");
  assert.equal(result.snapshot.worklines[1].returnPointConfidence, "completed");
  assert.equal(result.snapshot.worklines[1].nextAction, "");
});

test("reads only safe server names from the redacted Codex MCP listing", () => {
  const listing = `Name          Command    Args  Env  Cwd  Status    Auth
codegraph     codegraph  -     -    -    enabled   Unsupported
node_repl     node       -     -    -    disabled  Unsupported

Name             Url                       Bearer Token Env Var  Status   Auth
cloudflare       https://mcp.example/mcp   -                     enabled  OAuth
cloudflare_docs  https://docs.example/mcp  -                     enabled  Unsupported
`;

  assert.deepEqual(parseMcpListOutput(listing), [
    "codegraph",
    "node_repl",
    "cloudflare",
    "cloudflare_docs",
  ]);
  assert.equal(parseMcpListOutput("unexpected output"), null);
});

test("isolates MCP discovery from an unsupported user reasoning effort", async () => {
  const invocations = [];
  const items = [{
    threadId: "billing-thread",
    nativeTitle: "接入 Google Analytics",
    userMessage: "继续排查费用。",
    assistantMessage: "Cloudflare 费用止损已经验证。",
  }];
  const spawnImpl = (command, args, options) => {
    invocations.push({ command, args, options });
    if (args[0] === "mcp") {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end("No MCP servers configured.\n");
        child.emit("close", 0, null);
      });
      return child;
    }
    return fakeSpawn({
      items: [{
        threadId: "billing-thread",
        decision: "keep",
        workstream: "接入 Google Analytics",
        titleChapter: "",
        evidence: "",
        confidence: "high",
        progressDecision: "keep",
        progressChapter: "",
        progress: "",
        progressEvidence: "",
        progressConfidence: "low",
      }],
    })(command, args, options);
  };

  await decideTitlesWithCodex(items, {
    command: "/test/codex",
    cwd: "/tmp",
    env: { PATH: "/test" },
    spawnImpl,
    timeoutMs: 100,
  });

  assert.deepEqual(invocations[0].args, [
    "mcp",
    "list",
    "-c",
    'model_reasoning_effort="low"',
    "-c",
    "features.plugins=false",
  ]);
  assert.equal(invocations[1].args[0], "exec");
});

test("runs Codex through an ephemeral read-only fake process", async () => {
  let invocation;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    return fakeSpawn({
      items: [{
        threadId: "candidate-thread",
        state: "waiting_for_user",
        checkpoint: "The audit is complete.",
        nextAction: "Request approval for production verification.",
        nextActor: "user",
        checkpointEvidence: "The source audit is complete.",
        nextActionEvidence: "Production verification still needs approval.",
        confidence: "medium",
      }],
    })(command, args, options);
  };

  const result = await organizeSnapshotWithCodex(snapshotFixture(), {
    command: "/test/codex",
    cwd: "/tmp",
    env: { PATH: "/test" },
    spawnImpl,
    timeoutMs: 100,
    mcpServerNames: ["cloudflare", "node_repl"],
  });

  assert.equal(invocation.command, "/test/codex");
  assert.equal(invocation.args.includes("--ephemeral"), true);
  assert.equal(invocation.args.includes("read-only"), true);
  assert.equal(invocation.args.includes("--output-schema"), true);
  assert.equal(invocation.args.includes("--ignore-user-config"), false);
  assert.equal(invocation.args.includes("--ignore-rules"), true);
  assert.equal(invocation.args.includes('web_search="disabled"'), true);
  assert.equal(invocation.args.includes("features.plugins=false"), true);
  assert.equal(invocation.args.includes("features.shell_tool=false"), true);
  assert.equal(invocation.args.includes("mcp_servers.cloudflare.enabled=false"), true);
  assert.equal(invocation.args.includes("mcp_servers.node_repl.enabled=false"), true);
  assert.equal(invocation.options.cwd, "/tmp");
  assert.equal(result.organization.enhancedCount, 1);
});

test("matches a new goal through the isolated Codex runner", async () => {
  let invocation;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    return fakeSpawn({
      matched: true,
      threadId: "billing-thread",
      chapter: "Cloudflare 费用止损已验证",
      evidence: "**累计账单仍为 `$0.94`，Live Instances = 0**",
      confidence: "high",
    })(command, args, options);
  };

  const result = await matchGoalWithCodex(
    goalMatchFixture(),
    "继续检查 ModelDial 的 Cloudflare 费用",
    {
      command: "/test/codex",
      cwd: "/tmp",
      env: { PATH: "/test" },
      spawnImpl,
      timeoutMs: 100,
      mcpServerNames: [],
    },
  );

  const schemaIndex = invocation.args.indexOf("--output-schema");
  assert.match(invocation.args[schemaIndex + 1], /semantic-goal-match\.schema\.json$/);
  assert.equal(result.state, "ready");
  assert.equal(result.match.threadId, "billing-thread");
});

test("labels a completed result with a source-backed current chapter", async () => {
  const items = [{
    threadId: "billing-thread",
    project: "ModelDial",
    nativeTitle: "接入 Google Analytics",
    assistantMessage: "累计账单仍为 $0.94，Live Instances = 0，费用异常已经止住。",
  }];
  const payload = buildChapterPayload(items);
  assert.equal(payload.items[0].title, "接入 Google Analytics");
  assert.equal(payload.items[0].assistantMessage.includes("费用异常已经止住"), true);

  const accepted = applyChapterLabels(items, {
    items: [{
      threadId: "billing-thread",
      chapter: "Cloudflare 费用止损已验证",
      evidence: "费用异常已经止住",
      confidence: "high",
    }],
  });
  assert.equal(accepted[0].chapter, "Cloudflare 费用止损已验证");

  const rejected = applyChapterLabels(items, {
    items: [{
      threadId: "billing-thread",
      chapter: "Cloudflare 费用止损已验证",
      evidence: "原文不存在",
      confidence: "high",
    }],
  });
  assert.equal(rejected[0].chapter, undefined);

  let invocation;
  const labeled = await labelAttentionWithCodex(items, {
    command: "/test/codex",
    cwd: "/tmp",
    env: { PATH: "/test" },
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return fakeSpawn({
        items: [{
          threadId: "billing-thread",
          chapter: "Cloudflare 费用止损已验证",
          evidence: "费用异常已经止住",
          confidence: "medium",
        }],
      })(command, args, options);
    },
    timeoutMs: 100,
    mcpServerNames: [],
  });
  const schemaIndex = invocation.args.indexOf("--output-schema");
  assert.match(invocation.args[schemaIndex + 1], /semantic-chapter\.schema\.json$/);
  assert.equal(labeled[0].chapter, "Cloudflare 费用止损已验证");
});

test("keeps Codex's native title unless a completed turn proves substantial drift", async () => {
  const items = [{
    threadId: "billing-thread",
    project: "ModelDial",
    nativeTitle: "接入 Google Analytics",
    previousChapter: "Cloudflare 费用排查",
    previousProgress: "已确认 Container 仍有实例运行",
    userMessage: "排查 Cloudflare Container 费用。",
    assistantMessage: "累计账单仍为 $0.94，Live Instances = 0，费用异常已经止住。",
  }];
  const payload = buildTitleDecisionPayload(items);
  assert.equal(Object.hasOwn(payload.items[0], "project"), false);
  assert.equal(payload.items[0].comparisonBaseline.currentTitle, "接入 Google Analytics");
  assert.equal(payload.items[0].comparisonBaseline.currentWorkstream, "接入 Google Analytics");
  assert.equal(payload.items[0].comparisonBaseline.currentTitleChapter, "");
  assert.equal(payload.items[0].evidenceContext.previousProgress, "已确认 Container 仍有实例运行");
  assert.equal(payload.items[0].evidenceContext.userMessage.includes("Cloudflare"), true);
  assert.deepEqual(Object.keys(payload.items[0]), [
    "threadId",
    "evidenceContext",
    "comparisonBaseline",
  ]);

  const renamed = applyTitleDecisions(items, {
    items: [{
      threadId: "billing-thread",
      decision: "replace_workstream",
      workstream: "Cloudflare费用",
      titleChapter: "止损验证",
      evidence: "费用异常已经止住",
      confidence: "high",
      progressDecision: "update",
      progressChapter: "Cloudflare 费用止损",
      progress: "费用异常已经止住，Live Instances 已归零",
      progressEvidence: "Live Instances = 0，费用异常已经止住",
      progressConfidence: "high",
    }],
  });
  assert.equal(renamed[0].titleDecision, "replace_workstream");
  assert.equal(renamed[0].proposedWorkstream, "Cloudflare费用");
  assert.equal(renamed[0].proposedTitleChapter, "止损验证");
  assert.equal(renamed[0].proposedTitle, "Cloudflare费用｜止损验证");
  assert.equal(renamed[0].progressDecision, "update");
  assert.equal(renamed[0].progressChapter, "Cloudflare 费用止损");
  assert.equal(renamed[0].progressSummary, "费用异常已经止住，Live Instances 已归零");

  const unsupported = applyTitleDecisions(items, {
    items: [{
      threadId: "billing-thread",
      decision: "replace_workstream",
      workstream: "Cloudflare费用",
      titleChapter: "止损验证",
      evidence: "原文没有这句话",
      confidence: "high",
      progressDecision: "update",
      progressChapter: "Cloudflare 费用止损",
      progress: "费用异常已经止住",
      progressEvidence: "原文也没有这句话",
      progressConfidence: "high",
    }],
  });
  assert.equal(unsupported[0].titleDecision, undefined);
  assert.equal(unsupported[0].progressDecision, undefined);

  const kept = applyTitleDecisions(items, {
    items: [{
      threadId: "billing-thread",
      decision: "keep",
      workstream: "接入 Google Analytics",
      titleChapter: "",
      evidence: "",
      confidence: "high",
      progressDecision: "keep",
      progressChapter: "",
      progress: "",
      progressEvidence: "",
      progressConfidence: "low",
    }],
  });
  assert.equal(kept[0].titleDecision, "keep");
  assert.equal(kept[0].progressDecision, "keep");

  const chapterUpdated = applyTitleDecisions([{
    ...items[0],
    nativeTitle: "自动标题｜回归修复",
    userMessage: "把标题改成工作线和当前章节。",
    assistantMessage: "双层语义标题方案已经确定。",
  }], {
    items: [{
      threadId: "billing-thread",
      decision: "update_chapter",
      workstream: "自动标题",
      titleChapter: "双层语义设计",
      evidence: "双层语义标题方案已经确定",
      confidence: "high",
      progressDecision: "keep",
      progressChapter: "",
      progress: "",
      progressEvidence: "",
      progressConfidence: "low",
    }],
  });
  assert.equal(chapterUpdated[0].titleDecision, "update_chapter");
  assert.equal(chapterUpdated[0].proposedTitle, "自动标题｜双层语义设计");

  const englishChapterUpdated = applyTitleDecisions([{
    ...items[0],
    nativeTitle: "Plugin release｜Install workflow",
    userMessage: "Make the first install work without memorizing commands.",
    assistantMessage: "The guided local install workflow is now verified end to end.",
  }], {
    items: [{
      threadId: "billing-thread",
      decision: "update_chapter",
      workstream: "Plugin release",
      titleChapter: "Guided local installation",
      evidence: "guided local install workflow is now verified",
      confidence: "high",
      progressDecision: "update",
      progressChapter: "Guided local installation",
      progress: "The guided local install workflow is verified end to end.",
      progressEvidence: "The guided local install workflow is now verified end to end",
      progressConfidence: "high",
    }],
  });
  assert.equal(englishChapterUpdated[0].titleDecision, "update_chapter");
  assert.equal(englishChapterUpdated[0].proposedTitle, "Plugin release｜Guided local installation");
  assert.equal(englishChapterUpdated[0].progressChapter, "Guided local installation");

  const sideQuestionKept = applyTitleDecisions([{
    ...items[0],
    nativeTitle: "自动标题｜双层语义设计",
    userMessage: "看看今天宁波天气。",
    assistantMessage: "宁波今天多云，最高气温 34℃。",
  }], {
    items: [{
      threadId: "billing-thread",
      decision: "keep",
      workstream: "自动标题",
      titleChapter: "双层语义设计",
      evidence: "",
      confidence: "high",
      progressDecision: "keep",
      progressChapter: "",
      progress: "",
      progressEvidence: "",
      progressConfidence: "low",
    }],
  });
  assert.equal(sideQuestionKept[0].titleDecision, "keep");
  assert.equal(sideQuestionKept[0].proposedTitle, "自动标题｜双层语义设计");
  assert.equal(sideQuestionKept[0].progressDecision, "keep");

  const separateTaskSuggested = applyTitleDecisions([{
    ...items[0],
    nativeTitle: "自动标题｜双层语义设计",
    userMessage: "另外开发一个完全独立的财务系统。",
    assistantMessage: "这项财务系统工作与当前自动标题上下文无关。",
  }], {
    items: [{
      threadId: "billing-thread",
      decision: "suggest_new_thread",
      workstream: "自动标题",
      titleChapter: "双层语义设计",
      evidence: "与当前自动标题上下文无关",
      confidence: "high",
      progressDecision: "keep",
      progressChapter: "",
      progress: "",
      progressEvidence: "",
      progressConfidence: "low",
    }],
  });
  assert.equal(separateTaskSuggested[0].titleDecision, "suggest_new_thread");
  assert.equal(separateTaskSuggested[0].proposedTitle, "自动标题｜双层语义设计");

  let invocation;
  const decided = await decideTitlesWithCodex(items, {
    command: "/test/codex",
    cwd: "/tmp",
    env: { PATH: "/test" },
    spawnImpl(command, args, options) {
      invocation = { command, args, options };
      return fakeSpawn({
        items: [{
          threadId: "billing-thread",
          decision: "replace_workstream",
          workstream: "Cloudflare费用",
          titleChapter: "止损验证",
          evidence: "费用异常已经止住",
          confidence: "high",
          progressDecision: "update",
          progressChapter: "Cloudflare 费用止损",
          progress: "费用异常已经止住，Live Instances 已归零",
          progressEvidence: "Live Instances = 0，费用异常已经止住",
          progressConfidence: "high",
        }],
      })(command, args, options);
    },
    timeoutMs: 100,
    mcpServerNames: [],
  });
  const schemaIndex = invocation.args.indexOf("--output-schema");
  assert.match(invocation.args[schemaIndex + 1], /semantic-title\.schema\.json$/);
  assert.match(invocation.args.at(-1), /language of evidenceContext\.userMessage/);
  assert.match(invocation.args.at(-1), /derive contextWorkstream using only evidenceContext/);
  assert.match(invocation.args.at(-1), /do not look at comparisonBaseline for this field/);
  assert.match(invocation.args.at(-1), /shared cwd alone does not preserve a stale workstream/);
  assert.equal(decided[0].proposedTitle, "Cloudflare费用｜止损验证");
  assert.equal(decided[0].progressChapter, "Cloudflare 费用止损");
});

test("keeps the rules snapshot when Codex fails or times out", async () => {
  const input = withRulesOrganization(snapshotFixture(), { codexAvailable: true });
  const failed = await organizeSnapshotWithCodex(input, {
    spawnImpl: fakeSpawn("not json"),
    timeoutMs: 100,
    mcpServerNames: [],
  });
  assert.equal(failed.organization.state, "error");
  assert.equal(failed.snapshot.worklines, input.worklines);

  const timedOut = await organizeSnapshotWithCodex(input, {
    spawnImpl: fakeSpawn({}, { neverClose: true }),
    timeoutMs: 5,
    mcpServerNames: [],
  });
  assert.equal(timedOut.organization.state, "error");
  assert.equal(timedOut.organization.diagnostic, "timeout");
  assert.equal(timedOut.snapshot.worklines, input.worklines);

  const authFailed = await organizeSnapshotWithCodex(input, {
    spawnImpl: fakeSpawn("", {
      exitCode: 1,
      stderrText: "401 Unauthorized: invalid_api_key",
    }),
    timeoutMs: 100,
    mcpServerNames: [],
  });
  assert.equal(authFailed.organization.state, "unavailable");
  assert.equal(authFailed.organization.codexAvailable, false);
  assert.equal(authFailed.organization.diagnostic, "authentication_failed");
});
