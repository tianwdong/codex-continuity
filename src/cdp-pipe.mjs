const MESSAGE_SEPARATOR = 0;
const COMMAND_TIMEOUT_MS = 30_000;

class CdpSession {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.closed = false;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    return this.browser.send(method, params, this.sessionId);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.browser.detach(this.sessionId);
  }
}

export class CdpPipeClient {
  constructor(child) {
    this.child = child;
    this.input = child.stdio[3];
    this.output = child.stdio[4];
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.closed = false;

    if (!this.input || !this.output) {
      throw new Error("Codex was not launched with private CDP pipes");
    }
    this.output.on("data", (chunk) => this.receive(chunk));
    this.output.once("error", (error) => this.fail(error));
    this.output.once("end", () => this.fail(new Error("CDP output ended")));
    this.input.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      this.fail(new Error(`Codex exited (${signal ?? code ?? "unknown"})`));
    });
  }

  async open() {
    await this.send("Browser.getVersion");
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let boundary = this.buffer.indexOf(MESSAGE_SEPARATOR);
    while (boundary !== -1) {
      const raw = this.buffer.subarray(0, boundary).toString("utf8");
      this.buffer = this.buffer.subarray(boundary + 1);
      if (raw) this.handleMessage(JSON.parse(raw));
      boundary = this.buffer.indexOf(MESSAGE_SEPARATOR);
    }
  }

  handleMessage(message) {
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP pipe is closed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP command ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      const message = sessionId
        ? { id, method, params, sessionId }
        : { id, method, params };
      this.input.write(`${JSON.stringify(message)}\0`, (error) => {
        if (error) this.fail(error);
      });
    });
  }

  async targets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos;
  }

  async connect(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = new CdpSession(this, sessionId);
    this.sessions.set(sessionId, session);
    return session;
  }

  detach(sessionId) {
    this.sessions.delete(sessionId);
    if (!this.closed) {
      this.send("Target.detachFromTarget", { sessionId }).catch(() => {});
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
    for (const session of this.sessions.values()) session.closed = true;
    this.sessions.clear();
  }

  close() {
    if (this.closed) return;
    this.input.destroy();
    this.output.destroy();
    this.fail(new Error("CDP pipe closed"));
  }
}
