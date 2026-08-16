import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyTitleDecision,
  buildNotificationEvent,
  undoTitleChange,
} from "../src/sidecar.mjs";
import { TitleLedger } from "../src/title-ledger.mjs";

test("builds a bounded official-Codex notification event without task resume", async () => {
  const event = buildNotificationEvent({
    threadId: "thread/with space",
    turnId: "turn-1",
    project: "ModelDial",
    nativeTitle: "接入 Google Analytics",
    chapter: "Cloudflare 费用止损已验证",
    chapterEvidence: "累计账单仍为 $0.94。",
  });

  assert.equal(event.type, "attention");
  assert.equal(event.chapter, "Cloudflare 费用止损已验证");
  assert.equal(event.excerpt, "累计账单仍为 $0.94。");
  assert.equal(event.deepLink, "codex://threads/thread%2Fwith%20space");

  const source = await readFile(new URL("../src/sidecar.mjs", import.meta.url), "utf8");
  const titleMaintainer = await readFile(new URL("../src/title-maintainer.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /thread\/resume|resumeOrConfirmThread|remote-debugging-pipe/);
  assert.match(source, /decideTitlesWithCodex/);
  assert.match(titleMaintainer, /setThreadName/);
  assert.match(source, /attention_snapshot/);
});

test("undo rejects the same title suggestion without disabling later chapters", async () => {
  let title = "接入 Google Analytics";
  const appServer = {
    async readThread(threadId) { return { thread: { id: threadId, name: title } }; },
    async setThreadName(_threadId, value) { title = value; },
  };
  const titleLedger = new TitleLedger();
  titleLedger.observe({ id: "thread-1", name: title });
  const item = {
    threadId: "thread-1",
    turnId: "turn-1",
    sourceMessageId: "message-1",
    nativeTitle: title,
    titleDecision: "replace_workstream",
    proposedTitle: "Cloudflare费用｜止损验证",
    titleConfidence: "high",
  };

  const updated = await applyTitleDecision(item, { appServer, titleLedger });
  assert.equal(title, "Cloudflare费用｜止损验证");
  assert.equal(updated.change.type, "title_changed");
  assert.deepEqual(titleLedger.undoCandidate("thread-1"), {
    threadId: "thread-1",
    title: "Cloudflare费用｜止损验证",
    previousTitle: "接入 Google Analytics",
  });

  const undone = await undoTitleChange("thread-1", { appServer, titleLedger });
  assert.equal(undone.type, "title_undone");
  assert.equal(title, "接入 Google Analytics");

  const repeated = await applyTitleDecision({
    ...item,
    turnId: "turn-2",
    nativeTitle: title,
  }, { appServer, titleLedger });
  assert.equal(repeated.change, null);
  assert.equal(title, "接入 Google Analytics");

  const laterChapter = await applyTitleDecision({
    ...item,
    turnId: "turn-3",
    nativeTitle: title,
    proposedTitle: "自动标题｜刷新机制",
  }, { appServer, titleLedger });
  assert.equal(laterChapter.change.type, "title_changed");
  assert.equal(title, "自动标题｜刷新机制");
});

test("fails closed when the native title changes before the write", async () => {
  const titleLedger = new TitleLedger();
  titleLedger.observe({ id: "thread-1", name: "原生标题" });
  let setCalls = 0;
  const appServer = {
    async readThread() { return { thread: { id: "thread-1", name: "用户手动标题" } }; },
    async setThreadName() { setCalls += 1; },
  };
  const result = await applyTitleDecision({
    threadId: "thread-1",
    turnId: "turn-1",
    nativeTitle: "原生标题",
    titleDecision: "replace_workstream",
    proposedTitle: "模型建议｜新章节",
    titleConfidence: "high",
  }, { appServer, titleLedger });
  assert.equal(result.change, null);
  assert.equal(setCalls, 0);
  assert.equal(titleLedger.shouldEvaluate({ id: "thread-1", name: "用户手动标题" }, "turn-2"), true);
});

test("rejects notification events without a stable task and turn coordinate", () => {
  assert.equal(buildNotificationEvent({ threadId: "thread-1" }), null);
  assert.equal(buildNotificationEvent({ turnId: "turn-1" }), null);
});

test("exits quietly when the native parent closes the event pipe", async () => {
  const source = await readFile(new URL("../src/sidecar.mjs", import.meta.url), "utf8");
  assert.match(source, /error\?\.code === "EPIPE"/);
});
