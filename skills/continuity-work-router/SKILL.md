---
name: continuity-work-router
description: Quietly classify each new durable Codex goal as work for the current task, a native subagent, a persistent chat branch, or a separate new task. Invoke implicitly for new durable goals and when a user asks to split, fork, branch, delegate, use subagents, merge results back, archive a branch, or answers a prior Continuity suggestion with “并行处理” or “run in parallel”, “开支线” or “create a branch”, “新建任务” or “create a new task”, “就在这里做” or “do it here”, “回到主线” or “return to the parent”, or “回主线并归档” or “return and archive”. Stay silent for current-task decisions, one-shot side questions, and low-confidence classifications.
---

# Codex Continuity Work Router

Classify every new durable goal, but keep routing invisible unless another container has a credible independent benefit. Never turn every request into a menu.
Write every user-facing response in the language of the user's latest request. Localize choice labels and example wording; preserve commands, native task titles, model names, links, and quoted evidence as-is.

## Resolve a pending choice first

- If the current system role or native task metadata identifies this task as delegated or subagent work, do the assigned bounded work and stop this workflow. Never make a Continuity route suggestion from inside a subagent; parent or higher-priority instructions still control delegation.
- If the request answers a pending `continuity-context-match` suggestion, let that Skill apply the choice and stop this workflow.
- Preserve the exact request that caused the prior routing suggestion. Never replace it with a generated approximation.
- Treat “就在这里做” as consent to cancel the pending route receipt and execute that preserved request in the current task without asking again.
- If the latest request directly says to keep or do the work in the current task, choose **Current task** immediately. This explicit choice overrides an automatic delegation, branch, or new-task recommendation that has not yet executed.
- Treat “并行处理”, “开支线”, “新建任务”, “回到主线”, and “回主线并归档” as consent only for the one route that was just proposed or when the user makes the same direct, unambiguous request. Never infer consent from silence or a vague acknowledgement.

## Persist only high-impact route actions

Persistent branches, separate tasks, cross-task returns, and archives must use the bundled private action receipt. It stores only task ids, action kind, source turn id, timestamps, and step state; never pass request text, titles, summaries, code, or message content to it. Native subagents return inside the current task and do not use this receipt.

- On macOS or Linux, run `/bin/sh "<plugin-root>/scripts/run-action-command.sh" <operation> --current "<current-task-id>"` with the required `--target`, `--kind`, `--source-turn`, `--step`, or `--reason` fields.
- On Windows, run `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<plugin-root>\scripts\run-plugin-node.ps1" -Mode action -ActionOperation <operation> -CurrentTaskId "<current-task-id>"` and map those fields to `-TargetTaskId`, `-ActionKind`, `-SourceTurnId`, `-ActionStep`, and `-FailureCode`.
- Before offering a branch, new-task, return, or return-and-archive choice, run `propose` with the Hook-supplied current task and source turn ids. Use kind `create-branch`, `create-task`, `return-parent`, or `return-archive`; return kinds also require the official parent target id. Do not present an actionable choice if persistence fails.
- For a reply to a proposal, run `confirm` with that exact kind. Proceed only for `ok: true`. For a direct, unambiguous request for the structural action, run `start` instead. A missing, stale, mismatched, failed, or completed receipt cannot authorize a structural action.
- Before every native `create_thread`, `fork_thread`, cross-task send, navigation, or archive call, run `begin-step`. Call the native tool only for decision `perform`; skip it for `done`; stop without replay for `uncertain` or `unavailable`.
- After native success, immediately run `complete-step`. When `create` succeeds, include the returned child task id as the receipt target. On definite failure, run `fail`. When the planned sequence is complete, run `finish`.

## Choose the smallest fitting container

One-shot lookups, calculations, translations, and similar side questions are outside this workflow. Answer them in the current task without a routing suggestion.

Use these routes in order:

1. **Current task:** keep work here when it shares the current objective or context and can remain one coherent result. This is the default. Execute silently.
2. **Native subagent:** use for bounded work whose result can return to this task now and does not need a durable user-visible identity or later steering. Recommend it when one responsibility can return independently and separate execution has a credible practical benefit. Because an unlaunched recommendation is reversible, any one of these shapes is enough for a medium-confidence suggestion: two or more separable scopes; implementation plus independent verification; cross-platform or documentation／code／test comparison; a read-heavy scan across several files or sources; test or log analysis; or clearly non-overlapping implementation ownership. Infer this from the task shape; do not require the user to say “parallel” or “subagent”. Keep a one-shot lookup, small sequential task, or one dependent chain in the current task. Shared mutable writes do not justify parallel writers: keep those writes with the parent and delegate only a useful read-only scan, review, or verification. If no safe bounded responsibility remains, keep the whole goal here.
3. **Persistent chat branch:** use when the work needs current history but should retain an independent context that the user may revisit, steer, or continue later. Prefer it for a long-lived alternative direction or an explicitly isolated worktree, not for a disposable subtask.
4. **Separate new task:** use only for unrelated durable work that is likely to need future steering, multiple turns, reusable artifacts, or persistent state. Never create it automatically.

