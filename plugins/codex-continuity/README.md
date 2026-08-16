<p align="center">
  <img src="./assets/logo.png" alt="Codex Continuity" width="112" />
</p>

<h1 align="center">Codex Continuity</h1>

<p align="center"><strong>Continue the right task. Keep the context you already built.</strong></p>

<p align="center">
  A lightweight, local-first Codex plugin that helps you return to the task that already knows the work,<br />
  keep progress recognizable, and choose the right native path when work needs to split.
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./LICENSE">MIT License</a> ·
  <a href="./PRIVACY.md">Privacy</a> ·
  <a href="https://github.com/tianwdong/codex-continuity/issues">Issues</a>
</p>

<p align="center">
  <img alt="Platform: macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111111" />
  <img alt="Codex plugin" src="https://img.shields.io/badge/Codex-plugin-0A7AFF" />
  <img alt="Local first" src="https://img.shields.io/badge/data-local--first-2E8B57" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-EA7A16" />
</p>

> [!IMPORTANT]
> Codex Continuity is not another task manager. It does not ask you to maintain another list: tasks stay in Codex, files stay in your project, and Continuity only helps you find where the useful context lives and how the work has moved.

## Install with Codex

Copy this into Codex:

```text
Install the Codex Continuity plugin from this repository:
https://github.com/tianwdong/codex-continuity

Use the repository's Codex Marketplace entry. When installation finishes, tell me when to restart Desktop and guide me through reviewing the plugin Hooks.
```

After installation, restart Desktop and review and trust **Codex Continuity** when Codex asks. You do not need to remember an install command.

<details>
<summary>Prefer installing it yourself?</summary>

```bash
codex plugin marketplace add tianwdong/codex-continuity
codex plugin add codex-continuity@codex-continuity
```

Restart Desktop, then review and trust **Codex Continuity** in Hook management. The repository Marketplace installs only the allowlisted `plugins/codex-continuity/` bundle.

</details>

## Four ways Continuity helps

Two abilities work quietly during normal Codex use. The other two appear only when you ask for help deciding how work should continue.

### 1. Continue the task that already knows the work · Core

When you start a new task inside a project, Continuity checks whether one existing task already contains the context you need. If there is one clear match, it suggests **Continue the existing task** or **Stay here**. If the answer is uncertain, it stays out of the way.

### 2. See what each task has become · Core

Codex can name a task from its first message, but the work may later move somewhere else. Continuity keeps a short local progress marker and only updates the native title after a clear chapter change. You can inspect, undo, lock, or resume automatic title maintenance at any time.

### 3. Decide whether work should stay, branch, or start fresh · On demand

When you ask whether work should be split, Continuity recommends one native Codex path: stay in the current task, use a subagent, create a chat branch, or start a new task. It explains the choice and waits for your approval.

### 4. Pick a suitable subagent · On demand

