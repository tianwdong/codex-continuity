import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBuildIntegrity } from "../src/build-integrity.mjs";
import { APP_SERVER_CLIENT_VERSION } from "../src/app-server-client.mjs";
import { buildDoctorResult, readContinuitySnapshot } from "../src/plugin-diagnostics.mjs";
import { threadStateCoordinate } from "../src/plugin-runtime.mjs";
import { maintainContinuityForStop, runStopHookWorker } from "../src/plugin-stop-hook.mjs";
import { runTitleOperation } from "../src/plugin-title-command.mjs";
import { ProgressLedger, saveProgressLedger } from "../src/progress-ledger.mjs";

const NOW = Date.parse("2026-09-08T12:00:00Z");

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continuity-doctor-"));
  const coordinate = threadStateCoordinate(directory, "thread-1");
  const pluginRoot = path.join(directory, "plugin");
  await writeJson(path.join(pluginRoot, ".codex-plugin/plugin.json"), { version: "0.1.18" });
  const diagnose = async () => buildDoctorResult("thread-1", await readContinuitySnapshot("thread-1", {
    coordinate, pluginRoot, now: NOW,
  }));
  try {
    await run({ directory, coordinate, pluginRoot, diagnose });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pending(turnId = "turn-2", extra = {}) {
  return { schemaVersion: 1, threadId: "thread-1", turnId, receivedAt: "2026-09-08T11:59:00Z", ...extra };
}

function diagnostic(extra = {}) {
  return {
    schemaVersion: 1, threadId: "thread-1", turnId: "turn-2", status: "error", reason: "semantic_timeout",
    stage: "semantic", updatedAt: "2026-09-08T11:59:30Z", durationMs: 150000, ...extra,
  };
}

async function writeProgress(coordinate, evaluatedTurnId = "turn-1") {
  const ledger = new ProgressLedger();
  ledger.recordProgress({
    threadId: "thread-1", turnId: "turn-1", sourceMessageId: "message-1", nativeTitle: "private title",
    chapter: "private chapter", progress: "private conversation", confidence: "high",
  });
  if (evaluatedTurnId !== "turn-1") {
    ledger.recordEvaluated({ threadId: "thread-1", turnId: evaluatedTurnId, nativeTitle: "private title" });
  }
  await saveProgressLedger(coordinate.progressPath, ledger);
}

test("doctor needs only local files and reports executing manifest without claiming host load or trust", async () => {
  await fixture(async ({ directory, pluginRoot }) => {
    const before = await readdir(directory, { recursive: true });
    const result = await runTitleOperation("doctor", "thread-1", {
      dataDirectory: directory, pluginRoot,
      resolveExecutable: () => assert.fail("doctor must not discover Codex"),
      createAppServer: () => assert.fail("doctor must not start a service"),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.executingPlugin, { manifest: "available", version: "0.1.18", hostLoadedVersion: "unknown" });
    assert.equal(result.hookTrust, "unknown");
    assert.equal(result.lastWorkerVersion, null);
    assert.equal(result.latestStop, null);
    assert.equal(result.progressFreshness.state, "no_progress");
    assert.deepEqual(result.ledgers, { title: "missing", progress: "missing" });
    assert.deepEqual(await readdir(directory, { recursive: true }), before);
  });
});

test("doctor reports the recorded Stop worker version separately from its executing package and host load", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    for (const version of ["0.1.18", "0.1.19-dev.1", "1.2.3-beta.2+build.007"]) {
      await writeJson(coordinate.diagnosticPath, diagnostic({ workerVersion: version }));
      const result = await diagnose();
      assert.equal(result.lastWorkerVersion, version);
      assert.equal(result.diagnostic.workerVersion, version);
      assert.equal(result.executingPlugin.version, "0.1.18");
      assert.equal(result.executingPlugin.hostLoadedVersion, "unknown");
      assert.equal(result.hookTrust, "unknown");
    }
    await writeJson(coordinate.pendingStopPath, pending("turn-3"));
    const result = await diagnose();
    assert.equal(result.latestStop.turnId, "turn-3");
    assert.equal(result.diagnostic.turnId, "turn-2");
    assert.equal(result.diagnostic.updatedAt, "2026-09-08T11:59:30.000Z");
    assert.equal(result.lastWorkerVersion, "1.2.3-beta.2+build.007");
    assert.equal(result.executingPlugin.hostLoadedVersion, "unknown");
  });
});

