import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildEmbeddedDocument } from "../src/embedded-document.mjs";
import { buildInjectionSource, isCodexTarget } from "../src/injection-source.mjs";
import { startContinuityServer } from "../src/server.mjs";

test("serves only token-scoped prototype assets", async () => {
  const runtime = await startContinuityServer();
  try {
    const page = await fetch(runtime.baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(await page.text(), /Codex 接着做原型/);

    const script = await fetch(new URL("app.js", runtime.baseUrl));
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/);

    const outside = await fetch(`${runtime.origin}/prototype/`);
    assert.equal(outside.status, 404);
  } finally {
    await runtime.close();
  }
});

test("builds a scoped host adapter and filters renderer targets", () => {
  const source = buildInjectionSource({
    panelUrl: "http://127.0.0.1:4173/token/?host=codex",
    capability: "test-capability",
    open: true,
  });
  assert.match(source, /__codexContinuityHost__/);
  assert.match(source, /test-capability/);
  assert.match(source, /takeThreadRequest/);
  assert.match(source, /takeThreadActivationRequest/);
  assert.match(source, /completeThreadOpen/);
  assert.match(source, /markThreadActiveElsewhere/);
  assert.match(source, /takeDetailRequest/);
  assert.match(source, /takeRefreshRequest/);
  assert.match(source, /updateData/);
  assert.equal(isCodexTarget({ type: "page", url: "app://-/index.html", title: "Codex" }), true);
  assert.equal(isCodexTarget({ type: "iframe", url: "app://-/index.html", title: "Codex" }), false);
  assert.equal(isCodexTarget({ type: "page", url: "https://example.com", title: "Example" }), false);
});

test("builds a self-contained embedded document", async () => {
  const html = await buildEmbeddedDocument({
    capability: "embedded-test",
    data: { state: "ready", worklines: [{ title: "</script><script>unsafe()</script>" }] },
  });
  assert.match(html, /__CODEX_CONTINUITY_EMBED__/);
  assert.match(html, /embedded-test/);
  assert.match(html, /continuity-page/);
  assert.match(html, /continuity-query/);
  assert.match(html, /上次停在/);
  assert.match(html, /接下来/);
  assert.match(html, /不是这件事？换一个/);
  assert.match(html, /整理设置/);
  assert.doesNotMatch(html, /continuity-palette/);
  assert.doesNotMatch(html, /palette-settings/);
  assert.doesNotMatch(html, /查找原任务/);
  assert.match(html, /:root\[data-host="codex"\] \.workspace/);
  assert.doesNotMatch(html, /href="\.\/styles\.css"/);
  assert.doesNotMatch(html, /src="\.\/app\.js"/);
  assert.doesNotMatch(html, /<script>unsafe\(\)<\/script>/);
});

test("launcher leaves task ownership to the native renderer", async () => {
  const source = await readFile(new URL("../src/launcher.mjs", import.meta.url), "utf8");

  assert.match(source, /outcome\?\.state === "alreadyActive"/);
  assert.match(source, /markThreadActiveElsewhere/);
  assert.match(source, /codex:\/\/threads\/\$\{encodeURIComponent\(threadId\)\}/);
  assert.match(source, /takeThreadActivationRequest/);
  assert.match(source, /loadAttentionLedger/);
  assert.match(source, /ATTENTION_REFRESH_MS = 5_000/);
  assert.match(source, /markAttentionHandled/);
  assert.match(source, /matchGoalWithCodex/);
  assert.match(source, /takeGoalMatchRequest/);
  assert.match(source, /finishGoalMatch/);
  assert.doesNotMatch(source, /appServer\.resumeOrConfirmThread\(requestedThreadId\)/);
  assert.match(
    source,
    /outcome: \{ state: "nativeNavigation" \}[\s\S]*await markAttentionHandled\(session, requestedThreadId\);/,
  );
});
