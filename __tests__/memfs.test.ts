/**
 * MemFS test suite:
 * - Deterministic relative paths and segment sanitization
 * - Markdown frontmatter round-trip (tags, content containing `---`)
 * - Export writes the tree + manifest and is idempotent
 * - Edited files update memories on sync
 * - New files create memories at their canonical path
 * - Memory-side changes rewrite files
 * - Conflicts: default "memory wins" with a backup, plus status counts
 * - Prune deletes memories whose files were removed
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemOS } from "../src/memory.js";
import {
  MEMFS_MANIFEST_FILENAME,
  hashMemFSContent,
  listMemFSFiles,
  memfsRelativePath,
  parseMemFSFile,
  readMemFSManifest,
  sanitizeMemFSSegment,
  serializeMemFSNode,
} from "../src/memfs.js";
import type { MemoryNode } from "../src/types.js";

function fakeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    content: "Production deployments require two approvals.",
    summary: "Deployment approvals",
    type: "fact",
    tags: ["deploy", "sre"],
    namespace: "default",
    pool: "note",
    createdAt: Date.UTC(2026, 2, 15),
    updatedAt: Date.UTC(2026, 2, 16),
    importance: 0.7,
    trustScore: 0.9,
    accessCount: 0,
    lastAccessed: Date.UTC(2026, 2, 16),
    provenance: "user",
    source: "manual",
    verified: true,
    expiresAt: null,
    validFrom: null,
    validTo: null,
    harness: null,
    ...overrides,
  } as unknown as MemoryNode;
}

describe("MemFS paths", () => {
  test("sanitizes segments for Windows and POSIX", () => {
    expect(sanitizeMemFSSegment("project:Alpha One")).toBe("project-alpha-one");
    expect(sanitizeMemFSSegment("  ...  ")).toBe("");
    expect(sanitizeMemFSSegment("Über Rasen")).toBe("uber-rasen");
  });

  test("relative path is namespace/year/month/slug-id.md", () => {
    const path = memfsRelativePath(fakeNode());
    expect(path).toBe(
      "default/2026/03/deployment-approvals-11111111-2222-3333-4444-555555555555.md",
    );
  });

  test("falls back to content when there is no summary", () => {
    const path = memfsRelativePath(
      fakeNode({ summary: "", content: "A short note about caching" }),
    );
    expect(path).toContain("a-short-note-about-caching");
  });
});

describe("MemFS serialization", () => {
  test("round-trips frontmatter, tags, and body", () => {
    const node = fakeNode({
      content: "Line one\n---\nLine three with --- inside.",
      tags: ["a", "two words", "quote,comma"],
    });
    const parsed = parseMemFSFile(serializeMemFSNode(node));
    expect(parsed.id).toBe(node.id);
    expect(parsed.namespace).toBe("default");
    expect(parsed.type).toBe("fact");
    expect(parsed.tags).toEqual(["a", "two words", "quote,comma"]);
    expect(parsed.content).toBe(node.content.trim());
  });

  test("hash is stable and content-sensitive", () => {
    expect(hashMemFSContent("abc")).toBe(hashMemFSContent("abc"));
    expect(hashMemFSContent("abc")).not.toBe(hashMemFSContent("abd"));
  });

  test("parses a file with no frontmatter as body-only", () => {
    const parsed = parseMemFSFile("Just a note\n");
    expect(parsed.id).toBeNull();
    expect(parsed.content).toBe("Just a note");
  });
});

describe("MemFS sync", () => {
  let dir: string;
  let memos: MemOS;
  let ids: string[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memos-memfs-"));
    memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    const a = await memos.store(
      "Production deployment runbook requires two SRE approvals",
      { tags: ["deploy", "sre"] },
    );
    const b = await memos.store(
      "Rollback procedure restores the previous release artifact",
      { tags: ["deploy"] },
    );
    ids = [a.node.id, b.node.id];
  });

  afterEach(async () => {
    await memos.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("export writes the tree and manifest, then skips unchanged", async () => {
    const first = await memos.memfsExport(dir);
    expect(first.written).toBe(2);
    expect(existsSync(join(dir, MEMFS_MANIFEST_FILENAME))).toBe(true);
    expect(listMemFSFiles(dir)).toHaveLength(2);

    const manifest = readMemFSManifest(dir);
    expect(Object.keys(manifest.files)).toHaveLength(2);

    const second = await memos.memfsExport(dir);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(2);
  });

  test("edited file updates the memory", async () => {
    await memos.memfsExport(dir);
    const manifest = readMemFSManifest(dir);
    const entry = manifest.files[ids[0]!];
    const file = join(dir, ...entry!.path.split("/"));
    const original = readFileSync(file, "utf8");
    writeFileSync(
      file,
      original.replace(
        "two SRE approvals",
        "three SRE approvals and a change ticket",
      ),
      "utf8",
    );

    const stats = await memos.memfsSync(dir);
    expect(stats.updated).toBe(1);
    expect(stats.skipped).toBe(1);

    const node = await memos.retrieve(ids[0]!);
    expect(node?.content).toContain("three SRE approvals");
  });

  test("new file creates a memory at its canonical path", async () => {
    await memos.memfsExport(dir);
    const newFile = join(dir, "inbox-note.md");
    writeFileSync(
      newFile,
      "---\nid:\ntype: preference\ntags: [ui, theme]\n---\n\nUser prefers dark mode in every editor\n",
      "utf8",
    );

    const stats = await memos.memfsSync(dir);
    expect(stats.created).toBe(1);
    expect(existsSync(newFile)).toBe(false);

    const files = listMemFSFiles(dir);
    const created = files.find((file) => file.includes("dark-mode"));
    expect(created).toBeDefined();
    const parsed = parseMemFSFile(
      readFileSync(join(dir, ...created!.split("/")), "utf8"),
    );
    expect(parsed.id).toBeTruthy();
    expect(parsed.tags).toEqual(["ui", "theme"]);
  });

  test("memory-side changes rewrite the file", async () => {
    await memos.memfsExport(dir);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await memos.update(ids[1]!, {
      content: "Rollback now uses blue-green swap",
    });

    const stats = await memos.memfsSync(dir);
    expect(stats.written).toBe(1);

    const manifest = readMemFSManifest(dir);
    const entry = manifest.files[ids[1]!];
    const text = readFileSync(join(dir, ...entry!.path.split("/")), "utf8");
    expect(text).toContain("blue-green swap");
  });

  test("conflict defaults to memory wins and backs up the file", async () => {
    await memos.memfsExport(dir);
    const manifest = readMemFSManifest(dir);
    const entry = manifest.files[ids[0]!];
    const file = join(dir, ...entry!.path.split("/"));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await memos.update(ids[0]!, {
      content: "Memory-side deployment policy v2",
    });
    writeFileSync(
      file,
      "---\nid: " + ids[0] + "\n---\n\nFile-side edit\n",
      "utf8",
    );

    const stats = await memos.memfsSync(dir);
    expect(stats.conflicts).toBe(1);
    expect(stats.conflictPaths).toHaveLength(1);

    const backups = readdirSync(
      join(dir, ...entry!.path.split("/").slice(0, -1)),
    ).filter((name) => name.includes(".conflict-"));
    expect(backups).toHaveLength(1);

    const node = await memos.retrieve(ids[0]!);
    expect(node?.content).toContain("Memory-side deployment policy v2");
  });

  test("status reports pending changes without writing", async () => {
    await memos.memfsExport(dir);
    const manifest = readMemFSManifest(dir);
    const entry = manifest.files[ids[0]!];
    const file = join(dir, ...entry!.path.split("/"));
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("runbook", "playbook"),
      "utf8",
    );

    const status = await memos.memfsStatus(dir);
    expect(status.pendingUpdates).toBe(1);
    expect(status.pendingWrites).toBe(0);
    expect(status.conflicts).toBe(0);
  });

  test("prune deletes memories whose files were removed", async () => {
    await memos.memfsExport(dir);
    const manifest = readMemFSManifest(dir);
    const entry = manifest.files[ids[1]!];
    rmSync(join(dir, ...entry!.path.split("/")));

    const stats = await memos.memfsSync(dir, { prune: true });
    expect(stats.deleted).toBe(1);
    expect(await memos.retrieve(ids[1]!)).toBeNull();
  });
});