test("old or invalid optional worker versions retain diagnostic evidence without falling back to manifest version", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    for (const version of [
      undefined, null, "", 19, {}, "private version", "/private/token", "v0.1.19", "1.2",
      "01.2.3", "1.2.3-", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+", `1.2.3+${"a".repeat(129)}`,
    ]) {
      await writeJson(coordinate.diagnosticPath, diagnostic({ workerVersion: version }));
      const result = await diagnose();
      assert.equal(result.metadata.diagnostic, "available");
      assert.equal(result.diagnostic.workerVersion, null);
      assert.equal(result.lastWorkerVersion, null);
      assert.equal(result.diagnostic.reason, "semantic_timeout");
      assert.equal(result.refresh.state, "failed");
      assert.equal(result.executingPlugin.version, "0.1.18");
      assert.equal(result.executingPlugin.hostLoadedVersion, "unknown");
      assert.equal(result.hookTrust, "unknown");
      assert.equal(JSON.stringify(result).includes("private"), false);
    }
  });
});

test("new Stop runtime and failure diagnostics record the actual worker code version", async () => {
  await fixture(async ({ directory, coordinate, diagnose }) => {
    let runningDiagnostic;
    const result = await runStopHookWorker({
      session_id: "thread-1", turn_id: "turn-2", cwd: "/tmp/continuity-doctor-fixture",
      hook_event_name: "Stop", last_assistant_message: "private completed answer",
    }, {
      dataDirectory: directory,
      resolveCommand: async () => {
        runningDiagnostic = JSON.parse(await readFile(coordinate.diagnosticPath, "utf8"));
        throw new Error("private runtime failure");
      },
      startServer: () => assert.fail("this test must not start a real runtime"),
      decideTitles: () => assert.fail("this test must not call a model"),
    });
    assert.equal(runningDiagnostic.status, "running");
    assert.equal(runningDiagnostic.workerVersion, APP_SERVER_CLIENT_VERSION);
    assert.equal(result.reason, "stop_runtime_failed");
    const stored = JSON.parse(await readFile(coordinate.diagnosticPath, "utf8"));
    assert.equal(stored.workerVersion, APP_SERVER_CLIENT_VERSION);
    assert.equal(stored.status, "error");
    const report = await diagnose();
    assert.equal(report.lastWorkerVersion, APP_SERVER_CLIENT_VERSION);
    assert.equal(report.executingPlugin.version, "0.1.18");
    assert.equal(report.executingPlugin.hostLoadedVersion, "unknown");
    assert.equal(report.hookTrust, "unknown");
    assert.equal(JSON.stringify(report).includes("private"), false);
  });
});

test("doctor CLI works when the configured Codex executable is unavailable", async () => {
  await fixture(async ({ directory }) => {
    const output = execFileSync(process.execPath, [
      path.join(process.cwd(), "src/plugin-title-command.mjs"), "doctor", "thread-1",
    ], {
      encoding: "utf8",
      env: { ...process.env, PATH: "", CODEX_CONTINUITY_CODEX: path.join(directory, "absent"), CODEX_CONTINUITY_DATA: directory },
    });
    const result = JSON.parse(output);
    assert.equal(result.ok, true);
    assert.equal(result.type, "continuity_diagnostics");
    assert.equal(result.hookTrust, "unknown");
    assert.equal(output.includes(directory), false);
  });
});

