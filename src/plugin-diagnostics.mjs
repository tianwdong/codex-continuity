import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyBuildIntegrity } from "./build-integrity.mjs";
import { loadProgressLedger } from "./progress-ledger.mjs";
import { loadTitleLedger } from "./title-ledger.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));
const STALE_LOCK_MS = 300_000;
const STATUSES = new Set(["queued", "running", "completed", "skipped", "failed", "error", "ignored", "renamed", "progress_updated", "kept", "launched"]);
const STAGES = new Set(["queued", "runtime", "app_server", "thread_read", "semantic", "progress", "title", "persist", "completed", "launch", "input", "ledger", "account"]);
const REASONS = new Set([
  "invalid_event", "continued_stop", "workspace_unavailable", "assistant_message_unavailable",
  "thread_metadata_unavailable", "subagent_thread", "already_evaluated", "account_unavailable",
  "already_running", "runtime_unavailable", "codex_unavailable", "worker_spawn_failed",
  "worker_exit_before_ready", "worker_ready_timeout", "semantic_timeout", "semantic_spawn_failed",
  "semantic_nonzero_exit", "semantic_invalid_json", "semantic_invalid_input", "semantic_input_failed", "semantic_output_too_large",
  "semantic_decision_unavailable", "semantic_mcp_discovery_failed", "title_ledger_corrupt",
  "title_ledger_unavailable", "progress_ledger_corrupt", "progress_ledger_unavailable",
  "app_server_unavailable", "thread_read_failed", "title_write_failed", "persist_failed",
  "codex_runtime_unavailable", "queued_result_unavailable", "stop_runtime_failed", "stop_thread_read_failed",
  "stop_semantic_failed", "stop_persist_failed", "stop_queue_timeout", "stop_queue_unavailable", "stop_worker_failed",
]);
const NORMAL_IGNORED_REASONS = new Set(["continued_stop", "workspace_unavailable", "subagent_thread", "already_evaluated"]);
const WAITING_REASONS = new Set(["already_running", "queued_result_unavailable"]);
const FAILURE_REASONS = new Set([...REASONS].filter((reason) => (
  !NORMAL_IGNORED_REASONS.has(reason) && !WAITING_REASONS.has(reason)
)));

function diagnosticOutcome(diagnostic) {
  if (!diagnostic) return "unknown";
  if (["failed", "error"].includes(diagnostic.status) || FAILURE_REASONS.has(diagnostic.reason)) return "failed";
  if (WAITING_REASONS.has(diagnostic.reason)) return "waiting";
  if (diagnostic.reason === "unknown" || diagnostic.status === "unknown") return "unknown";
  if (["ignored", "skipped", "completed"].includes(diagnostic.status)
    && NORMAL_IGNORED_REASONS.has(diagnostic.reason)) return "ignored";
  if (["completed", "renamed", "progress_updated", "kept"].includes(diagnostic.status)
    && diagnostic.reason === null) return "successful";
  if (["queued", "running", "launched"].includes(diagnostic.status)) return "running";
  return "unknown";
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

function identifier(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value) ? value : null;
}

function workerVersion(value) {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || match[1]?.split(".").some((part) => /^0\d+$/.test(part))) return null;
  return value;
}

async function readMetadata(filePath, parse) {
  if (!filePath) return { state: "missing", value: null };
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "unavailable", value: null };
  }
  try {
    const value = parse(JSON.parse(raw));
    return { state: value ? "available" : "corrupt", value };
  } catch (_) {
    return { state: "corrupt", value: null };
  }
}

async function readLedger(filePath, load) {
  try {
    await stat(filePath);
    return { state: "available", value: await load(filePath) };
  } catch (error) {
    return {
      state: error?.code === "ENOENT" ? "missing"
        : String(error?.code || "").endsWith("_CORRUPT") ? "corrupt" : "unavailable",
      value: null,
    };
  }
}

async function readLock(filePath, now) {
  try {
    const info = await stat(filePath);
    const ageMs = Math.max(0, now - info.mtimeMs);
    return { state: ageMs > STALE_LOCK_MS ? "stale" : "held", ageMs: Math.round(ageMs) };
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "idle" : "unavailable", ageMs: null };
  }
}

function parsePending(value, threadId) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.threadId !== threadId
    || !identifier(value.turnId) || !timestamp(value.receivedAt)) return null;
  if (value.handledAt !== undefined && !timestamp(value.handledAt)) return null;
  return { turnId: value.turnId, receivedAt: timestamp(value.receivedAt), handledAt: timestamp(value.handledAt) };
}

