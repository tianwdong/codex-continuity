function installContinuityHost(config) {
  "use strict";

  const VERSION = "0.7.1";
  const SENTINEL = "__codexContinuityHost__";
  const OWNED = "data-codex-continuity-owned";
  const ENTRY_ID = "codex-continuity-entry";
  const SIDEBAR_SECTION_ID = "codex-continuity-sidebar-section";
  const RESUME_STRIP_ID = "codex-continuity-resume-strip";
  const GOAL_MATCH_ID = "codex-continuity-goal-match";
  const PAGE_ID = "codex-continuity-page";
  const STYLE_ID = "codex-continuity-host-style";
  const previous = window[SENTINEL];

  if (previous?.version === VERSION && previous?.instanceId === config.capability) {
    previous.refresh();
    if (config.open) previous.open();
    return;
  }
  try {
    previous?.destroy?.();
  } catch (_) {}

  let active = Boolean(config.open);
  let destroyed = false;
  let entry = null;
  let page = null;
  let frame = null;
  let frameReady = false;
  let status = null;
  let observer = null;
  let refreshTimer = null;
  let readyTimer = null;
  let resumeTimer = null;
  let noticeTimer = null;
  let goalMatchTimer = null;
  let continuationDraftTimer = null;
  let lastFocus = null;
  let latestData = null;
  let pendingResumeItem = null;
  let resumeItem = null;
  let resumeSignature = "";
  let sidebarNotice = "";
  let sidebarSignature = "";
  const pendingThreadRequests = [];
  const pendingThreadActivationRequests = [];
  const pendingDetailRequests = [];
  let pendingRefreshRequest = "";
  let pendingOrganizationRequest = null;
  let openingThreadId = "";
  let pendingGoalMatchRequest = null;
  let goalMatchSequence = 0;
  let goalMatchRequestedGoal = "";
  let goalMatchCheckedGoal = "";
  let goalMatchBlocking = false;
  let goalMatchResult = null;
  let pendingNativeSubmitGoal = "";
  let ignoredGoal = "";
  let replayingNativeSubmit = false;
  let pendingContinuationGoal = "";

  function normalized(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function hostText(chinese, english) {
    const language = String(document.documentElement.lang || navigator.language || "").toLowerCase();
    return language === "zh" || language.startsWith("zh-") ? chinese : english;
  }

  function theme() {
    const root = document.documentElement;
    const explicit = String(root.dataset.theme || root.getAttribute("data-color-theme") || "").toLowerCase();
    if (explicit.includes("dark") || root.classList.contains("dark")) return "dark";
    if (explicit.includes("light") || root.classList.contains("light")) return "light";
    return getComputedStyle(root).colorScheme.includes("dark") ? "dark" : "light";
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED, "true");
    style.textContent = `
      #${ENTRY_ID}[aria-pressed="true"] {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 8%, transparent));
      }
      #${ENTRY_ID} { display: none !important; }
      #${ENTRY_ID}:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
      #${SIDEBAR_SECTION_ID} {
        display: grid; margin: 8px 8px 10px; min-width: 0;
        font: 12px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-heading] {
        display: flex; align-items: center; gap: 6px; padding: 3px 8px 5px;
        color: color-mix(in srgb, currentColor 62%, transparent); font-size: 10px; font-weight: 650;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-count] {
        display: grid; min-width: 16px; height: 16px; padding: 0 4px; place-items: center;
        border-radius: 999px; background: color-mix(in srgb, Highlight 12%, transparent);
        color: Highlight; font-size: 9px;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-return] {
        display: grid; grid-template-columns: minmax(0, 1fr) 8px; gap: 8px; width: 100%;
        align-items: center; border: 0; border-radius: 7px; background: transparent;
        padding: 7px 8px; color: inherit; text-align: left; cursor: pointer;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-return]:hover {
        background: var(--color-token-list-hover-background, color-mix(in srgb, currentColor 7%, transparent));
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-return]:focus-visible {
        outline: 2px solid Highlight; outline-offset: 1px;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-return]:disabled { cursor: wait; opacity: .6; }
      #${SIDEBAR_SECTION_ID} [data-continuity-copy] { display: block; min-width: 0; }
      #${SIDEBAR_SECTION_ID} [data-continuity-topline] {
        display: flex; justify-content: space-between; gap: 8px; min-width: 0;
        color: color-mix(in srgb, currentColor 54%, transparent); font-size: 9px;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-project] {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-updated] { flex: 0 0 auto; }
      #${SIDEBAR_SECTION_ID} [data-continuity-title] {
        display: block; overflow: hidden; margin-top: 2px; font-size: 11px; font-weight: 650;
        line-height: 1.4; text-overflow: ellipsis; white-space: nowrap;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-excerpt] {
        display: -webkit-box; overflow: hidden; margin-top: 4px;
        color: color-mix(in srgb, currentColor 68%, transparent); font-size: 10px; line-height: 1.4;
        -webkit-box-orient: vertical; -webkit-line-clamp: 2;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-dot] {
        width: 7px; height: 7px; border-radius: 999px; background: Highlight;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-notice] {
        padding: 5px 8px; color: color-mix(in srgb, currentColor 58%, transparent);
        font-size: 10px; line-height: 1.4;
      }
      #${SIDEBAR_SECTION_ID} [data-continuity-empty],
      #${SIDEBAR_SECTION_ID} [data-continuity-more] {
        padding: 5px 8px; color: color-mix(in srgb, currentColor 46%, transparent);
        font-size: 9px; line-height: 1.4;
      }
      #${RESUME_STRIP_ID} {
        position: absolute; top: 54px; left: 50%; z-index: 30; width: min(720px, calc(100% - 32px));
        transform: translateX(-50%); border: 1px solid color-mix(in srgb, Highlight 28%, currentColor 14%);
        border-radius: 9px; background: color-mix(in srgb, Canvas 96%, Highlight 4%);
        box-shadow: 0 8px 28px color-mix(in srgb, CanvasText 12%, transparent);
        color: CanvasText; font: 12px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      }
      #${RESUME_STRIP_ID} [data-resume-content] { padding: 9px 38px 9px 12px; }
      #${RESUME_STRIP_ID} [data-resume-meta] {
        color: color-mix(in srgb, CanvasText 56%, transparent); font-size: 10px;
      }
      #${RESUME_STRIP_ID} [data-resume-checkpoint],
      #${RESUME_STRIP_ID} [data-resume-next] { margin-top: 4px; }
      #${RESUME_STRIP_ID} [data-resume-label] {
        margin-right: 6px; color: color-mix(in srgb, CanvasText 52%, transparent); font-size: 10px;
      }
      #${RESUME_STRIP_ID} [data-resume-source] {
        overflow: hidden; margin-top: 5px; color: color-mix(in srgb, CanvasText 48%, transparent);
        font-size: 9px; text-overflow: ellipsis; white-space: nowrap;
      }
      #${RESUME_STRIP_ID} [data-resume-close] {
        position: absolute; top: 6px; right: 7px; display: grid; width: 26px; height: 26px;
        place-items: center; border: 0; border-radius: 6px; background: transparent;
        color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 17px; cursor: pointer;
      }
      #${RESUME_STRIP_ID} [data-resume-close]:hover {
        background: color-mix(in srgb, CanvasText 8%, transparent); color: CanvasText;
      }
      #${GOAL_MATCH_ID} {
        box-sizing: border-box; width: 100%; padding: 12px 14px;
        border: 1px solid color-mix(in srgb, Highlight 36%, CanvasText 13%);
        border-radius: 12px; background: color-mix(in srgb, Canvas 96%, Highlight 4%);
        box-shadow: 0 5px 16px color-mix(in srgb, CanvasText 6%, transparent);
        color: CanvasText; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      }
      #${GOAL_MATCH_ID} [data-goal-match-label] {
        margin: 0 0 5px; color: Highlight; font-size: 11px; font-weight: 700;
      }
      #${GOAL_MATCH_ID} [data-goal-match-title] {
        margin: 0; font-size: 15px; font-weight: 650; line-height: 1.4;
      }
      #${GOAL_MATCH_ID} [data-goal-match-evidence] {
        display: -webkit-box; overflow: hidden; margin: 7px 0 0;
        color: color-mix(in srgb, CanvasText 72%, transparent); font-size: 12px; line-height: 1.55;
        -webkit-box-orient: vertical; -webkit-line-clamp: 2;
      }
      #${GOAL_MATCH_ID} [data-goal-match-source] {
        overflow: hidden; margin: 5px 0 0; color: color-mix(in srgb, CanvasText 48%, transparent);
        font-size: 10px; text-overflow: ellipsis; white-space: nowrap;
      }
      #${GOAL_MATCH_ID} [data-goal-match-actions] {
        display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px;
      }
      #${GOAL_MATCH_ID} button {
        min-height: 32px; padding: 5px 11px; border-radius: 8px;
        cursor: pointer; font: inherit; font-size: 12px; font-weight: 650; white-space: nowrap;
      }
      #${GOAL_MATCH_ID} button[data-goal-match-continue] {
        border: 1px solid Highlight; background: Highlight; color: HighlightText;
      }
      #${GOAL_MATCH_ID} button[data-goal-match-new] {
        border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
        background: Canvas; color: CanvasText;
      }
      #${GOAL_MATCH_ID} button:hover { filter: brightness(.97); }
      #${GOAL_MATCH_ID} button:active { transform: translateY(1px); }
      #${GOAL_MATCH_ID} button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
      #${GOAL_MATCH_ID}[data-loading="true"] {
        box-shadow: none; color: color-mix(in srgb, CanvasText 62%, transparent);
      }
      #${PAGE_ID} { position: absolute; inset: 0; z-index: 32; min-width: 0; min-height: 0; background: transparent; }
      #${PAGE_ID}[hidden] { display: none !important; }
      #${PAGE_ID} iframe { width: 100%; height: 100%; border: 0; background: transparent; }
      #${PAGE_ID} [data-continuity-status] {
        position: absolute; inset: 0; display: grid; place-items: center; z-index: 2;
        background: Canvas;
        color: color-mix(in srgb, CanvasText 62%, transparent);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif;
      }
      #${PAGE_ID} [data-continuity-status][hidden] { display: none !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findReferenceButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    const buttons = Array.from(scroll.querySelectorAll("button"))
      .filter((button) => !button.closest(`[${OWNED}="true"]`));
    return buttons.find((button) => ["插件", "plugins"].includes(normalized(
      button.textContent || button.getAttribute("aria-label"),
    ))) || buttons.find((button) => button.getClientRects().length > 0) || null;
  }

  function labelEntry(button) {
    const labelText = hostText("接着做", "Continue");
    button.setAttribute("aria-label", labelText);
    button.setAttribute("title", labelText);
    const candidates = Array.from(button.querySelectorAll(".text-fade-truncate, span, div"));
    const label = candidates.find((node) => node.hasAttribute("data-continuity-entry-label"))
      || candidates.find((node) => ["插件", "plugins"].includes(normalized(node.textContent)))
      || candidates.find((node) => node.children.length === 0 && normalized(node.textContent));
    if (label) {
      label.setAttribute("data-continuity-entry-label", "true");
      if (label.textContent !== labelText) label.textContent = labelText;
    } else if (!normalized(button.textContent).includes(normalized(labelText))) {
      button.append(document.createTextNode(labelText));
    }
  }

  function sidebarItems() {
    const activeId = normalizedThreadId(activeThreadId());
    const seen = new Set();
    return (Array.isArray(latestData?.attentionItems) ? latestData.attentionItems : [])
      .filter((item) => {
        const threadId = normalizedThreadId(item?.threadId);
        if (!threadId || threadId === activeId || seen.has(threadId) || !item?.excerpt) return false;
        seen.add(threadId);
        return true;
      });
  }

  function clearSidebarNoticeSoon() {
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeTimer = null;
      sidebarNotice = "";
      renderSidebarReturns();
    }, 4_000);
  }

  function renderSidebarReturns() {
    const section = document.getElementById(SIDEBAR_SECTION_ID);
    if (!section) return;
    const allItems = sidebarItems();
    const items = allItems.slice(0, 3);
    const signature = JSON.stringify({
      notice: sidebarNotice,
      pending: openingThreadId,
      items: items.map((item) => [
        item?.threadId,
        item?.project,
        item?.chapter || item?.nativeTitle,
        item?.excerpt,
        item?.updated,
      ]),
      remaining: Math.max(0, allItems.length - items.length),
    });
    if (signature === sidebarSignature && section.childElementCount) return;
    sidebarSignature = signature;
    section.replaceChildren();

    const heading = document.createElement("div");
    heading.setAttribute("data-continuity-heading", "true");
    const headingLabel = document.createElement("span");
    headingLabel.textContent = hostText("等你处理", "Ready for you");
    heading.append(headingLabel);
    if (allItems.length) {
      const count = document.createElement("span");
      count.setAttribute("data-continuity-count", "true");
      count.textContent = String(allItems.length);
      heading.append(count);
    }
    section.append(heading);

    if (sidebarNotice) {
      const notice = document.createElement("div");
      notice.setAttribute("data-continuity-notice", "true");
      notice.textContent = sidebarNotice;
      section.append(notice);
    }
    for (const item of items) {
      const threadId = normalizedThreadId(item?.threadId);
      if (!threadId) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = Boolean(openingThreadId);
      button.setAttribute("data-continuity-return", "attention");
      button.setAttribute("data-thread-id", threadId);
      button.setAttribute(
        "title",
        [item?.chapter || item?.nativeTitle, item?.excerpt].filter(Boolean).join("\n"),
      );

      const copy = document.createElement("span");
      copy.setAttribute("data-continuity-copy", "true");
      const topline = document.createElement("span");
      topline.setAttribute("data-continuity-topline", "true");
      const project = document.createElement("span");
      project.setAttribute("data-continuity-project", "true");
      project.textContent = String(item?.project || "");
      const updated = document.createElement("span");
      updated.setAttribute("data-continuity-updated", "true");
      updated.textContent = String(item?.updated || "");
      topline.append(project, updated);
      const title = document.createElement("span");
      title.setAttribute("data-continuity-title", "true");
      title.textContent = String(item?.chapter || item?.nativeTitle || hostText("原任务", "Original task"));
      const excerpt = document.createElement("span");
      excerpt.setAttribute("data-continuity-excerpt", "true");
      excerpt.textContent = openingThreadId === threadId
        ? hostText("正在打开最近结果…", "Opening the latest result…")
        : `“${String(item.excerpt)}”`;
      const dot = document.createElement("span");
      dot.setAttribute("data-continuity-dot", "true");
      dot.setAttribute("aria-label", hostText("尚未查看", "Not reviewed"));
      copy.append(topline, title, excerpt);
      button.append(copy, dot);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        requestThreadOpen(threadId);
      });
      section.append(button);
    }
    if (!items.length && !sidebarNotice) {
      const empty = document.createElement("div");
      empty.setAttribute("data-continuity-empty", "true");
      empty.textContent = hostText("暂无新结果", "No new results");
      section.append(empty);
    }
    if (allItems.length > items.length) {
      const more = document.createElement("div");
      more.setAttribute("data-continuity-more", "true");
      more.textContent = hostText(
        `还有 ${allItems.length - items.length} 件在原任务列表中`,
        `${allItems.length - items.length} more in the original task list`,
      );
      section.append(more);
    }
  }

  function ensureSidebarSection() {
    if (!entry?.parentElement) return;
    let section = document.getElementById(SIDEBAR_SECTION_ID);
    if (!section) {
      section = document.createElement("section");
      section.id = SIDEBAR_SECTION_ID;
      section.setAttribute(OWNED, "true");
      section.setAttribute("aria-label", hostText("等你处理", "Ready for you"));
      sidebarSignature = "";
    }
    if (section.parentElement !== entry.parentElement || section.previousElementSibling !== entry) {
      entry.after(section);
    }
    renderSidebarReturns();
  }

  function createEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.type = "button";
    button.setAttribute(OWNED, "true");
    for (const attribute of Array.from(button.attributes)) {
      if (attribute.name.startsWith("data-app-action") || [
        "aria-controls",
        "aria-expanded",
        "aria-pressed",
        "aria-describedby",
        "data-state",
      ].includes(attribute.name)) button.removeAttribute(attribute.name);
    }
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    labelEntry(button);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    return button;
  }

  function ensureEntry() {
    if (destroyed || !document.body) return;
    installStyles();
    const reference = findReferenceButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = createEntry(reference);
    labelEntry(entry);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) {
      reference.after(entry);
    }
    entry.setAttribute("aria-pressed", String(active));
    ensureSidebarSection();
  }

  function findMount() {
    const directFrame = document.querySelector(".app-shell-main-content-frame");
    const layout = directFrame?.closest?.("[data-app-shell-main-content-layout]")
      || document.querySelector("[data-app-shell-main-content-layout]");
    const surface = layout?.parentElement;
    if (!layout || !surface || !surface.closest("main")) return null;
    return surface;
  }

  function activeThreadId() {
    const rows = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"));
    const row = rows.find((candidate) => (
      candidate.getAttribute("data-app-action-sidebar-thread-active") === "true"
      || ["page", "true"].includes(candidate.getAttribute("aria-current"))
    ));
    return row?.getAttribute("data-app-action-sidebar-thread-id") || "";
  }

  function nativeComposerEditor() {
    return Array.from(document.querySelectorAll("[contenteditable='true'][role='textbox']"))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 80 && rect.height > 20
          && style.display !== "none"
          && style.visibility !== "hidden";
      })
      .sort((left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom)[0]
      || null;
  }

  function nativeComposerRoot(editor = nativeComposerEditor()) {
    return editor?.closest?.("[data-composer-radius-variant]") || null;
  }

  function nativeGoalEditor() {
    const pathname = String(window.location?.pathname || "");
    if (normalizedThreadId(activeThreadId()) || /\/(?:local|cloud)\//i.test(pathname)) return null;
    const editor = nativeComposerEditor();
    return nativeComposerRoot(editor) ? editor : null;
  }

  function nativeGoalText(editor = nativeGoalEditor()) {
    return String(editor?.innerText || editor?.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2_000);
  }

  function removeGoalMatch() {
    document.getElementById(GOAL_MATCH_ID)?.remove();
  }

  function goalMatchMount(editor = nativeGoalEditor()) {
    const root = nativeComposerRoot(editor);
    const shell = root?.parentElement;
    const stack = shell?.parentElement;
    if (!root || !shell || !stack) return null;
    return { shell, stack };
  }

  function clearGoalMatchState({ invalidate = false } = {}) {
    if (invalidate) goalMatchSequence += 1;
    goalMatchRequestedGoal = "";
    goalMatchCheckedGoal = "";
    goalMatchBlocking = false;
    goalMatchResult = null;
    pendingGoalMatchRequest = null;
    pendingNativeSubmitGoal = "";
    removeGoalMatch();
  }

  function requestGoalMatch(value, { blocking = false } = {}) {
    const goal = String(value || "").replace(/\s+/g, " ").trim().slice(0, 2_000);
    if (goal.length < 4 || goal === ignoredGoal || goal === goalMatchCheckedGoal) return false;
    if (goal === goalMatchRequestedGoal) {
      if (blocking && !goalMatchBlocking) {
        goalMatchBlocking = true;
        renderGoalMatch();
      }
      return true;
    }
    goalMatchSequence += 1;
    goalMatchRequestedGoal = goal;
    goalMatchCheckedGoal = "";
    goalMatchBlocking = Boolean(blocking);
    goalMatchResult = null;
    pendingGoalMatchRequest = { requestId: goalMatchSequence, goal };
    renderGoalMatch();
    return true;
  }

  function takeGoalMatchRequest() {
    const request = pendingGoalMatchRequest;
    pendingGoalMatchRequest = null;
    return request;
  }

  function completeGoalMatch(requestId, goal, value) {
    const normalizedGoal = String(goal || "").replace(/\s+/g, " ").trim().slice(0, 2_000);
    if (Number(requestId) !== goalMatchSequence || normalizedGoal !== goalMatchRequestedGoal) return false;
    const threadId = normalizedThreadId(value?.threadId);
    goalMatchResult = threadId && value?.excerpt
      ? {
          threadId,
          worklineId: String(value?.worklineId || ""),
          project: String(value?.project || ""),
          nativeTitle: String(value?.nativeTitle || ""),
          chapter: String(value?.chapter || ""),
          excerpt: String(value.excerpt || ""),
          sourceMessageId: String(value?.sourceMessageId || ""),
        }
      : null;
    goalMatchCheckedGoal = normalizedGoal;
    goalMatchBlocking = false;
    renderGoalMatch();
    if (pendingNativeSubmitGoal === normalizedGoal && !goalMatchResult) {
      pendingNativeSubmitGoal = "";
      window.queueMicrotask(() => submitNativeGoal(normalizedGoal));
    }
    return true;
  }

  function failGoalMatch(requestId, goal) {
    return completeGoalMatch(requestId, goal, null);
  }

  function renderGoalMatch() {
    const editor = nativeGoalEditor();
    const mount = goalMatchMount(editor);
    const currentGoal = nativeGoalText(editor);
    const loading = goalMatchBlocking
      && currentGoal
      && currentGoal === goalMatchRequestedGoal
      && goalMatchCheckedGoal !== currentGoal;
    const match = currentGoal && currentGoal === goalMatchCheckedGoal ? goalMatchResult : null;
    if (!mount || (!loading && !match)) {
      removeGoalMatch();
      return;
    }
    let card = document.getElementById(GOAL_MATCH_ID);
    if (!card) {
      card = document.createElement("aside");
      card.id = GOAL_MATCH_ID;
      card.setAttribute(OWNED, "true");
      card.setAttribute("aria-live", "polite");
    }
    card.replaceChildren();
    card.dataset.loading = String(loading);
    const label = document.createElement("p");
    label.setAttribute("data-goal-match-label", "true");
    label.textContent = loading
      ? hostText("正在查找相关上下文", "Looking for relevant context")
      : hostText("找到可能的上下文", "Possible context found");
    card.append(label);
    if (loading) {
      const statusText = document.createElement("p");
      statusText.setAttribute("data-goal-match-evidence", "true");
      statusText.textContent = hostText(
        "只在有明确匹配时多问你一步。",
        "You will only be asked when there is a clear match.",
      );
      card.append(statusText);
    } else {
      const title = document.createElement("h2");
      title.setAttribute("data-goal-match-title", "true");
      title.textContent = match.chapter || match.nativeTitle || hostText("相关原任务", "Related task");
      const evidence = document.createElement("p");
      evidence.setAttribute("data-goal-match-evidence", "true");
      evidence.textContent = `“${match.excerpt}”`;
      const source = document.createElement("p");
      source.setAttribute("data-goal-match-source", "true");
      source.textContent = hostText(
        `来自“${match.nativeTitle || "原任务"}”的最近回复`,
        `From the latest reply in “${match.nativeTitle || "the original task"}”`,
      );
      const actions = document.createElement("div");
      actions.setAttribute("data-goal-match-actions", "true");
      const continueButton = document.createElement("button");
      continueButton.type = "button";
      continueButton.setAttribute("data-goal-match-continue", "true");
      continueButton.textContent = hostText("继续这个会话", "Continue this task");
      continueButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        pendingContinuationGoal = currentGoal;
        pendingResumeItem = {
          ...match,
          kind: "goal-match",
          checkpoint: match.excerpt,
          nextAction: currentGoal,
        };
        clearGoalMatchState({ invalidate: true });
        requestThreadOpen(match.threadId, pendingResumeItem);
      });
      const newButton = document.createElement("button");
      newButton.type = "button";
      newButton.setAttribute("data-goal-match-new", "true");
      newButton.textContent = hostText("仍然新建", "Create anyway");
      newButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        ignoredGoal = currentGoal;
        clearGoalMatchState({ invalidate: true });
        submitNativeGoal(currentGoal);
      });
      actions.append(continueButton, newButton);
      card.append(title, evidence, source, actions);
    }
    if (card.parentElement !== mount.stack || card.nextElementSibling !== mount.shell) {
      mount.stack.insertBefore(card, mount.shell);
    }
  }

  function scheduleGoalMatch(value) {
    if (goalMatchTimer !== null) window.clearTimeout(goalMatchTimer);
    goalMatchTimer = window.setTimeout(() => {
      goalMatchTimer = null;
      requestGoalMatch(value, { blocking: true });
    }, 650);
  }

  function nativeSendButton(editor = nativeGoalEditor()) {
    const root = nativeComposerRoot(editor);
    return Array.from(root?.querySelectorAll?.("button") || []).find((button) => (
      ["send", "发送"].includes(normalized(button.getAttribute("aria-label")))
    )) || null;
  }

  function submitNativeGoal(goal) {
    const editor = nativeGoalEditor();
    if (!editor || nativeGoalText(editor) !== goal) return false;
    const button = nativeSendButton(editor);
    if (!button || button.disabled) return false;
    replayingNativeSubmit = true;
    button.click();
    window.queueMicrotask(() => {
      replayingNativeSubmit = false;
    });
    return true;
  }

  function interceptNativeGoalSubmit(event) {
    if (replayingNativeSubmit) return;
    const editor = nativeGoalEditor();
    const goal = nativeGoalText(editor);
    if (!editor || goal.length < 4 || goal === ignoredGoal) return;
    if (goal === goalMatchCheckedGoal) {
      if (!goalMatchResult) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      renderGoalMatch();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingNativeSubmitGoal = goal;
    requestGoalMatch(goal, { blocking: true });
  }

  function receiveNativeComposerInput(event) {
    const editor = nativeGoalEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target))) return;
    const goal = nativeGoalText(editor);
    if (goal !== ignoredGoal) ignoredGoal = "";
    if (goal !== goalMatchRequestedGoal && goal !== goalMatchCheckedGoal) {
      goalMatchResult = null;
      goalMatchCheckedGoal = "";
      pendingNativeSubmitGoal = "";
      removeGoalMatch();
    }
    if (goal.length >= 4) scheduleGoalMatch(goal);
  }

  function receiveNativeComposerKeydown(event) {
    const editor = nativeGoalEditor();
    if (!editor || (event.target !== editor && !editor.contains(event.target)) || event.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      interceptNativeGoalSubmit(event);
    }
  }

  function receiveNativeComposerClick(event) {
    if (replayingNativeSubmit) return;
    const editor = nativeGoalEditor();
    const button = event.target?.closest?.("button");
    if (!editor || !button || button !== nativeSendButton(editor)) return;
    interceptNativeGoalSubmit(event);
  }

  function restoreContinuationGoal(threadId, goal, attempt = 0) {
    if (attempt >= 40) return;
    const editor = nativeComposerEditor();
    if (!editor || normalizedThreadId(activeThreadId()) !== threadId) {
      continuationDraftTimer = window.setTimeout(
        () => restoreContinuationGoal(threadId, goal, attempt + 1),
        100,
      );
      return;
    }
    continuationDraftTimer = null;
    editor.focus();
    const selection = window.getSelection?.();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const inserted = document.execCommand?.("insertText", false, goal);
    if (!inserted || nativeGoalText(editor) !== goal) {
      const paragraph = document.createElement("p");
      paragraph.textContent = goal;
      editor.replaceChildren(paragraph);
      const inputEvent = typeof window.InputEvent === "function"
        ? new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: goal })
        : new Event("input", { bubbles: true });
      editor.dispatchEvent(inputEvent);
    }
  }

  function nativeUnreadThreadIds() {
    const seen = new Set();
    const result = [];
    for (const row of document.querySelectorAll("[data-app-action-sidebar-thread-id]")) {
      const hasUnreadMarker = Array.from(row.querySelectorAll("span")).some((node) => {
        const classes = String(node.className?.baseVal || node.className || "").split(/\s+/);
        if (!classes.includes("absolute") || !classes.includes("inset-0") || !classes.includes("rounded-full")) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const background = String(style.backgroundColor || "").replace(/\s+/g, "").toLowerCase();
        return rect.width >= 4 && rect.width <= 12
          && rect.height >= 4 && rect.height <= 12
          && style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || 1) > 0
          && background !== "transparent"
          && background !== "rgba(0,0,0,0)";
      });
      if (!hasUnreadMarker) continue;
      const threadId = normalizedThreadId(row.getAttribute("data-app-action-sidebar-thread-id"));
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      result.push(threadId);
    }
    return result;
  }

  function hostContext() {
    return { theme: theme(), threadId: activeThreadId() };
  }

  function postContext() {
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({
      type: "continuity:host-context",
      capability: config.capability,
      payload: hostContext(),
    }, "*");
  }

  function postFocus() {
    if (!active || !frameReady || !frame?.contentWindow) return;
    frame.contentWindow.postMessage({
      type: "continuity:focus",
      capability: config.capability,
    }, "*");
  }

  function createPage() {
    frameReady = false;
    const section = document.createElement("section");
    section.id = PAGE_ID;
    section.hidden = true;
    section.setAttribute(OWNED, "true");
    section.setAttribute("role", "region");
    section.setAttribute("aria-label", hostText("接着做", "Continue"));

    status = document.createElement("div");
    status.setAttribute("data-continuity-status", "true");
    status.textContent = hostText("正在找回最近进度…", "Finding your recent progress…");

    frame = document.createElement("iframe");
    frame.title = hostText("接着做", "Continue");
    frame.name = `codex-continuity-${crypto.randomUUID()}`;
    frame.src = "about:blank";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-downloads");
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame.addEventListener("load", postContext);

    section.append(frame, status);
    readyTimer = window.setTimeout(() => {
      if (!status || status.hidden) return;
      status.textContent = hostText(
        "最近进度暂时没有载入。Codex 原来的对话不受影响。",
        "Recent progress is not ready. Your original Codex tasks are unaffected.",
      );
    }, 12_000);
    return section;
  }

  function mountPage() {
    if (!active) return;
    if (!page) page = createPage();
    const surface = findMount();
    if (!surface) return;
    if (page.parentElement !== surface) surface.appendChild(page);
    restoreNativeContent();
    page.hidden = false;
    postContext();
    postFocus();
  }

  function restoreNativeContent() {
    document.querySelectorAll("[data-codex-continuity-native-hidden='true']")
      .forEach((node) => node.removeAttribute("data-codex-continuity-native-hidden"));
  }

  function open() {
    if (destroyed) return;
    if (!active) lastFocus = document.activeElement;
    pendingRefreshRequest = activeThreadId() || "refresh";
    active = true;
    ensureEntry();
    mountPage();
    postFocus();
  }

  function close(restoreFocus = true) {
    active = false;
    if (page) page.hidden = true;
    restoreNativeContent();
    entry?.setAttribute("aria-pressed", "false");
    if (restoreFocus) lastFocus?.focus?.();
    lastFocus = null;
  }

  function normalizedThreadId(value) {
    const threadId = String(value || "").trim().replace(/^(?:local|cloud):/i, "");
    return threadId && threadId.length <= 256 ? threadId : "";
  }

  function requestThreadOpen(value, preferredItem = null) {
    const threadId = normalizedThreadId(value);
    if (!threadId || openingThreadId || pendingThreadRequests.length) return;
    pendingResumeItem = preferredItem
      || (Array.isArray(latestData?.attentionItems) ? latestData.attentionItems : [])
      .find((item) => normalizedThreadId(item?.threadId) === threadId)
      || (Array.isArray(latestData?.worklines) ? latestData.worklines : [])
        .find((item) => normalizedThreadId(item?.threadId) === threadId)
      || null;
    openingThreadId = threadId;
    pendingThreadRequests.push(threadId);
    renderSidebarReturns();
    frame?.contentWindow?.postMessage({
      type: "continuity:thread-opening",
      capability: config.capability,
      payload: { threadId },
    }, "*");
  }

  function takeThreadRequest() {
    return pendingThreadRequests.shift() || "";
  }

  function requestThreadActivation(value) {
    const threadId = normalizedThreadId(value);
    if (!threadId || openingThreadId || pendingThreadActivationRequests.length) return;
    openingThreadId = threadId;
    pendingThreadActivationRequests.push(threadId);
  }

  function takeThreadActivationRequest() {
    return pendingThreadActivationRequests.shift() || "";
  }

  function requestThreadDetail(value) {
    const threadId = normalizedThreadId(value);
    if (!threadId || pendingDetailRequests.includes(threadId)) return;
    pendingDetailRequests.push(threadId);
  }

  function takeDetailRequest() {
    return pendingDetailRequests.shift() || "";
  }

  function takeRefreshRequest() {
    const request = pendingRefreshRequest;
    pendingRefreshRequest = "";
    return request;
  }

  function setOrganizationMode(mode) {
    if (mode !== "rules" && mode !== "codex") {
      return { accepted: false };
    }
    pendingOrganizationRequest = mode;
    return { accepted: true, mode };
  }

  function takeOrganizationRequest() {
    const request = pendingOrganizationRequest;
    pendingOrganizationRequest = null;
    return request;
  }

  function updateData(value) {
    latestData = value && typeof value === "object" ? value : null;
    if (resumeItem?.threadId) {
      resumeItem = (Array.isArray(latestData?.worklines) ? latestData.worklines : [])
        .find((item) => normalizedThreadId(item?.threadId) === normalizedThreadId(resumeItem.threadId))
        || resumeItem;
    }
    renderSidebarReturns();
    renderResumeStrip();
    frame?.contentWindow?.postMessage({
      type: "continuity:data",
      capability: config.capability,
      payload: { data: value },
    }, "*");
  }

  function failThreadDetail(value, message) {
    const threadId = normalizedThreadId(value);
    frame?.contentWindow?.postMessage({
      type: "continuity:detail-failed",
      capability: config.capability,
      payload: {
        threadId,
        message: String(message || hostText("任务停点暂时无法读取。", "Task context could not be loaded.")),
      },
    }, "*");
  }

  function removeResumeStrip() {
    if (resumeTimer !== null) window.clearTimeout(resumeTimer);
    resumeTimer = null;
    resumeSignature = "";
    document.getElementById(RESUME_STRIP_ID)?.remove();
  }

  function renderResumeStrip() {
    if (!resumeItem) {
      removeResumeStrip();
      return;
    }
    const surface = findMount();
    if (!surface) return;
    let strip = document.getElementById(RESUME_STRIP_ID);
    if (!strip) {
      strip = document.createElement("aside");
      strip.id = RESUME_STRIP_ID;
      strip.setAttribute(OWNED, "true");
      strip.setAttribute("aria-label", hostText("原任务续接信息", "Original task resume context"));
      surface.appendChild(strip);
    }
    const signature = JSON.stringify({
      threadId: resumeItem.threadId,
      project: resumeItem.project,
      title: resumeItem.threadTitle || resumeItem.title,
      checkpoint: resumeItem.checkpoint,
      next: resumeItem.attention || resumeItem.nextAction,
      source: resumeItem.sourceMeta,
      updated: resumeItem.updated,
    });
    if (signature === resumeSignature && strip.childElementCount) return;
    resumeSignature = signature;
    strip.replaceChildren();

    const content = document.createElement("div");
    content.setAttribute("data-resume-content", "true");
    const meta = document.createElement("div");
    meta.setAttribute("data-resume-meta", "true");
    meta.textContent = [hostText("已恢复现场", "Context restored"), resumeItem.project]
      .filter(Boolean).join(" · ");
    content.append(meta);

    if (resumeItem.checkpoint) {
      const checkpoint = document.createElement("div");
      checkpoint.setAttribute("data-resume-checkpoint", "true");
      const label = document.createElement("span");
      label.setAttribute("data-resume-label", "true");
      label.textContent = hostText("已到这里", "Checkpoint");
      checkpoint.append(label, document.createTextNode(String(resumeItem.checkpoint)));
      content.append(checkpoint);
    }

    const next = document.createElement("div");
    next.setAttribute("data-resume-next", "true");
    const nextLabel = document.createElement("span");
    nextLabel.setAttribute("data-resume-label", "true");
    nextLabel.textContent = hostText("下一步", "Next");
    next.append(nextLabel, document.createTextNode(String(
      resumeItem.attention || resumeItem.nextAction || hostText("查看最近回复后继续", "Continue from the latest reply"),
    )));
    content.append(next);

    const source = String(resumeItem.sourceMeta || [resumeItem.threadTitle, resumeItem.updated].filter(Boolean).join(" · "));
    if (source) {
      const sourceNode = document.createElement("div");
      sourceNode.setAttribute("data-resume-source", "true");
      sourceNode.textContent = `${hostText("来源", "Source")}：${source}`;
      content.append(sourceNode);
    }

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("data-resume-close", "true");
    closeButton.setAttribute("aria-label", hostText("关闭续接信息", "Close resume context"));
    closeButton.textContent = "×";
    closeButton.addEventListener("click", () => {
      resumeItem = null;
      removeResumeStrip();
    });
    strip.append(content, closeButton);

    if (resumeTimer === null) {
      resumeTimer = window.setTimeout(() => {
        resumeTimer = null;
        resumeItem = null;
        removeResumeStrip();
      }, 10_000);
    }
  }

  function completeThreadOpen(value) {
    const threadId = normalizedThreadId(value);
    if (!threadId) return;
    const row = Array.from(document.querySelectorAll("[data-app-action-sidebar-thread-id]"))
      .find((candidate) => (
        String(candidate.getAttribute("data-app-action-sidebar-thread-id") || "")
          .replace(/^(?:local|cloud):/i, "") === threadId
      ));
    const openedAttention = pendingResumeItem?.kind === "attention";
    const continuationGoal = pendingResumeItem?.kind === "goal-match" ? pendingContinuationGoal : "";
    resumeItem = openedAttention
      ? null
      : pendingResumeItem
        || (Array.isArray(latestData?.worklines) ? latestData.worklines : [])
          .find((item) => normalizedThreadId(item?.threadId) === threadId)
        || null;
    pendingResumeItem = null;
    pendingContinuationGoal = "";
    openingThreadId = "";
    if (openedAttention && latestData && typeof latestData === "object") {
      latestData = {
        ...latestData,
        attentionItems: (Array.isArray(latestData.attentionItems) ? latestData.attentionItems : [])
          .filter((item) => normalizedThreadId(item?.threadId) !== threadId),
      };
    }
    if (resumeItem?.id && latestData && typeof latestData === "object") {
      latestData = { ...latestData, activeId: resumeItem.id };
    }
    sidebarNotice = "";
    renderSidebarReturns();
    close(false);
    if (row?.isConnected) {
      row.click?.();
    } else {
      window.postMessage({
        type: "navigate-to-route",
        path: `/local/${encodeURIComponent(threadId)}`,
      }, window.location.origin);
    }
    if (resumeItem) window.setTimeout(renderResumeStrip, 180);
    if (continuationGoal) restoreContinuationGoal(threadId, continuationGoal);
  }

  function markThreadActiveElsewhere(value) {
    const threadId = normalizedThreadId(value);
    if (!threadId) return;
    const openedAttention = pendingResumeItem?.kind === "attention";
    pendingResumeItem = null;
    pendingContinuationGoal = "";
    openingThreadId = "";
    if (openedAttention && latestData && typeof latestData === "object") {
      latestData = {
        ...latestData,
        attentionItems: (Array.isArray(latestData.attentionItems) ? latestData.attentionItems : [])
          .filter((item) => normalizedThreadId(item?.threadId) !== threadId),
      };
    }
    sidebarNotice = hostText("已在另一个窗口打开", "Open in another window");
    renderSidebarReturns();
    clearSidebarNoticeSoon();
    frame?.contentWindow?.postMessage({
      type: "continuity:thread-active-elsewhere",
      capability: config.capability,
      payload: {
        threadId,
        message: hostText("这件事已在另一个窗口打开。", "This task is open in another window."),
      },
    }, "*");
  }

  function completeThreadActivation(value) {
    const threadId = normalizedThreadId(value);
    if (!threadId) return;
    openingThreadId = "";
    frame?.contentWindow?.postMessage({
      type: "continuity:thread-activation-complete",
      capability: config.capability,
      payload: { threadId },
    }, "*");
  }

  function failThreadActivation(value, message) {
    const threadId = normalizedThreadId(value);
    openingThreadId = "";
    frame?.contentWindow?.postMessage({
      type: "continuity:thread-activation-failed",
      capability: config.capability,
      payload: {
        threadId,
        message: String(message || hostText(
          "现在无法前往那个窗口。",
          "That window cannot be opened right now.",
        )),
      },
    }, "*");
  }

  function failThreadOpen(value, message) {
    const threadId = normalizedThreadId(value);
    pendingResumeItem = null;
    pendingContinuationGoal = "";
    openingThreadId = "";
    sidebarNotice = String(message || hostText("这次没有打开", "This task did not open."));
    renderSidebarReturns();
    clearSidebarNoticeSoon();
    frame?.contentWindow?.postMessage({
      type: "continuity:thread-open-failed",
      capability: config.capability,
      payload: {
        threadId,
        message: String(message || hostText(
          "你仍可以从 Codex 左侧找到这个对话。",
          "You can still find this task in the Codex sidebar.",
        )),
      },
    }, "*");
  }

  function receiveFrameMessage(event) {
    if (event.source !== frame?.contentWindow) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.capability !== config.capability) return;
    if (message.type === "continuity:ready") {
      frameReady = true;
      if (readyTimer !== null) window.clearTimeout(readyTimer);
      readyTimer = null;
      if (status) status.hidden = true;
      postContext();
      postFocus();
    } else if (message.type === "continuity:open-thread") {
      requestThreadOpen(message.payload?.threadId);
    } else if (message.type === "continuity:activate-thread") {
      requestThreadActivation(message.payload?.threadId);
    } else if (message.type === "continuity:load-thread") {
      requestThreadDetail(message.payload?.threadId);
    } else if (message.type === "continuity:set-organization-mode") {
      const result = setOrganizationMode(message.payload?.mode);
      frame?.contentWindow?.postMessage({
        type: "continuity:organization-mode-result",
        capability: config.capability,
        payload: result,
      }, "*");
    } else if (message.type === "continuity:close") {
      close();
    }
  }

  function receiveNativeClick(event) {
    const target = event.target?.closest?.("button,a,[role='button'],[data-app-action-sidebar-thread-id]");
    if (!target || target === entry || target.closest(`#${ENTRY_ID}`) || target.closest(`#${SIDEBAR_SECTION_ID}`)) return;
    if (target.closest("aside nav[role='navigation']")) {
      close(false);
      if (event.isTrusted) {
        resumeItem = null;
        removeResumeStrip();
      }
    }
  }

  function refresh() {
    ensureEntry();
    mountPage();
    renderResumeStrip();
    renderGoalMatch();
    const editor = nativeGoalEditor();
    const goal = nativeGoalText(editor);
    if (goal.length >= 4 && goal !== ignoredGoal
      && goal !== goalMatchRequestedGoal && goal !== goalMatchCheckedGoal) {
      scheduleGoalMatch(goal);
    }
    postContext();
  }

  function scheduleRefresh() {
    if (destroyed || refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 160);
  }

  function mount() {
    if (destroyed || observer || !document.documentElement) return;
    refresh();
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-theme", "aria-current"],
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    if (readyTimer !== null) window.clearTimeout(readyTimer);
    if (resumeTimer !== null) window.clearTimeout(resumeTimer);
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    if (goalMatchTimer !== null) window.clearTimeout(goalMatchTimer);
    if (continuationDraftTimer !== null) window.clearTimeout(continuationDraftTimer);
    observer?.disconnect();
    window.removeEventListener("message", receiveFrameMessage);
    document.removeEventListener("click", receiveNativeClick, true);
    document.removeEventListener("input", receiveNativeComposerInput, true);
    document.removeEventListener("keydown", receiveNativeComposerKeydown, true);
    document.removeEventListener("click", receiveNativeComposerClick, true);
    document.removeEventListener("DOMContentLoaded", mount);
    restoreNativeContent();
    document.querySelectorAll(`[${OWNED}="true"]`).forEach((node) => node.remove());
    if (window[SENTINEL] === api) delete window[SENTINEL];
  }

  const api = {
    version: VERSION,
    instanceId: config.capability,
    get active() { return active; },
    get entryMounted() { return Boolean(entry?.isConnected); },
    get sidebarMounted() { return Boolean(document.getElementById(SIDEBAR_SECTION_ID)?.isConnected); },
    get returnPointCount() {
      return document.querySelectorAll(`#${SIDEBAR_SECTION_ID} [data-continuity-return]`).length;
    },
    get dataReady() { return Boolean(latestData); },
    get frameMounted() { return Boolean(frame?.isConnected); },
    get frameReady() { return frameReady; },
    get frameName() { return frame?.name || ""; },
    get nativeActiveThreadId() { return normalizedThreadId(activeThreadId()); },
    get nativeUnreadThreadIds() { return nativeUnreadThreadIds(); },
    get goalMatchMounted() { return Boolean(document.getElementById(GOAL_MATCH_ID)?.isConnected); },
    get goalMatchPending() { return Boolean(pendingGoalMatchRequest || (goalMatchRequestedGoal && !goalMatchCheckedGoal)); },
    takeThreadRequest,
    takeThreadActivationRequest,
    takeDetailRequest,
    takeRefreshRequest,
    setOrganizationMode,
    takeOrganizationRequest,
    takeGoalMatchRequest,
    completeGoalMatch,
    failGoalMatch,
    completeThreadOpen,
    markThreadActiveElsewhere,
    completeThreadActivation,
    failThreadActivation,
    failThreadOpen,
    updateData,
    failThreadDetail,
    refresh,
    open,
    close,
    destroy,
  };
  window[SENTINEL] = api;
  window.addEventListener("message", receiveFrameMessage);
  document.addEventListener("click", receiveNativeClick, true);
  document.addEventListener("input", receiveNativeComposerInput, true);
  document.addEventListener("keydown", receiveNativeComposerKeydown, true);
  document.addEventListener("click", receiveNativeComposerClick, true);
  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
}

export function buildInjectionSource(config) {
  return `(${installContinuityHost.toString()})(${JSON.stringify(config)});`;
}

export function isCodexTarget(target) {
  if (target?.type !== "page") return false;
  const url = String(target.url || "");
  if (url.includes("initialRoute=%2Fglobal-dictation") || url.includes("initialRoute=%2Favatar-overlay")) {
    return false;
  }
  return url.startsWith("app://") || /^(Codex|ChatGPT)$/i.test(String(target.title || ""));
}