test("doctor separates the latest Stop receipt, old reliable progress and semantic failure", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeProgress(coordinate);
    await writeJson(coordinate.pendingStopPath, pending());
    await writeJson(coordinate.diagnosticPath, diagnostic());
    const result = await diagnose();
    assert.equal(result.latestStop.turnId, "turn-2");
    assert.equal(result.latestStop.receivedAt, "2026-09-08T11:59:00.000Z");
    assert.equal(result.progressFreshness.state, "awaiting_latest_stop");
    assert.equal(result.refresh.latestStopHandled, false);
    assert.equal(result.refresh.state, "failed");
    assert.equal(result.diagnostic.stage, "semantic");
    assert.equal(result.diagnostic.reason, "semantic_timeout");
    assert.match(result.nextStep, /connectivity/);
    assert.equal(JSON.stringify(result).includes("private"), false);
  });
});

test("doctor does not count retained but evaluated or explicitly handled Stops as pending", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeProgress(coordinate, "turn-2");
    await writeJson(coordinate.pendingStopPath, pending());
    let result = await diagnose();
    assert.equal(result.refresh.state, "received_stop_handled");
    assert.equal(result.refresh.latestStopEvaluated, true);
    assert.equal(result.progressFreshness.state, "previous_reliable");
    await writeJson(coordinate.pendingStopPath, pending("turn-3", { handledAt: "2026-09-08T11:59:30Z" }));
    result = await diagnose();
    assert.equal(result.refresh.state, "received_stop_handled");
    assert.equal(result.refresh.latestStopEvaluated, false);
    await writeJson(coordinate.pendingStopPath, pending("turn-4"));
    result = await diagnose();
    assert.equal(result.refresh.state, "pending");
  });
});

test("doctor honors completed ignored metadata without inventing reliable progress", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeJson(coordinate.pendingStopPath, pending("turn-2", { handledAt: "2026-09-08T11:59:30Z" }));
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: "ignored", reason: "already_evaluated", stage: "completed" }));
    const result = await diagnose();
    assert.equal(result.refresh.state, "received_stop_handled");
    assert.equal(result.progressFreshness.state, "no_progress");
  });
});

test("completed diagnostic stage does not hide semantic failure and queued result remains pending", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeJson(coordinate.pendingStopPath, pending());
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: "ignored", stage: "completed" }));
    let result = await diagnose();
    assert.equal(result.refresh.state, "failed");
    assert.match(result.nextStep, /connectivity/);
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: "ignored", reason: "queued_result_unavailable", stage: "thread_read" }));
    result = await diagnose();
    assert.equal(result.refresh.state, "pending");
    assert.equal(result.refresh.latestStopHandled, false);
    assert.match(result.nextStep, /completed turn/);
  });
});

test("a real Stop thread-read failure stays failed with its unhandled receipt and previous reliable progress", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeProgress(coordinate);
    const result = await maintainContinuityForStop({
      session_id: "thread-1", turn_id: "turn-2", cwd: "/tmp/continuity-doctor-fixture",
      hook_event_name: "Stop", last_assistant_message: "private completed answer",
    }, {
      appServer: { async readThread() { throw new Error("private read failure"); } },
      decideTitles: () => assert.fail("metadata failure must not call a model"),
    });
    assert.equal(result.status, "ignored");
    assert.equal(result.reason, "thread_metadata_unavailable");
    await writeJson(coordinate.pendingStopPath, pending());
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: result.status, reason: result.reason, stage: "completed" }));
    const report = await diagnose();
    assert.equal(report.refresh.state, "failed");
    assert.equal(report.refresh.latestStopEvaluated, false);
    assert.equal(report.refresh.latestStopHandled, false);
    assert.equal(report.progressFreshness.state, "awaiting_latest_stop");
    assert.equal(report.diagnostic.reason, "thread_metadata_unavailable");
    assert.match(report.nextStep, /current task opens normally/);
    assert.equal(JSON.stringify(report).includes("private"), false);
  });
});

