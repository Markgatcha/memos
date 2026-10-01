/**
 * Round 4: query-embedding LRU cache + embed-once threading.
 *
 * The semantic leg embeds the query on every search, and
 * multiStreamSearch fans out to three pool streams — previously three
 * identical inferences per search. These tests prove the query vector
 * is computed once per unique (provider, model, query) and shared, and
 * that sharing is recall-neutral (the provider is deterministic, so a
 * cached vector is byte-identical to a fresh inference).
 */

import { MemOS } from "../src/memory";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";
import { SQLiteStorage } from "../src/storage/sqlite";

class CountingProvider implements EmbeddingProvider {
  public readonly id = "counting";
  public readonly model = "counting-v1";
  public readonly dimensions = 4;
  public readonly calls: string[] = [];

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls.push(text);
    // Deterministic: same text → same vector. Cache correctness relies
    // on the provider being a pure function of its input.
    let h = 0;
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
    return [h % 100, (h >> 3) % 100, (h >> 6) % 100, 1];
  }
}

function makeMemos(provider: EmbeddingProvider) {
  const storage = new SQLiteStorage(":memory:", true);
  return new MemOS({
    storage,
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
  });
}

function queryEmbedCalls(provider: CountingProvider, query: string): number {
  return provider.calls.filter((c) => c === query).length;
}

describe("query embedding cache", () => {
  test("repeated identical semanticSearch embeds the query once", async () => {
    const provider = new CountingProvider();
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("user prefers dark mode");
    await memos.flushEmbeddings();

    const first = await memos.semanticSearch("dark mode");
    const second = await memos.semanticSearch("dark mode");

    // One inference total — the second call was served from the cache.
    expect(queryEmbedCalls(provider, "dark mode")).toBe(1);
    // Recall-neutral: byte-identical result ordering.
    expect(second.map((r) => r.node.id)).toEqual(
      first.map((r) => r.node.id),
    );
    await memos.close();
  });

  test("different queries embed independently", async () => {
    const provider = new CountingProvider();
    const memos = makeMemos(provider);
    await memos.init();

    await memos.semanticSearch("dark mode");
    await memos.semanticSearch("light theme");
    await memos.semanticSearch("dark mode");

    expect(queryEmbedCalls(provider, "dark mode")).toBe(1);
    expect(queryEmbedCalls(provider, "light theme")).toBe(1);
    await memos.close();
  });

  test("precomputed queryVector skips inference entirely", async () => {
    const provider = new CountingProvider();
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("user prefers dark mode");
    await memos.flushEmbeddings();

    const before = provider.calls.length;
    const results = await memos.semanticSearch("dark mode", 10, 0.1, {}, {
      queryVector: [1, 0, 0, 0],
    });

    expect(provider.calls.length).toBe(before);
    expect(Array.isArray(results)).toBe(true);
    await memos.close();
  });

  test("cache is bounded (LRU eviction)", async () => {
    const provider = new CountingProvider();
    const memos = makeMemos(provider);
    await memos.init();

    for (let i = 0; i < 300; i++) {
      await memos.semanticSearch(`unique query number ${i}`);
    }

    const cache = (memos as unknown as { queryEmbeddingCache: Map<string, number[]> })
      .queryEmbeddingCache;
    expect(cache.size).toBeLessThanOrEqual(256);
    await memos.close();
  });
});

describe("embed-once threading (multiStreamSearch)", () => {
  test("three pool streams share a single query inference", async () => {
    const provider = new CountingProvider();
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("user prefers dark mode");
    await memos.flushEmbeddings();

    const before = queryEmbedCalls(provider, "dark mode");
    await (
      memos as unknown as {
        multiStreamSearch: (filter: unknown) => Promise<unknown>;
      }
    ).multiStreamSearch({ query: "dark mode", limit: 10 });

    // One inference for all three pool streams — previously three.
    expect(queryEmbedCalls(provider, "dark mode") - before).toBe(1);
    await memos.close();
  });
});
