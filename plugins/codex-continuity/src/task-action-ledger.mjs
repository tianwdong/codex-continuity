import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const ACTION_KINDS = new Set([
  "continue-task",
  "create-branch",
  "create-task",
  "return-parent",
  "return-archive",
]);
const ACTION_STEPS = new Set(["create", "send", "navigate", "archive"]);
const STEP_STATES = new Set(["started", "done", "skipped"]);
const ACTION_STATUSES = new Set([
  "proposed",
  "confirmed",
  "completed",
  "failed",
  "canceled",
  "expired",
]);

function normalizedId(value) {
  const id = String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  return id && id.length <= 256 ? id : "";
}

function normalizedTime(value) {
  const candidate = String(value || "");
  return Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function timestamp(value = new Date().toISOString()) {
  return normalizedTime(value) || new Date().toISOString();
}

function normalizedSteps(value) {
  const steps = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return steps;
  for (const [step, raw] of Object.entries(value)) {
    if (!ACTION_STEPS.has(step) || !STEP_STATES.has(raw?.state)) continue;
    steps[step] = {
      state: raw.state,
      updatedAt: normalizedTime(raw.updatedAt),
    };
  }
  return steps;
}

function normalizedAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const currentThreadId = normalizedId(value.currentThreadId);
  const targetThreadId = normalizedId(value.targetThreadId);
  const sourceTurnId = normalizedId(value.sourceTurnId);
  const kind = ACTION_KINDS.has(value.kind) ? value.kind : "";
  const status = ACTION_STATUSES.has(value.status) ? value.status : "";
  if (!currentThreadId || !sourceTurnId || !kind || !status
    || (requiresKnownTarget(kind) && !targetThreadId)) return null;
  return {
    currentThreadId,
    targetThreadId,
    kind,
    sourceTurnId,
    status,
    steps: normalizedSteps(value.steps),
    failureCode: String(value.failureCode || "").replace(/[^a-z0-9_-]/giu, "").slice(0, 40),
    proposedAt: normalizedTime(value.proposedAt),
    confirmedAt: normalizedTime(value.confirmedAt),
    updatedAt: normalizedTime(value.updatedAt),
  };
}

function requiresKnownTarget(kind) {
  return ["continue-task", "return-parent", "return-archive"].includes(kind);
}

function sameAction(action, { currentThreadId, targetThreadId, kind, sourceTurnId }) {
  return action
    && action.currentThreadId === normalizedId(currentThreadId)
    && action.targetThreadId === normalizedId(targetThreadId)
    && action.kind === kind
    && action.sourceTurnId === normalizedId(sourceTurnId);
}

export class TaskActionLedger {
  constructor(value = {}) {
    this.action = Number(value?.schemaVersion) === SCHEMA_VERSION
      ? normalizedAction(value.action)
      : null;
    this.dirty = false;
  }

  current(currentThreadId) {
    const id = normalizedId(currentThreadId);
    return id && this.action?.currentThreadId === id
      ? structuredClone(this.action)
      : null;
  }

  propose({ currentThreadId, targetThreadId, kind, sourceTurnId, now }) {
    const current = normalizedId(currentThreadId);
    const target = normalizedId(targetThreadId);
    const turn = normalizedId(sourceTurnId);
    if (!current || !turn || !ACTION_KINDS.has(kind) || (requiresKnownTarget(kind) && !target)) return false;
    if (sameAction(this.action, { currentThreadId: current, targetThreadId: target, kind, sourceTurnId: turn })
      && this.action.status === "proposed") return true;
    if (this.action?.status === "confirmed") return false;
    const at = timestamp(now);
    this.action = normalizedAction({
      currentThreadId: current,
      targetThreadId: target,
      kind,
      sourceTurnId: turn,
      status: "proposed",
      steps: {},
      proposedAt: at,
      updatedAt: at,
    });
    this.dirty = true;
    return true;
  }

  confirm({ currentThreadId, kind, now }) {
    const current = normalizedId(currentThreadId);
    if (!current || !ACTION_KINDS.has(kind) || this.action?.currentThreadId !== current || this.action.kind !== kind) {
      return null;
    }
    if (this.action.status === "confirmed") return this.current(current);
    if (this.action.status !== "proposed") return null;
    const at = timestamp(now);
    if (!this.action.proposedAt
      || Date.parse(at) - Date.parse(this.action.proposedAt) > PROPOSAL_TTL_MS) {
      this.action.status = "expired";
      this.action.updatedAt = at;
      this.dirty = true;
      return null;
    }
    this.action.status = "confirmed";
    this.action.confirmedAt = at;
    this.action.updatedAt = at;
    this.dirty = true;
    return this.current(current);
  }

