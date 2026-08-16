import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTitleLedger, saveTitleLedger, TitleLedger } from "../src/title-ledger.mjs";

test("uses the native title as baseline without treating external drift as a permanent lock", () => {
  const ledger = new TitleLedger();
  const thread = { id: "thread-1", name: "Codex 首次标题" };
  assert.equal(ledger.observe(thread), true);
  assert.equal(ledger.shouldEvaluate(thread, "turn-1"), true);
  ledger.recordEvaluated(thread, "turn-1");
  assert.equal(ledger.shouldEvaluate(thread, "turn-1"), false);

  ledger.observe({ ...thread, name: "用户手动标题" });
  assert.equal(ledger.status("thread-1").locked, false);
  assert.equal(ledger.shouldEvaluate({ ...thread, name: "用户手动标题" }, "turn-2"), true);
});

test("does not lock when an applied title temporarily bounces through another native value", () => {
  const ledger = new TitleLedger();
  ledger.observe({ id: "thread-1", name: "原生标题" });
  ledger.recordApplied({
    threadId: "thread-1",
    previousTitle: "原生标题",
    title: "当前工作章节",
    turnId: "turn-1",
    sourceMessageId: "message-1",
    confidence: "high",
  });

  ledger.observe({ id: "thread-1", name: "原生标题" });
  ledger.observe({ id: "thread-1", name: "当前工作章节" });

  assert.equal(ledger.status("thread-1").locked, false);
  assert.equal(ledger.shouldEvaluate({ id: "thread-1", name: "当前工作章节" }, "turn-2"), true);
});

test("only an explicit control can lock and resume automatic title maintenance", () => {
  const ledger = new TitleLedger();
  const thread = { id: "thread-1", name: "当前标题" };
  ledger.observe(thread);

  assert.equal(ledger.setLocked(thread, true), true);
  assert.equal(ledger.shouldEvaluate(thread, "turn-1"), false);
  assert.equal(ledger.setLocked(thread, false), true);
  assert.equal(ledger.shouldEvaluate(thread, "turn-1"), true);
});

test("migrates legacy ambiguous locks back to automatic maintenance", () => {
  const ledger = new TitleLedger({
    schemaVersion: 1,
    threads: {
      "thread-1": {
        observedTitle: "Codex Continuity 开源发布准备",
        evaluatedTurnId: "turn-1",
        locked: true,
      },
    },
  });

  const thread = { id: "thread-1", name: "Codex Continuity 开源发布准备" };
  assert.equal(ledger.status("thread-1").locked, false);
  assert.equal(ledger.shouldEvaluate(thread, "turn-2"), true);
});

test("persists only title-change metadata with private permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-"));
  const filePath = path.join(directory, "title-state.json");
  try {
    const ledger = new TitleLedger();
    ledger.observe({ id: "thread-1", name: "旧标题" });
    ledger.recordApplied({
      threadId: "thread-1",
      previousTitle: "旧标题",
      title: "新标题",
      turnId: "turn-1",
      sourceMessageId: "message-1",
      confidence: "high",
    });
    await saveTitleLedger(filePath, ledger);
    const restored = await loadTitleLedger(filePath);
    assert.equal(restored.undoCandidate("thread-1").previousTitle, "旧标题");
    assert.equal(restored.latestUndoCandidate().title, "新标题");
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(filePath, "utf8"), /完整回复|assistantMessage|userMessage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("distinguishes a missing title ledger from a corrupt one without replacing it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-corrupt-"));
  const missingPath = path.join(directory, "missing.json");
  const corruptPath = path.join(directory, "corrupt.json");
  const corruptContents = '{"schemaVersion":2,"threads":';
  try {
    assert.equal((await loadTitleLedger(missingPath)).status("thread-1").locked, false);
    await writeFile(corruptPath, corruptContents, "utf8");
    await assert.rejects(
      loadTitleLedger(corruptPath),
      (error) => error?.code === "TITLE_LEDGER_CORRUPT",
    );
    assert.equal(await readFile(corruptPath, "utf8"), corruptContents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
