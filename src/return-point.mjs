import { open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FINAL_ANSWER_MARKER = Buffer.from('"phase":"final_answer"');
const USER_MESSAGE_MARKER = Buffer.from('"role":"user"');
const SCAN_BLOCK_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_LINE_WINDOW_BYTES = 2 * 1024 * 1024;
const MAX_USER_CONTEXT_CHARS = 2_000;
const MAX_ASSISTANT_CONTEXT_CHARS = 6_000;

function trimText(value, limit) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function withoutMachineFooter(value) {
  return String(value || "")
    .replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
}

function withoutAmbientContext(value) {
  return String(value || "")
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>\s*/gi, "")
    .trim();
}

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
  const tailLength = remaining - headLength;
  return `${normalized.slice(0, headLength).trimEnd()}${separator}${normalized.slice(-tailLength).trimStart()}`;
}

function cleanMarkdown(value) {
  return String(value || "")
    .replace(/^\s*>\s?/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function paragraphs(value) {
  return withoutMachineFooter(value)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.split("\n").map(cleanMarkdown).filter(Boolean).join(" "))
    .filter(Boolean);
}

function labeledNextAction(value) {
  const lines = withoutMachineFooter(value).split("\n").map(cleanMarkdown);
  const label = /^(?:下一步(?:建议|计划)?|接下来|后续(?:步骤|行动)?|待办)\s*[:：]?\s*(.*)$/;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(label);
    if (!match) continue;
    if (match[1] && !/[:：]$/.test(match[1])) return trimText(match[1], 360);
    const following = lines.slice(index + 1).find(Boolean);
    if (following && !/[:：]$/.test(following)) return trimText(following, 360);
  }
  for (const line of lines) {
    const match = line.match(/(?:^|[。！？；]\s*)(下一步\s*[:：]?\s*[^。！？]*(?:[。！？]|$))/);
    if (match) return trimText(match[1].replace(/^下一步\s*[:：]?\s*/, ""), 360);
  }
  return "";
}

function candidateNextAction(items) {
  const actionCue = /(?:等.{0,40}时|仍需|还需|需要你|需要用户|请(?!求)|再(?:用|执行|运行|完成|验证|测试|确认|批准)|继续(?:进行|完成|处理|推进)|批准|复验)/;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const sentences = item.split(/(?<=[。！？；])\s*/).filter(Boolean);
    const sentence = [...sentences].reverse().find((candidate) => actionCue.test(candidate));
    if (sentence) {
      const continuation = /[:：]$/.test(sentence) ? items[index + 1] : "";
      return trimText(`${sentence}${continuation ? ` ${continuation}` : ""}`, 360);
    }
  }
  return "";
}

export function extractReturnPointFromFinalAnswer(
  text,
  { sealedAt = "", sourceMessageId = "", userMessage = "" } = {},
) {
  const items = paragraphs(text);
  if (!items.length) return null;
  const explicitAction = labeledNextAction(text);
  const candidateAction = explicitAction ? "" : candidateNextAction(items);
  const nextAction = explicitAction || trimText(candidateAction, 360);
  const checkpoint = items.find(
    (item) => item !== candidateAction && item !== explicitAction && !/[:：]$/.test(item),
  ) || items[0];
  return {
    checkpoint: trimText(checkpoint, 360),
    nextAction,
    confidence: explicitAction ? "explicit" : candidateAction ? "candidate" : "unknown",
    userMessage: boundedContext(withoutAmbientContext(userMessage), MAX_USER_CONTEXT_CHARS),
    assistantMessage: boundedContext(withoutMachineFooter(text), MAX_ASSISTANT_CONTEXT_CHARS),
    sealedAt,
    sourceMessageId,
  };
}

async function findMarkerBefore(file, fileSize, endOffset, marker = FINAL_ANSWER_MARKER) {
  const lowerBound = Math.max(0, fileSize - MAX_SCAN_BYTES);
  let cursor = endOffset;
  let suffix = Buffer.alloc(0);
  while (cursor > lowerBound) {
    const length = Math.min(SCAN_BLOCK_BYTES, cursor - lowerBound);
    cursor -= length;
    const block = Buffer.alloc(length);
    await file.read(block, 0, length, cursor);
    const combined = Buffer.concat([block, suffix]);
    const index = combined.lastIndexOf(marker);
    if (index >= 0 && cursor + index < endOffset) return cursor + index;
    suffix = block.subarray(0, marker.length - 1);
  }
  return -1;
}

