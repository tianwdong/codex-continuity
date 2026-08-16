import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AttentionLedger,
  loadAttentionLedger,
  saveAttentionLedger,
} from "../src/attention-ledger.mjs";

function completedDetail(threadId, turnId = "turn-1") {
  return {
    thread: {
      id: threadId,
      turns: [{
        id: turnId,
        status: "completed",
        completedAt: 100,
        items: [{
          id: `message-${turnId}`,
          type: "agentMessage",
          phase: "final_answer",
          text: `Result for ${turnId}`,
        }],
      }],
    },
  };
}

test("builds a quiet first-run baseline and records only later completed turns", () => {
  const ledger = new AttentionLedger();
  const initial = { id: "thread-1", recencyAt: 10 };

  assert.deepEqual(ledger.scan([initial]), []);
  assert.deepEqual(ledger.pendingThreadIds(), []);

  const changed = { ...initial, recencyAt: 20 };
  assert.deepEqual(ledger.scan([changed]), ["thread-1"]);
  assert.equal(ledger.record(changed, completedDetail("thread-1")), true);
  assert.deepEqual(ledger.pendingThreadIds(), ["thread-1"]);

  assert.equal(ledger.markHandled("thread-1"), true);
  assert.deepEqual(ledger.pendingThreadIds(), []);
  assert.equal(ledger.record(changed, completedDetail("thread-1"), { forcePending: true }), false);
  assert.deepEqual(ledger.pendingThreadIds(), []);
});

test("clears an old result when a new turn starts and waits for its final answer", () => {
  const ledger = new AttentionLedger();
  const initial = { id: "thread-1", recencyAt: 10 };
  ledger.scan([initial]);
  const completed = { ...initial, recencyAt: 20 };
  ledger.record(completed, completedDetail("thread-1", "turn-1"));

  const running = { ...initial, recencyAt: 30 };
  assert.deepEqual(ledger.scan([running]), ["thread-1"]);
  ledger.record(running, {
    thread: {
      id: "thread-1",
      turns: [{ id: "turn-2", status: "inProgress", items: [] }],
    },
  });
  assert.deepEqual(ledger.pendingThreadIds(), []);

  const finished = { ...initial, recencyAt: 40 };
  assert.deepEqual(ledger.scan([finished]), ["thread-1"]);
  ledger.record(finished, completedDetail("thread-1", "turn-2"));
  assert.deepEqual(ledger.pendingThreadIds(), ["thread-1"]);
});

test("retries a completed turn until its final answer is readable", () => {
  const ledger = new AttentionLedger();
  const initial = { id: "thread-1", recencyAt: 10 };
  ledger.scan([initial]);
  const changed = { ...initial, recencyAt: 20 };
  ledger.record(changed, {
    thread: {
      id: "thread-1",
      turns: [{ id: "turn-1", status: "completed", items: [] }],
    },
  });

  assert.deepEqual(ledger.pendingThreadIds(), []);
  assert.deepEqual(ledger.scan([changed]), ["thread-1"]);
  ledger.record(changed, completedDetail("thread-1"));
  assert.deepEqual(ledger.pendingThreadIds(), ["thread-1"]);
});

test("persists pending turn ids without storing conversation text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-attention-"));
  const filePath = path.join(directory, "attention-state.json");
  try {
    const ledger = new AttentionLedger();
    const thread = { id: "thread-1", recencyAt: 10 };
    ledger.scan([thread]);
    ledger.record({ ...thread, recencyAt: 20 }, completedDetail("thread-1"));
    await saveAttentionLedger(filePath, ledger);

    const restored = await loadAttentionLedger(filePath);
    assert.deepEqual(restored.pendingThreadIds(), ["thread-1"]);
    assert.deepEqual(
      restored.scan([{ ...thread, recencyAt: 20 }], { loadedThreadIds: [] }),
      ["thread-1"],
    );
    assert.doesNotMatch(JSON.stringify(restored.toJSON()), /Result for turn-1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emits each completed turn once without treating notification as task ownership", () => {
  const ledger = new AttentionLedger();
  const initial = { id: "thread-1", recencyAt: 10 };
  ledger.scan([initial]);
  const changed = { ...initial, recencyAt: 20 };
  ledger.record(changed, completedDetail("thread-1", "turn-1"));

  assert.equal(ledger.shouldNotify("thread-1", "turn-1"), true);
  assert.equal(ledger.markNotified("thread-1", "turn-1"), true);
  assert.equal(ledger.shouldNotify("thread-1", "turn-1"), false);
  assert.deepEqual(ledger.pendingThreadIds(), ["thread-1"]);

  ledger.record({ ...initial, recencyAt: 30 }, completedDetail("thread-1", "turn-2"));
  assert.equal(ledger.shouldNotify("thread-1", "turn-2"), true);
});