test("failure reasons override ignored, renamed and completed statuses without consuming an unhandled Stop", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeProgress(coordinate, "turn-2");
    await writeJson(coordinate.pendingStopPath, pending());
    for (const reason of [
      "thread_metadata_unavailable", "assistant_message_unavailable", "account_unavailable",
      "semantic_timeout", "semantic_decision_unavailable", "semantic_mcp_discovery_failed",
      "stop_runtime_failed", "stop_thread_read_failed", "stop_semantic_failed", "stop_persist_failed",
      "stop_queue_timeout", "stop_queue_unavailable", "stop_worker_failed", "title_ledger_corrupt",
    ]) {
      for (const status of ["ignored", "renamed", "completed"]) {
        await writeJson(coordinate.diagnosticPath, diagnostic({ status, reason, stage: "completed" }));
        const report = await diagnose();
        assert.equal(report.refresh.state, "failed", `${status}/${reason}`);
        assert.equal(report.refresh.latestStopHandled, false, `${status}/${reason}`);
        assert.doesNotMatch(report.nextStep, /No local refresh action/);
        assert.equal(report.diagnostic.reason, reason);
      }
    }
    await writeJson(coordinate.pendingStopPath, pending("turn-2", { handledAt: "2026-09-08T11:59:30Z" }));
    const report = await diagnose();
    assert.equal(report.refresh.state, "failed");
    assert.equal(report.refresh.latestStopHandled, true);
  });
});

test("normal ignored and kept diagnostics need handled receipts or reliable evaluation when a receipt exists", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    for (const outcome of [
      { status: "ignored", reason: "subagent_thread" },
      { status: "ignored", reason: "already_evaluated" },
      { status: "kept", reason: null },
    ]) {
      await writeJson(coordinate.pendingStopPath, pending());
      await writeJson(coordinate.diagnosticPath, diagnostic({ ...outcome, stage: "completed" }));
      let report = await diagnose();
      assert.equal(report.refresh.state, "pending");
      assert.equal(report.refresh.latestStopHandled, false);
      await writeJson(coordinate.pendingStopPath, pending("turn-2", { handledAt: "2026-09-08T11:59:30Z" }));
      report = await diagnose();
      assert.equal(report.refresh.state, "received_stop_handled");
      assert.equal(report.refresh.latestStopHandled, true);
      assert.equal(report.progressFreshness.state, "no_progress");
    }
    await writeProgress(coordinate, "turn-2");
    await writeJson(coordinate.pendingStopPath, pending());
    const report = await diagnose();
    assert.equal(report.refresh.state, "received_stop_handled");
    assert.equal(report.refresh.latestStopEvaluated, true);
    assert.equal(report.progressFreshness.state, "previous_reliable");
  });
});

test("missing receipts allow normal completed evidence but never turn failed or unknown diagnostics into success", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: "ignored", reason: "subagent_thread", stage: "completed" }));
    let report = await diagnose();
    assert.equal(report.refresh.state, "received_stop_handled");
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: "ignored", reason: "thread_metadata_unavailable", stage: "completed" }));
    report = await diagnose();
    assert.equal(report.refresh.state, "failed");
    assert.equal(report.refresh.latestStopHandled, false);
    await writeJson(coordinate.diagnosticPath, diagnostic({ status: "ignored", reason: "unrecognized", stage: "completed" }));
    report = await diagnose();
    assert.equal(report.refresh.state, "unknown");
    assert.equal(report.refresh.latestStopHandled, false);
  });
});

test("doctor reads held or stale locks without deleting or taking them", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await mkdir(path.dirname(coordinate.lockPath), { recursive: true });
    await writeFile(coordinate.lockPath, "private lock identity");
    await utimes(coordinate.lockPath, new Date(NOW - 1000), new Date(NOW - 1000));
    let result = await diagnose();
    assert.equal(result.backgroundLock.state, "held");
    assert.equal(result.refresh.state, "busy");
    await utimes(coordinate.lockPath, new Date(NOW - 301000), new Date(NOW - 301000));
    result = await diagnose();
    assert.equal(result.backgroundLock.state, "stale");
    assert.equal(result.refresh.state, "unknown");
    assert.equal(await readFile(coordinate.lockPath, "utf8"), "private lock identity");
    assert.equal(JSON.stringify(result).includes("private"), false);
  });
});

