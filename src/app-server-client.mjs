import { spawn } from "node:child_process";
import readline from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;
export const APP_SERVER_CLIENT_VERSION = "0.1.12";

export class AppServerClient {
  constructor({ command = "codex", args = ["app-server"], env = process.env } = {}) {
    this.child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    this.stderr = "";

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.receive(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2_000);
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => {
      this.fail(new Error(`Codex App Server exited (${signal ?? code ?? "unknown"})`));
    });
  }

  async open() {
    await this.request("initialize", {
      clientInfo: {
        name: "codex_continuity",
        title: "Codex Continuity",
        version: APP_SERVER_CLIENT_VERSION,
      },
    });
    this.notify("initialized", {});
    return this;
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "Codex App Server request failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error("Codex App Server connection is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params = {}) {
    this.write({ method, params });
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("Codex App Server connection is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex App Server method ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async listThreads({ limit = 100, sourceKinds = ["cli", "vscode"] } = {}) {
    const data = [];
    let cursor = null;
    do {
      const result = await this.request("thread/list", {
        cursor,
        limit: Math.min(100, limit - data.length),
        sortKey: "recency_at",
        sortDirection: "desc",
        sourceKinds,
      });
      data.push(...(result?.data ?? []));
      cursor = result?.nextCursor ?? null;
    } while (cursor && data.length < limit);
    return data.slice(0, limit);
  }

  readThread(threadId, { includeTurns = true } = {}) {
    return this.request("thread/read", { threadId, includeTurns });
  }

  setThreadName(threadId, name) {
    return this.request("thread/name/set", { threadId, name });
  }

  getGoal(threadId) {
    return this.request("thread/goal/get", { threadId });
  }

  readAccount() {
    return this.request("account/read", { refreshToken: false });
  }

  async hasManagedAccount() {
    try {
      return Boolean((await this.readAccount())?.account?.type);
    } catch (_) {
      return false;
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.lines.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server connection closed"));
    }
    this.pending.clear();
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
  }
}

export async function startAppServer(options) {
  const client = new AppServerClient(options);
  try {
    return await client.open();
  } catch (error) {
    client.close();
    throw error;
  }
}
