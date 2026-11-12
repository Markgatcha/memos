/**
 * Drift radar tests:
 * - Hash matches the ingest convention (SHA-256, first 32 hex)
 * - Source extraction and local/remote classification
 * - unchanged / drifted / missing / unsupported outcomes
 * - `stamp: true` writes metadata.drift
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemOS } from "../src/memory.js";
import {
  expectedSourceHash,
  hashSourceBytes,
  isLocalSource,
  resolveSourcePath,
  sourceOf,
} from "../src/drift.js";
import type { MemoryNode } from "../src/types.js";

function nodeWith(metadata: Record<string, unknown>): MemoryNode {
  return {
    id: "n1",
    content: "x",
    metadata,
  } as unknown as MemoryNode;
}

describe("drift helpers", () => {
  test("hash is stable and 32 hex characters", () => {
    const hash = hashSourceBytes(Buffer.from("hello"));
    expect(hash).toHaveLength(32);
    expect(hash).toBe(hashSourceBytes(Buffer.from("hello")));
    expect(hash).not.toBe(hashSourceBytes(Buffer.from("hello!")));
  });

  test("sourceOf prefers sourcePath, then url, then source", () => {
    expect(sourceOf(nodeWith({ sourcePath: "docs/a.md" }))).toBe("docs/a.md");
    expect(sourceOf(nodeWith({ url: "https://example.com" }))).toBe(
      "https://example.com",
    );
    expect(sourceOf(nodeWith({ source: "manual" }))).toBe("manual");
    expect(sourceOf(nodeWith({}))).toBeNull();
  });

  test("local vs remote classification", () => {
    expect(isLocalSource("docs/a.md")).toBe(true);
    expect(isLocalSource("C:/docs/a.md")).toBe(true);
    expect(isLocalSource("file:///C:/docs/a.md")).toBe(true);
    expect(isLocalSource("https://example.com/a")).toBe(false);
  });

  test("resolveSourcePath joins relative paths and passes absolutes through", () => {
    expect(resolveSourcePath("docs/a.md", "/root")).toContain("a.md");
    expect(resolveSourcePath("C:/docs/a.md", "/root")).toBe("C:/docs/a.md");
  });

  test("expectedSourceHash reads only non-empty strings", () => {
    expect(expectedSourceHash(nodeWith({ sourceHash: "abc" }))).toBe("abc");
    expect(expectedSourceHash(nodeWith({ sourceHash: "" }))).toBeNull();
    expect(expectedSourceHash(nodeWith({}))).toBeNull();
  });
});

describe("detectDrift", () => {
  let dir: string;
  let file: string;
  let memos: MemOS;
  let id: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memos-drift-"));
    file = join(dir, "policy.md");
    writeFileSync(file, "Deployments require two approvals.\n", "utf8");
    const hash = hashSourceBytes(readFileSync(file));

    memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    const stored = await memos.store("Deployments require two approvals", {
      metadata: { sourcePath: file, sourceHash: hash },
    });
    id = stored.node.id;
  });

  afterEach(async () => {
    await memos.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports unchanged when the file hash matches", async () => {
    const report = await memos.detectDrift();
    expect(report.scanned).toBe(1);
    expect(report.sources).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.drifted).toBe(0);
    expect(report.findings[0]?.memoryIds).toEqual([id]);
  });

  test("reports drifted after the file changes", async () => {
    writeFileSync(file, "Deployments now require four approvals.\n", "utf8");
    const report = await memos.detectDrift();
    expect(report.drifted).toBe(1);
    expect(report.findings[0]?.status).toBe("drifted");
    expect(report.findings[0]?.expectedHash).not.toBe(
      report.findings[0]?.actualHash,
    );
  });

  test("reports missing after the file is deleted", async () => {
    unlinkSync(file);
    const report = await memos.detectDrift();
    expect(report.missing).toBe(1);
    expect(report.findings[0]?.error).toBe("ENOENT");
  });

  test("reports remote URLs as unsupported without fetching", async () => {
    await memos.store("Remote claim", {
      metadata: { url: "https://example.com/policy" },
    });
    const report = await memos.detectDrift();
    expect(report.unsupported).toBe(1);
  });

  test("stamp writes metadata.drift", async () => {
    writeFileSync(file, "Changed policy.\n", "utf8");
    await memos.detectDrift({ stamp: true });
    const node = await memos.retrieve(id);
    const drift = node?.metadata?.drift as { status?: string } | undefined;
    expect(drift?.status).toBe("drifted");
  });
});
