import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST = "build-integrity.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Content consistency only: this is not a signature or evidence of host loading.
export async function createBuildIntegrity(root) {
  const files = {};
  async function visit(relative = "") {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === MANIFEST) continue;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = hash(await readFile(path.join(root, name)));
      else throw new Error("Unsupported package entry");
    }
  }
  await visit();
  const { version } = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
  if (typeof version !== "string") throw new Error("Missing package version");
  return { schemaVersion: 1, version, files, digest: hash(JSON.stringify({ version, files })) };
}

export async function verifyBuildIntegrity(root) {
  let expected;
  try { expected = JSON.parse(await readFile(path.join(root, MANIFEST), "utf8")); }
  catch (error) { return { state: error.code === "ENOENT" ? "missing" : error instanceof SyntaxError ? "invalid" : "unavailable", digest: null }; }
  if (expected?.schemaVersion !== 1 || typeof expected.version !== "string"
    || !expected.files || typeof expected.files !== "object" || Array.isArray(expected.files)
    || !/^[a-f0-9]{64}$/.test(expected.digest)
    || Object.entries(expected.files).some(([name, digest]) => !name || name.split("/").some((part) => !part || part === "." || part === "..") || name.includes("\\") || !/^[a-f0-9]{64}$/.test(digest))
    || hash(JSON.stringify({ version: expected.version, files: expected.files })) !== expected.digest) {
    return { state: "invalid", digest: null };
  }
  try {
    const actual = await createBuildIntegrity(root);
    return { state: actual.digest === expected.digest ? "verified" : "mismatch", digest: actual.digest, expectedDigest: expected.digest };
  } catch (_) { return { state: "unavailable", digest: null }; }
}
