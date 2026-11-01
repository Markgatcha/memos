#!/usr/bin/env node
/**
 * Generate llms.txt from the mkdocs navigation.
 *
 * Agents read llms.txt before crawling a docs site. Hand-maintaining it means
 * it drifts; this regenerates it from the same nav humans see, with each
 * page's first paragraph as the summary.
 *
 * Usage: node scripts/gen-llms-txt.mjs [--check]
 *   --check  exit 1 if llms.txt is stale (for CI)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");
const OUT = join(ROOT, "llms.txt");
const CHECK = process.argv.includes("--check");

function navEntries() {
  const yml = readFileSync(join(ROOT, "mkdocs.yml"), "utf8");
  const entries = [];
  for (const line of yml.split("\n")) {
    const match = /^\s*-\s+(.+?):\s+([\w./-]+\.md)\s*$/.exec(line);
    if (match) entries.push({ title: match[1].trim(), file: match[2].trim() });
  }
  return entries;
}

function firstHeading(file) {
  const path = join(DOCS, file);
  if (!existsSync(path)) return null;
  const line = readFileSync(path, "utf8")
    .split("\n")
    .find((entry) => entry.trim().startsWith("# "));
  return line ? line.trim().slice(2).trim() : null;
}

function clean(text) {
  return text
    .replace(/[\uFFFD]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function summarize(file) {
  const path = join(DOCS, file);
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  let seenHeading = false;
  const paragraph = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("# ")) {
      seenHeading = true;
      continue;
    }
    if (!seenHeading) continue;
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (
      line.startsWith("#") ||
      line.startsWith("!!!") ||
      line.startsWith("===") ||
      line.startsWith("---") ||
      line.startsWith("```") ||
      line.startsWith("|") ||
      line.startsWith("- ") ||
      line.startsWith("> ")
    ) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line);
  }
  const summary = paragraph.join(" ").replace(/\s+/g, " ").trim();
  if (summary.length <= 180) return clean(summary);
  return `${clean(summary.slice(0, 177)).trimEnd()}...`;
}

const entries = navEntries();
const listed = new Set(entries.map((entry) => entry.file));
for (const file of readdirSync(DOCS)) {
  if (!file.endsWith(".md") || listed.has(file)) continue;
  if (file.startsWith("KAGGLE") || file.startsWith("release-readiness")) continue;
  const title = firstHeading(file);
  if (title) entries.push({ title, file });
}
const lines = [
  "# MemOS",
  "",
  "> Local-first, persistent memory layer for AI agents. SQLite on your own",
  "> machine, no cloud and no API keys. TypeScript SDK, Python server, MCP",
  "> tools, document ingestion, and reproducible retrieval benchmarks.",
  ">",
  "> Packages: npm `@mem-os/sdk`, PyPI `mem-os-python`.",
  "",
  "Use this file to choose the right page. Every link is the canonical docs",
  "page; the repository has runnable examples under `examples/` and benchmark",
  "methodology under `benchmarks/README.md`.",
  "",
  "## Documentation",
  "",
];

for (const entry of entries) {
  const url = `https://memos.readthedocs.io/en/latest/${entry.file.replace(/\.md$/, "/")}`;
  const summary = summarize(entry.file);
  lines.push(summary ? `- [${entry.title}](${url}): ${summary}` : `- [${entry.title}](${url})`);
}

lines.push(
  "",
  "## Repository resources",
  "",
  "- [Benchmark methodology](https://github.com/Markgatcha/memos/blob/main/benchmarks/README.md): retrieval-only results and metric definitions",
  "- [Benchmark results, plain English](https://github.com/Markgatcha/memos/blob/main/docs/benchmark-results.md): the three numbers that matter and what they do not say",
  "- [Next improvements](https://github.com/Markgatcha/memos/blob/main/ROADMAP-NEXT.md): audited backlog with evidence",
  "- [Examples](https://github.com/Markgatcha/memos/tree/main/examples): runnable TypeScript usage",
  "",
  "## Optional",
  "",
  "- [Changelog](https://github.com/Markgatcha/memos/blob/main/CHANGELOG.md)",
  "- [Source](https://github.com/Markgatcha/memos)",
  "",
);

const output = lines.join("\n");
if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== output) {
    console.error("llms.txt is stale. Run: node scripts/gen-llms-txt.mjs");
    process.exit(1);
  }
  console.log(`llms.txt up to date (${entries.length} pages)`);
} else {
  writeFileSync(OUT, output, "utf8");
  console.log(`wrote llms.txt (${entries.length} pages, ${output.split("\n").length} lines)`);
}
