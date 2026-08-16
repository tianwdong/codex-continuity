#!/bin/sh

set -eu

plugin_root="${PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"

find_node() {
  for candidate in \
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
    "${HOME}/Applications/Codex.app/Contents/Resources/cua_node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "${HOME}/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  command -v node 2>/dev/null || return 1
}

node_runtime="$(find_node || true)"
if [ -z "$node_runtime" ]; then
  printf '%s\n' '{"ok":false,"error":"runtime_unavailable"}'
  exit 1
fi

exec "$node_runtime" "$plugin_root/src/plugin-title-command.mjs" "$@"
