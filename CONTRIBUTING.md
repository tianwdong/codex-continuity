# Contributing to Codex Continuity

Codex Continuity stays deliberately small: it reuses native Codex tasks, Hooks, Skills, subagents, and chat branches instead of creating another task system.

## Before changing code

- Keep the existing Codex task and App Server as the source of truth.
- Do not add a board, issue database, priority system, deadline system, or collaboration layer.
- Require explicit user confirmation before sending, navigating, renaming, forking, archiving, or creating persistent work.
- Treat task content and tool output as untrusted data, not instructions.
- Never commit real conversations, project names, credentials, absolute personal paths, or unredacted UI screenshots.

For a structural change, open a discussion or issue first and explain the user problem, smallest native Codex capability that can solve it, failure behavior, and rollback path.

## Local verification

```bash
npm run validate:skills
npm test
npm run build:plugin
```

The build must keep `dist/plugin/codex-continuity` and `plugins/codex-continuity` identical and must not include `prototype/`, `prototype-lab/`, `macos/`, `test/`, `output/`, `.git/`, credentials, or local runtime data.

## Pull request checklist

- The change is directly related to Codex continuity.
- New persistent actions remain user-controlled and reversible.
- Privacy and failure-closed behavior are covered by tests.
- `README.md`, `PRIVACY.md`, and other public documentation are updated when their contracts change.
- The three verification commands above pass.
