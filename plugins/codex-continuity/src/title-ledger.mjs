import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 2;

function normalizedId(value) {
  const threadId = String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  return threadId && threadId.length <= 256 ? threadId : "";
}

function normalizedTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizedRecord(value = {}) {
  return {
    observedTitle: normalizedTitle(value.observedTitle),
    previousTitle: normalizedTitle(value.previousTitle),
    appliedTitle: normalizedTitle(value.appliedTitle),
    evaluatedTurnId: String(value.evaluatedTurnId || ""),
    sourceTurnId: String(value.sourceTurnId || ""),
    sourceMessageId: String(value.sourceMessageId || ""),
    confidence: String(value.confidence || ""),
    changedAt: String(value.changedAt || ""),
    suppressedTitle: normalizedTitle(value.suppressedTitle),
    locked: Boolean(value.locked),
    undone: Boolean(value.undone),
  };
}

function threadCoordinate(thread) {
  return {
    threadId: normalizedId(thread?.id),
    title: normalizedTitle(thread?.name),
  };
}

function titleWorkstream(value) {
  return normalizedTitle(value).split("｜", 1)[0].trim();
}

export class TitleLedger {
  constructor(value = {}) {
    const threads = {};
    const sourceVersion = Number(value?.schemaVersion);
    if ([1, SCHEMA_VERSION].includes(sourceVersion) && value.threads && typeof value.threads === "object") {
      for (const [rawId, record] of Object.entries(value.threads)) {
        const threadId = normalizedId(rawId);
        if (threadId) {
          threads[threadId] = normalizedRecord(sourceVersion === 1
            ? { ...record, locked: false, suppressedTitle: "" }
            : record);
        }
      }
    }
    this.state = { schemaVersion: SCHEMA_VERSION, threads };
    this.dirty = sourceVersion === 1;
  }

  observe(thread) {
    const { threadId, title } = threadCoordinate(thread);
    if (!threadId || !title) return false;
    const previous = this.state.threads[threadId];
    if (!previous) {
      this.state.threads[threadId] = normalizedRecord({ observedTitle: title });
      this.dirty = true;
      return true;
    }
    if (title === previous.observedTitle) return false;

    const selfApplied = previous.appliedTitle && title === previous.appliedTitle;
    const next = normalizedRecord(selfApplied
      ? { ...previous, observedTitle: title }
      : {
          ...previous,
          observedTitle: title,
          previousTitle: "",
          appliedTitle: "",
          suppressedTitle: "",
          undone: false,
        });
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    this.state.threads[threadId] = next;
    this.dirty = true;
    return true;
  }

  shouldEvaluate(thread, turnId) {
    this.observe(thread);
    const { threadId, title } = threadCoordinate(thread);
    const record = this.state.threads[threadId];
    const candidateTurnId = String(turnId || "");
    return Boolean(
      threadId
      && title
      && candidateTurnId
      && record
      && !record.locked
      && record.evaluatedTurnId !== candidateTurnId
      && (!record.appliedTitle || record.appliedTitle === title),
    );
  }

  recordEvaluated(thread, turnId) {
    this.observe(thread);
    const { threadId, title } = threadCoordinate(thread);
    const previous = this.state.threads[threadId];
    const candidateTurnId = String(turnId || "");
    if (!previous || !title || !candidateTurnId || previous.evaluatedTurnId === candidateTurnId) return false;
    this.state.threads[threadId] = normalizedRecord({
      ...previous,
      observedTitle: title,
      evaluatedTurnId: candidateTurnId,
    });
    this.dirty = true;
    return true;
  }

  recordApplied({ threadId, previousTitle, title, turnId, sourceMessageId, confidence }) {
    const normalizedThreadId = normalizedId(threadId);
    const oldTitle = normalizedTitle(previousTitle);
    const newTitle = normalizedTitle(title);
    if (!normalizedThreadId || !oldTitle || !newTitle || oldTitle === newTitle) return false;
    const previous = normalizedRecord(this.state.threads[normalizedThreadId]);
    this.state.threads[normalizedThreadId] = normalizedRecord({
      ...previous,
      observedTitle: newTitle,
      previousTitle: oldTitle,
      appliedTitle: newTitle,
      evaluatedTurnId: String(turnId || ""),
      sourceTurnId: String(turnId || ""),
      sourceMessageId: String(sourceMessageId || ""),
      confidence,
      changedAt: new Date().toISOString(),
      suppressedTitle: "",
      locked: false,
      undone: false,
    });
    this.dirty = true;
    return true;
  }

