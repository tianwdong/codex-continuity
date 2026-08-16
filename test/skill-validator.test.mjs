import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateSkillContent, validateSkillDirectory } from "../scripts/validate-skills.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("validates every bundled skill without Python or PyYAML", async () => {
  for (const name of ["continuity-context-match", "continuity-subagent-dispatch", "continuity-title", "continuity-work-router"]) {
    const result = await validateSkillDirectory(path.join(root, "skills", name));
    assert.deepEqual(result, { valid: true, message: "Skill is valid" });
  }

  const output = execFileSync(process.execPath, [path.join(root, "scripts", "validate-skills.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: path.dirname(process.execPath) },
  });
  assert.match(output, /continuity-context-match: Skill is valid/);
  assert.match(output, /continuity-subagent-dispatch: Skill is valid/);
  assert.match(output, /continuity-title: Skill is valid/);
  assert.match(output, /continuity-work-router: Skill is valid/);
});

test("rejects the same core frontmatter errors as quick_validate", () => {
  assert.equal(validateSkillContent("# no frontmatter").valid, false);
  assert.match(validateSkillContent("---\nname: Bad_Name\ndescription: test\n---\n").message, /lowercase/);
  assert.match(validateSkillContent("---\nname: valid-name\n---\n").message, /Missing 'description'/);
  assert.match(validateSkillContent("---\nname: valid-name\ndescription: test\nunknown: value\n---\n").message, /Unexpected key/);
  assert.match(validateSkillContent("---\nname: valid-name\ndescription: <unsafe>\n---\n").message, /angle brackets/);
});

test("build script runs the project validator before packaging", async () => {
  const buildScript = await readFile(path.join(root, "scripts", "build-plugin.sh"), "utf8");
  assert.match(buildScript, /node "\$project_root\/scripts\/validate-skills\.mjs"/);
});
