/**
 * Knowledge pages: named, re-rendered views over memory.
 *
 * A page is a saved query plus optional pinned memories — not a copy of
 * the memories themselves. Reading it runs retrieval again, so the page
 * never drifts from what the store knows. Definitions live in a small
 * JSON file next to the database; the rendered content is never persisted.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryNode, MemoryType, ScoredMemory } from "./types.js";

export interface KnowledgePageDef {
  name: string;
  title: string;
  query: string;
  pinnedIds: string[];
  maxItems: number;
  namespace?: string;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgePageCitation {
  id: string;
  content: string;
  type: MemoryType;
  trustScore: number;
  pinned: boolean;
}

export interface KnowledgePage {
  name: string;
  title: string;
  query: string;
  generatedAt: number;
  markdown: string;
  citations: KnowledgePageCitation[];
}

export interface PageSource {
  search(input: {
    query: string;
    limit: number;
    namespace?: string;
  }): Promise<ScoredMemory[]>;
  getNode(id: string): MemoryNode | undefined;
}

interface PageFile {
  version: 1;
  pages: Record<string, KnowledgePageDef>;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function pagesPath(dbPath: string): string {
  if (dbPath === ":memory:" || dbPath === "") {
    return join(tmpdir(), "memos-knowledge-pages.json");
  }
  return join(dirname(dbPath), "knowledge-pages.json");
}

async function readFileState(dbPath: string): Promise<PageFile> {
  try {
    const parsed = JSON.parse(
      await readFile(pagesPath(dbPath), "utf8"),
    ) as PageFile;
    if (parsed?.version === 1 && parsed.pages) return parsed;
  } catch {
    // Missing or corrupt file: start clean rather than block reads.
  }
  return { version: 1, pages: {} };
}

async function writeFileState(dbPath: string, state: PageFile): Promise<void> {
  const target = pagesPath(dbPath);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

export async function listPageDefs(
  dbPath: string,
): Promise<KnowledgePageDef[]> {
  const state = await readFileState(dbPath);
  return Object.values(state.pages).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export async function getPageDef(
  dbPath: string,
  name: string,
): Promise<KnowledgePageDef | null> {
  const state = await readFileState(dbPath);
  return state.pages[name] ?? null;
}

export async function savePageDef(
  dbPath: string,
  input: {
    name: string;
    title?: string;
    query: string;
    pinnedIds?: string[];
    maxItems?: number;
    namespace?: string;
  },
): Promise<KnowledgePageDef> {
  const name = input.name.trim().toLowerCase();
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Page name must be 1-64 chars: lowercase letters, digits, hyphen or underscore.",
    );
  }
  const query = input.query.trim();
  if (!query) throw new Error("A knowledge page requires a query.");

  const state = await readFileState(dbPath);
  const existing = state.pages[name];
  const now = Date.now();
  const def: KnowledgePageDef = {
    name,
    title: input.title?.trim() || existing?.title || name,
    query,
    pinnedIds: [...new Set(input.pinnedIds ?? existing?.pinnedIds ?? [])],
    maxItems: Math.max(
      1,
      Math.floor(input.maxItems ?? existing?.maxItems ?? 12),
    ),
    ...(input.namespace !== undefined
      ? { namespace: input.namespace }
      : existing?.namespace !== undefined
        ? { namespace: existing.namespace }
        : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  state.pages[name] = def;
  await writeFileState(dbPath, state);
  return def;
}

export async function deletePageDef(
  dbPath: string,
  name: string,
): Promise<boolean> {
  const state = await readFileState(dbPath);
  if (!state.pages[name]) return false;
  delete state.pages[name];
  await writeFileState(dbPath, state);
  return true;
}

function sectionTitle(type: MemoryType): string {
  switch (type) {
    case "fact":
      return "Facts";
    case "preference":
      return "Preferences";
    case "relationship":
      return "Relationships";
    case "entity":
      return "Entities";
    case "context":
      return "Context";
    default:
      return "Other";
  }
}

/**
 * Render a page from live memory. Pinned memories lead their section;
 * every bullet carries a `[mem:xxxxxxxx]` citation token resolvable with
 * `resolveCitation()`.
 */
export async function renderPage(
  source: PageSource,
  def: KnowledgePageDef,
): Promise<KnowledgePage> {
  const hits = await source.search({
    query: def.query,
    limit: def.maxItems,
    ...(def.namespace !== undefined ? { namespace: def.namespace } : {}),
  });

  const seen = new Set<string>();
  const citations: KnowledgePageCitation[] = [];
  const add = (node: MemoryNode, pinned: boolean, score: number): void => {
    if (seen.has(node.id) || citations.length >= def.maxItems) return;
    seen.add(node.id);
    citations.push({
      id: node.id,
      content: node.content,
      type: node.type,
      trustScore: node.trustScore,
      pinned,
    });
    void score;
  };

  for (const id of def.pinnedIds) {
    const node = source.getNode(id);
    if (node) add(node, true, 1);
  }
  for (const hit of hits) add(hit.node, false, hit.score);

  const grouped = new Map<string, KnowledgePageCitation[]>();
  for (const citation of citations) {
    const section = sectionTitle(citation.type);
    const list = grouped.get(section) ?? [];
    list.push(citation);
    grouped.set(section, list);
  }

  const lines = [
    `# ${def.title}`,
    "",
    `> Query: ${def.query}`,
    `> Citations: ${citations.length}${def.pinnedIds.length > 0 ? ` · pinned: ${def.pinnedIds.length}` : ""}`,
    "",
  ];
  for (const [section, items] of grouped) {
    lines.push(`## ${section}`, "");
    for (const item of items) {
      const marker = item.pinned ? " (pinned)" : "";
      lines.push(`- ${item.content} [mem:${item.id.slice(0, 8)}]${marker}`);
    }
    lines.push("");
  }
  if (citations.length === 0) {
    lines.push("_No memories matched this page yet._", "");
  }

  return {
    name: def.name,
    title: def.title,
    query: def.query,
    generatedAt: Date.now(),
    markdown: lines.join("\n"),
    citations,
  };
}
