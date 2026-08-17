import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APP_SERVER_CLIENT_VERSION } from "../src/app-server-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const distRoot = path.join(root, "dist", "plugin", "codex-continuity");
const marketplaceRoot = path.join(root, "plugins", "codex-continuity");

async function fileMap(directory, prefix = "") {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of await fileMap(path.join(directory, entry.name), relativePath)) {
        files.set(name, value);
      }
    } else if (entry.isFile()) {
      files.set(relativePath, await readFile(path.join(directory, entry.name)));
    }
  }
  return files;
}

test("release metadata uses one version and a white-listed repository marketplace source", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8"));
  const marketplace = JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");

  assert.equal(packageJson.version, manifest.version);
  assert.equal(APP_SERVER_CLIENT_VERSION, packageJson.version);
  assert.equal(packageJson.repository.url, "git+https://github.com/tianwdong/codex-continuity.git");
  assert.equal(manifest.repository, "https://github.com/tianwdong/codex-continuity");
  assert.equal(manifest.interface.websiteURL, "https://github.com/tianwdong/codex-continuity");
  assert.equal(manifest.interface.privacyPolicyURL, "https://github.com/tianwdong/codex-continuity/blob/main/PRIVACY.md");
  assert.equal(marketplace.name, "codex-continuity");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "codex-continuity",
      source: {
        source: "local",
        path: "./plugins/codex-continuity",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_INSTALL",
      },
      category: "Productivity",
    },
  ]);
  assert.match(gitignore, /^\/output\/$/m);
  assert.match(gitignore, /^\/codex-continuity$/m);
});

test("bilingual READMEs link to each other and document direct installation", async () => {
  const englishReadme = await readFile(path.join(root, "README.md"), "utf8");
  const chineseReadme = await readFile(path.join(root, "README.zh-CN.md"), "utf8");

  for (const readme of [englishReadme, chineseReadme]) {
    assert.match(readme, /codex plugin marketplace add tianwdong\/codex-continuity/);
    assert.match(readme, /codex plugin add codex-continuity@codex-continuity/);
    assert.match(readme, /plugins\/codex-continuity/);
    assert.match(readme, /Windows 11/);
    assert.match(readme, /LOCALAPPDATA/);
  }
  assert.match(englishReadme, /href="\.\/README\.zh-CN\.md">简体中文<\/a>/);
  assert.match(chineseReadme, /href="\.\/README\.md">English<\/a>/);
  assert.match(englishReadme, /When you state a new goal, Continuity quietly judges/);
  assert.match(englishReadme, /Plugins → Installed → Codex Continuity/);
  assert.match(englishReadme, /select the gear on the far right/);
  assert.match(englishReadme, /enabled toggles do not mean the Hook has been trusted/);
  assert.match(englishReadme, /Current-task and low-confidence decisions stay completely silent/);
  assert.match(englishReadme, /explicit standing authorization/);
  assert.match(englishReadme, /Persistent branches, separate tasks, returns, and archives always require confirmation/);
  assert.doesNotMatch(englishReadme, /The other two appear only when you ask/);
  assert.match(chineseReadme, /别再翻一排 Codex 任务/);
  assert.match(chineseReadme, /左侧「插件」→「已安装」→「Codex Continuity」/);
  assert.match(chineseReadme, /点击这一行最右侧的齿轮/);
  assert.match(chineseReadme, /开关已经打开，不代表 Hook 已被信任/);
  assert.match(chineseReadme, /拿不准时，Continuity 就留在当前任务，不打扰你/);
  assert.match(chineseReadme, /你已经授权自动委派时/);
  assert.match(chineseReadme, /开支线、新建任务、回传结果和归档旧任务前，Continuity 都会先征求你的确认/);
  assert.doesNotMatch(chineseReadme, /后两项只在你主动询问/);
  assert.doesNotMatch(chineseReadme, /静默选择最小承载方式|低置信判断|持久结构/);
});

test("repository marketplace bundle exactly matches the distributable allowlist", async () => {
  const distFiles = await fileMap(distRoot);
  const marketplaceFiles = await fileMap(marketplaceRoot);

  assert.deepEqual([...marketplaceFiles.keys()].sort(), [...distFiles.keys()].sort());
  for (const [name, contents] of marketplaceFiles) {
    assert.deepEqual(contents, distFiles.get(name), name);
  }
  assert.ok(marketplaceFiles.has("assets/continuity-flow-en.svg"));
  assert.ok(marketplaceFiles.has("assets/continuity-flow-zh-CN.svg"));

  const topLevelEntries = [...new Set([...marketplaceFiles.keys()].map((name) => name.split(path.sep)[0]))].sort();
  assert.deepEqual(topLevelEntries, [
    ".codex-plugin",
    "CONTRIBUTING.md",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "README.zh-CN.md",
    "SECURITY.md",
    "assets",
    "hooks",
    "scripts",
    "skills",
    "src",
  ]);
  for (const name of marketplaceFiles.keys()) {
    assert.doesNotMatch(name, /(^|\/)(?:\.git|macos|output|prototype|prototype-lab|test)(?:\/|$)/);
  }
});