test("doctor tolerates missing and corrupt manifest, ledgers and metadata without exposing raw content", async () => {
  await fixture(async ({ coordinate, pluginRoot, diagnose }) => {
    const manifestPath = path.join(pluginRoot, ".codex-plugin/plugin.json");
    await rm(manifestPath);
    let result = await diagnose();
    assert.equal(result.executingPlugin.manifest, "missing");
    assert.equal(result.executingPlugin.version, null);
    assert.match(result.nextStep, /manifest/);
    for (const filePath of [manifestPath, coordinate.statePath, coordinate.progressPath, coordinate.pendingStopPath, coordinate.diagnosticPath]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "private invalid JSON");
    }
    result = await diagnose();
    assert.equal(result.executingPlugin.manifest, "corrupt");
    assert.deepEqual(result.ledgers, { title: "corrupt", progress: "corrupt" });
    assert.deepEqual(result.metadata, { pendingStop: "corrupt", diagnostic: "corrupt" });
    assert.equal(result.refresh.state, "unknown");
    assert.equal(result.diagnostic, null);
    assert.equal(result.lastWorkerVersion, null);
    assert.equal(JSON.stringify(result).includes("private"), false);
    await writeJson(manifestPath, { version: "/private/token" });
    await writeJson(coordinate.diagnosticPath, diagnostic({ threadId: "another-thread" }));
    result = await diagnose();
    assert.equal(result.executingPlugin.manifest, "corrupt");
    assert.equal(result.metadata.diagnostic, "corrupt");
  });
});

test("doctor replaces unknown diagnostic codes with unknown and ignores unrecognized fields", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeJson(coordinate.diagnosticPath, diagnostic({
      status: "private status", reason: "/private/path/token", stage: "private stage",
      stderr: "private error", environment: { TOKEN: "private token" }, transcript: "private conversation",
    }));
    const result = await diagnose();
    assert.equal(result.diagnostic.status, "unknown");
    assert.equal(result.diagnostic.reason, "unknown");
    assert.equal(result.diagnostic.stage, "unknown");
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(result.hookTrust, "unknown");
  });
});

 test("handled Stop never certifies coverage of the latest native completed turn", async () => {
  await fixture(async ({ coordinate, diagnose }) => {
    await writeJson(coordinate.pendingStopPath, pending("turn-2", { handledAt: "2026-09-08T11:59:30Z" }));
    const report = await diagnose();
    assert.equal(report.refresh.state, "received_stop_handled");
    assert.deepEqual(report.coverage, { scope: "received_stops_only", latestNativeCompletedTurn: "unverified" });
    assert.match(report.nextStep, /Coverage.*unverified/);
  });
});

test("doctor distinguishes package tampering from a historical recorder digest", async () => {
  await fixture(async ({ pluginRoot, coordinate, diagnose }) => {
    const manifest = await createBuildIntegrity(pluginRoot);
    await writeJson(path.join(pluginRoot, "build-integrity.json"), manifest);
    await writeJson(coordinate.diagnosticPath, diagnostic({ packageDigest: manifest.digest }));
    let report = await diagnose();
    assert.equal(report.packageIntegrity.state, "verified");
    assert.equal(report.lastRecordedPackageDigest, manifest.digest);
    await writeFile(path.join(pluginRoot, "unexpected.mjs"), "changed");
    report = await diagnose();
    assert.equal(report.packageIntegrity.state, "mismatch");
    assert.equal(report.lastRecordedPackageDigest, manifest.digest);
    assert.match(report.nextStep, /do not match/);
    assert.equal(report.executingPlugin.hostLoadedVersion, "unknown");
  });
});
