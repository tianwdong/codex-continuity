import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import test from "node:test";

import { buildInjectionSource } from "../src/injection-source.mjs";

function createHostContext() {
  const documentListeners = new Map();
  const window = {
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  };
  const document = {
    body: {},
    documentElement: {
      lang: "en",
      dataset: {},
      classList: { contains: () => false },
      getAttribute: () => "",
    },
    head: { appendChild() {} },
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) ?? [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener() {},
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      dataset: {},
      setAttribute() {},
      removeAttribute() {},
      append() {},
      appendChild() {},
      replaceChildren() {},
      addEventListener() {},
      querySelectorAll: () => [],
    }),
  };
  window.window = window;
  return {
    window,
    document,
    navigator: { language: "en-US" },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle: (node) => ({
      colorScheme: "light",
      display: node?.display || "block",
      visibility: "visible",
      opacity: "1",
      backgroundColor: node?.backgroundColor || "transparent",
    }),
    documentListeners,
  };
}

function installTestHost() {
  const source = buildInjectionSource({ capability: "test-capability", open: false });
  const context = createHostContext();
  runInNewContext(source, context);
  return { source, host: context.window.__codexContinuityHost__, context };
}

test("organization mode host source is syntactically valid", () => {
  const { source } = installTestHost();
  assert.doesNotThrow(() => new Script(source));
});

test("continuity opens as an overlay without hiding the native task", () => {
  const { source } = installTestHost();

  assert.doesNotMatch(source, /child\.setAttribute\(HIDDEN/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /background: transparent/);
});

test("continuity keeps up to three attention results in the native sidebar and hides the old dashboard entry", () => {
  const { source, host } = installTestHost();

  assert.equal(host.active, false);
  assert.match(source, /codex-continuity-sidebar-section/);
  assert.match(source, /data-continuity-return/);
  assert.doesNotMatch(source, /data-continuity-search/);
  assert.match(source, /function sidebarItems\(\)/);
  assert.match(source, /latestData\?\.attentionItems/);
  assert.match(source, /allItems\.slice\(0, 3\)/);
  assert.match(source, /hostText\("等你处理", "Ready for you"\)/);
  assert.match(source, /data-continuity-excerpt/);
  assert.match(source, /data-continuity-dot/);
  assert.match(source, /#\$\{ENTRY_ID\} \{ display: none !important; \}/);
  assert.doesNotMatch(source, /aria-modal/);
});

test("goal matching augments the native composer without adding a second input", () => {
  const { source, host } = installTestHost();

  assert.match(source, /codex-continuity-goal-match/);
  assert.match(source, /\[contenteditable='true'\]\[role='textbox'\]/);
  assert.match(source, /\[data-composer-radius-variant\]/);
  assert.match(source, /data-goal-match-continue/);
  assert.match(source, /hostText\("继续这个会话", "Continue this task"\)/);
  assert.match(source, /hostText\("仍然新建", "Create anyway"\)/);
  assert.match(source, /pendingNativeSubmitGoal/);
  assert.match(source, /requestGoalMatch\(value, \{ blocking: true \}\)/);
  assert.match(source, /editor\.contains\(event\.target\)/);
  assert.match(source, /characterData: true/);
  assert.equal(host.takeGoalMatchRequest(), null);
  assert.equal(host.goalMatchMounted, false);
  assert.equal(host.goalMatchPending, false);
});

test("goal matching accepts input events from a nested ProseMirror node", async () => {
  const { host, context } = installTestHost();
  const nested = {};
  const stack = { insertBefore() {} };
  const shell = { parentElement: stack };
  const root = { parentElement: shell };
  const editor = {
    innerText: "继续检查 ModelDial 的 Cloudflare 费用",
    contains: (node) => node === nested,
    closest: (selector) => (selector === "[data-composer-radius-variant]" ? root : null),
    getBoundingClientRect: () => ({ width: 720, height: 120, bottom: 900 }),
  };
  context.document.querySelectorAll = (selector) => (
    selector === "[contenteditable='true'][role='textbox']" ? [editor] : []
  );

  const inputListener = context.documentListeners.get("input")[0];
  inputListener({ target: nested });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const request = host.takeGoalMatchRequest();
  assert.equal(request.goal, "继续检查 ModelDial 的 Cloudflare 费用");
});

test("native unread signal is read from the official thread row and normalized to a thread id", () => {
  const { host, context } = installTestHost();
  const marker = {
    className: "absolute inset-0 rounded-full",
    backgroundColor: "rgb(51, 156, 255)",
    getBoundingClientRect: () => ({ width: 8, height: 8 }),
  };
  const hiddenMarker = {
    ...marker,
    display: "none",
  };
  const row = (threadId, markers) => ({
    getAttribute: (name) => (name === "data-app-action-sidebar-thread-id" ? threadId : null),
    querySelectorAll: (selector) => (selector === "span" ? markers : []),
  });
  context.document.querySelectorAll = (selector) => (
    selector === "[data-app-action-sidebar-thread-id]"
      ? [
        row("local:thread-unread", [marker]),
        row("local:thread-hidden", [hiddenMarker]),
        row("local:thread-read", []),
      ]
      : []
  );

  assert.deepEqual(Array.from(host.nativeUnreadThreadIds), ["thread-unread"]);
});

test("exposes the active native task so opening it can clear a pending result", () => {
  const { host, context } = installTestHost();
  context.document.querySelectorAll = (selector) => (
    selector === "[data-app-action-sidebar-thread-id]"
      ? [{
        getAttribute: (name) => ({
          "data-app-action-sidebar-thread-id": "local:thread-active",
          "data-app-action-sidebar-thread-active": "true",
        })[name] ?? null,
      }]
      : []
  );

  assert.equal(host.nativeActiveThreadId, "thread-active");
});

test("active writer is a recoverable other-window state", () => {
  const { source, host } = installTestHost();

  assert.doesNotThrow(() => host.markThreadActiveElsewhere("thread-1"));
  assert.match(source, /continuity:thread-active-elsewhere/);
  assert.match(source, /continuity:activate-thread/);
  assert.match(source, /takeThreadActivationRequest/);
  assert.match(source, /completeThreadActivation/);
  assert.match(source, /failThreadActivation/);
  assert.match(source, /openedAttention[\s\S]*attentionItems:[\s\S]*\.filter/);
});

test("resume context disappears automatically instead of becoming a persistent surface", () => {
  const { source } = installTestHost();

  assert.match(source, /resumeItem = null;\s*removeResumeStrip\(\);\s*}, 10_000\)/s);
  assert.doesNotMatch(source, /resumeCollapsed = true/);
});

