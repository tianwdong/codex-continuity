import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadTaskActionLedger,
  saveTaskActionLedger,
  TaskActionLedger,
} from "../src/task-action-ledger.mjs";

test("binds confirmation to one persisted proposal without storing task content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-action-ledger-"));
  const filePath = path.join(directory, "state", "thread.json");
  try {
    const ledger = new TaskActionLedger();
    assert.equal(ledger.propose({
      currentThreadId: "current-task",
      targetThreadId: "target-task",
      kind: "continue-task",
      sourceTurnId: "turn-1",
      now: "2026-08-19T00:00:00.000Z",
    }), true);
    assert.equal(ledger.confirm({
      currentThreadId: "current-task",
      kind: "create-branch",
      now: "2026-08-19T00:01:00.000Z",
    }), null);
    const confirmed = ledger.confirm({
      currentThreadId: "current-task",
      kind: "continue-task",
      now: "2026-08-19T00:01:00.000Z",
    });
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.targetThreadId, "target-task");
    await saveTaskActionLedger(filePath, ledger);

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /prompt|message|继续推进|用户原话/iu);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(filePath))).mode & 0o777, 0o700);
    assert.equal((await loadTaskActionLedger(filePath)).current("current-task").status, "confirmed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects stale proposals instead of treating a late reply as consent", () => {
  const ledger = new TaskActionLedger();
  ledger.propose({
    currentThreadId: "current-task",
    targetThreadId: "target-task",
    kind: "continue-task",
    sourceTurnId: "turn-1",
    now: "2026-08-17T00:00:00.000Z",
  });
  assert.equal(ledger.confirm({
    currentThreadId: "current-task",
    kind: "continue-task",
    now: "2026-08-19T00:00:01.000Z",
  }), null);
  assert.equal(ledger.current("current-task").status, "expired");
});

test("makes every structural step at-most-once across retries", () => {
  const ledger = new TaskActionLedger();
  ledger.start({
    currentThreadId: "current-task",
    targetThreadId: "target-task",
    kind: "continue-task",
    sourceTurnId: "turn-2",
    now: "2026-08-19T00:00:00.000Z",
  });

  assert.equal(ledger.beginStep("current-task", "send").state, "perform");
  assert.equal(ledger.beginStep("current-task", "send").state, "uncertain");
  assert.equal(ledger.completeStep({ currentThreadId: "current-task", step: "send" }), true);
  assert.equal(ledger.beginStep("current-task", "send").state, "done");

  assert.equal(ledger.beginStep("current-task", "navigate").state, "perform");
  assert.equal(ledger.completeStep({ currentThreadId: "current-task", step: "navigate" }), true);
  assert.equal(ledger.beginStep("current-task", "archive").state, "perform");
  assert.equal(ledger.completeStep({ currentThreadId: "current-task", step: "archive" }), true);
  assert.equal(ledger.finish("current-task"), true);
  assert.equal(ledger.beginStep("current-task", "archive").state, "done");
});

test("records a created child before delivery and does not recreate it on retry", () => {
  const ledger = new TaskActionLedger();
  ledger.start({
    currentThreadId: "parent-task",
    kind: "create-branch",
    sourceTurnId: "turn-3",
    now: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(ledger.beginStep("parent-task", "create").state, "perform");
  assert.equal(ledger.completeStep({
    currentThreadId: "parent-task",
    step: "create",
    targetThreadId: "child-task",
  }), true);
  assert.equal(ledger.beginStep("parent-task", "create").state, "done");
  assert.equal(ledger.current("parent-task").targetThreadId, "child-task");
});

test("rejects a malformed receipt that omits a required target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-action-corrupt-"));
  const filePath = path.join(directory, "action.json");
  try {
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1,
      action: {
        currentThreadId: "current-task",
        targetThreadId: "",
        kind: "continue-task",
        sourceTurnId: "turn-1",
        status: "proposed",
      },
    }));
    await assert.rejects(loadTaskActionLedger(filePath), /task_action_ledger_corrupt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the action command persists and returns machine-readable step decisions", async () => {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "continuity-action-command-"));
  const command = fileURLToPath(new URL("../src/task-action-command.mjs", import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [command, ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_CONTINUITY_DATA: dataDirectory },
  }));
  try {
    assert.equal(run("propose", "--current", "current-task", "--target", "target-task", "--kind", "continue-task", "--source-turn", "turn-1").ok, true);
    assert.equal(run("confirm", "--current", "current-task", "--kind", "continue-task").action.status, "confirmed");
    assert.equal(run("begin-step", "--current", "current-task", "--step", "send").decision, "perform");
    assert.equal(run("begin-step", "--current", "current-task", "--step", "send").decision, "uncertain");
    assert.equal(run("complete-step", "--current", "current-task", "--step", "send").ok, true);
    assert.equal(run("begin-step", "--current", "current-task", "--step", "send").decision, "done");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
