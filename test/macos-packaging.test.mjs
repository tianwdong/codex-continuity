import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("macOS App build keeps the shipped package minimal", async () => {
  const [packageText, buildScript, launcherSource, infoPlist] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("scripts/build-macos-app.sh", root), "utf8"),
    readFile(new URL("macos/Launcher/main.swift", root), "utf8"),
    readFile(new URL("macos/Info.plist", root), "utf8"),
  ]);

  const packageJson = JSON.parse(packageText);
  assert.equal(packageJson.scripts["legacy:sidecar"], "node src/sidecar.mjs");
  assert.equal(packageJson.scripts["legacy:build:macos"], "bash scripts/build-macos-app.sh");
  assert.match(buildScript, /sidecar\.mjs/);
  assert.match(buildScript, /title-ledger\.mjs/);
  assert.match(buildScript, /semantic-title\.schema\.json/);
  assert.doesNotMatch(buildScript, /cdp-pipe\.mjs|injection-source\.mjs|launcher\.mjs/);
  assert.doesNotMatch(buildScript, /ditto \"\$project_root\/prototype\"/);
  assert.doesNotMatch(buildScript, /node_modules/);
  assert.match(buildScript, /CODEX_CONTINUITY_SIGN_IDENTITY/);
  assert.match(buildScript, /codesign --force --deep --sign "\$sign_identity"/);
  assert.match(launcherSource, /Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(launcherSource, /sidecar\.mjs/);
  assert.match(launcherSource, /UNUserNotificationCenter/);
  assert.match(launcherSource, /getNotificationSettings/);
  assert.match(launcherSource, /系统通知未开启；新结果仍会保留在这里/);
  assert.match(launcherSource, /不可用，已降级为菜单栏/);
  assert.match(launcherSource, /NSWorkspace\.shared\.open\(url\)/);
  assert.match(launcherSource, /菜单栏结果状态已更新/);
  assert.match(launcherSource, /撤销标题/);
  assert.match(launcherSource, /undo_title/);
  assert.match(infoPlist, /app\.codexcontinuity\.launcher/);
  assert.match(infoPlist, /<key>LSUIElement<\/key>[\s\S]*?<true\/>/);

  execFileSync("/bin/bash", ["-n", fileURLToPath(new URL("scripts/build-macos-app.sh", root))]);
});
