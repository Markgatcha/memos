#!/usr/bin/env node
/**
 * Keep every published surface on one version and one Python package name.
 *
 * Historically the npm package, PyPI package, README release status, plugin
 * manifests, and pinned `npx` args drifted independently. This script is the
 * single gate for those surfaces.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const pkg = readJson("package.json");
const version = pkg?.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error("[check-versions] package.json has no valid version");
  process.exit(1);
}

const pyproject = readText("pyproject.toml");
const pyprojectName = match(pyproject, /^name\s*=\s*"([^"]+)"/m);
const pyprojectVersion = match(pyproject, /^version\s*=\s*"([^"]+)"/m);

expect("pyproject.toml name", pyprojectName, "mem-os-python");
expect("pyproject.toml version", pyprojectVersion, version);

for (const [label, relative] of [
  ["plugin/plugin.json", "plugin/plugin.json"],
  ["plugin/.claude-plugin/plugin.json", "plugin/.claude-plugin/plugin.json"],
]) {
  expect(`${label} version`, readJson(relative)?.version, version);
}

const marketplaceVersion = readJson(".claude-plugin/marketplace.json")?.plugins?.find(
  (entry) => entry?.name === "memos",
)?.version;
expect("marketplace version", marketplaceVersion, version);

for (const [label, relative] of [
  ["plugin/mcp.json", "plugin/mcp.json"],
  ["plugin/.mcp.json", "plugin/.mcp.json"],
]) {
  const args = readJson(relative)?.mcpServers?.memos?.args;
  const pinned = Array.isArray(args) && args.includes(`@mem-os/sdk@${version}`);
  if (!pinned) errors.push(`${label}: args must pin @mem-os/sdk@${version}`);
}

const readme = readText("README.md");
expect(
  "README release status",
  match(readme, /canonical, always-current build \(v(\d+\.\d+\.\d+)\)/),
  version,
);
if (!readme.includes("pip install mem-os-python")) {
  errors.push("README.md: missing `pip install mem-os-python`");
}
if (/pip install mem-os-sdk\b/.test(readme)) {
  errors.push("README.md: stale `pip install mem-os-sdk` (PyPI name is mem-os-python)");
}

const installation = readText("docs/installation.md");
if (!installation.includes("mem-os-python")) {
  errors.push("docs/installation.md: missing the PyPI name mem-os-python");
}
if (installation.includes("mem-os-sdk")) {
  errors.push("docs/installation.md: stale mem-os-sdk reference");
}

const llms = readText("llms.txt");
if (!llms.includes("mem-os-python")) {
  errors.push("llms.txt: missing the PyPI name mem-os-python");
}
if (llms.includes("mem-os-sdk")) {
  errors.push("llms.txt: stale mem-os-sdk reference");
}

const publishWorkflow = readText(".github/workflows/publish-pypi.yml");
if (!publishWorkflow.includes("mem-os-python")) {
  errors.push(".github/workflows/publish-pypi.yml: missing mem-os-python");
}
if (publishWorkflow.includes("mem-os-sdk")) {
  errors.push(".github/workflows/publish-pypi.yml: stale mem-os-sdk reference");
}

if (errors.length > 0) {
  console.error(`[check-versions] FAILED for ${version}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[check-versions] OK: ${pkg.name}@${version}, PyPI mem-os-python@${version}`);

function expect(label, actual, wanted) {
  if (actual !== wanted) {
    errors.push(`${label}: ${String(actual)} != ${wanted}`);
  }
}

function match(text, regex) {
  return regex.exec(text)?.[1];
}

function readText(relative) {
  const absolute = resolve(root, relative);
  if (!existsSync(absolute)) {
    errors.push(`${relative}: missing`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function readJson(relative) {
  const text = readText(relative);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    errors.push(`${relative}: invalid JSON: ${String(error)}`);
    return null;
  }
}
