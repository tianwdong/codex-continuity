import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { startAppServer } from "./app-server-client.mjs";
import { loadAttentionLedger, saveAttentionLedger } from "./attention-ledger.mjs";
import { CdpPipeClient } from "./cdp-pipe.mjs";
import {
  buildAttentionItems,
  buildContinuityViewModel,
  loadContinuityRuntime,
} from "./continuity-data.mjs";
import { buildEmbeddedDocument } from "./embedded-document.mjs";
import { buildInjectionSource, isCodexTarget } from "./injection-source.mjs";
import {
  matchGoalWithCodex,
  organizeSnapshotWithCodex,
  withRulesOrganization,
} from "./semantic-organizer.mjs";

const appCandidates = [
  "/Applications/Codex.app/Contents/MacOS/Codex",
  path.join(os.homedir(), "Applications/Codex.app/Contents/MacOS/Codex"),
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  path.join(os.homedir(), "Applications/ChatGPT.app/Contents/MacOS/ChatGPT"),
];
const supportDirectory = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Codex Continuity",
);
const profileDirectory = path.join(supportDirectory, "codex-profile");
const attentionStatePath = path.join(supportDirectory, "attention-state.json");
const ATTENTION_REFRESH_MS = 5_000;

function isRootThread(thread) {
  return !Boolean(
    thread?.source?.subAgent?.thread_spawn
    || thread?.threadSource?.subAgent?.thread_spawn,
  );
}