When confidence is low, keep the work in the current task and say nothing about routing.

Use separate thresholds for recommendation and execution:

- Medium confidence is enough to show at most one lightweight native-subagent recommendation for the preserved durable goal, because execution still waits for the user's choice.
- Automatic launch under standing authorization still requires a high-confidence fit and a safely isolated responsibility.
- The user's “并行处理” choice authorizes that bounded route, not overlapping writes or a wider task. If safe ownership cannot be isolated, narrow the subagent to read-only review or verification and keep shared edits with the parent.

Classify the fitting container before checking launch authorization. Lack of launch authorization is not a reason to classify a medium-confidence native-subagent fit as **Current task**. After the user chooses “就在这里做”, execute the preserved goal here and do not offer the same route again for that goal.

Do not announce a **Current task** classification, confidence score, internal rationale, or the fact that this Skill ran. Continue with the user's request.

## Refresh a changed work chapter through the current Codex host

The initial task title belongs to Codex. On a later root-task turn, maintain the visible title only when the `UserPromptSubmit` context explicitly says automatic task-title maintenance is unlocked for this turn.

After a **Current task** route has produced a reliable completed result, decide whether the durable work chapter—not merely the next step—has clearly changed. If it has:

1. Read the current workstream from the native title. If the title already uses `workstream｜chapter`, the text before `｜` is the workstream; otherwise the complete title is the workstream.
2. Keep that workstream by default. Replace it only when the user explicitly switched the primary durable objective, or when both the previous reliable chapter and the current completed result consistently center the same new durable context and the old workstream would mislead the user's next return.
3. Keep unrelated durable work in the branch or new-task decision above instead of repurposing this task.
4. Create one concise, outcome-oriented chapter phrase. Do not use a status word, internal function, command, mechanical fix, or next action as the chapter.
5. Before the final reply, call the native `set_thread_title` tool exactly once with `workstream｜chapter`. This current-host call owns immediate sidebar visibility; the `Stop` Hook remains the progress recorder and fallback.
6. Do not mention title maintenance unless the user asks.

Skip this step for the first task turn, one-shot side questions, a delegated or subagent task, a branch that should keep its own identity, the same chapter, minor fixes, wording or test-only refinements, partial or failed work, blocked work, low confidence, a missing stable workstream, an unavailable native title tool, or any context that says title maintenance is locked.

## Hand a selected native subagent route to dispatch

After choosing **Native subagent**, apply `$codex-continuity:continuity-subagent-dispatch` before presenting or executing that route. The dispatch Skill alone owns ModelDial reads, quality／economy mode selection, model and reasoning-effort advice, and permitted native overrides.

- ModelDial may inform configuration only after this Skill has chosen the native-subagent container. It must never decide whether work should be delegated.
- The dispatch Skill classifies the bounded responsibility as focused, exploration, or demanding. Do not duplicate that task-role logic here or expose it as another user choice.
- If the dispatch Skill is unavailable, invalid, or blocked by higher-priority rules, keep the normal native-subagent choice usable with the currently permitted configuration.
- Never duplicate its ranking logic, switch the current main agent, or expose extra model choices from this Skill.
- Selecting the subagent route authorizes the dispatch Skill to prepare one recommendation. It does not by itself authorize launching a subagent.
- Treat a direct request for delegation, an explicit pending choice of “并行处理”, an applicable higher-priority instruction, or an explicit standing instruction to auto-delegate suitable work as authorization to launch. Do not infer standing authorization from prior successful delegations, silence, tool availability, or installation of this plugin.
- With standing authorization, launch only a high-confidence fit with a safely isolated responsibility, then briefly state what was delegated and which permitted worker configuration was used. Do not ask for another confirmation.
- Without launch authorization, present one lightweight recommendation and wait for “并行处理” or “就在这里做”.

## Offer one decision, not four options

Show at most one route recommendation for each preserved durable goal. A rejection applies to that goal and must not be asked again.

For a bounded parallel subtask without launch authorization, use the dispatch Skill's lightweight recommendation when available. Otherwise say:

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

