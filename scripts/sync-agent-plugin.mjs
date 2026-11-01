#!/usr/bin/env node
/**
 * Keep the root Agent Plugins 1.0.0 package in sync with the Claude plugin.
 *
 * Claude reads `plugin/`; Hermes and OpenClaw discover `plugin.json`,
 * `mcp.json`, and `skills/` at the repository root. One source, two layouts.
 *
 * Usage: node scripts/sync-agent-plugin.mjs [--check]
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const targets = [
  ["plugin/plugin.json", "plugin.json"],
  ["plugin/mcp.json", "mcp.json"],
];
const skills = ["memos-memory", "memos-maintenance"];

const mismatches = [];

for (const [source, target] of targets) {
  const expected = readFileSync(resolve(root, source), "utf8");
  let actual = "";
  try {
    actual = readFileSync(resolve(root, target), "utf8");
  } catch {
    actual = "";
  }
  if (check) {
    if (actual !== expected) mismatches.push(target);
  } else {
    writeFileSync(resolve(root, target), expected, "utf8");
  }
}

for (const skill of skills) {
  const source = resolve(root, "plugin", "skills", skill);
  const target = resolve(root, "skills", skill);
  if (check) {
    try {
      const expected = readFileSync(join(source, "SKILL.md"), "utf8");
      const actual = readFileSync(join(target, "SKILL.md"), "utf8");
      if (expected !== actual) mismatches.push(`skills/${skill}/SKILL.md`);
    } catch {
      mismatches.push(`skills/${skill}/SKILL.md`);
    }
  } else {
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }
}

if (check) {
  if (mismatches.length > 0) {
    console.error(
      `[sync-agent-plugin] stale: ${mismatches.join(", ")}. Run \`npm run plugin:sync\`.`,
    );
    process.exit(1);
  }
  console.log("[sync-agent-plugin] root Agent Plugin is in sync");
} else {
  console.log("[sync-agent-plugin] wrote root plugin.json, mcp.json, skills/");
}
