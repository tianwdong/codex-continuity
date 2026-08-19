#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireThreadLock,
  pluginDataDirectory,
  releaseThreadLock,
  threadStateCoordinate,
} from "./plugin-runtime.mjs";
import { loadTaskActionLedger, saveTaskActionLedger } from "./task-action-ledger.mjs";

function parseArguments(values) {
  const [operation = "", ...rest] = values;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("invalid_arguments");
    options[key.slice(2)] = value;
  }
  return { operation, options };
}

function responseFor(operation, ledger, options) {
  const currentThreadId = options.current;
  switch (operation) {
    case "propose":
      return {
        ok: ledger.propose({
          currentThreadId,
          targetThreadId: options.target,
          kind: options.kind,
          sourceTurnId: options["source-turn"],
        }),
        action: ledger.current(currentThreadId),
      };
    case "confirm": {
      const action = ledger.confirm({ currentThreadId, kind: options.kind });
      return { ok: Boolean(action), action };
    }
    case "start": {
      const action = ledger.start({
        currentThreadId,
        targetThreadId: options.target,
        kind: options.kind,
        sourceTurnId: options["source-turn"],
      });
      return { ok: Boolean(action), action };
    }
    case "cancel":
      return {
        ok: ledger.cancel({ currentThreadId, kind: options.kind }),
        action: ledger.current(currentThreadId),
      };
    case "begin-step": {
      const result = ledger.beginStep(currentThreadId, options.step);
      return {
        ok: result.state !== "unavailable",
        decision: result.state,
        action: result.action,
      };
    }
    case "complete-step":
      return {
        ok: ledger.completeStep({
          currentThreadId,
          step: options.step,
          targetThreadId: options.target,
        }),
        action: ledger.current(currentThreadId),
      };
    case "skip-step":
      return {
        ok: ledger.skipStep({ currentThreadId, step: options.step }),
        action: ledger.current(currentThreadId),
      };
    case "fail":
      return {
        ok: ledger.fail({ currentThreadId, failureCode: options.reason }),
        action: ledger.current(currentThreadId),
      };
    case "finish":
      return {
        ok: ledger.finish(currentThreadId),
        action: ledger.current(currentThreadId),
      };
    case "status":
      return { ok: true, action: ledger.current(currentThreadId) };
    default:
      throw new Error("invalid_operation");
  }
}

export async function runTaskActionCommand(values = process.argv.slice(2)) {
  const { operation, options } = parseArguments(values);
  if (!options.current) return { ok: false, error: "current_task_unavailable" };
  const coordinate = threadStateCoordinate(pluginDataDirectory(), options.current);
  const lock = await acquireThreadLock(coordinate.actionLockPath);
  if (!lock) return { ok: false, error: "action_busy" };
  try {
    const ledger = await loadTaskActionLedger(coordinate.actionStatePath);
    const response = responseFor(operation, ledger, options);
    if (ledger.dirty) await saveTaskActionLedger(coordinate.actionStatePath, ledger);
    return response;
  } finally {
    await releaseThreadLock(coordinate.actionLockPath, lock);
  }
}

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runTaskActionCommand()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message || "action_failed" })}\n`);
      process.exitCode = 1;
    });
}
