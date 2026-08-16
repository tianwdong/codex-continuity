---
name: continuity-work-router
description: Route durable Codex work among the current task, native subagents, a persistent chat branch, or a separate new task while requiring explicit consent before container changes. Use when a user asks whether to split, fork, branch, delegate, use subagents, merge results back, or archive a branch, or answers a prior Continuity suggestion with “并行处理” or “run in parallel”, “开支线” or “create a branch”, “新建任务” or “create a new task”, “就在这里做” or “do it here”, “回到主线” or “return to the parent”, or “回主线并归档” or “return and archive”. Do not use for ordinary work or one-shot side questions that do not create a durable workline.
---

# Codex Continuity Work Router

Keep routing invisible unless durable work clearly benefits from changing containers. Never turn every request into a menu.
Write every user-facing response in the language of the user's latest request. Localize choice labels and example wording; preserve commands, native task titles, model names, links, and quoted evidence as-is.

## Resolve a pending choice first

- If the current system role or native task metadata identifies this task as delegated or subagent work, do the assigned bounded work and stop this workflow. Never make a Continuity route suggestion from inside a subagent; parent or higher-priority instructions still control delegation.
- If the request answers a pending `continuity-context-match` suggestion, let that Skill apply the choice and stop this workflow.
- Preserve the exact request that caused the prior routing suggestion. Never replace it with a generated approximation.
- Treat “就在这里做” as consent to execute that preserved request in the current task without asking again.
- Treat “并行处理”, “开支线”, “新建任务”, “回到主线”, and “回主线并归档” as consent only for the one route that was just proposed or when the user makes the same direct, unambiguous request. Never infer consent from silence or a vague acknowledgement.

## Choose the smallest fitting container

One-shot lookups, calculations, translations, and similar side questions are outside this workflow. Answer them in the current task without a routing suggestion.

Use these routes in order:

1. **Current task:** keep work here when it shares the current objective or context and can remain one coherent result. This is the default. Execute silently.
2. **Native subagent:** use only for bounded, independent work whose result can return to this task now, does not need a durable user-visible identity or later steering, and materially improves speed or quality by running separately. Prefer it for read-heavy research, review, or clearly separated implementation ownership. Keep a small task, one dependent chain, or shared mutable work in the current task; parallelism being technically possible is not enough.
3. **Persistent chat branch:** use when the work needs current history but should retain an independent context that the user may revisit, steer, or continue later. Prefer it for a long-lived alternative direction or an explicitly isolated worktree, not for a disposable subtask.
4. **Separate new task:** use only for unrelated durable work that is likely to need future steering, multiple turns, reusable artifacts, or persistent state. Never create it automatically.

When confidence is low, keep the work in the current task and say nothing about routing.

## Hand an approved native subagent route to dispatch

After choosing **Native subagent**, apply `$codex-continuity:continuity-subagent-dispatch` before presenting or executing that route. The dispatch Skill alone owns ModelDial reads, quality／economy mode selection, model and reasoning-effort advice, and permitted native overrides.

- ModelDial may inform configuration only after this Skill has chosen the native-subagent container. It must never decide whether work should be delegated.
- The dispatch Skill classifies the bounded responsibility as focused, exploration, or demanding. Do not duplicate that task-role logic here or expose it as another user choice.
- If the dispatch Skill is unavailable, invalid, or blocked by higher-priority rules, keep the normal native-subagent choice usable with the currently permitted configuration.
- Never duplicate its ranking logic, switch the current main agent, or expose extra model choices from this Skill.

## Offer one decision, not four options

For a bounded parallel subtask, use the dispatch Skill's lightweight recommendation when available. Otherwise say:

```text
这部分适合在当前任务内并行处理，结果会自动回来，不会增加任务列表。
回复「并行处理」或「就在这里做」。
```

For durable work that needs inherited context, say:

```text
这项工作以后可能需要单独回来，建议开一条支线保留当前上下文。
回复「开支线」或「就在这里做」。
```

For unrelated durable work, say:

```text
这件事不需要当前上下文，单独新建会更清楚。
回复「新建任务」或「就在这里做」。
```

Do not expose scores, internal classifiers, or tool names.

## Execute an approved subagent route

1. Use the native collaboration or subagent tools, not `create_thread` or `fork_thread`.
2. Obey the current system instructions and applicable `AGENTS.md` or Skill rules. A direct user request for a subagent, an applicable higher-priority instruction, or the explicit “并行处理” choice can authorize delegation; this Skill alone cannot.
3. Give each subagent one bounded responsibility. Warn it about shared workspace edits when applicable.
4. Use one subagent by default. Add another only for an independent, non-overlapping workstream that materially improves speed or quality; obey native concurrency and ownership rules.
5. Wait for the result, verify it proportionately, and synthesize it into the current parent task.
6. Never rename, archive, navigate to, match against, or present a subagent thread as a user task. The parent owns the outcome.
7. If the work becomes persistent or needs future user steering, have the subagent return a concise `needs_branch` summary. Ask the branch choice in the parent; never silently promote the subagent thread.
8. Let `continuity-subagent-dispatch` apply any permitted model or reasoning-effort override. Never duplicate its fallback or change the main agent here.

## Execute an approved branch route

1. Call the official `fork_thread` tool only after the user chooses or directly requests “开支线”. Fork the current human task. Use a same-directory branch by default; use a worktree only when the user explicitly asks for isolated parallel code edits.
2. Remember that a fork contains completed history only. After the child is ready, send the exact preserved request to it with `send_message_to_thread` when work must start there.
3. Navigate to the child only after creation and message delivery succeed. On failure, keep the current task unchanged and point to Codex's native right-click “创建聊天分支” fallback.
4. Never archive or rename the parent merely because a branch exists.

## Return a branch to its parent

Treat “合回” as a context handoff, not a physical chat merge.

1. Resolve the official parent or fork relation. Never guess a parent from similar titles or directories.
2. Build a short return brief from the branch's verified results: outcome, changed files or artifacts, verification, and unresolved work. Do not copy the full conversation.
3. Confirm the parent is available and not running another turn. Send the return brief to the parent with `send_message_to_thread`, then navigate to the parent only after delivery succeeds.
4. Keep the branch by default. Archive it only when the user explicitly chose “回主线并归档”, and only after the handoff succeeds.
5. For a worktree branch, do not claim that code was merged. Report the actual Git state and require the normal reviewed Git integration path.
6. If the parent relation or delivery is unavailable, leave both tasks unchanged and explain the native fallback.

## Preserve task boundaries

- Exclude delegated and subagent tasks from title maintenance, context matching, branch suggestions, archive suggestions, and attention lists.
- Do not scan the task list in this workflow; `continuity-context-match` owns duplicate detection.
- Do not auto-archive completed human tasks. Archive only a confirmed duplicate or an explicitly completed branch after successful handoff.
- Do not create a Dashboard, project hierarchy, branch manager, or second task database.