Persist the matching route proposal before showing either persistent-task choice above. If the receipt cannot be written, keep the work in the current task and do not show a choice that cannot later be verified.

Do not expose scores, internal classifiers, or tool names.

Creating a persistent branch or separate task, returning work to another task, and archiving a task always require an explicit user choice. A direct, unambiguous request for that exact action is the confirmation; an inferred route is not.

## Execute an approved subagent route

1. Use the native collaboration or subagent tools, not `create_thread` or `fork_thread`.
2. Obey the current system instructions and applicable `AGENTS.md` or Skill rules. A direct user request for a subagent, an applicable higher-priority instruction, an explicit standing auto-delegation instruction, or the explicit “并行处理” choice can authorize delegation; this Skill alone cannot.
3. Give each subagent one bounded responsibility. User confirmation does not authorize overlapping writers. Keep shared mutable edits with the parent and narrow the subagent to independent implementation, read-only review, testing, or verification.
4. Use one subagent by default. Add another only for an independent, non-overlapping workstream that materially improves speed or quality; obey native concurrency and ownership rules.
5. Wait for the result, verify it proportionately, and synthesize it into the current parent task.
6. Never rename, archive, navigate to, match against, or present a subagent thread as a user task. The parent owns the outcome.
7. If the work becomes persistent or needs future user steering, have the subagent return a concise `needs_branch` summary. Ask the branch choice in the parent; never silently promote the subagent thread.
8. Let `continuity-subagent-dispatch` apply any permitted model or reasoning-effort override. Never duplicate its fallback or change the main agent here.
9. After an automatically authorized launch, give one brief disclosure in the parent task. Do not turn it into a second approval step or expose internal classification details.

## Execute an approved branch route

1. Confirm the pending `create-branch` receipt, or start one for a direct unambiguous request. Then call `begin-step` for `create`. Only for `perform`, call the official `fork_thread` tool, fork the current human task, and immediately record `complete-step` with the returned child task id. Use a same-directory branch by default; use a worktree only when explicitly requested.
2. Remember that a fork contains completed history only. Call `begin-step` for `send`; only for `perform`, send the exact preserved request to the recorded child with `send_message_to_thread`, then record `complete-step`.
3. Call `begin-step` for `navigate`; only for `perform`, navigate to the child, then record `complete-step` and `finish`. On failure or an uncertain step, keep the current task unchanged and point to Codex's native right-click “创建聊天分支” fallback. Never replay an uncertain create or send.
4. Never archive or rename the parent merely because a branch exists.

## Execute an approved separate-task route

1. Confirm the pending `create-task` receipt, or start one for a direct unambiguous request. Call `begin-step` for `create`; only for `perform`, call the official `create_thread` tool once with the exact preserved request and immediately record `complete-step` with its returned task id.
2. Do not send the request a second time: `create_thread` already dispatches it. Navigate only when the user asked to switch, and guard that navigation with the receipt.
3. Finish the receipt after the intended creation and optional navigation. On failure or an uncertain create, keep the current task unchanged and never create another task automatically.

## Return a branch to its parent

Treat “合回” as a context handoff, not a physical chat merge.

1. Resolve the official parent or fork relation. Never guess a parent from similar titles or directories. Confirm the matching `return-parent` or `return-archive` receipt, or start it for a direct unambiguous request.
2. Build a short return brief from the branch's verified results: outcome, changed files or artifacts, verification, and unresolved work. Do not copy the full conversation.
3. Confirm the parent is available and not running another turn. Guard `send` and `navigate` with `begin-step` and `complete-step`; send the return brief once, then navigate only after delivery is recorded successful.
4. Keep the branch by default. Archive it only when the user explicitly chose “回主线并归档”. For `return-archive`, guard the archive step and archive only after send and navigation are recorded successful. Finish the receipt after all intended steps. Never replay an uncertain send, navigation, or archive.
5. For a worktree branch, do not claim that code was merged. Report the actual Git state and require the normal reviewed Git integration path.
6. If the parent relation or delivery is unavailable, leave both tasks unchanged and explain the native fallback.

## Preserve task boundaries

- Exclude delegated and subagent tasks from title maintenance, context matching, branch suggestions, archive suggestions, and attention lists.
- Do not scan the task list in this workflow; `continuity-context-match` owns duplicate detection.
- Do not auto-archive completed human tasks. Archive only a confirmed duplicate or an explicitly completed branch after successful handoff.
- Do not create a Dashboard, project hierarchy, branch manager, or second task database.
