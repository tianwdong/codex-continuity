import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapeClosingTag(value, tagName) {
  return value.replaceAll(`</${tagName}`, `<\\/${tagName}`);
}

function serializeForScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export async function buildEmbeddedDocument({ capability, data = null }) {
  const [html, css, script] = await Promise.all([
    readFile(path.join(projectRoot, "prototype/index.html"), "utf8"),
    readFile(path.join(projectRoot, "prototype/styles.css"), "utf8"),
    readFile(path.join(projectRoot, "prototype/app.js"), "utf8"),
  ]);
  const config = serializeForScript({ host: "codex", capability, data });
  return html
    .replace(
      '<link rel="stylesheet" href="./styles.css" />',
      `<style>${escapeClosingTag(css, "style")}</style>`,
    )
    .replace(
      '<script src="./app.js"></script>',
      `<script>globalThis.__CODEX_CONTINUITY_EMBED__=${config};\n${escapeClosingTag(script, "script")}</script>`,
    );
}
