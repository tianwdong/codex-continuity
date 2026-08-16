import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;

function normalizedId(value) {
  const id = String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  return id && id.length <= 256 ? id : "";
}

function normalizedText(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizedRecord(value = {}) {
  return {
    threadId: normalizedId(value.threadId),
    nativeTitle: normalizedText(value.nativeTitle, 160),
    evaluatedTurnId: normalizedId(value.evaluatedTurnId),
    sourceTurnId: normalizedId(value.sourceTurnId),
    sourceMessageId: normalizedId(value.sourceMessageId),
    chapter: normalizedText(value.chapter, 64),
    progress: normalizedText(value.progress, 200),
    confidence: ["high", "medium"].includes(value.confidence) ? value.confidence : "",
    updatedAt: String(value.updatedAt || ""),
  };
}

export class ProgressLedger {
  constructor(value = {}) {
    this.state = Number(value?.schemaVersion) === SCHEMA_VERSION
      ? normalizedRecord(value)
      : normalizedRecord();
    this.dirty = false;
  }

  shouldEvaluate(threadId, turnId) {
    const candidateThreadId = normalizedId(threadId);
    const candidateTurnId = normalizedId(turnId);
    return Boolean(
      candidateThreadId
      && candidateTurnId
      && (this.state.threadId !== candidateThreadId
        || this.state.evaluatedTurnId !== candidateTurnId),
    );
  }

  current(threadId) {
    const candidateThreadId = normalizedId(threadId);
    if (!candidateThreadId || this.state.threadId !== candidateThreadId || !this.state.sourceTurnId) {
      return null;
    }
    return { ...this.state };
  }

  recordEvaluated({ threadId, turnId, nativeTitle }) {
    const candidateThreadId = normalizedId(threadId);
    const candidateTurnId = normalizedId(turnId);
    if (!candidateThreadId || !candidateTurnId || !this.shouldEvaluate(candidateThreadId, candidateTurnId)) {
      return false;
    }
    this.state = normalizedRecord({
      ...this.state,
      threadId: candidateThreadId,
      nativeTitle,
      evaluatedTurnId: candidateTurnId,
    });
    this.dirty = true;
    return true;
  }

  recordProgress({
    threadId,
    turnId,
    sourceMessageId,
    nativeTitle,
    chapter,
    progress,
    confidence,
  }) {
    const candidateThreadId = normalizedId(threadId);
    const candidateTurnId = normalizedId(turnId);
    const normalizedChapter = normalizedText(chapter, 64);
    const normalizedProgress = normalizedText(progress, 200);
    if (!candidateThreadId
      || !candidateTurnId
      || !this.shouldEvaluate(candidateThreadId, candidateTurnId)
      || !normalizedChapter
      || !normalizedProgress
      || !["high", "medium"].includes(confidence)) return false;
    this.state = normalizedRecord({
      threadId: candidateThreadId,
      nativeTitle,
      evaluatedTurnId: candidateTurnId,
      sourceTurnId: candidateTurnId,
      sourceMessageId,
      chapter: normalizedChapter,
      progress: normalizedProgress,
      confidence,
      updatedAt: new Date().toISOString(),
    });
    this.dirty = true;
    return true;
  }

  toJSON() {
    return { schemaVersion: SCHEMA_VERSION, ...this.state };
  }

  markClean() {
    this.dirty = false;
  }
}

export async function loadProgressLedger(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new ProgressLedger();
    const unavailable = new Error("progress_ledger_unavailable", { cause: error });
    unavailable.code = "PROGRESS_LEDGER_UNAVAILABLE";
    throw unavailable;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const corrupt = new Error("progress_ledger_corrupt", { cause: error });
    corrupt.code = "PROGRESS_LEDGER_CORRUPT";
    throw corrupt;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Number(value.schemaVersion) !== SCHEMA_VERSION) {
    const corrupt = new Error("progress_ledger_corrupt");
    corrupt.code = "PROGRESS_LEDGER_CORRUPT";
    throw corrupt;
  }
  try {
    return new ProgressLedger(value);
  } catch (error) {
    const corrupt = new Error("progress_ledger_corrupt", { cause: error });
    corrupt.code = "PROGRESS_LEDGER_CORRUPT";
    throw corrupt;
  }
}

export async function saveProgressLedger(filePath, ledger) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  ledger.markClean();
}
