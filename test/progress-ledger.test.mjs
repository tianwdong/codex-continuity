import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadProgressLedger,
  ProgressLedger,
  saveProgressLedger,
} from "../src/progress-ledger.mjs";

test("records one semantic progress result per completed turn", () => {
  const ledger = new ProgressLedger();
  assert.equal(ledger.shouldEvaluate("thread-1", "turn-1"), true);
  assert.equal(ledger.recordProgress({
    threadId: "thread-1",
    turnId: "turn-1",
    sourceMessageId: "message-1",
    nativeTitle: "Codex 管理面板",
    chapter: "开源发布准备",
    progress: "README、安装方式和许可证检查已完成",
    confidence: "high",
  }), true);
  assert.equal(ledger.shouldEvaluate("thread-1", "turn-1"), false);
  assert.equal(ledger.current("thread-1").progress, "README、安装方式和许可证检查已完成");
  assert.equal(ledger.current("another-thread"), null);
  assert.equal(ledger.recordProgress({
    threadId: "thread-1",
    turnId: "turn-1",
    nativeTitle: "Codex 管理面板",
    chapter: "重复结果",
    progress: "不应覆盖同一 Turn",
    confidence: "high",
  }), false);
});

test("a semantic keep consumes the turn without erasing prior progress", () => {
  const ledger = new ProgressLedger();
  ledger.recordProgress({
    threadId: "thread-1",
    turnId: "turn-1",
    sourceMessageId: "message-1",
    nativeTitle: "Codex 管理面板",
    chapter: "开源发布准备",
    progress: "README 检查已完成",
    confidence: "medium",
  });
  assert.equal(ledger.recordEvaluated({
    threadId: "thread-1",
    turnId: "turn-2",
    nativeTitle: "Codex 管理面板",
  }), true);
  assert.equal(ledger.shouldEvaluate("thread-1", "turn-2"), false);
  assert.equal(ledger.current("thread-1").sourceTurnId, "turn-1");
  assert.equal(ledger.current("thread-1").progress, "README 检查已完成");
});

test("persists only bounded progress metadata with private permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-progress-"));
  const filePath = path.join(directory, "progress-state.json");
  try {
    const ledger = new ProgressLedger();
    ledger.recordProgress({
      threadId: "thread-1",
      turnId: "turn-1",
      sourceMessageId: "message-1",
      nativeTitle: "Codex 管理面板",
      chapter: "开源发布准备",
      progress: "README、安装方式和许可证检查已完成",
      confidence: "high",
    });
    await saveProgressLedger(filePath, ledger);
    const restored = await loadProgressLedger(filePath);
    assert.equal(restored.current("thread-1").chapter, "开源发布准备");
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /assistantMessage|userMessage|完整会话/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("distinguishes a missing progress ledger from a corrupt one without replacing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-progress-corrupt-"));
  const missingPath = path.join(directory, "missing.json");
  const corruptPath = path.join(directory, "corrupt.json");
  const corruptContents = '{"schemaVersion":1';
  try {
    assert.equal((await loadProgressLedger(missingPath)).current("thread-1"), null);
    await writeFile(corruptPath, corruptContents, "utf8");
    await assert.rejects(
      loadProgressLedger(corruptPath),
      (error) => error?.code === "PROGRESS_LEDGER_CORRUPT",
    );
    assert.equal(await readFile(corruptPath, "utf8"), corruptContents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
