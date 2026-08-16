#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MODELDIAL_LATEST_URL = "https://modeldial.com/api/v1/radar/latest.json";
export const ECONOMY_QUALITY_FLOOR_RATIO = 0.8;
export const ECONOMY_SCORE_TIE_POINTS = 1;
export const TASK_CLASS_MODELS = Object.freeze({
  focused: "gpt-5.6-luna",
  exploration: "gpt-5.6-terra",
  demanding: "gpt-5.6-sol",
});

const SUPPORTED_MODES = new Set(["economy", "quality"]);
const SUPPORTED_TASK_CLASSES = new Set(Object.keys(TASK_CLASS_MODELS));
const REQUIRED_ROUTE = "official_login";
const REQUIRED_PROVIDER = "codex";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeCandidate(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.provider !== REQUIRED_PROVIDER || entry.route !== REQUIRED_ROUTE) return null;
  if (typeof entry.id !== "string" || typeof entry.model !== "string") return null;
  if (typeof entry.reasoningEffort !== "string" || typeof entry.displayName !== "string") return null;
  if (!isFiniteNumber(entry.score) || !isFiniteNumber(entry.maxScore) || entry.maxScore <= 0) return null;
  if (!isFiniteNumber(entry.elapsedMs) || entry.elapsedMs < 0) return null;
  if (!isFiniteNumber(entry.estimatedReferenceCostUsd) || entry.estimatedReferenceCostUsd < 0) return null;

  return {
    id: entry.id,
    provider: entry.provider,
    model: entry.model,
    displayName: entry.displayName,
    reasoningEffort: entry.reasoningEffort,
    route: entry.route,
    score: entry.score,
    maxScore: entry.maxScore,
    elapsedMs: entry.elapsedMs,
    estimatedReferenceCostUsd: entry.estimatedReferenceCostUsd,
    rank: isFiniteNumber(entry.rank) ? entry.rank : Number.MAX_SAFE_INTEGER,
  };
}

function compareQuality(a, b) {
  return (
    b.score - a.score
    || a.elapsedMs - b.elapsedMs
    || a.estimatedReferenceCostUsd - b.estimatedReferenceCostUsd
    || a.rank - b.rank
    || a.id.localeCompare(b.id)
  );
}

function compareEconomyWorkers(a, b) {
  const scoreDifference = Math.abs(a.score - b.score);
  if (scoreDifference > ECONOMY_SCORE_TIE_POINTS) return b.score - a.score;
  return (
    a.estimatedReferenceCostUsd - b.estimatedReferenceCostUsd
    || a.elapsedMs - b.elapsedMs
    || b.score - a.score
    || a.rank - b.rank
    || a.id.localeCompare(b.id)
  );
}

function publicCandidate(candidate) {
  return {
    id: candidate.id,
    provider: candidate.provider,
    model: candidate.model,
    displayName: candidate.displayName,
    reasoningEffort: candidate.reasoningEffort,
    route: candidate.route,
    score: candidate.score,
    maxScore: candidate.maxScore,
    elapsedMs: candidate.elapsedMs,
    estimatedReferenceCostUsd: candidate.estimatedReferenceCostUsd,
  };
}

export function selectDispatchProfile(snapshot, { mode = "economy", taskClass = "focused" } = {}) {
  if (!SUPPORTED_MODES.has(mode)) throw new Error(`Unsupported mode: ${mode}`);
  if (!SUPPORTED_TASK_CLASSES.has(taskClass)) throw new Error(`Unsupported task class: ${taskClass}`);
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.rankings)) {
    throw new Error("Invalid ModelDial snapshot");
  }
  if (typeof snapshot.batch?.id !== "string" || typeof snapshot.batch?.publishedAt !== "string") {
    throw new Error("ModelDial snapshot is missing batch identity");
  }

  const candidates = snapshot.rankings.map(normalizeCandidate).filter(Boolean);
  if (candidates.length === 0) throw new Error("No eligible Codex configurations");

  const mainAgent = [...candidates].sort(compareQuality)[0];
  let workerAgent;
  let workerRule;

  if (mode === "quality") {
    workerAgent = mainAgent;
    workerRule = "highest_score";
  } else {
    const preferredModel = TASK_CLASS_MODELS[taskClass];
    const qualityFloor = mainAgent.score * ECONOMY_QUALITY_FLOOR_RATIO;
    const economyCandidates = candidates.filter((candidate) => (
      candidate.model === preferredModel && candidate.score >= qualityFloor
    ));
    if (economyCandidates.length === 0) {
      throw new Error(`No ${taskClass} worker in ${preferredModel} meets the economy quality floor`);
    }
    workerAgent = [...economyCandidates].sort(compareEconomyWorkers)[0];
    workerRule = "best_eligible_task_family_with_cost_tiebreak";
  }

  return {
    schemaVersion: "1.0",
    generatedAt: snapshot.generatedAt,
    source: {
      name: snapshot.source?.name ?? "ModelDial Public Radar",
      url: MODELDIAL_LATEST_URL,
    },
    batch: {
      id: snapshot.batch.id,
      publishedAt: snapshot.batch.publishedAt,
    },
    evidenceBoundary: {
      configurationEvidence: "same_batch_independent_configurations",
      pairedAgentBenchmark: false,
      recommendationMode: "advisory_only",
    },
    mode,
    taskClass,
    mainAgent: publicCandidate(mainAgent),
    workerAgent: publicCandidate(workerAgent),
    selection: {
      mainAgent: "highest_score_quality_anchor",
      workerAgent: workerRule,
      preferredModel: mode === "economy" ? TASK_CLASS_MODELS[taskClass] : null,
      economyQualityFloorRatio: ECONOMY_QUALITY_FLOOR_RATIO,
      scoreTiePoints: ECONOMY_SCORE_TIE_POINTS,
    },
  };
}

export function parseArgs(argv) {
  const options = { mode: "economy", taskClass: "focused", input: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--mode") {
      options.mode = argv[index + 1];
      index += 1;
    } else if (argument === "--task-class") {
      options.taskClass = argv[index + 1];
      index += 1;
    } else if (argument === "--input") {
      options.input = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!SUPPORTED_MODES.has(options.mode)) throw new Error(`Unsupported mode: ${options.mode}`);
  if (!SUPPORTED_TASK_CLASSES.has(options.taskClass)) {
    throw new Error(`Unsupported task class: ${options.taskClass}`);
  }
  if (options.input === undefined) throw new Error("--input requires a path");
  return options;
}

async function readSnapshot(inputPath) {
  if (inputPath) return JSON.parse(await readFile(inputPath, "utf8"));
  const response = await fetch(MODELDIAL_LATEST_URL, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`ModelDial returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const snapshot = await readSnapshot(options.input);
    process.stdout.write(`${JSON.stringify(selectDispatchProfile(snapshot, options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`continuity-subagent-dispatch: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