  recordNativeTitleChange(thread, turnId) {
    const { threadId, title } = threadCoordinate(thread);
    const previous = this.state.threads[threadId];
    const previousTitle = normalizedTitle(previous?.observedTitle);
    const candidateTurnId = String(turnId || "");
    if (!threadId
      || !title
      || !candidateTurnId
      || !previousTitle
      || previous?.locked
      || previousTitle === title
      || !title.includes("｜")) return null;
    const decision = titleWorkstream(previousTitle) === titleWorkstream(title)
      ? "update_chapter"
      : "replace_workstream";
    if (!this.recordApplied({
      threadId,
      previousTitle,
      title,
      turnId: candidateTurnId,
      sourceMessageId: "",
      confidence: "high",
    })) return null;
    return { threadId, turnId: candidateTurnId, previousTitle, title, decision };
  }

  undoCandidate(value) {
    const threadId = normalizedId(value);
    const record = this.state.threads[threadId];
    if (!record?.appliedTitle || !record.previousTitle) return null;
    return { threadId, title: record.appliedTitle, previousTitle: record.previousTitle };
  }

  isSuppressed(value, title) {
    const threadId = normalizedId(value);
    const proposedTitle = normalizedTitle(title);
    return Boolean(proposedTitle && this.state.threads[threadId]?.suppressedTitle === proposedTitle);
  }

  status(value) {
    const threadId = normalizedId(value);
    const record = this.state.threads[threadId];
    return {
      locked: Boolean(record?.locked),
      undoAvailable: Boolean(this.undoCandidate(threadId)),
    };
  }

  latestUndoCandidate() {
    return Object.keys(this.state.threads)
      .map((threadId) => ({ ...this.undoCandidate(threadId), changedAt: this.state.threads[threadId].changedAt }))
      .filter((item) => item.threadId)
      .sort((left, right) => right.changedAt.localeCompare(left.changedAt))[0] ?? null;
  }

  recordUndone(value) {
    const candidate = this.undoCandidate(value);
    if (!candidate) return false;
    const previous = this.state.threads[candidate.threadId];
    this.state.threads[candidate.threadId] = normalizedRecord({
      ...previous,
      observedTitle: candidate.previousTitle,
      previousTitle: "",
      appliedTitle: "",
      suppressedTitle: candidate.title,
      undone: true,
    });
    this.dirty = true;
    return true;
  }

  setLocked(thread, locked) {
    this.observe(thread);
    const { threadId } = threadCoordinate(thread);
    const previous = this.state.threads[threadId];
    const nextLocked = Boolean(locked);
    if (!previous || previous.locked === nextLocked) return false;
    this.state.threads[threadId] = normalizedRecord({ ...previous, locked: nextLocked });
    this.dirty = true;
    return true;
  }

  toJSON() {
    return { schemaVersion: SCHEMA_VERSION, threads: this.state.threads };
  }

  markClean() {
    this.dirty = false;
  }
}

export async function loadTitleLedger(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new TitleLedger();
    const unavailable = new Error("title_ledger_unavailable", { cause: error });
    unavailable.code = "TITLE_LEDGER_UNAVAILABLE";
    throw unavailable;
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const corrupt = new Error("title_ledger_corrupt", { cause: error });
    corrupt.code = "TITLE_LEDGER_CORRUPT";
    throw corrupt;
  }
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || ![1, SCHEMA_VERSION].includes(Number(value.schemaVersion))
    || !value.threads
    || typeof value.threads !== "object"
    || Array.isArray(value.threads)
    || Object.values(value.threads).some((record) => (
      !record || typeof record !== "object" || Array.isArray(record)
    ))) {
    const corrupt = new Error("title_ledger_corrupt");
    corrupt.code = "TITLE_LEDGER_CORRUPT";
    throw corrupt;
  }
  try {
    return new TitleLedger(value);
  } catch (error) {
    const corrupt = new Error("title_ledger_corrupt", { cause: error });
    corrupt.code = "TITLE_LEDGER_CORRUPT";
    throw corrupt;
  }
}

export async function saveTitleLedger(filePath, ledger) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  ledger.markClean();
}
