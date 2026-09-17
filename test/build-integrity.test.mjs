import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuildIntegrity, verifyBuildIntegrity } from "../src/build-integrity.mjs";

test("deterministic package digest detects same-version edits, additions and deletions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "continuity-integrity-"));
  try {
    assert.equal((await verifyBuildIntegrity(root)).state, "missing");
    await mkdir(path.join(root, ".codex-plugin"));
    await writeFile(path.join(root, ".codex-plugin/plugin.json"), '{"version":"1.0.0"}');
    await writeFile(path.join(root, "runtime.mjs"), "original");
    const manifest = await createBuildIntegrity(root);
    await writeFile(path.join(root, "build-integrity.json"), JSON.stringify(manifest));
    assert.deepEqual(await createBuildIntegrity(root), manifest);
    assert.equal((await verifyBuildIntegrity(root)).state, "verified");
    await writeFile(path.join(root, "runtime.mjs"), "changed");
    assert.equal((await verifyBuildIntegrity(root)).state, "mismatch");
    await writeFile(path.join(root, "runtime.mjs"), "original");
    await writeFile(path.join(root, "extra"), "added");
    assert.equal((await verifyBuildIntegrity(root)).state, "mismatch");
    await rm(path.join(root, "extra"));
    await rm(path.join(root, "runtime.mjs"));
    assert.equal((await verifyBuildIntegrity(root)).state, "mismatch");
    await writeFile(path.join(root, "build-integrity.json"), '{');
    assert.equal((await verifyBuildIntegrity(root)).state, "invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});