test("host data is cached for native return points before the search frame mounts", () => {
  const { host } = installTestHost();

  assert.doesNotThrow(() => host.updateData({
    activeId: "primary",
    worklines: [{ id: "primary", threadId: "thread-1", project: "Project" }],
  }));
  assert.equal(host.dataReady, true);
  assert.equal(host.returnPointCount, 0);
  assert.equal(host.active, false);
  assert.equal(host.frameMounted, false);
});

test("organization mode requests accept supported values and take atomically", () => {
  const { host } = installTestHost();

  assert.deepEqual({ ...host.setOrganizationMode("rules") }, { accepted: true, mode: "rules" });
  assert.deepEqual({ ...host.setOrganizationMode("codex") }, { accepted: true, mode: "codex" });
  assert.equal(host.takeOrganizationRequest(), "codex");
  assert.equal(host.takeOrganizationRequest(), null);
});

test("invalid organization mode requests are rejected without changing the queue", () => {
  const { host } = installTestHost();

  assert.deepEqual({ ...host.setOrganizationMode("rules") }, { accepted: true, mode: "rules" });
  assert.deepEqual({ ...host.setOrganizationMode("invalid") }, { accepted: false });
  assert.deepEqual({ ...host.setOrganizationMode("Rules") }, { accepted: false });
  assert.equal(host.takeOrganizationRequest(), "rules");
  assert.equal(host.takeOrganizationRequest(), null);
});