function parseDiagnostic(value, threadId) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.threadId !== threadId
    || !identifier(value.turnId) || !timestamp(value.updatedAt)) return null;
  return {
    turnId: value.turnId,
    workerVersion: workerVersion(value.workerVersion),
    packageDigest: /^[a-f0-9]{64}$/.test(value.packageDigest) ? value.packageDigest : null,
    status: STATUSES.has(value.status) ? value.status : "unknown",
    reason: !value.reason ? null : REASONS.has(value.reason) ? value.reason : "unknown",
    stage: STAGES.has(value.stage) ? value.stage : "unknown",
    updatedAt: timestamp(value.updatedAt),
    durationMs: Number.isFinite(value.durationMs) && value.durationMs >= 0 ? value.durationMs : null,
  };
}

export async function readContinuitySnapshot(threadId, {
  coordinate,
  pluginRoot = PLUGIN_ROOT,
  now = Date.now(),
} = {}) {
  const [title, progress, pending, diagnostic, backgroundLock, manifest, packageIntegrity] = await Promise.all([
    readLedger(coordinate.statePath, loadTitleLedger),
    readLedger(coordinate.progressPath, loadProgressLedger),
    readMetadata(coordinate.pendingStopPath, (value) => parsePending(value, threadId)),
    readMetadata(coordinate.diagnosticPath, (value) => parseDiagnostic(value, threadId)),
    readLock(coordinate.lockPath, now),
    readMetadata(path.join(pluginRoot, ".codex-plugin", "plugin.json"), (value) => (
      isRecord(value) && typeof value.version === "string"
        && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(value.version)
        ? { version: value.version } : null
    )),
    verifyBuildIntegrity(pluginRoot),
  ]);
  const progressRecord = progress.value?.current(threadId) ?? null;
  const evaluatedTurnId = progress.value?.toJSON()?.threadId === threadId
    ? progress.value.toJSON().evaluatedTurnId : null;
  const latestStop = pending.value
    ? { ...pending.value, source: "pending_stop" }
    : diagnostic.value ? {
      turnId: diagnostic.value.turnId,
      receivedAt: null,
      source: "diagnostic",
    } : null;
  const evaluatedLatestStop = latestStop ? evaluatedTurnId === latestStop.turnId : null;
  const latestDiagnostic = diagnostic.value?.turnId === latestStop?.turnId ? diagnostic.value : null;
  const outcome = diagnosticOutcome(latestDiagnostic);
  const handledLatestStop = Boolean(pending.value?.handledAt)
    || (evaluatedLatestStop && !["failed", "waiting"].includes(outcome))
    || (pending.state === "missing" && ["successful", "ignored"].includes(outcome));
  let refreshState = "unknown";
  if (["held", "stale", "unavailable"].includes(backgroundLock.state)) {
    refreshState = backgroundLock.state === "held" ? "busy" : "unknown";
  } else if (outcome === "failed") {
    refreshState = "failed";
  } else if (outcome === "waiting") {
    refreshState = "pending";
  } else if (latestDiagnostic && outcome === "unknown") {
    refreshState = "unknown";
  } else if (latestStop && !handledLatestStop) {
    refreshState = "pending";
  } else if (handledLatestStop) {
    refreshState = "received_stop_handled";
  } else if (pending.state === "missing" && diagnostic.state === "missing") {
    refreshState = "idle";
  }
  const progressUpdatedAt = timestamp(progressRecord?.updatedAt);
  return {
    titleLedger: title.value,
    progressLedger: progress.value,
    ledgers: { title: title.state, progress: progress.state },
    executingPlugin: { manifest: manifest.state, version: manifest.value?.version ?? null, hostLoadedVersion: "unknown" },
    packageIntegrity,
    coverage: { scope: "received_stops_only", latestNativeCompletedTurn: "unverified" },
    hookTrust: "unknown",
    latestStop,
    metadata: { pendingStop: pending.state, diagnostic: diagnostic.state },
    diagnostic: diagnostic.value,
    backgroundLock,
    refresh: { state: refreshState, latestStopEvaluated: evaluatedLatestStop, latestStopHandled: latestStop ? Boolean(handledLatestStop) : null },
    progressFreshness: {
      state: !progressRecord ? "no_progress" : !latestStop ? "unknown"
        : progressRecord.sourceTurnId === latestStop.turnId ? "matches_received_stop"
          : handledLatestStop ? "previous_reliable" : "awaiting_latest_stop",
      updatedAt: progressUpdatedAt,
      ageMs: progressUpdatedAt ? Math.max(0, now - Date.parse(progressUpdatedAt)) : null,
    },
  };
}

