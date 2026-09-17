#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MODELDIAL_LATEST_URL = "https://modeldial.com/api/v1/radar/latest.json";
// Product guardrails, not model-role benchmark claims. Families are not fixed.
export const TASK_QUALITY_FLOORS = Object.freeze({ focused: 0.8, exploration: 0.85, demanding: 0.95 });
const MODES = new Set(["economy", "quality"]);
const token = (value) => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value);
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const identity = (entry) => `${entry.model}:${entry.reasoningEffort}`;

function normalizeCandidate(entry) {
  if (!entry || ![entry.id, entry.provider, entry.model, entry.reasoningEffort].every(token)) return null;
  if (!["official_login", "custom_endpoint"].includes(entry.route)) return null;
  if (![entry.score, entry.maxScore, entry.elapsedMs, entry.estimatedReferenceCostUsd].every(Number.isFinite)) return null;
  if (entry.maxScore <= 0 || entry.score < 0 || entry.score > entry.maxScore
    || entry.elapsedMs < 0 || entry.estimatedReferenceCostUsd < 0) return null;
  return { id: entry.id, provider: entry.provider, model: entry.model, reasoningEffort: entry.reasoningEffort,
    displayName: `${entry.model} / ${entry.reasoningEffort}`, route: entry.route,
    score: entry.score, maxScore: entry.maxScore, elapsedMs: entry.elapsedMs,
    estimatedReferenceCostUsd: entry.estimatedReferenceCostUsd };
}

function readRanking(snapshot) {
  if (!["1.0", "1.1"].includes(snapshot?.schemaVersion)) throw new Error("unsupported_snapshot_schema");
  const ranking = snapshot.defaultRanking ?? "rankings";
  if (!["rankings", "overallRankings"].includes(ranking)) throw new Error("unsupported_ranking");
  const batch = ranking === "overallRankings" ? snapshot.overallBatch : snapshot.batch;
  if (!Array.isArray(snapshot[ranking]) || !token(batch?.id) || !timestamp(batch?.publishedAt)) {
    throw new Error("invalid_ranking_identity");
  }
  // A declared overall ranking must never silently fall back to backend data.
  return { ranking, batch: { id: batch.id, publishedAt: batch.publishedAt }, entries: snapshot[ranking] };
}

function capabilities(profile) {
  if (!profile || profile.schemaVersion !== 1 || !Array.isArray(profile.workerConfigurations)
    || !profile.workerConfigurations.length) return null;
  const configs = profile.workerConfigurations;
  for (const config of configs) {
    if (!token(config?.model) || !token(config?.reasoningEffort)
      || (config.agentType !== undefined && !token(config.agentType))
      || typeof config.canOverride !== "boolean" || (!config.canOverride && !config.agentType)) {
      throw new Error("invalid_host_profile");
    }
  }
  // One preselected agent route only: do not change agent type to chase scores.
  if (new Set(configs.map((x) => x.agentType ?? "default")).size > 1
    || (configs.some((x) => !x.canOverride) && configs.length !== 1)) throw new Error("mixed_agent_profiles");
  for (const current of [profile.currentWorker, profile.currentMain]) {
    if (current != null && (!token(current.model) || !token(current.reasoningEffort))) throw new Error("invalid_current_configuration");
  }
  return configs;
}

function compareQuality(a, b) {
  return b.score - a.score || a.estimatedReferenceCostUsd - b.estimatedReferenceCostUsd
    || a.elapsedMs - b.elapsedMs || a.id.localeCompare(b.id);
}
function compareCost(a, b) {
  return a.estimatedReferenceCostUsd - b.estimatedReferenceCostUsd || compareQuality(a, b);
}
function comparison(current, worker, candidates) {
  if (!current) return { state: "current_unknown" };
  const matching = candidates.filter((x) => identity(x) === identity(current) && x.maxScore === worker.maxScore);
  const baseline = matching.length === 1 ? matching[0] : null;
  if (!baseline) return { state: "current_unmeasured", model: current.model, reasoningEffort: current.reasoningEffort };
  const scoreDelta = worker.score - baseline.score;
  const referenceCostDeltaUsd = worker.estimatedReferenceCostUsd - baseline.estimatedReferenceCostUsd;
  return { state: identity(worker) === identity(baseline) ? "unchanged"
    : scoreDelta >= 0 && referenceCostDeltaUsd <= 0 ? "dominates" : "tradeoff",
    model: baseline.model, reasoningEffort: baseline.reasoningEffort, scoreDelta, referenceCostDeltaUsd };
}

