import assert from "node:assert/strict";
import test from "node:test";

import {
  ECONOMY_QUALITY_FLOOR_RATIO,
  ECONOMY_SCORE_TIE_POINTS,
  TASK_CLASS_MODELS,
  parseArgs,
  selectDispatchProfile,
} from "../skills/continuity-subagent-dispatch/scripts/select-profile.mjs";

function ranking({
  rank,
  model,
  effort,
  score,
  cost,
  elapsed,
  route = "official_login",
  provider = "codex",
}) {
  return {
    rank,
    id: `${provider}:${model}:${effort}`,
    provider,
    model,
    displayName: `${model} / ${effort}`,
    reasoningEffort: effort,
    route,
    score,
    maxScore: 100,
    elapsedMs: elapsed,
    estimatedReferenceCostUsd: cost,
  };
}

function snapshot(rankings) {
  return {
    schemaVersion: "1.0",
    generatedAt: "2026-08-16T12:00:00Z",
    source: { name: "ModelDial Public Radar" },
    batch: {
      id: "snapshot-test",
      publishedAt: "2026-08-16T12:00:00Z",
    },
    rankings,
  };
}

const solMax = ranking({
  rank: 1,
  model: "gpt-5.6-sol",
  effort: "max",
  score: 85,
  cost: 2.49,
  elapsed: 1_930_000,
});

test("focused economy work keeps the quality anchor and selects the best eligible Luna effort", () => {
  const result = selectDispatchProfile(snapshot([
    solMax,
    ranking({ rank: 2, model: "gpt-5.6-luna", effort: "max", score: 72, cost: 0.178, elapsed: 2_650_000 }),
    ranking({ rank: 3, model: "gpt-5.6-luna", effort: "xhigh", score: 66, cost: 0.114, elapsed: 1_710_000 }),
  ]));

  assert.equal(result.mode, "economy");
  assert.equal(result.taskClass, "focused");
  assert.equal(result.mainAgent.model, "gpt-5.6-sol");
  assert.equal(result.mainAgent.reasoningEffort, "max");
  assert.equal(result.workerAgent.model, "gpt-5.6-luna");
  assert.equal(result.workerAgent.reasoningEffort, "max");
  assert.equal(result.selection.preferredModel, TASK_CLASS_MODELS.focused);
  assert.equal(result.evidenceBoundary.recommendationMode, "advisory_only");
  assert.equal(result.evidenceBoundary.pairedAgentBenchmark, false);
});

test("exploration economy work stays inside Terra and uses the one-point cost tiebreak", () => {
  const result = selectDispatchProfile(snapshot([
    solMax,
    ranking({ rank: 2, model: "gpt-5.6-luna", effort: "max", score: 80, cost: 0.05, elapsed: 800_000 }),
    ranking({ rank: 3, model: "gpt-5.6-terra", effort: "high", score: 72, cost: 0.19, elapsed: 1_200_000 }),
    ranking({ rank: 4, model: "gpt-5.6-terra", effort: "xhigh", score: 71, cost: 0.11, elapsed: 900_000 }),
  ]), { taskClass: "exploration" });

  assert.equal(result.taskClass, "exploration");
  assert.equal(result.workerAgent.model, "gpt-5.6-terra");
  assert.equal(result.workerAgent.reasoningEffort, "xhigh");
  assert.equal(result.selection.preferredModel, TASK_CLASS_MODELS.exploration);
});

test("demanding economy work stays inside Sol and prefers the cheaper effort within one point", () => {
  assert.equal(ECONOMY_SCORE_TIE_POINTS, 1);
  const result = selectDispatchProfile(snapshot([
    solMax,
    ranking({ rank: 2, model: "gpt-5.6-sol", effort: "xhigh", score: 84, cost: 1.25, elapsed: 1_300_000 }),
    ranking({ rank: 3, model: "gpt-5.6-terra", effort: "max", score: 84, cost: 0.3, elapsed: 900_000 }),
  ]), { taskClass: "demanding" });

  assert.equal(result.taskClass, "demanding");
  assert.equal(result.workerAgent.model, "gpt-5.6-sol");
  assert.equal(result.workerAgent.reasoningEffort, "xhigh");
  assert.equal(result.selection.preferredModel, TASK_CLASS_MODELS.demanding);
});

test("quality selects the highest-scoring eligible configuration for both roles", () => {
  const result = selectDispatchProfile(snapshot([
    solMax,
    ranking({ rank: 2, model: "gpt-5.6-luna", effort: "max", score: 72, cost: 0.178, elapsed: 2_650_000 }),
  ]), { mode: "quality", taskClass: "exploration" });

  assert.equal(result.taskClass, "exploration");
  assert.equal(result.mainAgent.id, solMax.id);
  assert.equal(result.workerAgent.id, solMax.id);
  assert.equal(result.selection.workerAgent, "highest_score");
  assert.equal(result.selection.preferredModel, null);
});

test("economy fails closed instead of leaving the preferred task family", () => {
  assert.equal(ECONOMY_QUALITY_FLOOR_RATIO, 0.8);
  assert.throws(() => selectDispatchProfile(snapshot([
    ranking({ rank: 1, model: "gpt-5.6-sol", effort: "max", score: 100, cost: 2.49, elapsed: 1_930_000 }),
    ranking({ rank: 2, model: "gpt-5.6-terra", effort: "max", score: 79, cost: 0.3, elapsed: 1_200_000 }),
    ranking({ rank: 3, model: "gpt-5.6-luna", effort: "max", score: 95, cost: 0.1, elapsed: 800_000 }),
  ]), { taskClass: "exploration" }), /quality floor/);
});

test("selector ignores incomplete routes and validates CLI modes and task classes", () => {
  const result = selectDispatchProfile(snapshot([
    solMax,
    ranking({ rank: 2, model: "gpt-5.6-luna", effort: "max", score: 72, cost: 0.178, elapsed: 2_650_000 }),
    ranking({ rank: 3, model: "gpt-5.6-luna", effort: "xhigh", score: 99, cost: 0.01, elapsed: 10, route: "custom_endpoint" }),
    { ...ranking({ rank: 4, model: "gpt-5.6-luna", effort: "high", score: 98, cost: 0.01, elapsed: 10 }), estimatedReferenceCostUsd: null },
  ]));

  assert.equal(result.workerAgent.reasoningEffort, "max");
  assert.deepEqual(parseArgs([]), { mode: "economy", taskClass: "focused", input: null });
  assert.deepEqual(parseArgs([
    "--mode", "quality",
    "--task-class", "demanding",
    "--input", "/tmp/snapshot.json",
  ]), {
    mode: "quality",
    taskClass: "demanding",
    input: "/tmp/snapshot.json",
  });
  assert.throws(() => parseArgs(["--mode", "fast"]), /Unsupported mode/);
  assert.throws(() => parseArgs(["--task-class", "generic"]), /Unsupported task class/);
});