  start({ currentThreadId, targetThreadId, kind, sourceTurnId, now }) {
    const current = normalizedId(currentThreadId);
    const target = normalizedId(targetThreadId);
    const turn = normalizedId(sourceTurnId);
    if (!current || !turn || !ACTION_KINDS.has(kind) || (requiresKnownTarget(kind) && !target)) return null;
    if (sameAction(this.action, { currentThreadId: current, targetThreadId: target, kind, sourceTurnId: turn })) {
      return ["confirmed", "completed"].includes(this.action.status) ? this.current(current) : null;
    }
    if (this.action?.status === "confirmed") return null;
    const at = timestamp(now);
    this.action = normalizedAction({
      currentThreadId: current,
      targetThreadId: target,
      kind,
      sourceTurnId: turn,
      status: "confirmed",
      steps: {},
      proposedAt: at,
      confirmedAt: at,
      updatedAt: at,
    });
    this.dirty = true;
    return this.current(current);
  }

  cancel({ currentThreadId, kind, now }) {
    const current = normalizedId(currentThreadId);
    if (!current || this.action?.currentThreadId !== current || this.action.kind !== kind
      || this.action.status !== "proposed") return false;
    this.action.status = "canceled";
    this.action.updatedAt = timestamp(now);
    this.dirty = true;
    return true;
  }

  beginStep(currentThreadId, step, now) {
    const current = normalizedId(currentThreadId);
    if (!current || !ACTION_STEPS.has(step) || this.action?.currentThreadId !== current) {
      return { state: "unavailable", action: null };
    }
    const existing = this.action.steps[step]?.state;
    if (["done", "skipped"].includes(existing)) {
      return { state: "done", action: this.current(current) };
    }
    if (existing === "started") {
      return { state: "uncertain", action: this.current(current) };
    }
    if (this.action.status !== "confirmed") {
      return { state: "unavailable", action: this.current(current) };
    }
    const at = timestamp(now);
    this.action.steps[step] = { state: "started", updatedAt: at };
    this.action.updatedAt = at;
    this.dirty = true;
    return { state: "perform", action: this.current(current) };
  }

  completeStep({ currentThreadId, step, targetThreadId, now }) {
    const current = normalizedId(currentThreadId);
    if (!current || !ACTION_STEPS.has(step) || this.action?.currentThreadId !== current) return false;
    const existing = this.action.steps[step]?.state;
    if (existing === "done") {
      return !targetThreadId || this.action.targetThreadId === normalizedId(targetThreadId);
    }
    if (this.action.status !== "confirmed" || existing !== "started") return false;
    if (targetThreadId) {
      const target = normalizedId(targetThreadId);
      if (step !== "create" || !target || (this.action.targetThreadId && this.action.targetThreadId !== target)) {
        return false;
      }
      this.action.targetThreadId = target;
    }
    const at = timestamp(now);
    this.action.steps[step] = { state: "done", updatedAt: at };
    this.action.updatedAt = at;
    this.dirty = true;
    return true;
  }

  skipStep({ currentThreadId, step, now }) {
    const current = normalizedId(currentThreadId);
    if (!current || !ACTION_STEPS.has(step) || this.action?.currentThreadId !== current
      || this.action.status !== "confirmed") return false;
    const existing = this.action.steps[step]?.state;
    if (["done", "skipped"].includes(existing)) return true;
    if (existing === "started") return false;
    const at = timestamp(now);
    this.action.steps[step] = { state: "skipped", updatedAt: at };
    this.action.updatedAt = at;
    this.dirty = true;
    return true;
  }

  fail({ currentThreadId, failureCode, now }) {
    const current = normalizedId(currentThreadId);
    if (!current || this.action?.currentThreadId !== current || this.action.status !== "confirmed") return false;
    this.action.status = "failed";
    this.action.failureCode = String(failureCode || "action_failed")
      .replace(/[^a-z0-9_-]/giu, "")
      .slice(0, 40) || "action_failed";
    this.action.updatedAt = timestamp(now);
    this.dirty = true;
    return true;
  }

  finish(currentThreadId, now) {
    const current = normalizedId(currentThreadId);
    if (!current || this.action?.currentThreadId !== current || this.action.status !== "confirmed") return false;
    if (Object.values(this.action.steps).some((step) => step.state === "started")) return false;
    this.action.status = "completed";
    this.action.updatedAt = timestamp(now);
    this.dirty = true;
    return true;
  }

  toJSON() {
    return { schemaVersion: SCHEMA_VERSION, action: this.action };
  }

  markClean() {
    this.dirty = false;
  }
}

export async function loadTaskActionLedger(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new TaskActionLedger();
    const unavailable = new Error("task_action_ledger_unavailable", { cause: error });
    unavailable.code = "TASK_ACTION_LEDGER_UNAVAILABLE";
    throw unavailable;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const corrupt = new Error("task_action_ledger_corrupt", { cause: error });
    corrupt.code = "TASK_ACTION_LEDGER_CORRUPT";
    throw corrupt;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Number(value.schemaVersion) !== SCHEMA_VERSION
    || (value.action !== null && normalizedAction(value.action) === null)) {
    const corrupt = new Error("task_action_ledger_corrupt");
    corrupt.code = "TASK_ACTION_LEDGER_CORRUPT";
    throw corrupt;
  }
  return new TaskActionLedger(value);
}

export async function saveTaskActionLedger(filePath, ledger) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  ledger.markClean();
}
