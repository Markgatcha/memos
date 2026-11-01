// Parse CHANGELOG.md into website/data/changelog.json.
//
// Only released sections are published (the Unreleased section is working
// notes and can be tens of kilobytes). Inline markdown is flattened so the
// page renders plain text without shipping a markdown parser.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(websiteDir, "..");
const source = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");

function stripInline(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRelease(block) {
  const lines = block.split(/\r?\n/);
  const heading = lines.shift() ?? "";
  const match = heading.match(/^\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/);
  if (!match) return null;
  const [, version, date] = match;
  if (version.toLowerCase() === "unreleased") return null;

  const sections = [];
  let current = null;
  let item = null;

  const flushItem = () => {
    if (item && current) {
      const text = stripInline(item.join(" "));
      if (text) current.items.push(text);
    }
    item = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const section = line.match(/^###\s+(.+)$/);
    if (section) {
      flushItem();
      current = { title: stripInline(section[1]), items: [] };
      sections.push(current);
      continue;
    }
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet) {
      flushItem();
      if (!current) {
        current = { title: "Changes", items: [] };
        sections.push(current);
      }
      item = [bullet[1]];
      continue;
    }
    if (item && /^\s{2,}\S/.test(line)) {
      item.push(line);
      continue;
    }
    if (!line.trim()) continue;
    flushItem();
    if (!current) {
      current = { title: "Changes", items: [] };
      sections.push(current);
    }
    item = [line];
  }
  flushItem();

  return {
    version,
    date: date ?? null,
    sections: sections.filter((section) => section.items.length > 0),
  };
}

const releases = source
  .split(/^## /m)
  .slice(1)
  .map(parseRelease)
  .filter(Boolean);

const out = {
  generatedAt: new Date().toISOString(),
  source: "CHANGELOG.md",
  releases,
};

const outDir = path.join(websiteDir, "data");
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "changelog.json"),
  JSON.stringify(out, null, 2) + "\n",
  "utf8",
);

console.log(
  `sync-changelog: wrote data/changelog.json (${releases.length} releases, ${releases.reduce(
    (n, release) => n + release.sections.reduce((m, s) => m + s.items.length, 0),
    0,
  )} entries)`,
);
