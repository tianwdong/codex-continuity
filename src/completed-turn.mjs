function boundedContext(value, limit) {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= limit) return normalized;
  const separator = "\n\n[…中间内容已省略…]\n\n";
  const remaining = limit - separator.length;
  const headLength = Math.floor(remaining * 0.4);
  return `${normalized.slice(0, headLength).trimEnd()}${separator}${normalized.slice(-(remaining - headLength)).trimStart()}`;
}

function removeAmbientContext(value) {
  return String(value || "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/gi, "")
    .trim();
}

export function latestCompletedSnapshot(thread) {
  const turn = (thread?.turns ?? []).at(-1);
  if (!turn || turn.status !== "completed") return null;
  const userItem = turn.items?.find((item) => item.type === "userMessage");
  const finalItem = [...(turn.items ?? [])].reverse().find(
    (item) => item.type === "agentMessage" && item.phase === "final_answer" && item.text,
  );
  const userText = userItem?.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (!userText && !finalItem?.text) return null;
  return {
    turnId: String(turn.id || ""),
    completedAt: Number(turn.completedAt || turn.startedAt || 0),
    userMessage: boundedContext(removeAmbientContext(userText), 2_000),
    assistantMessage: boundedContext(finalItem?.text, 6_000),
    sourceMessageId: String(finalItem?.id || ""),
  };
}
