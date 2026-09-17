---
name: continuity-title
description: Inspect progress or prepare an on-demand continuation brief for the current Codex task, diagnose Continuity health, or control automatic titles. Use when the user explicitly asks where work stopped, what remains, to restore work context, for a continuation brief, or for Continuity health and title controls. A plain request to continue work does not trigger a check.
---

# Codex Continuity Status and Title Control

Codex Continuity normally runs automatically after a root task turn stops. Do not invoke the title checker on every turn from this skill; the bundled `Stop` hook owns automatic evaluation.
Use the continuation brief below for explicit requests such as “上次做到哪”, “还有什么没做”, “恢复工作上下文”, or “续接简报”. An ordinary “继续” means continue the active work; it does not request a status check or brief.
Write every user-facing response in the language of the user's latest request. Preserve commands, native task titles, and quoted progress evidence as-is.

Resolve the plugin root as two directories above this `SKILL.md` file, then use the platform title runner for every operation below:

- On macOS or Linux, run `scripts/run-title-command.sh <operation>` from the plugin root.
- On Windows, run `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<plugin-root>\scripts\run-plugin-node.ps1" -Mode title -Operation <operation>`.

## Prepare a continuation brief on request

1. Run `status` once for the current task. Treat `progress` as a recorded summary, with `sourceTurnId`, `sourceMessageId`, and `updatedAt` identifying its source and age. An evaluated or handled later Stop does not make that summary newer. Preserve `refresh` and `progressFreshness` when reporting its limits.
2. Use the latest explicit user instructions and final answers already available in the current task context. If they establish the current scope, completed results, and remaining work, no additional native read is needed. A local summary alone does not establish what remains or what to do next.
3. If necessary evidence is missing, use the existing native `read_thread` tool for this task with `turnLimit: 3` and `includeOutputs: false`. The current task ID must be explicit, for example `status.threadId` returned by the runner using the current `CODEX_THREAD_ID`; never infer it from a title or inspect another task. Use at most one additional page, with the returned cursor and the same limit, only to resolve missing source evidence. If the source is still absent, truncated, or unavailable, mark the corresponding point unknown. Do not scan raw transcripts.
4. Give a short brief distinguishing completed results, explicitly unfinished work or blockers, and items awaiting confirmation. Prefer the latest governing user instruction and latest relevant final answer over an older summary. Attribute reported completion to its source; do not turn an assistant's proposal, suggested next step, or unapproved plan into a user commitment. Include a next action only when those latest sources explicitly support it; otherwise mark it unknown.
5. Label the sources briefly, using available turn/message IDs or source time, and disclose stale or unavailable evidence and the refresh state. Missing remaining-work evidence does not mean everything is complete. If `status` is unavailable, use only the current context's supported facts and state that freshness could not be checked.

The brief is read-only and scoped to the current task. Do not create a brief database, call a background model, dump raw history or ledgers, print environment values, send a continuation message, switch tasks, or create a task as part of preparing it.

## Inspect the current task

1. Run the platform title runner with `status`.
2. Report the latest progress chapter and result when `progress` is present, followed by the title, whether an undo is available, and whether the task is locked against future automatic changes. Null control fields mean unavailable, not unlocked.
3. If `progress` is null, say that no reliable completed progress has been recorded yet. Do not invent one from the conversation.
4. Explain `refresh` when busy, pending, failed, or unknown. A busy background update leaves the last reliable progress readable. `previous_reliable` means the latest Stop was handled without replacing that progress; it may have failed, so also inspect `refresh.state`.
5. If `nativeTitle.state` is `unavailable`, label a returned title as the last local snapshot; do not claim it is the current native title. Status reads do not wait on or change the Stop write lock.
6. Do not print either ledger file or any environment values.

## Check whether Continuity is working

For requests such as “检查 Continuity 是否正常”, run the platform title runner with `doctor` once. This reads local metadata only: it does not start a model or service, read authentication, or change files. Do not run it on every turn.

Report the refresh state and the returned `nextStep` in the user's language, with the executing plugin manifest version, latest recorded Stop time, progress freshness, background lock, and failure stage when relevant. The manifest describes the plugin files executing this command; `hostLoadedVersion: unknown` does not establish which version Codex has loaded. `hookTrust: unknown` cannot establish whether Hooks are trusted or enabled.

Missing or corrupt metadata is a diagnostic limit, not proof of disabled Hooks. A Stop receipt or completed diagnostic does not prove that progress or a title changed. Preserve that distinction when the latest Stop was handled without new reliable progress. Do not print paths, environment values, raw errors, transcripts, or raw ledger contents. The diagnosis itself requires no extra approval and does not authorize repairs.

When `lastWorkerVersion` is present, identify it as the code version that wrote the latest Stop diagnostic, together with that diagnostic's turn and stage. It can differ from the executing command's manifest version; neither proves the host's current loaded version. A launch failure does not prove that the background worker started. Missing version evidence from older records stays unknown.

## Undo the latest automatic title update

1. Run the platform title runner with `undo`.
2. The script uses the current `CODEX_THREAD_ID`; never guess another task ID.
3. If the JSON result has `ok: true`, call the native `set_thread_title` tool once with its returned `title`. This same-title call refreshes the Codex sidebar; do not guess or rewrite the title.
4. Report whether the original title was restored. Undo suppresses that rejected title suggestion but leaves future work chapters eligible for automatic maintenance.

## Lock automatic maintenance

1. Run the platform title runner with `lock`.
2. Report that the current native title is preserved and future automatic title changes are paused.
3. Do not call `set_thread_title`; locking does not change the title.

## Resume automatic maintenance

1. Run the platform title runner with `resume`.
2. Report that future completed turns can update the title again when the work chapter clearly changes.
3. Do not call `set_thread_title`; resuming does not immediately rename the task.

If the current task ID is unavailable, do not perform native reads or title mutations. Explain that those operations must run from the intended task; a brief may still report supported facts from the current context with that limitation.
