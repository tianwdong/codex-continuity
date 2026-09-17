import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { threadStateCoordinate } from "../src/plugin-runtime.mjs";
import { runTitleCommand, runTitleOperation } from "../src/plugin-title-command.mjs";
import { ProgressLedger, saveProgressLedger } from "../src/progress-ledger.mjs";
import { TitleLedger, saveTitleLedger } from "../src/title-ledger.mjs";

async function seedLedgers(coordinate) {
  const titleLedger = new TitleLedger();
  titleLedger.observe({ id: "thread-1", name: "Last known title" });
  await saveTitleLedger(coordinate.statePath, titleLedger);
  const progressLedger = new ProgressLedger();
  progressLedger.recordProgress({
    threadId: "thread-1", turnId: "turn-1", sourceMessageId: "message-1",
    nativeTitle: "Last known title", chapter: "Verified work", progress: "Last reliable result",
    confidence: "high",
  });
  await saveProgressLedger(coordinate.progressPath, progressLedger);
}

test("status reads the last reliable progress while Stop holds the write lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-command-lock-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    await seedLedgers(coordinate);
    const titleBefore = await readFile(coordinate.statePath, "utf8");
    const progressBefore = await readFile(coordinate.progressPath, "utf8");
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
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.progress.summary, "Last reliable result");
    assert.equal(result.progress.sourceTurnId, "turn-1");
    assert.equal(result.progress.sourceMessageId, "message-1");
    assert.equal(result.refresh.state, "busy");
    assert.equal(result.nativeTitle.state, "unavailable");
    assert.equal(result.nativeTitle.source, "local_snapshot");
    assert.equal(await readFile(coordinate.lockPath, "utf8"), "held-by-stop");
    assert.equal(await readFile(coordinate.statePath, "utf8"), titleBefore);
    assert.equal(await readFile(coordinate.progressPath, "utf8"), progressBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("undo, lock and resume still fail closed under the Stop lock without opening a runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-write-lock-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    await mkdir(path.dirname(coordinate.lockPath), { recursive: true });
    await writeFile(coordinate.lockPath, "held-by-stop");
    for (const command of ["undo", "lock", "resume"]) {
      const result = await runTitleOperation(command, "thread-1", {
        dataDirectory: directory,
        resolveExecutable: () => assert.fail("must not resolve a runtime while locked"),
      });
      assert.deepEqual(result, { ok: false, error: "already_running", threadId: "thread-1" });
      assert.equal(await readFile(coordinate.lockPath, "utf8"), "held-by-stop");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status is read only even when the live native title differs", async () => {
  const titleLedger = new TitleLedger();
  titleLedger.observe({ id: "thread-1", name: "Previous" });
  titleLedger.markClean();
  const before = JSON.stringify(titleLedger.toJSON());
  const result = await runTitleCommand("status", "thread-1", {
    titleLedger,
    appServer: {
      async readThread(threadId, options) {
        assert.equal(options.includeTurns, false);
        return { thread: { id: threadId, name: "Native renamed title" } };
      },
    },
  });
  assert.equal(result.title, "Native renamed title");
  assert.equal(result.nativeTitle.state, "available");
  assert.equal(titleLedger.dirty, false);
  assert.equal(JSON.stringify(titleLedger.toJSON()), before);
});

test("status falls back locally when runtime discovery, startup or native reads fail", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-offline-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    await seedLedgers(coordinate);
    for (const failure of ["runtime", "startup", "read"]) {
      let closed = false;
      const result = await runTitleOperation("status", "thread-1", {
        dataDirectory: directory,
        resolveExecutable: async () => {
          if (failure === "runtime") throw new Error("private runtime location");
          return "fake-codex";
        },
        createAppServer: () => ({
          async open() { if (failure === "startup") throw new Error("private startup data"); },
          async readThread() { throw new Error("private conversation data"); },
          close() { closed = true; },
        }),
      });
      assert.equal(result.ok, true);
      assert.equal(result.progress.summary, "Last reliable result");
      assert.equal(result.progress.sourceTurnId, "turn-1");
      assert.equal(result.progress.sourceMessageId, "message-1");
      assert.equal(result.title, "Last known title");
      assert.equal(result.nativeTitle.state, "unavailable");
      assert.equal(JSON.stringify(result).includes("private"), false);
      assert.equal(closed, failure !== "runtime");
    }
    await assert.rejects(readFile(coordinate.lockPath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status bounds a stalled App Server read and closes it before returning local progress", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-timeout-"));
  try {
    await seedLedgers(threadStateCoordinate(directory, "thread-1"));
    let closed = false;
    const result = await runTitleOperation("status", "thread-1", {
      dataDirectory: directory,
      resolveExecutable: async () => "fake-codex",
      nativeTitleTimeoutMs: 10,
      createAppServer: () => ({
        async open() {},
        readThread() { return new Promise(() => {}); },
        close() { closed = true; },
      }),
    });
    assert.equal(result.progress.summary, "Last reliable result");
    assert.equal(result.nativeTitle.state, "unavailable");
    assert.equal(closed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("status attributes retained reliable progress to its source rather than a later evaluated turn", async () => {
  const progressLedger = new ProgressLedger();
  progressLedger.recordProgress({
    threadId: "thread-1", turnId: "turn-1", sourceMessageId: "message-1",
    nativeTitle: "Last known title", chapter: "Verified work", progress: "Last reliable result",
    confidence: "high",
  });
  progressLedger.recordEvaluated({ threadId: "thread-1", turnId: "turn-2", nativeTitle: "Last known title" });
  const result = await runTitleCommand("status", "thread-1", { progressLedger });
  assert.equal(result.progress.sourceTurnId, "turn-1");
  assert.equal(result.progress.sourceMessageId, "message-1");
  assert.equal(result.progress.summary, "Last reliable result");
  assert.equal(progressLedger.toJSON().evaluatedTurnId, "turn-2");
});

test("status returns a valid native title while corrupt local progress remains unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-corrupt-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    await mkdir(path.dirname(coordinate.progressPath), { recursive: true });
    await writeFile(coordinate.progressPath, "private broken JSON");
    const result = await runTitleOperation("status", "thread-1", {
      dataDirectory: directory,
      resolveExecutable: async () => "fake-codex",
      createAppServer: () => ({
        async open() {},
        async readThread() { return { thread: { id: "thread-1", name: "Current title" } }; },
        close() {},
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.title, "Current title");
    assert.equal(result.progress, null);
    assert.equal(result.ledgers.progress, "corrupt");
    assert.equal(result.locked, null);
    assert.equal(JSON.stringify(result).includes("private"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("write operations still persist their title control change and release their own lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-title-write-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  try {
    await seedLedgers(coordinate);
    let closed = false;
    const result = await runTitleOperation("lock", "thread-1", {
      dataDirectory: directory,
      resolveExecutable: async () => "fake-codex",
      createAppServer: () => ({
        async open() {},
        async readThread() {
          assert.equal(typeof await readFile(coordinate.lockPath, "utf8"), "string");
          return { thread: { id: "thread-1", name: "Last known title" } };
        },
        close() { closed = true; },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.locked, true);
    assert.equal(JSON.parse(await readFile(coordinate.statePath, "utf8")).threads["thread-1"].locked, true);
    await assert.rejects(readFile(coordinate.lockPath), { code: "ENOENT" });
    assert.equal(closed, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