function messageText(payload, acceptedTypes) {
  return payload?.content
    ?.filter((part) => acceptedTypes.includes(part.type))
    .map((part) => part.text)
    .join("\n");
}

async function readUserMessageBefore(file, fileSize, endOffset) {
  let cursor = endOffset;
  while (cursor > Math.max(0, fileSize - MAX_SCAN_BYTES)) {
    const markerOffset = await findMarkerBefore(
      file,
      fileSize,
      cursor,
      USER_MESSAGE_MARKER,
    );
    if (markerOffset < 0) return "";
    const record = await readRecordAt(file, fileSize, markerOffset);
    const payload = record?.payload;
    if (record?.type === "response_item"
      && payload?.type === "message"
      && payload.role === "user") {
      return withoutAmbientContext(messageText(payload, ["input_text", "text"]) || "");
    }
    cursor = markerOffset;
  }
  return "";
}

async function readRecordAt(file, fileSize, offset) {
  const before = Math.min(offset, MAX_LINE_WINDOW_BYTES);
  const after = Math.min(fileSize - offset, MAX_LINE_WINDOW_BYTES);
  const window = Buffer.alloc(before + after);
  const windowStart = offset - before;
  await file.read(window, 0, window.length, windowStart);
  const markerIndex = before;
  const previousNewline = window.lastIndexOf(10, markerIndex);
  const nextNewline = window.indexOf(10, markerIndex);
  if ((previousNewline < 0 && windowStart > 0)
    || (nextNewline < 0 && windowStart + window.length < fileSize)) return null;
  const start = previousNewline + 1;
  const end = nextNewline >= 0 ? nextNewline : window.length;
  try {
    return JSON.parse(window.subarray(start, end).toString("utf8"));
  } catch (_) {
    return null;
  }
}

export async function readLatestFinalAnswer(sessionPath) {
  const file = await open(sessionPath, "r");
  try {
    const { size } = await file.stat();
    let endOffset = size;
    while (endOffset > Math.max(0, size - MAX_SCAN_BYTES)) {
      const markerOffset = await findMarkerBefore(file, size, endOffset);
      if (markerOffset < 0) return null;
      const record = await readRecordAt(file, size, markerOffset);
      const payload = record?.payload;
      if (record?.type === "response_item"
        && payload?.type === "message"
        && payload.role === "assistant"
        && payload.phase === "final_answer") {
        const text = messageText(payload, ["output_text", "text"]);
        if (text) {
          return {
            text,
            userMessage: await readUserMessageBefore(file, size, markerOffset),
            sealedAt: record.timestamp || "",
            sourceMessageId: payload.id || "",
          };
        }
      }
      endOffset = markerOffset;
    }
    return null;
  } finally {
    await file.close();
  }
}

export function isCodexSessionPath(value, homeDirectory = os.homedir()) {
  if (!value || path.extname(String(value)) !== ".jsonl") return false;
  const candidate = path.resolve(String(value));
  return ["sessions", "archived_sessions"].some((directory) => {
    const root = path.resolve(homeDirectory, ".codex", directory);
    return candidate.startsWith(`${root}${path.sep}`);
  });
}

export async function readThreadReturnPoint(thread) {
  if (!isCodexSessionPath(thread?.path)) return null;
  try {
    const finalAnswer = await readLatestFinalAnswer(thread.path);
    return finalAnswer ? extractReturnPointFromFinalAnswer(finalAnswer.text, finalAnswer) : null;
  } catch (_) {
    return null;
  }
}

export async function loadReturnPoints(threads, { concurrency = 8 } = {}) {
  const returnPoints = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, threads.length) }, async () => {
    while (cursor < threads.length) {
      const thread = threads[cursor++];
      const returnPoint = await readThreadReturnPoint(thread);
      if (returnPoint) returnPoints.set(thread.id, returnPoint);
    }
  }));
  return returnPoints;
}
