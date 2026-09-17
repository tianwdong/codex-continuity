import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { selectDispatchProfile, parseArgs } from "../skills/continuity-subagent-dispatch/scripts/select-profile.mjs";

const ranking = (model, effort, score, cost, extra = {}) => ({
  id: `codex:${model}:${effort}`, provider: "codex", route: "official_login", model,
  reasoningEffort: effort, score, maxScore: 100, elapsedMs: 100, estimatedReferenceCostUsd: cost, ...extra,
});
const snapshot = (entries) => ({ schemaVersion: "1.0", batch: { id: "fixture", publishedAt: "2026-09-17T00:00:00Z" }, rankings: entries });
const profile = (entries, extra = {}) => ({ schemaVersion: 1,
  workerConfigurations: entries.map((x) => ({ model: x.model, reasoningEffort: x.reasoningEffort, canOverride: true })), ...extra });
const entries = [ranking("gpt-6-astra", "high", 100, 5), ranking("gpt-5.6-sol", "high", 96, 2),
  ranking("gpt-5.6-luna", "xhigh", 82, 0.1)];
const choose = (extra = {}) => selectDispatchProfile(snapshot(entries), { hostProfile: profile(entries), ...extra });

test("economy selects across families using task quality floors; quality selects highest supported score", () => {
  assert.equal(choose().workerAgent.model, "gpt-5.6-luna");
  assert.equal(choose({ taskClass: "exploration" }).workerAgent.model, "gpt-5.6-sol");
  assert.equal(choose({ taskClass: "demanding" }).workerAgent.model, "gpt-5.6-sol");
  assert.equal(choose({ mode: "quality" }).workerAgent.model, "gpt-6-astra");
  assert.equal(choose().dispatch.forkTurns, "none");
});

test("host capability evidence is required; never guess unsupported models or efforts", () => {
  assert.equal(selectDispatchProfile(snapshot(entries)).reason, "host_capabilities_unavailable");
  const p = profile([entries[1]]);
  assert.equal(choose({ hostProfile: p, mode: "quality" }).workerAgent.model, "gpt-5.6-sol");
  p.workerConfigurations[0].reasoningEffort = "low";
  assert.equal(choose({ hostProfile: p }).reason, "no_supported_evidence");
});

test("fixed agent profiles are selected without model overrides and cannot mix routes", () => {
  const p = profile([entries[2]]);
  p.workerConfigurations[0] = { model: "gpt-5.6-luna", reasoningEffort: "xhigh", agentType: "luna_worker", canOverride: false };
  assert.deepEqual(choose({ hostProfile: p }).dispatch, { agentType: "luna_worker", override: false });
  p.workerConfigurations.push({ model: "gpt-6-astra", reasoningEffort: "high", canOverride: true });
  assert.throws(() => choose({ hostProfile: p }), /mixed_agent_profiles/);
});

test("current worker baseline distinguishes unknown, unmeasured, unchanged, dominance and tradeoff", () => {
  assert.equal(choose().currentWorkerComparison.state, "current_unknown");
  const select = (currentWorker, extra = {}) => choose({ hostProfile: profile(entries, { currentWorker }), ...extra });
  assert.equal(select(entries[2]).currentWorkerComparison.state, "unchanged");
  assert.equal(select(entries[0]).currentWorkerComparison.state, "tradeoff");
  assert.equal(select({ model: "missing", reasoningEffort: "high" }).currentWorkerComparison.state, "current_unmeasured");
  const improved = [...entries, ranking("new-worker", "high", 85, 0.05)];
  const result = selectDispatchProfile(snapshot(improved), { hostProfile: profile(improved, { currentWorker: entries[2] }) });
  assert.equal(result.workerAgent.model, "new-worker");
  assert.equal(result.currentWorkerComparison.state, "dominates");
});

test("overall ranking uses its own identity and never silently falls back to backend", () => {
  const s = { ...snapshot(entries), schemaVersion: "1.1", defaultRanking: "overallRankings",
    overallRankings: [entries[1]], overallBatch: { id: "aggregate", publishedAt: "2026-09-17T01:00:00Z" } };
  const r = selectDispatchProfile(s, { hostProfile: profile(entries) });
  assert.equal(r.batch.id, "aggregate");
  assert.equal(r.workerAgent.model, "gpt-5.6-sol");
  assert.equal(r.evidenceBoundary.configurationEvidence, "published_aggregate");
  delete s.overallRankings;
  assert.throws(() => selectDispatchProfile(s), /invalid_ranking_identity/);
});

