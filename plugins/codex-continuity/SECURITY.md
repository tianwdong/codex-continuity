# Security Policy

## Supported version

Security fixes are applied to the latest released version of Codex Continuity. Reproduce a report against the latest version before submitting it when possible.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/tianwdong/codex-continuity/security/advisories/new). Do not publish a suspected vulnerability in a public issue.

Include the affected version, operating system, Codex or ChatGPT Desktop version, reproduction steps, expected impact, and the smallest safe evidence needed to verify the report. Do not attach real API keys, login data, full conversations, private source code, or unredacted screenshots.

## Scope

Security reports may cover:

- plugin Hook and Skill execution;
- local task, title, and progress data handling;
- marketplace packaging and installation boundaries;
- unintended disclosure of prompts, final replies, credentials, or local paths.

Issues in Codex, ChatGPT Desktop, ModelDial, or another third-party service should be reported to that project's maintainer unless Codex Continuity introduced the issue. The plugin's data boundary is documented in [PRIVACY.md](./PRIVACY.md).