export function selectDispatchProfile(snapshot, { mode = "economy", taskClass = "focused", hostProfile = null } = {}) {
  if (!MODES.has(mode) || !Object.hasOwn(TASK_QUALITY_FLOORS, taskClass)) throw new Error("invalid_selection_mode");
  const { ranking, batch, entries } = readRanking(snapshot);
  const configs = capabilities(hostProfile);
  const base = { schemaVersion: "2.0", mode, taskClass, ranking, batch,
    source: { name: "ModelDial Public Radar", url: MODELDIAL_LATEST_URL },
    evidenceBoundary: { recommendationMode: "advisory_only", pairedAgentBenchmark: false,
      configurationEvidence: ranking === "overallRankings" ? "published_aggregate" : "single_published_batch",
      nativePerformanceVerified: false, referenceCostIsNativeBilling: false },
    currentMain: hostProfile?.currentMain ? { model: hostProfile.currentMain.model, reasoningEffort: hostProfile.currentMain.reasoningEffort } : null };
  const unavailable = (reason) => ({ ...base, status: "unavailable", reason, workerAgent: null, dispatch: null });
  if (!configs) return unavailable("host_capabilities_unavailable");
  const normalized = entries.map(normalizeCandidate).filter(Boolean);
  const supported = (candidate) => configs.some((x) => identity(x) === identity(candidate));
  // Never merge login and endpoint results in one cost/score comparison.
  const native = normalized.filter((x) => x.provider === "codex" && x.route === "official_login");
  const reference = normalized.filter((x) => x.route === "custom_endpoint");
  const pool = native.some(supported) ? native : reference;
  const candidates = pool.filter(supported);
  if (!candidates.length) return unavailable("no_supported_evidence");
  if (new Set(candidates.map((x) => x.maxScore)).size !== 1) return unavailable("incomparable_score_scales");
  // Multiple providers for the same configuration are ambiguous, not a license to cherry-pick.
  if (new Set(candidates.map(identity)).size !== candidates.length) return unavailable("ambiguous_configuration_evidence");
  const qualityAnchor = [...candidates].sort(compareQuality)[0];
  const floor = TASK_QUALITY_FLOORS[taskClass];
  const eligible = candidates.filter((x) => x.score >= qualityAnchor.score * floor);
  const workerAgent = [...eligible].sort(mode === "quality" ? compareQuality : compareCost)[0];
  const config = configs.find((x) => identity(x) === identity(workerAgent));
  return { ...base, status: "recommended", reason: null, qualityAnchor, workerAgent,
    evidenceBoundary: { ...base.evidenceBoundary, executionEvidence: pool === native ? "official_login" : "cross_route_reference" },
    dispatch: config.canOverride
      ? { agentType: config.agentType ?? "default", model: config.model, reasoningEffort: config.reasoningEffort,
        forkTurns: "none", override: true }
      : { agentType: config.agentType, override: false },
    currentWorkerComparison: comparison(hostProfile.currentWorker, workerAgent, pool),
    selection: { qualityFloorRatio: floor, workerRule: mode === "quality" ? "highest_supported_score" : "lowest_reference_cost_above_quality_floor" } };
}

export function parseArgs(argv) {
  const options = { mode: "economy", taskClass: "focused", input: null, hostProfilePath: null };
  const names = { "--mode": "mode", "--task-class": "taskClass", "--input": "input", "--host-profile": "hostProfilePath" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = names[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("invalid_arguments");
    options[key] = argv[i + 1];
  }
  if (!MODES.has(options.mode) || !Object.hasOwn(TASK_QUALITY_FLOORS, options.taskClass)) throw new Error("invalid_selection_mode");
  return options;
}
async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const hostProfile = options.hostProfilePath ? JSON.parse(await readFile(options.hostProfilePath, "utf8")) : null;
    let snapshot;
    if (options.input) snapshot = JSON.parse(await readFile(options.input, "utf8"));
    else {
      const response = await fetch(MODELDIAL_LATEST_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error("snapshot_http_failure");
      snapshot = await response.json();
    }
    process.stdout.write(`${JSON.stringify(selectDispatchProfile(snapshot, { ...options, hostProfile }), null, 2)}\n`);
  } catch (error) {
    // No raw paths, remote response bodies, credentials or fetch errors in diagnostics.
    const reason = /^[a-z_]+$/.test(error.message) ? error.message : "selector_unavailable";
    process.stdout.write(`${JSON.stringify({ status: "unavailable", reason, workerAgent: null, dispatch: null })}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
