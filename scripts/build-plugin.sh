#!/bin/bash

set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
plugin_output="$project_root/dist/plugin/codex-continuity"
marketplace_output="$project_root/plugins/codex-continuity"
task_tmp="$(mktemp -d "${TMPDIR:-/tmp}/codex-continuity-plugin.XXXXXX")"
bundle_root="$task_tmp/codex-continuity"

node "$project_root/scripts/validate-skills.mjs"
node -e '
  const fs = require("node:fs");
  const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  if (packageJson.version !== manifest.version) {
    console.error(`Plugin and package versions must match: ${manifest.version} != ${packageJson.version}`);
    process.exit(1);
  }
' "$project_root/package.json" "$project_root/.codex-plugin/plugin.json"

cleanup() {
  /bin/rm -rf "$task_tmp"
}
trap cleanup EXIT

mkdir -p \
  "$bundle_root/.codex-plugin" \
  "$bundle_root/assets" \
  "$bundle_root/hooks" \
  "$bundle_root/scripts" \
  "$bundle_root/skills/continuity-context-match/agents" \
  "$bundle_root/skills/continuity-subagent-dispatch/agents" \
  "$bundle_root/skills/continuity-subagent-dispatch/scripts" \
  "$bundle_root/skills/continuity-work-router/agents" \
  "$bundle_root/skills/continuity-title/agents" \
  "$bundle_root/src"

copy_file() {
  /usr/bin/ditto "$project_root/$1" "$bundle_root/$1"
}

copy_file .codex-plugin/plugin.json
copy_file assets/continuity-flow-en.svg
copy_file assets/continuity-flow-zh-CN.svg
copy_file assets/icon.png
copy_file assets/logo.png
copy_file CONTRIBUTING.md
copy_file LICENSE
copy_file PRIVACY.md
copy_file README.md
copy_file README.zh-CN.md
copy_file SECURITY.md
copy_file hooks/hooks.json
copy_file scripts/run-prompt-hook.sh
copy_file scripts/run-stop-hook.sh
copy_file scripts/run-title-command.sh
copy_file scripts/run-plugin-node.ps1
copy_file skills/continuity-context-match/SKILL.md
copy_file skills/continuity-context-match/agents/openai.yaml
copy_file skills/continuity-subagent-dispatch/SKILL.md
copy_file skills/continuity-subagent-dispatch/agents/openai.yaml
copy_file skills/continuity-subagent-dispatch/scripts/select-profile.mjs
copy_file skills/continuity-work-router/SKILL.md
copy_file skills/continuity-work-router/agents/openai.yaml
copy_file skills/continuity-title/SKILL.md
copy_file skills/continuity-title/agents/openai.yaml

runtime_files=(
  app-server-client.mjs
  plugin-prompt-hook.mjs
  plugin-runtime.mjs
  plugin-stop-hook.mjs
  plugin-title-command.mjs
  plugin-title-decision.mjs
  progress-ledger.mjs
  semantic-title.schema.json
  title-ledger.mjs
  title-maintainer.mjs
)
for runtime_file in "${runtime_files[@]}"; do
  copy_file "src/$runtime_file"
done

chmod +x \
  "$bundle_root/scripts/run-prompt-hook.sh" \
  "$bundle_root/scripts/run-stop-hook.sh" \
  "$bundle_root/scripts/run-title-command.sh"
sync_output() {
  local output_path="$1"
  mkdir -p "$(dirname "$output_path")"
  if [ -e "$output_path" ]; then
    /bin/rm -rf "$output_path"
  fi
  /usr/bin/ditto "$bundle_root" "$output_path"
}

sync_output "$plugin_output"
sync_output "$marketplace_output"

echo "$plugin_output"
