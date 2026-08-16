import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractReturnPointFromFinalAnswer,
  isCodexSessionPath,
  readLatestFinalAnswer,
} from "../src/return-point.mjs";

test("extracts a traceable explicit next action without summarizing it away", () => {
  const result = extractReturnPointFromFinalAnswer(
    "审计和进度已更新：修复审计、ROADMAP.md。\n\n下一步只能单独批准一次 `production trigger` 复验；自动触发目前仍关闭。",
    { sealedAt: "2026-08-12T10:00:00.000Z", sourceMessageId: "message-1" },
  );

  assert.equal(result.checkpoint, "审计和进度已更新：修复审计、ROADMAP.md。");
  assert.equal(result.nextAction, "只能单独批准一次 production trigger 复验；自动触发目前仍关闭。");
  assert.equal(result.confidence, "explicit");
  assert.equal(result.sourceMessageId, "message-1");
});

test("marks an unlabeled future action as a candidate", () => {
  const result = extractReturnPointFromFinalAnswer(
    "已完成候选构建和本地验证。\n\n你现在不用立即配合测试。等进行最终验收时，再用 v5 完成真实账号复验。",
  );

  assert.equal(result.confidence, "candidate");
  assert.match(result.nextAction, /最终验收/);
});

test("keeps the instruction that follows a candidate action label", () => {
  const result = extractReturnPointFromFinalAnswer(
    "当前有两个不同方向。\n\n需要你明确回复一句：\n\n> 继续验证当前候选版。",
  );

  assert.equal(result.confidence, "candidate");
  assert.equal(result.nextAction, "需要你明确回复一句： 继续验证当前候选版。");
});

test("does not promote an explanatory priority heading and keeps the conclusion at the tail", () => {
  const result = extractReturnPointFromFinalAnswer(
    `这次我理解了。你要的不是“按官方静态指定子代理”，而是：

> 主代理和子代理都从当前测试结果中动态选择。

第一优先级是“支配性升级”：

${"这里是中间的解释。".repeat(500)}

正确改法是在现有测试结果上增加“当前子代理配置”这个比较基线，分别生成主代理和子代理的动态切换建议。`,
    { userMessage: "当前子代理出现更便宜且得分更高的配置时，应当切换过去。" },
  );

  assert.equal(result.confidence, "unknown");
  assert.equal(result.nextAction, "");
  assert.equal(result.userMessage, "当前子代理出现更便宜且得分更高的配置时，应当切换过去。");
  assert.match(result.assistantMessage, /当前子代理配置/);
  assert.doesNotMatch(result.checkpoint, /：$/);
});

test("reads the latest final answer from the tail of a JSONL session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-return-point-"));
  const sessionPath = path.join(directory, "session.jsonl");
  const records = [
    { timestamp: "2026-08-12T09:00:00.000Z", type: "response_item", payload: { type: "message", id: "old", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "old" }] } },
    { timestamp: "2026-08-12T09:30:00.000Z", type: "response_item", payload: { type: "function_call_output", output: "x".repeat(300_000) } },
    { timestamp: "2026-08-12T09:59:00.000Z", type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: '<in-app-browser-context source="ambient-ui-state">ignore this</in-app-browser-context>\n\nContinue the real task' }] } },
    { timestamp: "2026-08-12T10:00:00.000Z", type: "response_item", payload: { type: "message", id: "latest", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "latest answer" }] } },
    { timestamp: "2026-08-12T10:01:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "still working" }] } },
  ];
  await writeFile(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    const result = await readLatestFinalAnswer(sessionPath);
    assert.equal(result.text, "latest answer");
    assert.equal(result.userMessage, "Continue the real task");
    assert.equal(result.sourceMessageId, "latest");
    assert.equal(result.sealedAt, "2026-08-12T10:00:00.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts only Codex-owned session paths", () => {
  assert.equal(isCodexSessionPath("/tmp/home/.codex/sessions/2026/thread.jsonl", "/tmp/home"), true);
  assert.equal(isCodexSessionPath("/tmp/home/.codex/archived_sessions/thread.jsonl", "/tmp/home"), true);
  assert.equal(isCodexSessionPath("/tmp/home/project/thread.jsonl", "/tmp/home"), false);
  assert.equal(isCodexSessionPath("/tmp/home/.codex/sessions/../config.toml", "/tmp/home"), false);
});
