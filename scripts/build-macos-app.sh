#!/bin/bash

set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
distribution_dir="${CODEX_CONTINUITY_DIST_DIR:-$project_root/dist}"
app_name="Codex Continuity"
app_path="$distribution_dir/$app_name.app"
sign_identity="${CODEX_CONTINUITY_SIGN_IDENTITY:--}"
task_tmp="$(mktemp -d "${TMPDIR:-/tmp}/codex-continuity-build.XXXXXX")"

cleanup() {
  rm -rf "$task_tmp"
}
trap cleanup EXIT

bundle_root="$task_tmp/$app_name.app"
contents="$bundle_root/Contents"
macos_dir="$contents/MacOS"
resources_dir="$contents/Resources"
embedded_app_dir="$resources_dir/app"
iconset_dir="$task_tmp/AppIcon.iconset"

mkdir -p "$macos_dir" "$embedded_app_dir/src" "$distribution_dir"

/usr/bin/swiftc \
  -framework AppKit \
  -o "$macos_dir/$app_name" \
  "$project_root/macos/Launcher/main.swift"

/usr/bin/swiftc \
  -framework AppKit \
  -o "$task_tmp/IconGenerator" \
  "$project_root/macos/IconGenerator.swift"
"$task_tmp/IconGenerator" "$iconset_dir"
/usr/bin/iconutil -c icns "$iconset_dir" -o "$resources_dir/AppIcon.icns"

runtime_files=(
  app-server-client.mjs
  attention-ledger.mjs
  continuity-data.mjs
  return-point.mjs
  semantic-organizer.mjs
  semantic-chapter.schema.json
  semantic-goal-match.schema.json
  semantic-return-point.schema.json
  semantic-title.schema.json
  sidecar.mjs
  title-ledger.mjs
)
for runtime_file in "${runtime_files[@]}"; do
  /usr/bin/ditto "$project_root/src/$runtime_file" "$embedded_app_dir/src/$runtime_file"
done
/usr/bin/ditto "$project_root/README.md" "$embedded_app_dir/README.md"
/usr/bin/ditto "$project_root/macos/Info.plist" "$contents/Info.plist"

/usr/bin/plutil -lint "$contents/Info.plist" >/dev/null

if [ -e "$app_path" ]; then
  rm -rf "$app_path"
fi
mv "$bundle_root" "$app_path"
/usr/bin/codesign --force --deep --sign "$sign_identity" "$app_path"

echo "$app_path"
