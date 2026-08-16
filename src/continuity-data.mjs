import path from "node:path";

import { latestCompletedSnapshot } from "./completed-turn.mjs";
import { loadReturnPoints } from "./return-point.mjs";

export { latestCompletedSnapshot } from "./completed-turn.mjs";

const UNKNOWN_PROJECT = "其他";

function timestamp(thread) {
  return thread.recencyAt ?? thread.updatedAt ?? thread.createdAt ?? 0;
}

function title(thread) {
  const spawn = subAgentSpawn(thread);
  const fallback = spawn?.agent_path?.split("/").filter(Boolean).at(-1)
    || (spawn?.agent_nickname ? `Agent ${spawn.agent_nickname}` : "未命名任务");
  return String(thread.name || (spawn ? fallback : thread.preview) || fallback).split("\n", 1)[0].trim().slice(0, 80) || fallback;
}

function subAgentSpawn(thread) {
  return thread?.source?.subAgent?.thread_spawn
    || thread?.threadSource?.subAgent?.thread_spawn
    || null;
}

function parentThreadId(thread) {
  return thread.parentThreadId
    || subAgentSpawn(thread)?.parent_thread_id
    || null;
}

function isSubAgentThread(thread) {
  return Boolean(subAgentSpawn(thread));
}

function sourceLabel(thread) {
  const spawn = subAgentSpawn(thread);
  if (spawn) return `Agent · ${spawn.agent_nickname || spawn.agent_role || "subagent"}`;
  return typeof thread.source === "string" ? thread.source : "unknown";
}

function projectName(cwd) {
  if (!cwd) return UNKNOWN_PROJECT;
  const base = path.basename(String(cwd).replace(/[\\/]+$/, ""));
  return base.replaceAll("_", " ").replaceAll("-", " ").trim() || UNKNOWN_PROJECT;
}

function relativeTime(epochSeconds, nowMs) {
  if (!epochSeconds) return "时间未知";
  const seconds = Math.max(0, Math.floor(nowMs / 1_000 - epochSeconds));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return `${Math.floor(seconds / 604_800)} 周前`;
}

function activeFlags(thread) {
  return thread.status?.type === "active" ? thread.status.activeFlags ?? [] : [];
}

function threadStatus(thread) {
  if (activeFlags(thread).includes("waitingOnApproval")) return "attention";
  if (thread.status?.type === "active") return "running";
  if (thread.status?.type === "idle") return "ready";
  return "unknown";
}

function groupStatus(threads) {
  const statuses = threads.map(threadStatus);
  if (statuses.includes("attention")) return "attention";
  if (statuses.includes("running")) return "running";
  if (statuses.includes("ready")) return "ready";
  return "unknown";
}

function trimText(value, limit) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function firstReplyLine(value, limit) {
  const line = String(value || "").split(/\n+/).map((item) => item.trim()).find(Boolean) || "";
  return trimText(line, limit);
}

function sessionKey(thread) {
  return parentThreadId(thread)
    || thread.forkedFromId
    || (thread.sessionId && thread.sessionId !== thread.id ? thread.sessionId : thread.id);
}

export function buildAttentionItems(
  threads,
  {
    attentionThreadIds = [],
    detailsById = new Map(),
    nowMs = Date.now(),
  } = {},
) {
  const threadsById = new Map(threads.filter((thread) => thread?.id).map((thread) => [thread.id, thread]));
  const seen = new Set();
  const items = [];

  for (const value of attentionThreadIds) {
    const threadId = String(value || "").trim().replace(/^(?:local|cloud):/i, "");
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    const thread = threadsById.get(threadId);
    if (!thread || isSubAgentThread(thread)) continue;
    const snapshot = latestCompletedSnapshot(detailsById.get(threadId)?.thread);
    if (!snapshot?.assistantMessage) continue;
    const recencyAt = snapshot.completedAt || timestamp(thread);
    items.push({
      kind: "attention",
      threadId,
      worklineId: sessionKey(thread),
      project: projectName(thread.cwd),
      nativeTitle: title(thread),
      chapter: "",
      excerpt: firstReplyLine(snapshot.assistantMessage, 180),
      updated: relativeTime(recencyAt, nowMs),
      recencyAt,
      turnId: snapshot.turnId,
      sourceMessageId: snapshot.sourceMessageId,
    });
  }

  return items.sort((left, right) => right.recencyAt - left.recencyAt);
}

