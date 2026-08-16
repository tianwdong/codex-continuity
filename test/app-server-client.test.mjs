import assert from "node:assert/strict";
import test from "node:test";

import { AppServerClient } from "../src/app-server-client.mjs";

const fakeServer = `
  import readline from "node:readline";
  const lines = readline.createInterface({ input: process.stdin });
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let threadName = "Real task";
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake" } });
    } else if (message.method === "thread/list") {
      send({ id: message.id, result: { data: [{ id: "thread-1", name: threadName }], nextCursor: null } });
    } else if (message.method === "thread/read") {
      send({ id: message.id, result: { thread: { id: message.params.threadId, name: threadName } } });
    } else if (message.method === "thread/name/set") {
      threadName = message.params.name;
      send({ id: message.id, result: {} });
    } else if (message.method === "account/read") {
      send({ id: message.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } });
    }
  });
`;

test("initializes the JSONL app-server connection and requests threads", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: ["--input-type=module", "-e", fakeServer],
  });
  try {
    await client.open();
    const threads = await client.listThreads({ limit: 10 });
    assert.deepEqual(threads, [{ id: "thread-1", name: "Real task" }]);
    const detail = await client.readThread("thread-1");
    assert.equal(detail.thread.id, "thread-1");
    await client.setThreadName("thread-1", "Updated task");
    assert.equal((await client.readThread("thread-1")).thread.name, "Updated task");
    assert.equal(client.resumeThread, undefined);
    const account = await client.readAccount();
    assert.equal(account.account.type, "chatgpt");
    assert.equal(await client.hasManagedAccount(), true);
  } finally {
    client.close();
  }
});
