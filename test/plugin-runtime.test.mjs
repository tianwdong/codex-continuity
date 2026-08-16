import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireThreadLock,
  codexExecutableCandidates,
  pluginDataDirectory,
  releaseThreadLock,
  resolveCodexExecutable,
  semanticEnvironment,
} from "../src/plugin-runtime.mjs";

test("uses the Windows user data directory without a macOS path", () => {
  assert.equal(pluginDataDirectory({
    environment: { LocalAppData: String.raw`C:\Users\Alice\AppData\Local` },
    platform: "win32",
    homeDirectory: String.raw`C:\Users\Alice`,
  }), String.raw`C:\Users\Alice\AppData\Local\Codex Continuity Plugin`);
  assert.equal(pluginDataDirectory({
    environment: { CODEX_CONTINUITY_DATA: String.raw`D:\Continuity` },
    platform: "win32",
    homeDirectory: String.raw`C:\Users\Alice`,
  }), String.raw`D:\Continuity`);
});

test("finds the Windows Codex executable beside the bundled Node runtime", async () => {
  const bundledCodex = String.raw`C:\Program Files\WindowsApps\OpenAI.ChatGPT\resources\codex.exe`;
  const options = {
    environment: { Path: String.raw`C:\Tools;D:\Apps` },
    platform: "win32",
    homeDirectory: String.raw`C:\Users\Alice`,
    nodeExecutable: String.raw`C:\Program Files\WindowsApps\OpenAI.ChatGPT\resources\cua_node\bin\node.exe`,
  };
  const candidates = codexExecutableCandidates(options);
  assert.equal(candidates[0], bundledCodex);
  assert.ok(candidates.includes(String.raw`C:\Tools\codex.exe`));
  assert.equal(await resolveCodexExecutable({
    ...options,
    accessImpl: async (candidate) => {
      if (candidate !== bundledCodex) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  }), bundledCodex);
});

test("keeps the Desktop Codex ahead of a standalone macOS Node sibling", () => {
  const candidates = codexExecutableCandidates({
    environment: {},
    platform: "darwin",
    homeDirectory: "/Users/alice",
    nodeExecutable: "/opt/homebrew/bin/node",
  });
  assert.equal(candidates[0], "/Applications/Codex.app/Contents/Resources/codex");
  assert.ok(candidates.indexOf("/opt/homebrew/bin/codex") > 0);
});

test("keeps Windows account and temp variables for semantic Codex calls", () => {
  assert.deepEqual(semanticEnvironment({
    Path: String.raw`C:\Tools`,
    USERPROFILE: String.raw`C:\Users\Alice`,
    LOCALAPPDATA: String.raw`C:\Users\Alice\AppData\Local`,
    APPDATA: String.raw`C:\Users\Alice\AppData\Roaming`,
    TEMP: String.raw`C:\Users\Alice\AppData\Local\Temp`,
    SYSTEMROOT: String.raw`C:\Windows`,
    SECRET: "do-not-forward",
  }, "win32"), {
    USERPROFILE: String.raw`C:\Users\Alice`,
    PATH: String.raw`C:\Tools`,
    TEMP: String.raw`C:\Users\Alice\AppData\Local\Temp`,
    LOCALAPPDATA: String.raw`C:\Users\Alice\AppData\Local`,
    APPDATA: String.raw`C:\Users\Alice\AppData\Roaming`,
    SYSTEMROOT: String.raw`C:\Windows`,
  });
});

test("a stale lock holder cannot release a newer owner lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-lock-"));
  const lockPath = path.join(directory, "thread.lock");
  let first;
  let second;
  try {
    first = await acquireThreadLock(lockPath);
    assert.ok(first?.identity);
    await first.handle.close();
    await unlink(lockPath);

    second = await acquireThreadLock(lockPath);
    assert.ok(second?.identity);
    await releaseThreadLock(lockPath, first);
    assert.equal((await readFile(lockPath, "utf8")).trim(), second.identity);
  } finally {
    if (second) await releaseThreadLock(lockPath, second);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fresh task lock makes concurrent callers fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-lock-contention-"));
  const lockPath = path.join(directory, "thread.lock");
  let owner;
  try {
    owner = await acquireThreadLock(lockPath);
    assert.ok(owner);
    assert.equal(await acquireThreadLock(lockPath), null);
  } finally {
    if (owner) await releaseThreadLock(lockPath, owner);
    await rm(directory, { recursive: true, force: true });
  }
});
