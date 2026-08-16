import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { threadStateCoordinate } from "../src/plugin-runtime.mjs";

test("title commands fail closed while the Stop task lock is held", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-command-lock-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    await mkdir(path.dirname(coordinate.lockPath), { recursive: true });
    await writeFile(coordinate.lockPath, "held-by-stop", "utf8");
    const output = execFileSync(process.execPath, [
      path.join(process.cwd(), "src/plugin-title-command.mjs"),
      "status",
      "thread-1",
    ], {
      encoding: "utf8",
      env: { ...process.env, CODEX_CONTINUITY_DATA: directory },
    });
    assert.deepEqual(JSON.parse(output), {
      ok: false,
      error: "already_running",
      threadId: "thread-1",
    });
    assert.equal(await readFile(coordinate.lockPath, "utf8"), "held-by-stop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
