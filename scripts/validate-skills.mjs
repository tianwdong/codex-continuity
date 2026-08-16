#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_SKILL_NAME_LENGTH = 64;
const ALLOWED_PROPERTIES = new Set(["name", "description", "license", "allowed-tools", "metadata"]);

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length === 1) {
      throw new Error("unterminated single-quoted value");
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function parseFrontmatter(content) {
  const normalized = content.replaceAll("\r\n", "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error("No valid YAML frontmatter found");

  const frontmatter = {};
  let nestedKey = null;
  for (const [index, line] of match[1].split("\n").entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) {
      if (nestedKey !== "metadata" || !/^\s+[A-Za-z0-9_-]+\s*:/.test(line)) {
        throw new Error(`Unsupported nested YAML at frontmatter line ${index + 2}`);
      }
      continue;
    }

    const property = line.match(/^([A-Za-z0-9-]+):(?:\s*(.*))?$/);
    if (!property) throw new Error(`Invalid YAML at frontmatter line ${index + 2}`);
    const [, key, rawValue = ""] = property;
    if (Object.hasOwn(frontmatter, key)) throw new Error(`Duplicate frontmatter key: ${key}`);

    nestedKey = rawValue === "" ? key : null;
    frontmatter[key] = rawValue === "" && key === "metadata" ? {} : parseScalar(rawValue);
  }
  return frontmatter;
}

export function validateSkillContent(content) {
  let frontmatter;
  try {
    frontmatter = parseFrontmatter(content);
  } catch (error) {
    return { valid: false, message: error.message };
  }

  const unexpected = Object.keys(frontmatter).filter((key) => !ALLOWED_PROPERTIES.has(key)).sort();
  if (unexpected.length > 0) {
    return {
      valid: false,
      message: `Unexpected key(s): ${unexpected.join(", ")}. Allowed: ${[...ALLOWED_PROPERTIES].sort().join(", ")}`,
    };
  }
  if (!("name" in frontmatter)) return { valid: false, message: "Missing 'name' in frontmatter" };
  if (!("description" in frontmatter)) return { valid: false, message: "Missing 'description' in frontmatter" };

  const name = frontmatter.name;
  if (typeof name !== "string") return { valid: false, message: `Name must be a string, got ${typeof name}` };
  if (name !== name.trim()) return { valid: false, message: "Name cannot have surrounding whitespace" };
  if (!/^[a-z0-9-]+$/.test(name)) {
    return { valid: false, message: `Name '${name}' must use lowercase letters, digits, and hyphens only` };
  }
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    return { valid: false, message: `Name '${name}' cannot start/end with a hyphen or contain consecutive hyphens` };
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return { valid: false, message: `Name is too long (${name.length}); maximum is ${MAX_SKILL_NAME_LENGTH}` };
  }

  const description = frontmatter.description;
  if (typeof description !== "string") {
    return { valid: false, message: `Description must be a string, got ${typeof description}` };
  }
  if (description.includes("<") || description.includes(">")) {
    return { valid: false, message: "Description cannot contain angle brackets (< or >)" };
  }
  if (description.length > 1024) {
    return { valid: false, message: `Description is too long (${description.length}); maximum is 1024` };
  }

  return { valid: true, message: "Skill is valid" };
}

export async function validateSkillDirectory(skillDirectory) {
  const skillFile = path.join(skillDirectory, "SKILL.md");
  try {
    return validateSkillContent(await readFile(skillFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { valid: false, message: "SKILL.md not found" };
    throw error;
  }
}

async function defaultSkillDirectories() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
  const entries = await readdir(root);
  const directories = [];
  for (const entry of entries.sort()) {
    const candidate = path.join(root, entry);
    if ((await stat(candidate)).isDirectory()) directories.push(candidate);
  }
  return directories;
}

async function main() {
  const directories = process.argv.slice(2).map((entry) => path.resolve(entry));
  const targets = directories.length > 0 ? directories : await defaultSkillDirectories();
  let failed = false;
  for (const target of targets) {
    const result = await validateSkillDirectory(target);
    const label = path.relative(process.cwd(), target) || ".";
    console.log(`${result.valid ? "✓" : "✗"} ${label}: ${result.message}`);
    failed ||= !result.valid;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