async function settleWithConcurrency(values, worker, concurrency = 8) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await worker(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

async function resolveCodexExecutable() {
  for (const candidate of appCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error("未找到 /Applications/Codex.app 或 /Applications/ChatGPT.app");
}

async function resolveAppServerExecutable(appExecutable) {
  const candidates = [
    path.join(path.dirname(appExecutable), "..", "Resources", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error("未找到可用的 Codex App Server runtime");
}

function childEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_INSPECTOR_IPC;
  delete environment.CODEX_THREAD_ID;
  return environment;
}

function semanticEnvironment() {
  const keys = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
  ];
  return Object.fromEntries(
    keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
}

async function injectTarget(client, target, source) {
  const session = await client.connect(target.targetId);
  try {
    await session.send("Page.enable");
    await session.send("Page.setBypassCSP", { enabled: true });
    await session.send("Runtime.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
    await session.send("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
    });
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}

async function readStatus(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const host = window.__codexContinuityHost__;
      return {
        href: window.location.href,
        title: document.title,
        sidebarReady: Boolean(document.querySelector('[data-app-action-sidebar-scroll]')),
        mainReady: Boolean(document.querySelector('[data-app-shell-main-content-layout]')),
        host: host ? {
          version: host.version,
          active: host.active,
          entryMounted: host.entryMounted,
          sidebarMounted: host.sidebarMounted,
          returnPointCount: host.returnPointCount,
          dataReady: host.dataReady,
          frameMounted: host.frameMounted,
          frameReady: host.frameReady,
          frameName: host.frameName,
          nativeActiveThreadId: host.nativeActiveThreadId,
          nativeUnreadThreadIds: host.nativeUnreadThreadIds,
          goalMatchMounted: host.goalMatchMounted,
          goalMatchPending: host.goalMatchPending
        } : null
      };
    })()`,
    returnByValue: true,
  });
  return result.result?.value ?? null;
}

function findFrameByName(frameTree, expectedName) {
  if (frameTree.frame?.name === expectedName) return frameTree.frame;
  for (const child of frameTree.childFrames ?? []) {
    const match = findFrameByName(child, expectedName);
    if (match) return match;
  }
  return null;
}

async function loadEmbeddedFrame(session, frameName, html) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { frameTree } = await session.send("Page.getFrameTree");
    const frame = findFrameByName(frameTree, frameName);
    if (frame) {
      await session.send("Page.setDocumentContent", { frameId: frame.id, html });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Continuity iframe did not appear in the Codex renderer");
}

async function takeThreadRequest(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "window.__codexContinuityHost__?.takeThreadRequest?.() || ''",
    returnByValue: true,
  });
  return String(result.result?.value || "");
}

async function takeThreadActivationRequest(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "window.__codexContinuityHost__?.takeThreadActivationRequest?.() || ''",
    returnByValue: true,
  });
  return String(result.result?.value || "");
}

async function takeDetailRequest(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "window.__codexContinuityHost__?.takeDetailRequest?.() || ''",
    returnByValue: true,
  });
  return String(result.result?.value || "");
}

async function takeRefreshRequest(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "window.__codexContinuityHost__?.takeRefreshRequest?.() || ''",
    returnByValue: true,
  });
  return String(result.result?.value || "");
}

async function takeOrganizationRequest(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "window.__codexContinuityHost__?.takeOrganizationRequest?.() || ''",
    returnByValue: true,
  });
  const mode = String(result.result?.value || "");
  return mode === "rules" || mode === "codex" ? mode : "";
}

async function takeGoalMatchRequest(session) {
  const result = await session.send("Runtime.evaluate", {
    expression: "window.__codexContinuityHost__?.takeGoalMatchRequest?.() || null",
    returnByValue: true,
  });
  const value = result.result?.value;
  const requestId = Number(value?.requestId || 0);
  const goal = String(value?.goal || "").trim();
  return requestId > 0 && goal ? { requestId, goal } : null;
}

async function finishGoalMatch(session, request, result) {
  const method = result?.state === "ready" ? "completeGoalMatch" : "failGoalMatch";
  const args = method === "completeGoalMatch"
    ? [request.requestId, request.goal, result.match]
    : [request.requestId, request.goal];
  await session.send("Runtime.evaluate", {
    expression: `window.__codexContinuityHost__?.${method}?.(...${JSON.stringify(args)})`,
    returnByValue: true,
  });
}

function withCodexOrganizationState(snapshot, state, codexAvailable) {
  return {
    ...snapshot,
    organization: {
      mode: "codex",
      state,
      enhancedCount: 0,
      fallbackCount: (snapshot.worklines ?? []).filter(
        (item) => item.returnPointConfidence !== "confirmed",
      ).length,
      message: state === "loading"
        ? "正在判断最近任务是已结束、等你回复，还是可以继续。"
        : "当前没有可用的 Codex 登录态，只显示 Goal 等确定结果。",
      codexAvailable,
    },
  };
}

async function finishThreadRequest(session, threadId, { outcome = null, error = null } = {}) {
  const method = error
    ? "failThreadOpen"
    : outcome?.state === "alreadyActive"
      ? "markThreadActiveElsewhere"
      : "completeThreadOpen";
  const args = error
    ? [threadId, "这次没有打开。你仍可以从 Codex 左侧找到这个对话。"]
    : [threadId];
  await session.send("Runtime.evaluate", {
    expression: `window.__codexContinuityHost__?.${method}?.(...${JSON.stringify(args)})`,
    returnByValue: true,
  });
}

function openOfficialCodexThread(threadId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/open",
      ["-b", "com.openai.codex", `codex://threads/${encodeURIComponent(threadId)}`],
      { env: childEnvironment(), stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open exited with code ${code ?? "unknown"}`));
    });
  });
}

async function finishThreadActivation(session, threadId, error = null) {
  const method = error ? "failThreadActivation" : "completeThreadActivation";
  const args = error ? [threadId, "现在无法前往那个窗口。"] : [threadId];
  await session.send("Runtime.evaluate", {
    expression: `window.__codexContinuityHost__?.${method}?.(...${JSON.stringify(args)})`,
    returnByValue: true,
  });
}

async function updateEmbeddedData(session, data) {
  await session.send("Runtime.evaluate", {
    expression: `window.__codexContinuityHost__?.updateData?.(${JSON.stringify(data)})`,
    returnByValue: true,
  });
}

async function failDetailRequest(session, threadId) {
  await session.send("Runtime.evaluate", {
    expression: `window.__codexContinuityHost__?.failThreadDetail?.(...${JSON.stringify([
      threadId,
      "App Server 暂时无法读取这个任务的停点。",
    ])})`,
    returnByValue: true,
  });
}

async function loadThreadDetail(
  appServer,
  threadId,
  continuityThreads,
  detailsById,
  goalsById,
  returnPointsById,
) {
  const [detailResult, goalResult] = await Promise.allSettled([
    appServer.readThread(threadId),
    appServer.getGoal(threadId),
  ]);
  if (detailResult.status === "rejected") throw detailResult.reason;
  detailsById.set(threadId, detailResult.value);
  if (goalResult.status === "fulfilled") goalsById.set(threadId, goalResult.value);
  return buildContinuityViewModel(continuityThreads, {
    focusThreadId: threadId,
    detailsById,
    goalsById,
    returnPointsById,
  });
}

async function main() {
  const executable = await resolveCodexExecutable();
  const appServerExecutable = await resolveAppServerExecutable(executable);
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const attentionLedger = await loadAttentionLedger(attentionStatePath);
  const capability = randomUUID();
  let appServer = null;
  let continuityData;
  let rulesData;
  let continuityThreads = [];
  let attentionThreads = [];
  let detailsById = new Map();
  let goalsById = new Map();
  let returnPointsById = new Map();
  let organizationMode = "rules";
  let codexAvailable = false;
  try {
    appServer = await startAppServer({
      command: appServerExecutable,
      env: childEnvironment(),
    });
    const [runtime, managedAccountAvailable] = await Promise.all([
      loadContinuityRuntime(appServer, {
        focusThreadId: process.env.CODEX_THREAD_ID || "",
        limit: 50,
      }),
      appServer.hasManagedAccount(),
    ]);
    codexAvailable = managedAccountAvailable;
    rulesData = withRulesOrganization(runtime.snapshot, { codexAvailable });
    continuityData = rulesData;
    continuityThreads = runtime.threads;
    attentionThreads = runtime.threads.filter(isRootThread);
    detailsById = runtime.detailsById;
    goalsById = runtime.goalsById;
    returnPointsById = runtime.returnPointsById;
    console.log(
      `App Server 已读取 ${continuityData.threadCount} 个用户任务和 `
      + `${continuityData.agentThreadCount} 个相关子 Agent，`
      + `按确定性关系形成 ${continuityData.worklines.length} 条工作线；`
      + `已提取 ${returnPointsById.size} 个可追溯返回点。`,
    );
  } catch (error) {
    appServer?.close();
    appServer = null;
    continuityData = {
      state: "error",
      source: "app-server",
      activeId: "",
      worklines: [],
      rawTasks: [],
      projectOrder: [],
      projectReturnPoints: [],
      attentionItems: [],
      threadCount: 0,
      agentThreadCount: 0,
      organization: {
        mode: "rules",
        state: "ready",
        enhancedCount: 0,
        fallbackCount: 0,
        message: "",
        codexAvailable: false,
      },
    };
    rulesData = continuityData;
    attentionThreads = [];
    console.error(`App Server 真实数据暂时不可用：${error.message}`);
  }

  const adoptRuntime = (runtime) => {
    continuityThreads = runtime.threads;
    attentionThreads = runtime.threads.filter(isRootThread);
    detailsById = runtime.detailsById;
    goalsById = runtime.goalsById;
    returnPointsById = runtime.returnPointsById;
    rulesData = withRulesOrganization({
      ...runtime.snapshot,
      attentionItems: rulesData?.attentionItems ?? [],
    }, { codexAvailable });
    return rulesData;
  };

  const rebuildRulesData = async (focusThreadId) => {
    if (!appServer) throw new Error("Codex App Server is unavailable");
    const [runtime, managedAccountAvailable] = await Promise.all([
      loadContinuityRuntime(appServer, { focusThreadId, limit: 50 }),
      appServer.hasManagedAccount(),
    ]);
    codexAvailable = managedAccountAvailable;
    return adoptRuntime(runtime);
  };

  const applyOrganizationMode = async (session, mode) => {
    organizationMode = mode;
    if (mode === "rules") {
      continuityData = withRulesOrganization(rulesData, { codexAvailable });
      rulesData = continuityData;
      await updateEmbeddedData(session, continuityData);
      return;
    }

    codexAvailable = appServer ? await appServer.hasManagedAccount() : false;
    rulesData = withRulesOrganization(rulesData, { codexAvailable });
    if (!codexAvailable) {
      continuityData = withCodexOrganizationState(rulesData, "unavailable", false);
      await updateEmbeddedData(session, continuityData);
      return;
    }

    continuityData = withCodexOrganizationState(rulesData, "loading", true);
    await updateEmbeddedData(session, continuityData);
    const result = await organizeSnapshotWithCodex(rulesData, {
      command: appServerExecutable,
      cwd: os.tmpdir(),
      env: semanticEnvironment(),
      codexAvailable: true,
    });
    continuityData = {
      ...result.snapshot,
      organization: {
        ...result.organization,
        codexAvailable: true,
      },
    };
    await updateEmbeddedData(session, continuityData);
    console.log(
      `Codex 语义判断：完成 ${continuityData.organization.enhancedCount} 项，`
      + `${continuityData.organization.fallbackCount} 项未通过证据校验。`,
    );
  };

  const embeddedDocument = await buildEmbeddedDocument({ capability, data: continuityData });
  const source = buildInjectionSource({
    capability,
    open: false,
  });

  const child = spawn(executable, [
    `--user-data-dir=${profileDirectory}`,
    "--remote-debugging-pipe",
  ], {
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });

  const client = new CdpPipeClient(child);
  const sessions = new Map();
  const statusSignatures = new Map();
  const loadedFrameNames = new Set();
  const goalMatchJobs = new Map();
  let stopping = false;
  let announced = false;
  let nativeUnreadSignature = "";
  let attentionItemsSignature = JSON.stringify(continuityData.attentionItems ?? []);
  let lastAttentionRefreshAt = 0;
  let attentionSaveError = "";

  const persistAttentionLedger = async () => {
    if (!attentionLedger.dirty) return;
    try {
      await saveAttentionLedger(attentionStatePath, attentionLedger);
      attentionSaveError = "";
    } catch (error) {
      const message = String(error?.message || error);
      if (message !== attentionSaveError) {
        attentionSaveError = message;
        console.error(`注意力账本暂时无法保存：${message}`);
      }
    }
  };

  const mergeAttentionThreads = (threads) => {
    attentionThreads = threads;
    const rootById = new Map(threads.map((thread) => [thread.id, thread]));
    const known = new Set(continuityThreads.map((thread) => thread.id));
    continuityThreads = continuityThreads.map((thread) => rootById.get(thread.id) ?? thread);
    for (const thread of threads) {
      if (!known.has(thread.id)) continuityThreads.push(thread);
    }
  };

  const rebuildAttentionData = () => {
    const attentionItems = buildAttentionItems(attentionThreads, {
      attentionThreadIds: attentionLedger.pendingThreadIds(),
      detailsById,
    });
    rulesData = { ...rulesData, attentionItems };
    continuityData = { ...continuityData, attentionItems };
    return attentionItems;
  };

  const publishAttentionData = async (session) => {
    const attentionItems = rebuildAttentionData();
    const signature = JSON.stringify(attentionItems.map((item) => [item.threadId, item.turnId]));
    if (signature !== attentionItemsSignature) {
      attentionItemsSignature = signature;
      console.log(`注意力账本：当前有 ${attentionItems.length} 条新结果等待处理。`);
    }
    await updateEmbeddedData(session, continuityData);
  };

  const syncAttention = async (session, values) => {
    if (!appServer) return;
    const nativeUnreadThreadIds = [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim().replace(/^(?:local|cloud):/i, ""))
      .filter(Boolean))]
      .slice(0, 12);
    const latestThreads = await appServer.listThreads({
      limit: 50,
      sourceKinds: ["cli", "vscode"],
    });
    mergeAttentionThreads(latestThreads);
    const threadIds = attentionLedger.scan(latestThreads, {
      nativeUnreadThreadIds,
      loadedThreadIds: [...detailsById.keys()],
    });
    await persistAttentionLedger();
    const nativeUnreadSet = new Set(nativeUnreadThreadIds);
    const threadById = new Map(latestThreads.map((thread) => [thread.id, thread]));
    for (const threadId of threadIds) detailsById.delete(threadId);
    const results = await settleWithConcurrency(threadIds, (threadId) => appServer.readThread(threadId));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "rejected") continue;
      const thread = result.value?.thread;
      if (!thread?.id) continue;
      const threadId = String(thread?.id || threadIds[index]);
      detailsById.set(threadId, result.value);
      const metadata = threadById.get(threadId) ?? thread;
      attentionLedger.record(metadata, result.value, {
        forcePending: nativeUnreadSet.has(threadId),
      });
      if (!threadById.has(threadId)) {
        threadById.set(threadId, thread);
        attentionThreads.push(thread);
      }
    }
    await persistAttentionLedger();
    await publishAttentionData(session);
  };

  const markAttentionHandled = async (session, threadId) => {
    if (!attentionLedger.markHandled(threadId)) return false;
    await persistAttentionLedger();
    await publishAttentionData(session);
    return true;
  };

  const cleanup = async ({ terminateChild = false } = {}) => {
    if (stopping) return;
    stopping = true;
    for (const session of sessions.values()) session.close();
    sessions.clear();
    client.close();
    appServer?.close();
    if (terminateChild && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };

  process.once("SIGINT", () => void cleanup({ terminateChild: true }));
  process.once("SIGTERM", () => void cleanup({ terminateChild: true }));
  child.once("exit", () => void cleanup());

  await client.open();
  console.log("已启动隔离的 Codex Continuity 窗口，正在等待侧栏就绪…");

  while (!stopping && !client.closed) {
    const targets = (await client.targets()).filter(isCodexTarget);
    const activeTargetIds = new Set(targets.map((target) => target.targetId));
    for (const [targetId, session] of sessions) {
      if (!activeTargetIds.has(targetId) || session.closed) {
        session.close();
        sessions.delete(targetId);
        statusSignatures.delete(targetId);
      }
    }
    for (const target of targets) {
      if (sessions.has(target.targetId)) continue;
      try {
        const session = await injectTarget(client, target, source);
        sessions.set(target.targetId, session);
        await updateEmbeddedData(session, continuityData);
      } catch (error) {
        console.error(`Continuity 注入等待重试：${error.message}`);
      }
    }
    for (const [targetId, session] of sessions) {
      try {
        const status = await readStatus(session);
        if (status.host && !status.host.dataReady) {
          await updateEmbeddedData(session, continuityData);
        }
        const unreadThreadIds = status.host?.nativeUnreadThreadIds ?? [];
        const unreadSignature = JSON.stringify(unreadThreadIds);
        const refreshDue = Date.now() - lastAttentionRefreshAt >= ATTENTION_REFRESH_MS;
        if (unreadSignature !== nativeUnreadSignature || refreshDue) {
          nativeUnreadSignature = unreadSignature;
          lastAttentionRefreshAt = Date.now();
          await syncAttention(session, unreadThreadIds);
        }
        await markAttentionHandled(session, status.host?.nativeActiveThreadId || "");
        const signature = JSON.stringify(status);
        if (statusSignatures.get(targetId) !== signature) {
          statusSignatures.set(targetId, signature);
          console.log(
            `Codex renderer：侧栏 ${status.sidebarReady ? "已就绪" : "等待中"}，`
            + `主区域 ${status.mainReady ? "已就绪" : "等待中"}，`
            + `结果 ${status.host?.sidebarMounted ? `已挂载 ${status.host.returnPointCount || 0} 条` : "等待中"}，`
            + `扩展页面 ${status.host?.frameReady ? "已就绪" : status.host?.frameMounted ? "加载中" : "未打开"}`,
          );
        }
        if (status.host?.frameName && !loadedFrameNames.has(status.host.frameName)) {
          await loadEmbeddedFrame(session, status.host.frameName, embeddedDocument);
          loadedFrameNames.add(status.host.frameName);
          await updateEmbeddedData(session, continuityData);
        }
        if (!announced && status.host?.sidebarMounted) {
          announced = true;
          console.log("Continuity 已嵌入 Codex：左侧“等你处理”可直接打开原任务。");
        }
        const refreshThreadId = await takeRefreshRequest(session);
        if (refreshThreadId && appServer) {
          try {
            await rebuildRulesData(
              refreshThreadId === "refresh"
                ? process.env.CODEX_THREAD_ID || ""
                : refreshThreadId,
            );
            await applyOrganizationMode(session, organizationMode);
          } catch (_) {}
        }
        const requestedOrganizationMode = await takeOrganizationRequest(session);
        if (requestedOrganizationMode) {
          await applyOrganizationMode(session, requestedOrganizationMode);
        }
        if (!goalMatchJobs.has(targetId)) {
          const goalMatchRequest = await takeGoalMatchRequest(session);
          if (goalMatchRequest) {
            console.log("目标续接：正在检查已有上下文…");
            const job = matchGoalWithCodex(rulesData, goalMatchRequest.goal, {
              command: appServerExecutable,
              cwd: os.tmpdir(),
              env: semanticEnvironment(),
              codexAvailable,
              timeoutMs: 30_000,
            }).then(async (result) => {
              await finishGoalMatch(session, goalMatchRequest, result);
              if (result.match) {
                console.log(`目标续接：找到高置信候选“${result.match.nativeTitle}”。`);
              } else {
                console.log(`目标续接：未找到高置信候选（${result.diagnostic || result.state}）。`);
              }
            }).catch(async (error) => {
              console.error(`目标续接：检查失败（${String(error?.message || error)}）。`);
              try {
                await finishGoalMatch(session, goalMatchRequest, { state: "error", match: null });
              } catch (_) {}
            }).finally(() => {
              goalMatchJobs.delete(targetId);
            });
            goalMatchJobs.set(targetId, job);
          }
        }
        const requestedThreadId = await takeThreadRequest(session);
        if (requestedThreadId) {
          try {
            // The renderer must acquire the task itself. Resuming it through this
            // standalone App Server first makes the renderer look like a second writer.
            await finishThreadRequest(session, requestedThreadId, {
              outcome: { state: "nativeNavigation" },
            });
            await markAttentionHandled(session, requestedThreadId);
          } catch (error) {
            await finishThreadRequest(session, requestedThreadId, { error });
          }
        }
        const activationThreadId = await takeThreadActivationRequest(session);
        if (activationThreadId) {
          try {
            await openOfficialCodexThread(activationThreadId);
            await finishThreadActivation(session, activationThreadId);
            await markAttentionHandled(session, activationThreadId);
          } catch (error) {
            await finishThreadActivation(session, activationThreadId, error);
          }
        }
        const detailThreadId = await takeDetailRequest(session);
        if (detailThreadId) {
          try {
            if (!appServer) throw new Error("Codex App Server is unavailable");
            const detailSnapshot = await loadThreadDetail(
              appServer,
              detailThreadId,
              continuityThreads,
              detailsById,
              goalsById,
              returnPointsById,
            );
            rulesData = withRulesOrganization(detailSnapshot, { codexAvailable });
            await applyOrganizationMode(session, organizationMode);
          } catch (_) {
            await failDetailRequest(session, detailThreadId);
          }
        }
      } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
