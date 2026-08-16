export async function applyTitleDecision(item, { appServer, titleLedger }) {
  const fresh = await appServer.readThread(item.threadId);
  const thread = fresh?.thread;
  if (!titleLedger.shouldEvaluate(thread, item.turnId)) return { item, change: null };
  if (["keep", "suggest_new_thread"].includes(item.titleDecision)) {
    titleLedger.recordEvaluated(thread, item.turnId);
    return { item, change: null };
  }
  if (!["update_chapter", "replace_workstream"].includes(item.titleDecision)) {
    return { item, change: null };
  }

  const currentTitle = String(thread?.name || "").replace(/\s+/g, " ").trim();
  const proposedTitle = String(item.proposedTitle || "").replace(/\s+/g, " ").trim();
  if (!currentTitle || currentTitle !== item.nativeTitle || !proposedTitle) {
    titleLedger.observe(thread);
    return { item, change: null };
  }
  if (titleLedger.isSuppressed(item.threadId, proposedTitle)) {
    titleLedger.recordEvaluated(thread, item.turnId);
    return { item, change: null };
  }

  try {
    await appServer.setThreadName(item.threadId, proposedTitle);
    const verified = await appServer.readThread(item.threadId);
    if (String(verified?.thread?.name || "").trim() !== proposedTitle) {
      titleLedger.recordEvaluated(thread, item.turnId);
      return { item, change: null };
    }
    titleLedger.recordApplied({
      threadId: item.threadId,
      previousTitle: currentTitle,
      title: proposedTitle,
      turnId: item.turnId,
      sourceMessageId: item.sourceMessageId,
      confidence: item.titleConfidence,
    });
    return {
      item: { ...item, nativeTitle: proposedTitle },
      change: {
        type: "title_changed",
        decision: item.titleDecision,
        threadId: item.threadId,
        turnId: item.turnId,
        previousTitle: currentTitle,
        title: proposedTitle,
      },
    };
  } catch (_) {
    titleLedger.recordEvaluated(thread, item.turnId);
    return { item, change: null };
  }
}

export async function undoTitleChange(threadId, { appServer, titleLedger }) {
  const fresh = await appServer.readThread(threadId);
  titleLedger.observe(fresh?.thread);
  const candidate = titleLedger.undoCandidate(threadId);
  if (!candidate || fresh?.thread?.name !== candidate.title) return null;
  await appServer.setThreadName(threadId, candidate.previousTitle);
  const verified = await appServer.readThread(threadId);
  if (verified?.thread?.name !== candidate.previousTitle) return null;
  titleLedger.recordUndone(threadId);
  return {
    type: "title_undone",
    threadId,
    previousTitle: candidate.title,
    title: candidate.previousTitle,
  };
}
