/**
 * Tests for memory consolidation.
 *
 * Three entry points are covered:
 *   - `memos.dedupe()` — merge near-duplicate memories
 *   - `memos.archive()` — move stale low-importance memories aside
 *   - `memos.consolidate()` — run dedupe + archive + cluster summary
 *
 * All three accept a `dryRun` flag for safe previewing.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class VectorProvider implements EmbeddingProvider {
  public readonly id = "vector";
  public readonly model = "vector-v1";
  public readonly dimensions = 4;
  /** Per-text deterministic vector. */
  public readonly vectors = new Map<string, EmbeddingVector>();

  constructor(seed: Record<string, EmbeddingVector> = {}) {
    for (const [k, v] of Object.entries(seed)) this.vectors.set(k, v);
  }

  async embed(text: string): Promise<EmbeddingVector> {
    // MemOS passes `summary + "\n" + content` to the provider. Match
    // either the exact key or any substring, so tests can register
    // vectors with the user-facing content while the provider sees
    // the summary-prefixed form.
    if (this.vectors.has(text)) return this.vectors.get(text)!;
    for (const [key, vec] of this.vectors) {
      if (text.includes(key)) return vec;
    }
    return [0, 0, 0, 0];
  }
}

function makeMemos(provider: EmbeddingProvider) {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { synchronous: true },
  });
}

describe("MemOS.dedupe()", () => {
  test("merges near-duplicate memories into the highest-importance one", async () => {
    const provider = new VectorProvider({
      "dark mode preference": [1, 0, 0, 0],
      "I like dark mode": [0.99, 0.01, 0, 0], // cosine ~0.99995
      "completely unrelated": [0, 0, 1, 0],
    });
    const memos = makeMemos(provider);
    await memos.init();
    const a = await memos.store("dark mode preference", { importance: 0.4 });
    const b = await memos.store("I like dark mode", { importance: 0.8 });
    const c = await memos.store("completely unrelated", { importance: 0.5 });

    const result = await memos.dedupe({ threshold: 0.9 });
    expect(result.merges.length).toBeGreaterThanOrEqual(1);
    // The kept node should be the one with the higher importance (b).
    const merge = result.merges.find((m) => m.kept === b.node.id);
    expect(merge).toBeDefined();
    expect(merge!.removed).toContain(a.node.id);

    // Total nodes should be 2 now.
    const after = await memos.search({});
    expect(after.length).toBe(2);
    void c;
    await memos.close();
  });

  test("dry-run does not delete or modify anything", async () => {
    const provider = new VectorProvider({
      "alpha": [1, 0, 0, 0],
      "alpha duplicate": [0.99, 0, 0, 0],
    });
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("alpha");
    await memos.store("alpha duplicate");

    const result = await memos.dedupe({ threshold: 0.9, dryRun: true });
    expect(result.merges.length).toBe(1);
    expect(result.dryRun).toBe(true);
    // Nothing actually removed.
    const all = await memos.search({});
    expect(all.length).toBe(2);
    await memos.close();
  });

  test("returns no merges when the threshold is too strict", async () => {
    const provider = new VectorProvider({
      "dark mode": [1, 0, 0, 0],
      "light mode": [0, 1, 0, 0],
    });
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("dark mode");
    await memos.store("light mode");
    const result = await memos.dedupe({ threshold: 0.99 });
    expect(result.merges).toEqual([]);
    await memos.close();
  });

  test("preserves the union of tags on the merged node", async () => {
    const provider = new VectorProvider({
      "alpha": [1, 0, 0, 0],
      "alpha dup": [0.99, 0, 0, 0],
    });
    const memos = makeMemos(provider);
    await memos.init();
    const a = await memos.store("alpha", { tags: ["pref", "ui"] });
    const b = await memos.store("alpha dup", { tags: ["ui", "favorite"] });
    await memos.dedupe({ threshold: 0.9 });
    // The kept node should be b (importance 0.5 > 0.5? both default to 0.5).
    // Either way, the tags should be the union.
    const after = await memos.search({});
    const kept = after.find((r) => r.node.id === a.node.id || r.node.id === b.node.id);
    expect(kept).toBeDefined();
    expect(new Set(kept!.node.tags)).toEqual(new Set(["pref", "ui", "favorite"]));
    await memos.close();
  });
});

describe("MemOS.archive()", () => {
  test("moves stale low-importance memories to the `archived` namespace", async () => {
    const provider = new VectorProvider({});
    const memos = makeMemos(provider);
    await memos.init();
    const stale = await memos.store("old fact", { importance: 0.1 });
    const fresh = await memos.store("new fact", { importance: 0.9 });

    // Force the stale one to look old by rewinding lastAccessed via a
    // direct metadata shim — the test doesn't need to wait 90 days.
    // We use the metadata path so the storage layer is unaware.
    // (Best-effort: skip if we can't time-warp.)
    // Instead, test the default 90-day cutoff by passing afterDays:0
    // and setting up nodes with old lastAccessed timestamps.
    await memos.retrieve(stale.node.id);
    // Manipulate via updateNode: set importance low so it qualifies.
    await memos.update(stale.node.id, { importance: 0.1 });
    void fresh;

    const result = await memos.archive({ afterDays: 0, importanceBelow: 0.5 });
    expect(result.moves.length).toBeGreaterThanOrEqual(1);
    const archived = await memos.listNamespaces();
    expect(archived).toContain("archived");

    await memos.close();
  });

  test("does not touch memories with high importance", async () => {
    const provider = new VectorProvider({});
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("important fact", { importance: 0.9 });
    const result = await memos.archive({ afterDays: 0, importanceBelow: 0.5 });
    expect(result.moves).toEqual([]);
    await memos.close();
  });
});

describe("MemOS.consolidate()", () => {
  test("runs dedupe and archive in one pass and reports combined stats", async () => {
    const provider = new VectorProvider({
      "alpha": [1, 0, 0, 0],
      "alpha dup": [0.99, 0, 0, 0],
    });
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("alpha", { importance: 0.4 });
    await memos.store("alpha dup", { importance: 0.4 });
    await memos.store("low value old fact", { importance: 0.1 });

    const result = await memos.consolidate({
      dedupeThreshold: 0.9,
      archiveAfterDays: 0,
      archiveImportanceBelow: 0.5,
    });
    expect(result.dryRun).toBe(false);
    expect(result.merges.length).toBe(1);
    expect(result.moves.length).toBeGreaterThanOrEqual(1);
    expect(result.durationMs).toBeGreaterThan(0);
    await memos.close();
  });
});
