---
name: continuity-title
description: Inspect the latest Codex Continuity task progress, or inspect, undo, lock, and resume automatic task-title updates. Use when the user asks what the current task most recently accomplished, whether its title changed automatically, wants to undo the latest automatic title update, or wants to stop or resume automatic title maintenance.
---

# Codex Continuity Status and Title Control

Codex Continuity normally runs automatically after a root task turn stops. Do not invoke the title checker on every turn from this skill; the bundled `Stop` hook owns automatic evaluation.
Write every user-facing response in the language of the user's latest request. Preserve commands, native task titles, and quoted progress evidence as-is.

Resolve the plugin root as two directories above this `SKILL.md` file, then use the platform title runner for every operation below:

- On macOS or Linux, run `scripts/run-title-command.sh <operation>` from the plugin root.
- On Windows, run `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<plugin-root>\scripts\run-plugin-node.ps1" -Mode title -Operation <operation>`.

## Inspect the current task

1. Run the platform title runner with `status`.
2. Report the latest progress chapter and result when `progress` is present, followed by the current native title, whether an undo is available, and whether the task is locked against future automatic changes.
3. If `progress` is null, say that no reliable completed progress has been recorded yet. Do not invent one from the conversation.
4. Do not print either ledger file or any environment values.

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

If the current task ID is unavailable, stop and explain that the operation must be run from the task whose title should be inspected or restored.
