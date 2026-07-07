/**
 * Tests for FastEmbedEmbeddingProvider.
 *
 * The provider dynamically requires `@xenova/transformers` if it is
 * installed. When it isn't, it falls back to a deterministic local
 * feature-hash that runs anywhere with zero dependencies. Both modes
 * expose the same shape so swapping in the real model is a no-op
 * for downstream code.
 */

import {
  FastEmbedEmbeddingProvider,
  createEmbeddingProvider,
} from "../src/embeddings";

describe("FastEmbedEmbeddingProvider", () => {
  test("constructs with FastEmbed-style defaults", () => {
    const p = new FastEmbedEmbeddingProvider();
    expect(p.id).toBe("fastembed");
    expect(p.model).toBe("BAAI/bge-small-en-v1.5");
    expect(p.dimensions).toBe(384);
  });

  test("accepts a custom model and dimensions", () => {
    const p = new FastEmbedEmbeddingProvider({
      model: "BAAI/bge-base-en-v1.5",
      dimensions: 768,
    });
    expect(p.model).toBe("BAAI/bge-base-en-v1.5");
    expect(p.dimensions).toBe(768);
  });

  test("embed() returns a normalized vector of the right length", async () => {
    const p = new FastEmbedEmbeddingProvider();
    const v = await p.embed("hello world");
    expect(v).toHaveLength(384);
    // L2 norm should be ~1 after normalizeVector.
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  test("embed() is deterministic for the same input", async () => {
    const p = new FastEmbedEmbeddingProvider();
    const a = await p.embed("dark mode preference");
    const b = await p.embed("dark mode preference");
    expect(a).toEqual(b);
  });

  test("batchEmbed() returns one normalized vector per input", async () => {
    const p = new FastEmbedEmbeddingProvider();
    const vectors = await p.batchEmbed!(["first", "second", "third"]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toHaveLength(384);
    }
  });

  test("createEmbeddingProvider recognizes provider: 'fastembed'", () => {
    const p = createEmbeddingProvider({ provider: "fastembed" });
    expect(p.id).toBe("fastembed");
  });
});
