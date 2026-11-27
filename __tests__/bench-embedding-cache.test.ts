/**
 * Tests for the benchmark embedding cache: hit/miss accounting, batch
 * ordering, query-vs-document separation, persistence, and namespacing.
 *
 * The cache only skips recomputation; every assertion below is about
 * vector identity (float32-rounded, as served over the wire) and call
 * counts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CachingEmbeddingProvider,
  withOptionalEmbeddingCache,
} from "../scripts/lib/embedding-cache";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

function vectorFor(text: string, salt = ""): EmbeddingVector {
  const input = `${salt}:${text}`;
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [0, 1, 2, 3].map((i) => ((h >>> (i * 8)) & 0xff) / 255);
}

function expectVectorClose(
  actual: EmbeddingVector,
  expected: EmbeddingVector,
): void {
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i]).toBeCloseTo(expected[i]!, 6);
  }
}

class FakeProvider implements EmbeddingProvider {
  public readonly id = "fake";
  public readonly model = "fake-embed-v1";
  public readonly dimensions = 4;
  public calls: string[] = [];

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls.push(`d:${text}`);
    return vectorFor(text);
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    this.calls.push(`q:${text}`);
    return vectorFor(text, "query");
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    this.calls.push(`bd:${texts.join(",")}`);
    return texts.map((t) => vectorFor(t));
  }

  async batchEmbedQueries(texts: string[]): Promise<EmbeddingVector[]> {
    this.calls.push(`bq:${texts.join(",")}`);
    return texts.map((t) => vectorFor(t, "query"));
  }
}

describe("CachingEmbeddingProvider", () => {
  let dir: string;
  let cachePath: string;
  const opened: CachingEmbeddingProvider[] = [];

  function open(
    inner: EmbeddingProvider,
    namespace?: string,
  ): CachingEmbeddingProvider {
    const provider = new CachingEmbeddingProvider(inner, cachePath, {
      ...(namespace !== undefined ? { namespace } : {}),
    });
    opened.push(provider);
    return provider;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memos-embed-cache-"));
    cachePath = join(dir, "cache.sqlite");
  });

  afterEach(() => {
    for (const provider of opened) provider.close();
    opened.length = 0;
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  });

  test("embed() reuses a cached vector", async () => {
    const inner = new FakeProvider();
    const provider = open(inner);

    const first = await provider.embed("remember this");
    const second = await provider.embed("remember this");

    expectVectorClose(second, first);
    expect(inner.calls).toEqual(["d:remember this"]);
    expect(provider.cacheStats()).toEqual({
      hits: 1,
      misses: 1,
      writes: 1,
    });
  });

  test("batchEmbed() computes only misses and preserves input order", async () => {
    const inner = new FakeProvider();
    const provider = open(inner);

    await provider.embed("a");
    inner.calls = [];
    const out = await provider.batchEmbed!(["a", "b", "c"]);

    expect(inner.calls).toEqual(["bd:b,c"]);
    out.forEach((vector, i) => {
      expectVectorClose(vector, vectorFor(["a", "b", "c"][i]!));
    });
  });

  test("a query and a document with the same text are different keys", async () => {
    const inner = new FakeProvider();
    const provider = open(inner);

    const asDoc = await provider.embed("same text");
    const asQuery = await provider.embedQuery("same text");

    expect(asQuery).not.toEqual(asDoc);
    expect(inner.calls).toHaveLength(2);
  });

  test("cache survives reopening the file", async () => {
    const firstInner = new FakeProvider();
    const first = open(firstInner);
    const original = await first.embed("persisted");
    first.close();

    const secondInner = new FakeProvider();
    const second = open(secondInner, "fake|fake-embed-v1|4");
    const replayed = await second.embed("persisted");

    expectVectorClose(replayed, original);
    expect(secondInner.calls).toEqual([]);
  });

  test("different namespaces do not share vectors", async () => {
    const inner = new FakeProvider();
    const a = open(inner, "namespace-a");
    const b = open(inner, "namespace-b");

    await a.embed("shared text");
    await b.embed("shared text");

    expect(inner.calls).toHaveLength(2);
  });

  test("no cache path passes the provider through untouched", () => {
    const inner = new FakeProvider();
    expect(withOptionalEmbeddingCache(inner, undefined)).toBe(inner);
  });
});
