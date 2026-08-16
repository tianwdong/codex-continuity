import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { latestCompletedSnapshot } from "./continuity-data.mjs";

const SCHEMA_VERSION = 1;

function normalizedId(value) {
  const threadId = String(value || "").trim().replace(/^(?:local|cloud):/i, "");
  return threadId && threadId.length <= 256 ? threadId : "";
}

function cursorFor(thread) {
  return [thread?.recencyAt ?? "", thread?.updatedAt ?? "", thread?.createdAt ?? ""].join(":");
}

function normalizedRecord(value = {}) {
  return {
    cursor: String(value.cursor || ""),
    latestTurnId: String(value.latestTurnId || ""),
    latestStatus: String(value.latestStatus || ""),
    latestMessageId: String(value.latestMessageId || ""),
    pendingTurnId: String(value.pendingTurnId || ""),
    handledTurnId: String(value.handledTurnId || ""),
    notifiedTurnId: String(value.notifiedTurnId || ""),
    retry: Boolean(value.retry),
  };
}

export class AttentionLedger {
  constructor(value = {}) {
    const threads = {};
    if (value?.schemaVersion === SCHEMA_VERSION && value.threads && typeof value.threads === "object") {
      for (const [rawId, record] of Object.entries(value.threads)) {
        const threadId = normalizedId(rawId);
        if (threadId) threads[threadId] = normalizedRecord(record);
      }
    }
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      initialized: value?.schemaVersion === SCHEMA_VERSION && Boolean(value.initialized),
      threads,
    };
    this.dirty = false;
  }

  scan(threads, { nativeUnreadThreadIds = [], loadedThreadIds = [] } = {}) {
    const current = new Map((Array.isArray(threads) ? threads : [])
      .map((thread) => [normalizedId(thread?.id), thread])
      .filter(([threadId]) => threadId));
    const loaded = new Set((Array.isArray(loadedThreadIds) ? loadedThreadIds : [])
      .map(normalizedId)
      .filter(Boolean));
    const candidates = [];
    const candidateSet = new Set();
    const addCandidate = (value) => {
      const threadId = normalizedId(value);
      if (!threadId || candidateSet.has(threadId)) return;
      candidateSet.add(threadId);
      candidates.push(threadId);
    };

    if (!this.state.initialized) {
      for (const [threadId, thread] of current) {
        this.state.threads[threadId] = normalizedRecord({ cursor: cursorFor(thread) });
      }
      this.state.initialized = true;
      this.dirty = true;
    } else {
      for (const [threadId, thread] of current) {
        const record = this.state.threads[threadId];
        if (!record || record.cursor !== cursorFor(thread) || record.retry) addCandidate(threadId);
        if (record?.pendingTurnId && !loaded.has(threadId)) addCandidate(threadId);
      }
    }

    for (const value of nativeUnreadThreadIds) {
      const threadId = normalizedId(value);
      const record = this.state.threads[threadId];
      if (!record
        || record.retry
        || !record.latestTurnId
        || ["inProgress", "running"].includes(record.latestStatus)) {
        addCandidate(threadId);
      }
    }

    for (const [threadId, record] of Object.entries(this.state.threads)) {
      if (!current.has(threadId) && !record.pendingTurnId) {
        delete this.state.threads[threadId];
        this.dirty = true;
      }
    }
    return candidates;
  }

  record(thread, detail, { forcePending = false } = {}) {
    const detailThread = detail?.thread ?? detail;
    const threadId = normalizedId(thread?.id || detailThread?.id);
    if (!threadId) return false;
    const previous = normalizedRecord(this.state.threads[threadId]);
    const latestTurn = (detailThread?.turns ?? []).at(-1);
    const turnId = String(latestTurn?.id || "");
    const status = String(latestTurn?.status || (latestTurn ? "unknown" : "empty"));
    const snapshot = latestCompletedSnapshot(detailThread);
    let pendingTurnId = previous.pendingTurnId;

    if (snapshot?.assistantMessage) {
      const changedResult = snapshot.turnId !== previous.latestTurnId
        || previous.latestStatus !== "completed"
        || snapshot.sourceMessageId !== previous.latestMessageId;
      if (previous.pendingTurnId === snapshot.turnId) {
        pendingTurnId = snapshot.turnId;
      } else if (previous.handledTurnId === snapshot.turnId) {
        pendingTurnId = "";
      } else if (changedResult || forcePending) {
        pendingTurnId = snapshot.turnId;
      }
    } else if (latestTurn && status !== "completed") {
      pendingTurnId = "";
    }

    const next = normalizedRecord({
      ...previous,
      cursor: cursorFor(thread ?? detailThread),
      latestTurnId: turnId,
      latestStatus: status,
      latestMessageId: snapshot?.sourceMessageId || "",
      pendingTurnId,
      retry: status === "completed" && !snapshot?.assistantMessage,
    });
    if (JSON.stringify(previous) === JSON.stringify(next)) return false;
    this.state.threads[threadId] = next;
    this.dirty = true;
    return true;
  }

  markHandled(value, turnId = "") {
    const threadId = normalizedId(value);
    const previous = this.state.threads[threadId];
    if (!previous?.pendingTurnId) return false;
    this.state.threads[threadId] = normalizedRecord({
      ...previous,
      handledTurnId: String(turnId || previous.pendingTurnId),
      pendingTurnId: "",
    });
    this.dirty = true;
    return true;
  }

  shouldNotify(value, turnId = "") {
    const threadId = normalizedId(value);
    const record = this.state.threads[threadId];
    const candidateTurnId = String(turnId || record?.pendingTurnId || "");
    return Boolean(
      record?.pendingTurnId
      && candidateTurnId === record.pendingTurnId
      && record.notifiedTurnId !== candidateTurnId,
    );
  }

  markNotified(value, turnId = "") {
    const threadId = normalizedId(value);
    const previous = this.state.threads[threadId];
    const candidateTurnId = String(turnId || previous?.pendingTurnId || "");
    if (!previous?.pendingTurnId
      || candidateTurnId !== previous.pendingTurnId
      || previous.notifiedTurnId === candidateTurnId) return false;
    this.state.threads[threadId] = normalizedRecord({
      ...previous,
      notifiedTurnId: candidateTurnId,
    });
    this.dirty = true;
    return true;
  }

  pendingThreadIds() {
    return Object.entries(this.state.threads)
      .filter(([, record]) => record.pendingTurnId)
      .map(([threadId]) => threadId);
  }

  toJSON() {
    return {
      schemaVersion: SCHEMA_VERSION,
      initialized: this.state.initialized,
      threads: this.state.threads,
    };
  }

  markClean() {
    this.dirty = false;
  }
}

export async function loadAttentionLedger(filePath) {
  try {
    return new AttentionLedger(JSON.parse(await readFile(filePath, "utf8")));
  } catch (_) {
    return new AttentionLedger();
  }
}

export async function saveAttentionLedger(filePath, ledger) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(ledger.toJSON(), null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
  ledger.markClean();
}
