import assert from "node:assert/strict";
import test from "node:test";

import { buildAttentionItems, buildContinuityViewModel } from "../src/continuity-data.mjs";

test("groups only deterministic session relationships and preserves unknown state", () => {
  const threads = [
    {
      id: "root",
      sessionId: "root",
      name: "Root task",
      cwd: "/work/project-one",
      source: "vscode",
      recencyAt: 900,
      status: { type: "notLoaded" },
    },
    {
      id: "child",
      sessionId: "child",
      name: "Child task",
      cwd: "/work/project-one",
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: "root",
            agent_nickname: "Curie",
            agent_role: "luna_worker",
          },
        },
      },
      recencyAt: 950,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    },
    {
      id: "separate",
      sessionId: "separate",
      name: "Separate task",
      cwd: "/work/project-two",
      source: "vscode",
      recencyAt: 940,
      status: { type: "notLoaded" },
    },
  ];
  const detailsById = new Map([
    ["root", {
      thread: {
        turns: [{
          status: "completed",
          items: [
            {
              type: "userMessage",
              content: [{
                type: "text",
                text: '<in-app-browser-context source="ambient-ui-state">not user intent</in-app-browser-context>\n\nContinue the real task',
              }],
            },
            { type: "agentMessage", phase: "final_answer", text: "Verified checkpoint from the original thread." },
          ],
        }],
      },
    }],
  ]);
  const goalsById = new Map([
    ["root", { goal: { objective: "Finish the verified next step", status: "active" } }],
  ]);

  const result = buildContinuityViewModel(threads, {
    focusThreadId: "root",
    detailsById,
    goalsById,
    nowMs: 1_000_000,
  });

  assert.equal(result.source, "app-server");
  assert.equal(result.worklines.length, 2);
  assert.equal(result.worklines[0].threadId, "root");
  assert.equal(result.worklines[0].taskCount, 2);
  assert.equal(result.worklines[0].status, "attention");
  assert.equal(result.worklines[0].detailState, "ready");
  assert.match(result.worklines[0].checkpoint, /Verified checkpoint/);
  assert.equal(result.worklines[0].userMessage, "Continue the real task");
  assert.equal(result.worklines[0].nextAction, "Finish the verified next step");
  assert.equal(result.worklines[1].status, "unknown");
  assert.equal(result.worklines[1].detailState, "unloaded");
  assert.equal(result.rawTasks.length, 2);
  assert.equal(result.agentThreadCount, 1);
  assert.equal(result.projectReturnPoints.length, 2);
  assert.equal(result.projectReturnPoints[0].worklineId, "root");
});

test("exposes one reliable return point per project", () => {
  const threads = [
    {
      id: "newer",
      sessionId: "newer",
      name: "Recent investigation",
      cwd: "/work/product",
      source: "vscode",
      recencyAt: 1_000,
      status: { type: "notLoaded" },
    },
    {
      id: "goal-thread",
      sessionId: "goal-thread",
      name: "Release verification",
      cwd: "/work/product",
      source: "vscode",
      recencyAt: 900,
      status: { type: "notLoaded" },
    },
  ];
  const returnPointsById = new Map([
    ["newer", {
      checkpoint: "Audit and roadmap are updated.",
      nextAction: "Approve one production trigger verification.",
      confidence: "explicit",
      assistantMessage: "Verified source response.",
      sealedAt: "1970-01-01T00:16:40.000Z",
      sourceMessageId: "message-1",
    }],
  ]);
  const goalsById = new Map([
    ["goal-thread", { goal: { objective: "Finish the active release goal", status: "active" } }],
  ]);

  const result = buildContinuityViewModel(threads, {
    returnPointsById,
    goalsById,
    nowMs: 1_100_000,
  });

  assert.equal(result.projectReturnPoints.length, 1);
  assert.equal(result.projectReturnPoints[0].threadId, "goal-thread");
  assert.equal(result.projectReturnPoints[0].nextAction, "Finish the active release goal");
  assert.equal(result.worklines.find((item) => item.id === "newer").nextAction, "Approve one production trigger verification.");
  assert.equal(result.worklines.find((item) => item.id === "newer").sourceMessageId, "message-1");
});

test("attention requires an explicit pending id and a final reply on the latest completed turn", () => {
  const threads = [
    {
      id: "ready",
      sessionId: "ready",
      name: "Stale native title",
      cwd: "/work/modeldial",
      recencyAt: 100,
      status: { type: "notLoaded" },
    },
    {
      id: "interrupted",
      sessionId: "interrupted",
      name: "Interrupted task",
      cwd: "/work/modeldial",
      recencyAt: 200,
      status: { type: "notLoaded" },
    },
    {
      id: "not-unread",
      sessionId: "not-unread",
      name: "Already seen",
      cwd: "/work/other",
      recencyAt: 300,
      status: { type: "notLoaded" },
    },
  ];
  const completedTurn = {
    id: "turn-ready",
    status: "completed",
    completedAt: 990,
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Check the bill" }] },
      {
        id: "final-ready",
        type: "agentMessage",
        phase: "final_answer",
        text: "The Cloudflare bill stopped growing and no containers are running.",
      },
    ],
  };
  const detailsById = new Map([
    ["ready", { thread: { turns: [completedTurn] } }],
    ["interrupted", {
      thread: {
        turns: [
          completedTurn,
          {
            id: "turn-interrupted",
            status: "interrupted",
            completedAt: 1_000,
            items: [{ type: "agentMessage", phase: "commentary", text: "Still checking" }],
          },
        ],
      },
    }],
    ["not-unread", { thread: { turns: [{ ...completedTurn, id: "turn-seen" }] } }],
  ]);

  const result = buildAttentionItems(threads, {
    attentionThreadIds: ["local:interrupted", "local:ready", "ready"],
    detailsById,
    nowMs: 1_010_000,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].threadId, "ready");
  assert.equal(result[0].nativeTitle, "Stale native title");
  assert.equal(result[0].chapter, "");
  assert.match(result[0].excerpt, /bill stopped growing/);
  assert.equal(result[0].turnId, "turn-ready");
  assert.equal(result[0].sourceMessageId, "final-ready");
});
