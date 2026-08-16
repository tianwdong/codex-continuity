#!/bin/bash

set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"

if [ "$#" -gt 1 ]; then
  echo "用法：npm run install:plugin:dev [-- --wait]" >&2
  exit 64
fi

wait_mode="false"
case "${1:-}" in
  "") ;;
  --wait) wait_mode="true" ;;
  *)
    echo "用法：npm run install:plugin:dev [-- --wait]" >&2
    exit 64
    ;;
esac

main_app_running() {
  /bin/ps -ax -o command= | /usr/bin/awk \
    -v user_codex="$HOME/Applications/Codex.app/Contents/MacOS/Codex" \
    -v user_chatgpt="$HOME/Applications/ChatGPT.app/Contents/MacOS/ChatGPT" '
    function is_main_app(path, command_line) {
      return command_line == path || index(command_line, path " ") == 1
    }
    is_main_app("/Applications/Codex.app/Contents/MacOS/Codex", $0) ||
    is_main_app(user_codex, $0) ||
    is_main_app("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", $0) ||
    is_main_app(user_chatgpt, $0) {
      found = 1
    }
    END {
      exit(found ? 0 : 1)
    }
  '
}

ensure_main_app_stopped() {
  if ! main_app_running; then
    return
  fi

  if [ "$wait_mode" != "true" ]; then
    echo "Codex／ChatGPT 主 App 仍在运行；已取消插件安装。" >&2
    echo "请运行 npm run install:plugin:dev -- --wait，再退出 App；检测到退出后会自动继续安装。" >&2
    exit 2
  fi

  echo "等待 Codex／ChatGPT 主 App 退出；退出后将自动继续安装。按 Ctrl-C 可取消。"
  while main_app_running; do
    /bin/sleep 1
  done
  echo "已检测到主 App 退出，继续安装。"
}

ensure_main_app_stopped

codex_command=""
for candidate in \
  "/opt/homebrew/bin/codex" \
  "/usr/local/bin/codex" \
  "/Applications/Codex.app/Contents/Resources/codex" \
  "/Applications/ChatGPT.app/Contents/Resources/codex" \
  "$HOME/Applications/Codex.app/Contents/Resources/codex" \
  "$HOME/Applications/ChatGPT.app/Contents/Resources/codex"
do
  if [ -x "$candidate" ]; then
    codex_command="$candidate"
    break
  fi
done
if [ -z "$codex_command" ]; then
  echo "找不到 Codex CLI，已取消插件安装。" >&2
  exit 1
fi

cd "$project_root"
npm run build:plugin
ensure_main_app_stopped
"$codex_command" plugin add codex-continuity@personal

node_command="$(command -v node || true)"
if [ -z "$node_command" ]; then
  echo "找不到 Node.js，无法核验插件安装。" >&2
  exit 1
fi

manifest_field() {
  "$node_command" -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = manifest[process.argv[2]];
    if (typeof value !== "string" || value.length === 0) process.exit(1);
    process.stdout.write(value);
  ' "$1" "$2"
}

tree_files() {
  (
    cd "$1"
    /usr/bin/find . -type f -print | /usr/bin/sed 's#^\./##' | /usr/bin/sort
  )
}

verify_installed_plugin() {
  local plugin_root="$project_root/dist/plugin/codex-continuity"
  local source_manifest="$plugin_root/.codex-plugin/plugin.json"
  local plugin_name
  local plugin_version
  local plugin_list_json
  local listed_version
  local listed_enabled
  local cache_root
  local cache_manifest
  local source_files
  local cache_files
  local relative_path
  local source_hash
  local cache_hash

  plugin_name="$(manifest_field "$source_manifest" name)"
  plugin_version="$(manifest_field "$source_manifest" version)"
  plugin_list_json="$("$codex_command" plugin list --marketplace personal --json)"
  listed_version="$(printf '%s' "$plugin_list_json" | "$node_command" -e '
    let value = "";
    try {
      const payload = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const item = (payload.installed || []).find((entry) => entry.pluginId === "codex-continuity@personal");
      if (item) value = String(item.version || "");
    } catch {}
    if (!value) process.exit(1);
    process.stdout.write(value);
  ')"
  listed_enabled="$(printf '%s' "$plugin_list_json" | "$node_command" -e '
    let value = "";
    try {
      const payload = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const item = (payload.installed || []).find((entry) => entry.pluginId === "codex-continuity@personal");
      if (item) value = String(item.enabled);
    } catch {}
    if (!value) process.exit(1);
    process.stdout.write(value);
  ')"
  if [ "$listed_version" != "$plugin_version" ]; then
    echo "安装后版本不一致：源码 $plugin_version，codex plugin list $listed_version。" >&2
    exit 1
  fi
  if [ "$listed_enabled" != "true" ]; then
    echo "codex-continuity 安装后未处于 enabled 状态。" >&2
    exit 1
  fi

  cache_root="$codex_home/plugins/cache/personal/$plugin_name/$plugin_version"
  cache_manifest="$cache_root/.codex-plugin/plugin.json"
  if [ ! -f "$cache_manifest" ]; then
    echo "找不到安装缓存 manifest：$cache_manifest" >&2
    exit 1
  fi
  if [ "$(manifest_field "$cache_manifest" name)" != "$plugin_name" ] || \
     [ "$(manifest_field "$cache_manifest" version)" != "$plugin_version" ]; then
    echo "安装缓存 manifest 与构建产物不一致：$cache_manifest" >&2
    exit 1
  fi

  source_files="$(tree_files "$plugin_root")"
  cache_files="$(tree_files "$cache_root")"
  if [ "$source_files" != "$cache_files" ]; then
    echo "安装缓存文件清单与构建产物不一致。" >&2
    /usr/bin/diff -u <(printf '%s\n' "$source_files") <(printf '%s\n' "$cache_files") >&2 || true
    exit 1
  fi
  while IFS= read -r relative_path; do
    [ -n "$relative_path" ] || continue
    source_hash="$(/usr/bin/shasum -a 256 "$plugin_root/$relative_path" | /usr/bin/awk '{print $1}')"
    cache_hash="$(/usr/bin/shasum -a 256 "$cache_root/$relative_path" | /usr/bin/awk '{print $1}')"
    if [ "$source_hash" != "$cache_hash" ]; then
      echo "安装缓存哈希不一致：$relative_path" >&2
      exit 1
    fi
  done <<EOF
$source_files
EOF

  echo "已核验 $plugin_name@$plugin_version：codex plugin list、cache manifest 和构建产物文件 SHA-256 一致。"
}

verify_installed_plugin
