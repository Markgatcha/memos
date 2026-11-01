#!/usr/bin/env node
/**
 * Fail the release if the published npm artifact grows beyond a small budget.
 *
 * The 1.6.27 tarball accidentally shipped the benchmark datasets under
 * `scripts/dataset/` (BEAM, HotpotQA, LoCoMo), which made a 38.6 MB unpacked
 * package out of a ~3 MB SDK. This gate catches that regression before
 * `npm publish`, and also rejects test fixtures, local databases, and source
 * files that belong in the repo rather than in the package.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const LIMITS = {
  tarballBytes: 4 * 1024 * 1024,
  unpackedBytes: 8 * 1024 * 1024,
  files: 350,
};

if (!existsSync(resolve(root, "dist", "index.js"))) {
  console.error("[check-pack] dist/index.js is missing. Run `pnpm build` first.");
  process.exit(1);
}

// `execSync` goes through the platform shell so `npm` resolves on Windows
// too; spawning `npm.cmd` directly is rejected by newer Node versions.
const raw = execSync("npm pack --dry-run --json", {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 64 * 1024 * 1024,
});

const trimmed = raw.trim();
const first = trimmed[0];
const start = first === "[" ? trimmed.indexOf("[") : trimmed.indexOf("{");
const end = first === "[" ? trimmed.lastIndexOf("]") : trimmed.lastIndexOf("}");
if (start === -1 || end === -1 || end <= start) {
  console.error("[check-pack] could not parse `npm pack --dry-run --json` output.");
  console.error(raw.slice(0, 2000));
  process.exit(1);
}

let report;
try {
  const parsed = JSON.parse(trimmed.slice(start, end + 1));
  // npm 11 returns `{ "@scope/pkg": { ... } }`; older npm returns an array.
  report = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
} catch (error) {
  console.error(`[check-pack] invalid npm pack JSON: ${String(error)}`);
  console.error(raw.slice(0, 2000));
  process.exit(1);
}

const files = Array.isArray(report.files) ? report.files : [];
const problems = [];

const forbidden = files
  .map((file) => file.path)
  .filter((path) =>
    /(^|\/)(__tests__|scripts\/dataset|node_modules|\.tmp-|probe-)/.test(path) ||
    path.endsWith(".db") ||
    path.endsWith(".db-wal") ||
    path.endsWith(".db-shm"),
  );
if (forbidden.length > 0) {
  problems.push(
    `forbidden files in the package:\n  ${forbidden.slice(0, 20).join("\n  ")}` +
      (forbidden.length > 20 ? `\n  ...and ${forbidden.length - 20} more` : ""),
  );
}

if (report.size > LIMITS.tarballBytes) {
  problems.push(
    `tarball is ${formatBytes(report.size)} (limit ${formatBytes(LIMITS.tarballBytes)})`,
  );
}
if (report.unpackedSize > LIMITS.unpackedBytes) {
  problems.push(
    `unpacked size is ${formatBytes(report.unpackedSize)} (limit ${formatBytes(LIMITS.unpackedBytes)})`,
  );
}
if (files.length > LIMITS.files) {
  problems.push(`${files.length} files (limit ${LIMITS.files})`);
}

if (problems.length > 0) {
  console.error(`[check-pack] ${pkg.name}@${pkg.version} is too large or dirty:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nKeep the package allowlist in package.json to `dist`, README.md, LICENSE, and UPGRADING.md.",
  );
  process.exit(1);
}

console.log(
  `[check-pack] OK: ${pkg.name}@${pkg.version} ` +
    `${formatBytes(report.size)} tarball / ${formatBytes(report.unpackedSize)} unpacked / ` +
    `${files.length} files`,
);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