export function buildContinuityViewModel(
  threads,
  {
    focusThreadId = "",
    detailsById = new Map(),
    goalsById = new Map(),
    returnPointsById = new Map(),
    attentionThreadIds = [],
    nowMs = Date.now(),
  } = {},
) {
  const groups = new Map();
  for (const thread of threads) {
    if (!thread?.id) continue;
    const key = sessionKey(thread);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(thread);
  }

  const focusThread = threads.find((thread) => thread.id === focusThreadId);
  const focusWorklineId = focusThread ? sessionKey(focusThread) : "";
  const worklines = [...groups.entries()].map(([id, members]) => {
    members.sort((left, right) => timestamp(right) - timestamp(left));
    const latest = members[0];
    const focusedMember = members.find((thread) => thread.id === focusThreadId);
    const parent = members.find((thread) => thread.id === id && !isSubAgentThread(thread));
    const head = parent ?? focusedMember ?? latest;
    const detail = detailsById.get(head.id)?.thread;
    const goal = goalsById.get(head.id)?.goal;
    const snapshot = returnPointsById.get(head.id) ?? latestCompletedSnapshot(detail);
    const status = groupStatus(members);
    const project = projectName(head.cwd);
    const detailLoaded = returnPointsById.has(head.id) || detailsById.has(head.id) || goalsById.has(head.id);
    const checkpoint = snapshot?.checkpoint || snapshot?.assistantMessage;
    const hasSnapshot = Boolean(checkpoint);
    const hasGoal = Boolean(goal?.objective && !["complete", "blocked"].includes(goal.status));
    const returnPointConfidence = hasGoal ? "confirmed" : snapshot?.confidence || "unknown";
    const nextAction = hasGoal
      ? goal.objective
      : snapshot?.nextAction || "下一步待确认；打开原任务查看最近完整回复。";
    const sourceTimestamp = snapshot?.sealedAt ? Date.parse(snapshot.sealedAt) / 1_000 : timestamp(head);
    return {
      id,
      project,
      projectShort: project,
      title: title(head),
      threadTitle: title(head),
      threadId: head.id,
      status,
      taskCount: members.length,
      agentCount: members.filter((thread) => thread.status?.type === "active").length,
      updated: relativeTime(timestamp(latest), nowMs),
      recencyAt: timestamp(latest),
      detailState: detailLoaded ? "ready" : "unloaded",
      focusLabel: hasSnapshot
        ? "可追溯返回点 · 最近最终回复"
        : "App Server 元数据 · 停点待确认",
      checkpointLabel: hasSnapshot ? "已到这里" : "当前状态",
      checkpoint: hasSnapshot
        ? checkpoint
        : "尚未读取到已完成的最终回复；原任务仍是权威来源。",
      nextAction,
      nextActionLabel: returnPointConfidence === "candidate" ? "候选下一步" : "下一步",
      returnPointConfidence,
      returnPointRank: hasGoal ? 3 : snapshot?.confidence === "explicit" ? 2 : snapshot?.confidence === "candidate" ? 1 : 0,
      changed: hasSnapshot
        ? "最近最终回复已从 Codex 原始会话尾部提取，未复制完整对话。"
        : "当前只有任务元数据，Continuity 没有伪造返回点。",
      contextMeta: members.length > 1
        ? `${members.length - 1} 个子 Agent 通过显式父任务关系归入这条工作线`
        : "未发现确定性子任务关系，不自动合并",
      attention: status === "attention" ? "Codex 正在等待你批准操作。" : null,
      tasks: members.map((thread) => ({
        title: title(thread),
        status: threadStatus(thread),
        meta: `${sourceLabel(thread)} · ${relativeTime(timestamp(thread), nowMs)}`,
      })),
      evidence: [
        "任务 ID、标题、工作区和运行状态来自 Codex App Server。",
        members.length > 1
          ? `这 ${members.length - 1} 个子 Agent 都显式记录了同一父任务 ID。`
          : "没有确定性子任务关系，因此保持为独立工作线。",
        hasGoal
          ? "下一步来自该任务的持久 Goal。"
          : snapshot?.confidence === "explicit"
            ? "下一步来自最近最终回复中的明确标记。"
            : snapshot?.confidence === "candidate"
              ? "该行动没有“下一步”明确标记，因此显示为候选。"
              : "未设置持久 Goal，也没有提取到明确下一步。",
      ],
      userMessage: snapshot?.userMessage || trimText(head.preview, 280) || "该任务没有可用预览。",
      assistantMessage: snapshot?.assistantMessage || "这条工作线尚未提取可靠停点。打开原任务后仍可查看完整记录。",
      workspaceMeta: head.cwd || "工作区未知",
      sourceMeta: `${title(head)} · ${relativeTime(sourceTimestamp, nowMs)}`,
      sourceMessageId: snapshot?.sourceMessageId || "",
      timelineLabel: hasSnapshot ? "Codex 原任务返回点" : "App Server 任务快照",
    };
  });

  worklines.sort((left, right) => {
    const leftFocused = left.id === focusWorklineId ? 1 : 0;
    const rightFocused = right.id === focusWorklineId ? 1 : 0;
    if (leftFocused !== rightFocused) return rightFocused - leftFocused;
    const leftThread = threads.find((thread) => thread.id === left.threadId);
    const rightThread = threads.find((thread) => thread.id === right.threadId);
    return timestamp(rightThread ?? {}) - timestamp(leftThread ?? {});
  });

  const projectOrder = [...new Set(worklines.map((item) => item.project))];
  const projectReturnPoints = projectOrder.map((project) => {
    const candidates = worklines.filter((item) => item.project === project);
    const focused = candidates.find((item) => item.id === focusWorklineId);
    const activeGoal = [...candidates]
      .filter((item) => item.returnPointRank === 3)
      .sort((left, right) => right.recencyAt - left.recencyAt)[0];
    const selected = focused ?? activeGoal ?? [...candidates]
      .sort((left, right) => right.recencyAt - left.recencyAt || right.returnPointRank - left.returnPointRank)[0];
    return {
      project,
      worklineId: selected.id,
      threadId: selected.threadId,
      threadTitle: selected.threadTitle,
      checkpoint: selected.checkpoint,
      nextAction: selected.nextAction,
      nextActionLabel: selected.nextActionLabel,
      confidence: selected.returnPointConfidence,
      sourceMeta: selected.sourceMeta,
    };
  });
  const worklineIdByThreadId = new Map();
  for (const item of worklines) {
    for (const thread of groups.get(item.id) ?? []) worklineIdByThreadId.set(thread.id, item.id);
  }
  const humanThreads = threads.filter((thread) => !isSubAgentThread(thread));
  const rawTasks = humanThreads.map((thread) => ({
    title: title(thread),
    project: projectName(thread.cwd),
    id: worklineIdByThreadId.get(thread.id) ?? sessionKey(thread),
    status: threadStatus(thread),
    time: relativeTime(timestamp(thread), nowMs),
  }));

  return {
    state: worklines.length ? "ready" : "empty",
    source: "app-server",
    activeId: worklines[0]?.id ?? "",
    worklines,
    rawTasks,
    projectOrder,
    projectReturnPoints,
    attentionItems: buildAttentionItems(threads, {
      attentionThreadIds,
      detailsById,
      nowMs,
    }),
    threadCount: humanThreads.length,
    agentThreadCount: threads.length - humanThreads.length,
  };
}