test("endpoint evidence stays advisory, never masquerades as login evidence or actual native costs", () => {
  const refs = entries.map((x) => ({ ...x, route: "custom_endpoint", provider: "cloudflare-reference" }));
  const r = selectDispatchProfile(snapshot(refs), { hostProfile: profile(entries) });
  assert.equal(r.status, "recommended");
  assert.equal(r.workerAgent.route, "custom_endpoint");
  assert.equal(r.evidenceBoundary.executionEvidence, "cross_route_reference");
  assert.equal(r.evidenceBoundary.nativePerformanceVerified, false);
  assert.equal(r.evidenceBoundary.referenceCostIsNativeBilling, false);
  const mixed = selectDispatchProfile(snapshot([...refs, ranking("gpt-5.6-sol", "high", 90, 20)]), { hostProfile: profile(entries) });
  assert.equal(mixed.workerAgent.route, "official_login");
  assert.equal(mixed.workerAgent.estimatedReferenceCostUsd, 20);
});

test("ambiguous provider configurations and incompatible score scales are not cherry-picked", () => {
  assert.equal(selectDispatchProfile(snapshot([...entries, { ...entries[0], id: "duplicate" }]),
    { hostProfile: profile(entries) }).reason, "ambiguous_configuration_evidence");
  assert.equal(selectDispatchProfile(snapshot([entries[0], { ...entries[1], maxScore: 120 }]),
    { hostProfile: profile(entries) }).reason, "incomparable_score_scales");
});

test("invalid numeric evidence, unknown schemas and malformed capabilities fail safely", () => {
  const broken = entries.map((x) => ({ ...x, score: 101 }));
  assert.equal(selectDispatchProfile(snapshot(broken), { hostProfile: profile(entries) }).reason, "no_supported_evidence");
  assert.throws(() => choose({ hostProfile: { schemaVersion: 1, workerConfigurations: [{}] } }), /invalid_host_profile/);
  assert.throws(() => selectDispatchProfile({ ...snapshot(entries), schemaVersion: "9" }), /unsupported_snapshot_schema/);
  assert.throws(() => selectDispatchProfile({ ...snapshot(entries), defaultRanking: "other" }), /unsupported_ranking/);
});

test("current published snapshot contract supports all task classes without unsupported families", async () => {
  const s = JSON.parse(await readFile(new URL("fixtures/modeldial-dispatch-2026-09-17.json", import.meta.url), "utf8"));
  const permitted = [{ model: "gpt-6-astra", reasoningEffort: "high" },
    { model: "gpt-6-astra", reasoningEffort: "xhigh" }, { model: "gpt-5.6-sol", reasoningEffort: "high" },
    { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }, { model: "grok-4.6", reasoningEffort: "high" }];
  for (const taskClass of ["focused", "exploration", "demanding"]) {
    const r = selectDispatchProfile(s, { taskClass, hostProfile: profile(permitted) });
    assert.equal(r.status, "recommended");
    assert.equal(r.ranking, "overallRankings");
    assert.equal(r.batch.id, s.overallBatch.id);
    assert.ok(permitted.some((x) => x.model === r.workerAgent.model && x.reasoningEffort === r.workerAgent.reasoningEffort));
    assert.equal(r.evidenceBoundary.executionEvidence, "cross_route_reference");
  }
});

test("CLI validates arguments and reports a missing local profile without leaking its path", () => {
  assert.equal(parseArgs(["--host-profile", "local.json"]).hostProfilePath, "local.json");
  for (const args of [["--host-profile"], ["--mode", "speed"], ["--task-class", "unknown"], ["--input", "--mode"]]) {
    assert.throws(() => parseArgs(args));
  }
  const r = spawnSync(process.execPath, ["skills/continuity-subagent-dispatch/scripts/select-profile.mjs", "--host-profile", "/private/SENTINEL_MISSING.json"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).reason, "selector_unavailable");
  assert.doesNotMatch(r.stdout + r.stderr, /SENTINEL|ENOENT/);
});


test("unsupported ambiguous evidence does not suppress a valid supported worker", () => {
  const s = snapshot([...entries, { ...entries[0], id: "other-provider-result", maxScore: 120 }]);
  const r = selectDispatchProfile(s, { hostProfile: profile([entries[1]], { currentWorker: entries[0] }) });
  assert.equal(r.status, "recommended");
  assert.equal(r.workerAgent.model, "gpt-5.6-sol");
});
