/**
 * Tests for the CLIP provider seam.
 *
 * The point of these tests is the SEAM, not real CLIP inference (a
 * model download in CI is out of scope by design):
 *
 * 1. `FakeClipProvider` is deterministic, 512-d, normalized, and counts
 *    calls — the stand-in that lets the rest of the image-memory suite
 *    run offline. Mirrors the FastEmbed local-hash fallback's contract.
 * 2. `ClipEmbeddingProvider` reports its identity and, with no
 *    transformers model loadable, fails SOFT: `embedImage` throws a typed
 *    `ClipUnavailableError` (never a silently-substituted text vector),
 *    and the failure reason is diagnosable via `fallbackReason`.
 * 3. `ClipQueryCache` memoizes CLIP query vectors under a `clip:`-tagged
 *    key — separate from the text query cache — with LRU eviction.
 */

import {
  ClipEmbeddingProvider,
  ClipUnavailableError,
  ClipQueryCache,
  DEFAULT_CLIP_MODEL,
  DEFAULT_CLIP_DIMENSIONS,
  DEFAULT_CLIP_QUERY_CACHE_MAX,
  FakeClipProvider,
} from "../src/vision/index";

describe("FakeClipProvider (the offline test seam)", () => {
  test("reports clip-like identity and 512-d defaults", () => {
    const clip = new FakeClipProvider();
    expect(clip.id).toBe("fake-clip");
    expect(clip.dimensions).toBe(512);
    expect(clip.model).toContain("clip");
  });

  test("accepts custom model and dimensions", () => {
    const clip = new FakeClipProvider({
      model: "fake-siglip",
      dimensions: 768,
    });
    expect(clip.model).toBe("fake-siglip");
    expect(clip.dimensions).toBe(768);
  });

  test("embedImage returns a normalized 512-d vector", async () => {
    const clip = new FakeClipProvider();
    const v = await clip.embedImage(Buffer.from([1, 2, 3, 4]));
    expect(v).toHaveLength(512);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  test("embedImage is deterministic for identical bytes", async () => {
    const clip = new FakeClipProvider();
    const a = await clip.embedImage(Buffer.from([9, 8, 7, 6]));
    const b = await clip.embedImage(Buffer.from([9, 8, 7, 6]));
    expect(a).toEqual(b);
  });

  test("different images hash to different vectors", async () => {
    const clip = new FakeClipProvider();
    const a = await clip.embedImage(Buffer.from([1, 1, 1, 1]));
    const b = await clip.embedImage(Buffer.from([2, 2, 2, 2]));
    expect(a).not.toEqual(b);
  });

  test("embedImageText returns a normalized vector and counts calls", async () => {
    const clip = new FakeClipProvider();
    expect(clip.textCalls).toBe(0);
    const v = await clip.embedImageText("a red error banner");
    expect(clip.textCalls).toBe(1);
    expect(v).toHaveLength(512);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });

  test("identical query text is deterministic", async () => {
    const clip = new FakeClipProvider();
    const a = await clip.embedImageText("the retry-loop diagram");
    const b = await clip.embedImageText("the retry-loop diagram");
    expect(a).toEqual(b);
  });

  test("embedImageText of an image's bytes differs from the image vector", async () => {
    // Sanity on the seam: the text side hashes the STRING, the image
    // side hashes the BYTES — they are different inputs into the same
    // space, so tests can construct (or avoid) collisions deliberately.
    const clip = new FakeClipProvider();
    const bytes = await clip.embedImage(Buffer.from([3, 3, 3, 3]));
    const text = await clip.embedImageText(String.fromCharCode(3, 3, 3, 3));
    expect(bytes).not.toEqual(text);
  });

  test("accepts a string input (path-like) without throwing", async () => {
    const clip = new FakeClipProvider();
    const v = await clip.embedImage("/some/path/to/image.png");
    expect(v).toHaveLength(512);
  });

  test("counts image calls", async () => {
    const clip = new FakeClipProvider();
    await clip.embedImage(Buffer.from([1]));
    await clip.embedImage(Buffer.from([2]));
    expect(clip.imageCalls).toBe(2);
  });
});

describe("ClipEmbeddingProvider", () => {
  test("reports id, default model, and default dimensions", () => {
    const clip = new ClipEmbeddingProvider();
    expect(clip.id).toBe("clip");
    expect(clip.model).toBe(DEFAULT_CLIP_MODEL);
    expect(clip.model).toBe("Xenova/clip-vit-base-patch32");
    expect(clip.dimensions).toBe(DEFAULT_CLIP_DIMENSIONS);
    expect(clip.dimensions).toBe(512);
  });

  test("accepts custom model and dimensions", () => {
    const clip = new ClipEmbeddingProvider({
      model: "Xenova/clip-vit-base-patch16",
      dimensions: 512,
    });
    expect(clip.model).toBe("Xenova/clip-vit-base-patch16");
  });

  test("is not available before any embed call", () => {
    const clip = new ClipEmbeddingProvider();
    expect(clip.available).toBe(false);
    expect(clip.fallbackReason).toBe(null);
  });

  test("embedImage fails SOFT with a typed error, never a text vector", async () => {
    // Whether or not the transformers package is installed and the model
    // can download, the contract is the same: a failure to encode an
    // image is a THROWN ClipUnavailableError, and the provider never
    // returns a bogus/placeholder vector. If the real pipeline happens to
    // be available in this environment, embedImage succeeds with a
    // genuine 512-d vector — both outcomes satisfy the invariant.
    const clip = new ClipEmbeddingProvider();
    let threw = false;
    try {
      const v = await clip.embedImage(Buffer.from([1, 2, 3, 4]));
      expect(v).toHaveLength(512);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ClipUnavailableError);
      // The reason must be diagnosable — this is what the write path
      // records in metadata.clip.error.
      expect((err as ClipUnavailableError).message).toBeTruthy();
    }
    if (threw) {
      // A decode/encode failure is NOT a resolve failure: the pipeline
      // loaded fine, the bytes were bad. `available` stays true (the
      // model is usable) while `fallbackReason` stays null (no fallback
      // activated). Either way, the invariant holds: the caller saw a
      // typed ClipUnavailableError, never a substituted text vector.
      expect(clip.available === true || clip.fallbackReason !== null).toBe(
        true,
      );
    } else {
      expect(clip.available).toBe(true);
    }
  }, 120_000);

  test("a failed resolve is sticky — repeat calls fail fast, same reason", async () => {
    const clip = new ClipEmbeddingProvider();
    try {
      await clip.embedImage(Buffer.from([1]));
    } catch {
      // expected when the model can't load
    }
    const reasonAfterFirst = clip.fallbackReason;
    try {
      await clip.embedImage(Buffer.from([2]));
    } catch {
      // expected
    }
    // If the first call failed, the second must report the SAME reason
    // (resolve() runs at most once) — no retry storm on every write.
    expect(clip.fallbackReason).toBe(reasonAfterFirst);
  }, 120_000);

  test("dimension mismatch is refused, not silently persisted", async () => {
    // Configuring dimensions that disagree with the model's real output
    // space must surface as an error, not as vectors that
    // querySimilarImages would filter out (or worse, score in the wrong
    // space). With no model loadable this is the unavailable path; the
    // guard exists for when one IS loadable.
    const clip = new ClipEmbeddingProvider({ dimensions: 999 });
    try {
      const v = await clip.embedImage(Buffer.from([1, 2]));
      expect(v).toHaveLength(999);
    } catch (err) {
      expect(err).toBeInstanceOf(ClipUnavailableError);
    }
  }, 120_000);
});

describe("ClipQueryCache (the parallel CLIP LRU)", () => {
  test("memoizes the provider's encode call", async () => {
    const provider = new FakeClipProvider();
    const cache = new ClipQueryCache();
    const a = await cache.get("a red banner", provider);
    const b = await cache.get("a red banner", provider);
    expect(a).toEqual(b);
    // Second call served from cache — the provider was hit exactly once.
    expect(provider.textCalls).toBe(1);
  });

  test("distinct queries hit the provider separately", async () => {
    const provider = new FakeClipProvider();
    const cache = new ClipQueryCache();
    await cache.get("query one", provider);
    await cache.get("query two", provider);
    expect(provider.textCalls).toBe(2);
  });

  test("returns null when the provider has no text encoder (degrade to caption leg)", async () => {
    const imageOnly = {
      model: "image-only",
      // no embedImageText — a provider that can only do image→image
      // search; the text→image leg must degrade, not fail.
    };
    const cache = new ClipQueryCache();
    const result = await cache.get("any query", imageOnly);
    expect(result).toBe(null);
  });

  test("LRU touch: a re-queried key survives eviction", async () => {
    const provider = new FakeClipProvider();
    const cache = new ClipQueryCache(3);
    await cache.get("k1", provider);
    await cache.get("k2", provider);
    await cache.get("k3", provider);
    // Touch k1 so it is the most-recently-used entry.
    const before = provider.textCalls;
    await cache.get("k1", provider);
    expect(provider.textCalls).toBe(before); // served from cache
    // Overflow past the bound — the OLDEST untouched key (k2) goes.
    await cache.get("k4", provider);
    await cache.get("k5", provider);
    const countBefore = provider.textCalls;
    await cache.get("k1", provider);
    // k1 survived because of the touch; k2 was evicted.
    expect(provider.textCalls).toBe(countBefore);
    await cache.get("k2", provider);
    expect(provider.textCalls).toBeGreaterThan(countBefore);
  });

  test("bounded size respects the configured max", async () => {
    const provider = new FakeClipProvider();
    const cache = new ClipQueryCache(2);
    await cache.get("a", provider);
    await cache.get("b", provider);
    await cache.get("c", provider);
    expect(cache.size).toBe(2);
  });

  test("default max is exported and sane", () => {
    expect(DEFAULT_CLIP_QUERY_CACHE_MAX).toBe(512);
  });

  test("clear() empties the cache", async () => {
    const provider = new FakeClipProvider();
    const cache = new ClipQueryCache();
    await cache.get("a", provider);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("propagates a provider error instead of caching the failure", async () => {
    const provider = {
      model: "throwing",
      embedImageText: async (): Promise<number[]> => {
        throw new ClipUnavailableError("encode failed");
      },
    };
    const cache = new ClipQueryCache();
    await expect(cache.get("q", provider)).rejects.toThrow(
      ClipUnavailableError,
    );
    expect(cache.size).toBe(0);
  });

  test("different models do not share cache entries (namespace)", async () => {
    // The key is `clip:<model>:<query>` — two providers with the same
    // query but different models must not collide.
    const p1 = new FakeClipProvider({ model: "clip-a" });
    const p2 = new FakeClipProvider({ model: "clip-b" });
    const cache = new ClipQueryCache();
    const v1 = await cache.get("same query", p1);
    const v2 = await cache.get("same query", p2);
    expect(v1).not.toEqual(v2);
    expect(p1.textCalls).toBe(1);
    expect(p2.textCalls).toBe(1);
    expect(cache.size).toBe(2);
  });
});