async function loadGoals(client, threads, concurrency = 8) {
  const goalsById = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, threads.length) }, async () => {
    while (cursor < threads.length) {
      const thread = threads[cursor++];
      try {
        const result = await client.getGoal(thread.id);
        if (result?.goal) goalsById.set(thread.id, result);
      } catch (_) {}
    }
  }));
  return goalsById;
}

export async function loadContinuitySnapshot(client, { focusThreadId = "", limit = 100 } = {}) {
  return (await loadContinuityRuntime(client, { focusThreadId, limit })).snapshot;
}

export async function loadContinuityRuntime(client, { focusThreadId = "", limit = 100 } = {}) {
  const [rootThreads, agentThreads] = await Promise.all([
    client.listThreads({
      limit,
      sourceKinds: ["cli", "vscode"],
    }),
    client.listThreads({
      limit: Math.max(limit * 4, 400),
      sourceKinds: ["subAgent", "subAgentThreadSpawn"],
    }),
  ]);
  const rootIds = new Set(rootThreads.map((thread) => thread.id));
  const threads = [
    ...rootThreads,
    ...agentThreads.filter((thread) => rootIds.has(parentThreadId(thread))),
  ];
  if (!threads.length) {
    return {
      snapshot: buildContinuityViewModel([], { focusThreadId }),
      threads,
      detailsById: new Map(),
      goalsById: new Map(),
      returnPointsById: new Map(),
    };
  }
  const [returnPointsById, goalsById] = await Promise.all([
    loadReturnPoints(rootThreads),
    loadGoals(client, rootThreads),
  ]);
  const detailsById = new Map();
  return {
    snapshot: buildContinuityViewModel(threads, {
      focusThreadId: threads.find((thread) => thread.id === focusThreadId)?.id ?? threads[0].id,
      detailsById,
      goalsById,
      returnPointsById,
    }),
    threads,
    detailsById,
    goalsById,
    returnPointsById,
  };
}
