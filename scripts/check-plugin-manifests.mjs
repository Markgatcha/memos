#!/usr/bin/env node
/**
 * Validate the plugin manifests before release.
 *
 * This exists because `plugin/hooks/hooks.json` shipped with two
 * `UserPromptSubmit` keys: JSON.parse keeps the last one, so the per-prompt
 * recall hook was silently shadowed by auto-capture. JSON.parse cannot detect
 * duplicate keys, so this script scans the raw text as well as parsing it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const manifests = [
  "plugin/plugin.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/mcp.json",
  "plugin/.mcp.json",
  "plugin/hooks/hooks.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/plugin.json",
  ".cursor-plugin/mcp.json",
  "gemini-extension.json",
];

for (const relative of manifests) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) {
    errors.push(`${relative}: missing`);
    continue;
  }
  const text = readFileSync(absolute, "utf8");
  const duplicateKeys = findDuplicateTopLevelKeys(text);
  if (duplicateKeys.length > 0) {
    errors.push(`${relative}: duplicate top-level key(s): ${duplicateKeys.join(", ")}`);
  }
  try {
    JSON.parse(text);
  } catch (error) {
    errors.push(`${relative}: invalid JSON: ${String(error)}`);
  }
}

const plugin = readJson("plugin/plugin.json");
const claudePlugin = readJson("plugin/.claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const mcp = readJson("plugin/mcp.json");
const claudeMcp = readJson("plugin/.mcp.json");
const cursorPlugin = readJson(".cursor-plugin/plugin.json");
const cursorMcp = readJson(".cursor-plugin/mcp.json");
const geminiExtension = readJson("gemini-extension.json");

for (const [label, value] of [
  ["plugin/plugin.json", plugin?.version],
  ["plugin/.claude-plugin/plugin.json", claudePlugin?.version],
  [
    ".claude-plugin/marketplace.json",
    marketplace?.plugins?.find((entry) => entry?.name === "memos")?.version,
  ],
  [".cursor-plugin/plugin.json", cursorPlugin?.version],
  ["gemini-extension.json", geminiExtension?.version],
]) {
  if (value !== pkg.version) {
    errors.push(`${label}: version ${String(value)} != package.json ${pkg.version}`);
  }
}

for (const [label, manifest] of [
  ["plugin/mcp.json", mcp],
  ["plugin/.mcp.json", claudeMcp],
  [".cursor-plugin/mcp.json", cursorMcp],
  ["gemini-extension.json", geminiExtension],
]) {
  const args = manifest?.mcpServers?.memos?.args;
  if (!Array.isArray(args)) {
    errors.push(`${label}: mcpServers.memos.args is missing`);
    continue;
  }
  const pinned = args.some((arg) => arg === `@mem-os/sdk@${pkg.version}`);
  if (!pinned) {
    errors.push(`${label}: args must pin @mem-os/sdk@${pkg.version}`);
  }
}

const hooks = readJson("plugin/hooks/hooks.json");
if (hooks && typeof hooks === "object") {
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      errors.push(`plugin/hooks/hooks.json: ${event} must be an array`);
      continue;
    }
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.hooks)) {
        errors.push(`plugin/hooks/hooks.json: ${event} entry is missing a hooks array`);
        continue;
      }
      for (const hook of entry.hooks) {
        if (hook?.type !== "command" || typeof hook.command !== "string") {
          errors.push(`plugin/hooks/hooks.json: ${event} has a non-command hook`);
          continue;
        }
        const match = hook.command.match(
          /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([A-Za-z0-9._-]+)/,
        );
        if (!match) {
          errors.push(
            `plugin/hooks/hooks.json: ${event} command does not use \${CLAUDE_PLUGIN_ROOT}/hooks/: ${hook.command}`,
          );
          continue;
        }
        const script = resolve(root, "plugin", "hooks", match[1]);
        if (!existsSync(script)) {
          errors.push(`plugin/hooks/hooks.json: missing hook script ${match[1]}`);
        }
      }
    }
  }
}

for (const skill of ["memos-memory", "memos-maintenance"]) {
  const path = resolve(root, "plugin", "skills", skill, "SKILL.md");
  if (!existsSync(path)) errors.push(`plugin/skills/${skill}/SKILL.md: missing`);
}

if (errors.length > 0) {
  console.error("[check-plugin-manifests] FAILED:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `[check-plugin-manifests] OK: ${manifests.length} manifests, ` +
    `${readdirSync(resolve(root, "plugin", "hooks")).filter((name) => name.endsWith(".mjs")).length} hooks, ` +
    `version ${pkg.version}`,
);

function readJson(relative) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Return top-level object keys that appear more than once in the raw text.
 * JSON.parse silently keeps the last duplicate; this scan looks at the
 * token stream so the mistake cannot hide.
 */
function findDuplicateTopLevelKeys(text) {
  const counts = new Map();
  let depth = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const current = text[index];
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        index += 1;
        break;
      }
      index += 1;
    }
    const raw = text.slice(start, index);
    if (depth !== 1) continue;

    let lookahead = index;
    while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
    if (text[lookahead] !== ":") continue;

    let key;
    try {
      key = JSON.parse(raw);
    } catch {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
}