export function buildDoctorResult(threadId, snapshot) {
  const {
    executingPlugin, hookTrust, latestStop, metadata, diagnostic: recordedDiagnostic, backgroundLock,
    refresh, progressFreshness, ledgers, packageIntegrity, coverage,
  } = snapshot;
  const diagnostic = recordedDiagnostic?.turnId === latestStop?.turnId ? recordedDiagnostic : null;
  let nextStep = "Review plugin enablement and Hook trust in Codex, then check again after a normal completed turn.";
  if (executingPlugin.manifest !== "available") {
    nextStep = "Check the plugin package manifest, then rerun doctor from the intended plugin installation.";
  } else if (backgroundLock.state === "held") {
    nextStep = "Wait for the current background update to finish, then run status again.";
  } else if (backgroundLock.state === "stale") {
    nextStep = "Run doctor again after the next normal completed turn; this read-only check does not remove locks.";
  } else if (Object.values(ledgers).some((state) => ["corrupt", "unavailable"].includes(state))) {
    nextStep = "Preserve the existing ledgers and check local storage access before attempting repairs.";
  } else if (Object.values(metadata).some((state) => ["corrupt", "unavailable"].includes(state))) {
    nextStep = "Preserve the local metadata and check storage access; rerun doctor after the next normal completed turn.";
  } else if (["runtime", "launch"].includes(diagnostic?.stage)
    || ["stop_runtime_failed", "stop_worker_failed", "codex_runtime_unavailable", "runtime_unavailable", "codex_unavailable", "worker_spawn_failed", "worker_exit_before_ready", "worker_ready_timeout"].includes(diagnostic?.reason)) {
    nextStep = "Check that the Codex CLI and plugin runtime are available, then complete a normal turn.";
  } else if (diagnostic?.reason === "account_unavailable") {
    nextStep = "Check sign-in in Codex itself; this diagnostic does not inspect authentication data.";
  } else if ((diagnostic?.stage === "semantic" || diagnostic?.reason?.startsWith("semantic_")
    || diagnostic?.reason === "stop_semantic_failed") && refresh.state === "failed") {
    nextStep = "Check Codex CLI connectivity, then run doctor after the next normal completed turn.";
  } else if ((["app_server", "thread_read", "title"].includes(diagnostic?.stage)
    || ["stop_thread_read_failed", "thread_metadata_unavailable", "assistant_message_unavailable", "app_server_unavailable", "thread_read_failed", "title_write_failed"].includes(diagnostic?.reason))
    && refresh.state === "failed") {
    nextStep = "Confirm the current task opens normally in Codex, then run status again.";
  } else if (["stop_persist_failed", "persist_failed"].includes(diagnostic?.reason)
    || diagnostic?.reason?.startsWith("title_ledger_") || diagnostic?.reason?.startsWith("progress_ledger_")) {
    nextStep = "Preserve the existing ledgers and check local storage access before attempting repairs.";
  } else if (["stop_queue_timeout", "stop_queue_unavailable", "queued_result_unavailable"].includes(diagnostic?.reason)) {
    nextStep = "Check that the completed turn is available in Codex, then run doctor after the next normal completed turn.";
  } else if (refresh.state === "received_stop_handled") {
    nextStep = "The latest received Stop was handled. Coverage of the latest native completed turn, Hook trust, and the host-loaded package remain unverified.";
  }
  if (["mismatch", "invalid"].includes(packageIntegrity?.state)) {
    nextStep = "Package contents do not match the build manifest. Rebuild or reinstall the intended package before relying on version equality.";
  }
  return {
    ok: true,
    type: "continuity_diagnostics",
    threadId,
    executingPlugin,
    packageIntegrity,
    coverage,
    lastRecordedPackageDigest: recordedDiagnostic?.packageDigest ?? null,
    lastWorkerVersion: recordedDiagnostic?.workerVersion ?? null,
    hookTrust,
    latestStop,
    metadata,
    ledgers,
    progressFreshness,
    backgroundLock,
    refresh,
    diagnostic: recordedDiagnostic,
    nextStep,
  };
}