After you choose delegation, Continuity can recommend both a main-agent profile and a worker profile. The main-agent choice remains yours; the worker profile is applied only when you approve the dispatch. Recommendations may use the latest public [ModelDial Radar](https://modeldial.com/radar) snapshot, without sending your prompt, code, task title, project folder, current configuration, credentials, or telemetry to ModelDial.

## A simple way to organize Codex work

**One stable project folder → several outcome-focused tasks → continue the task that already knows the work.**

- Put work that shares files and background in one stable project folder. An app, website, and backend for the same product can all live under the same project root.
- Create a separate task for each distinct outcome—not for every file, technical layer, or small fix.
- Continue an existing task when the new request depends on context already built there. Start fresh when the outcome can stand on its own.
- Quick, self-contained requests can still start without a project folder. Continuity simply avoids automatic context matching when there is no reliable project boundary.
- No `ROADMAP.md`, labels, manual status fields, or second task system is required.

<details>
<summary>Why keep the project root stable?</summary>

Automatic matching deliberately uses the exact same, non-empty working directory as its project boundary. Opening the repository root one day and a nested `app/` directory the next creates two different boundaries, which reduces match quality. This strict rule prevents unrelated projects with similar language from being mixed together.

This follows the native [Codex project model](https://learn.chatgpt.com/docs/projects): keep long-lived work and shared files in one project, then use a separate task for each distinct outcome.

</details>

## A concrete example

Codex names a task from its first prompt, while real work keeps moving. A task called **“Add Google Analytics”** may eventually become a Cloudflare cost investigation. A week later, the original title no longer tells you which task has the right context.

```text
Native first title          Add Google Analytics
Later working context       Cloudflare cost containment verified
Continuity title            Cloudflare cost | Containment verified
```

Continuity solves this without adding a board, inbox, labels, priorities, or another project database.

## How the two automatic moments work

### Before the first message: look for existing context

Describe your goal naturally. On the first prompt of a genuinely new task, Continuity reviews tasks inside the same project boundary.

- No strong match: your prompt continues normally.
- Ambiguous match: your prompt continues normally.
- One unique, high-confidence match: Continuity suggests either continuing that task or staying here.

It never sends another message, navigates, archives, forks, or merges a task without your choice.

### After a completed turn: keep progress recognizable

Codex still owns the initial title. After later turns, an asynchronous `Stop` Hook reads a bounded slice of the final reply and extracts the current work chapter, one evidence-backed progress statement, and whether the work has moved far enough to justify a title update.

Only a clear chapter change may update the native title. Small fixes, repeated conclusions, incomplete work, weak evidence, or model failure leave it untouched. Automatic title changes are reversible and can be locked per task.

## Two moments, no new workflow

<p align="center">
  <img src="./assets/continuity-flow-en.svg" alt="Say what you want, see whether it already exists, keep working in Codex, then make the result easy to find next time." width="1200" />
</p>

There is no inbox to clear, no board to groom, and no status taxonomy to learn.

## Use it

No command is required for everyday work.

1. Create a task and describe the goal naturally.
2. If Continuity finds one reliable existing context, choose whether to continue it or stay in the new task.
3. Let Codex finish a turn. Continuity records a short local progress marker and updates the title only when the chapter has clearly changed.

You can also ask in natural language:

```text
What did this task most recently accomplish?
Undo the last automatic title change.
Keep this title and stop updating it automatically.
Resume automatic title updates.
```

## How on-demand routing works

Continuity does not interrupt ordinary requests with a workflow menu. If you explicitly ask whether work should be split, parallelized, or moved elsewhere, an on-demand Skill can recommend one native Codex carrier:

| Situation | Recommended native carrier |
| --- | --- |
| Bounded, independent work whose result should return immediately | Subagent |
| Work that inherits the current context but needs a durable conversation | Chat branch |
| Work that does not need the current context | New task |
| Everything else | Stay in the current task |

The recommendation is optional. Continuity does not create the subagent, branch, or task until you authorize the native action.

When a subagent is appropriate, the optional delegation Skill uses Codex model roles to narrow the model family and may read the latest public [ModelDial Radar](https://modeldial.com/radar) snapshot to select a configuration within that family. It always states the main-agent recommendation as well as the worker recommendation. The plugin does not switch the main agent automatically, and no prompt, code, task title, working directory, current configuration, credentials, or telemetry is sent to ModelDial.

## Compatibility

- macOS or Windows 11
- A recent Codex or ChatGPT Desktop installation
- A working model/provider configuration in Codex

Title and progress maintenance depends on an asynchronous `Stop` Hook. The macOS path has been verified with the Desktop-bundled `codex 0.148.0-alpha.9`. Windows uses the official `commandWindows` Hook override, native PowerShell, and the Desktop-bundled Node/Codex runtime when available. The standalone `codex 0.146.1` loads first-prompt matching but skips asynchronous `Stop` Hooks. If matching works but titles never update, update Desktop first.

## Privacy and control

- **No Continuity backend.** There is no Continuity account and no task-content telemetry.
- **No credential copying.** Semantic decisions reuse the provider and login state already configured in Codex. The plugin does not read API keys, tokens, or the Codex login database.
- **Bounded context.** Title maintenance uses the current title, the previous short progress marker, and a limited slice of the final reply.
- **Same-directory matching.** Automatic matching reviews at most three candidates with the exact same non-empty working directory and at most their two most recent user/final-reply pairs.
- **Small local ledger.** It stores IDs, short chapter/progress text, confidence, and control state—not full prompts or conversations.
- **Reversible behavior.** Suggestions never force navigation; automatic renames can be undone, locked, and resumed.

Local state lives in the current user's platform data directory:

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/Codex Continuity Plugin/` |
| Windows | `%LOCALAPPDATA%\Codex Continuity Plugin\` |
| WSL/Linux | `${XDG_STATE_HOME:-~/.local/state}/codex-continuity-plugin/` |

macOS and Linux use directory mode `0700` and file mode `0600`. Windows uses the current user's `LOCALAPPDATA` access controls. See [PRIVACY.md](./PRIVACY.md) for the complete boundary.

## Native-first architecture

Continuity reuses Codex capabilities instead of recreating a conversation system.

| Moment | Native source of truth | Continuity adds | Failure behavior |
| --- | --- | --- | --- |
| First prompt in a new task | `UserPromptSubmit`, native task list and reads | Review up to three same-directory candidates | Continue the original prompt silently |
| User explicitly asks to split work | Plugin Skill and native task/subagent tools | Recommend one carrier | Stay in the current task |
| A turn completes | Async `Stop` Hook, `turn_id`, final assistant message | Extract chapter/progress; optionally request a title change | Preserve the existing title and progress |
| User requests control | Plugin Skill | Inspect, undo, lock, or resume title maintenance | Make no task change |

The semantic model makes bounded judgments; it does not own task state. Codex App Server remains authoritative for tasks, lineage, reads, and title operations. Uncertain paths fail closed.

## Deliberate boundaries

Continuity intentionally does **not** provide:

- a board, inbox, priorities, due dates, or another project database;
- manual labels or a status-maintenance ritual;
- automatic navigation, archiving, forking, merging, or subagent creation;
- cross-directory matching unless the user explicitly requests it;
- modification of the official app bundle or `app.asar`;
- a custom replacement for the native Codex task list.

Current technical limits:

- macOS is verified on a real Desktop installation; the native Windows path has automated contract coverage but still needs a real Windows Desktop acceptance run before its beta label is removed;
- native sidebar title updates may appear with a delay because cross-connection `thread/name/set` changes are not always broadcast immediately;
- an unfinished background Hook may be cancelled when Codex closes the task;
- the official Plugin UI does not yet expose a stable custom row/action slot in the task sidebar;
- returning from a chat branch means reporting a result back to the parent task, not physically merging conversation histories.

## Develop

```bash
git clone https://github.com/tianwdong/codex-continuity.git
cd codex-continuity
npm start
```

`npm start` validates every Skill and builds the same allowlisted plugin into:

```text
dist/plugin/codex-continuity
plugins/codex-continuity
```

Run the release checks:

```bash
npm run validate:skills
npm test
npm run build:plugin
```

For local development installation on macOS:

```bash
npm run install:plugin:dev -- --wait
```

Then quit Codex/ChatGPT. The installer waits for the main app to exit, rebuilds the plugin, installs it, and verifies the manifest, file list, and SHA-256 of every installed file. Do not write directly into `~/.codex/plugins/cache/`.

## Repository map

- `.codex-plugin/plugin.json` — plugin manifest
- `hooks/hooks.json` — `UserPromptSubmit` and `Stop` lifecycle entries
- `skills/` — context matching, work routing, subagent delegation, and title controls
- `src/plugin-*.mjs` — prompt marker, semantic decisions, progress ledger, and title runtime
- `scripts/build-plugin.sh` — allowlist-based distributable build
- `scripts/run-plugin-node.ps1` — native Windows Hook and title-control launcher
- `plugins/codex-continuity/` — the exact allowlisted bundle installed by the repository Marketplace

## Public documentation

- [Privacy](./PRIVACY.md)
- [Security policy](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)
- [MIT License](./LICENSE)

## License

Codex Continuity is released under the [MIT License](./LICENSE).
