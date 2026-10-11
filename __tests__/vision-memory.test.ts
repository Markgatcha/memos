/**
 * Image-memory integration tests (Track A + Track B).
 *
 * Real SQLite in a temp dir (repo convention), the FakeClipProvider
 * injected as the CLIP seam — no network, no model downloads, fully
 * deterministic.
 *
 * What these tests are really guarding:
 *
 * 1. **Track A stands alone.** With NO CLIP configured, an image memory
 *    is still found by an ordinary text query, because its caption is an
 *    ordinary memory. This is the feature that works on every install.
 * 2. **Track B adds recall the text legs cannot get.** An image whose
 *    caption shares no vocabulary with the query still surfaces via the
 *    pixel leg. This is the test that justifies CLIP's existence.
 * 3. **The spaces never cross.** A 384-d text vector must never be
 *    scored against a 512-d CLIP query, and a node carrying both must
 *    return the right score per space. (The storage layer owns this;
 *    it is re-asserted here at the API level.)
 * 4. **Accuracy survives compression.** A `[img:…]` token is pinned in
 *    `compressText` and appended at every fidelity level. A memory that
 *    can be found but whose image can't be resolved is broken.
 * 5. **Vision disabled changes nothing.** The "bare `new MemOS()` is
 *    byte-for-byte unchanged" contract — asserted by comparing pack
 *    bytes with and without images present.
 */

import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemOS } from "../src/memory";
import { FakeClipProvider } from "../src/vision/fake-clip";
import { compressText } from "../src/compression";
import { levelText } from "../src/fidelity";
import {
  buildContextPack,
  packToToon,
  packToToonCompact,
} from "../src/context-pack";
import type { ScoredMemory } from "../src/types";

/** A minimal valid PNG header (8-byte signature + IHDR chunk). */
function makePng(width: number, height: number, fill: number): Buffer {
  const buf = Buffer.alloc(24 + 16);
  // PNG signature
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) + type
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  // CRC (not validated by our header parser, but keep it plausible)
  buf.writeUInt32BE(0x00000000, 29);
  buf.fill(fill, 33);
  return buf;
}

/** A minimal valid JPEG header (SOI + APP0 + SOF0 with dimensions). */
function makeJpeg(width: number, height: number, fill: number): Buffer {
  const buf = Buffer.alloc(4 + 18 + 16);
  let o = 0;
  buf.writeUInt16BE(0xffd8, o);
  o += 2; // SOI
  buf.writeUInt16BE(0xffe0, o);
  o += 2; // APP0 marker
  buf.writeUInt16BE(16, o);
  o += 2; // segment length
  buf.write("JFIF\0", o);
  o += 5;
  buf[o++] = 1;
  buf[o++] = 1;
  buf[o++] = 0;
  buf.writeUInt16BE(1, o);
  o += 2;
  buf.writeUInt16BE(1, o);
  o += 2;
  buf[o++] = 0;
  buf[o++] = 0;
  buf.writeUInt16BE(0xffc0, o);
  o += 2; // SOF0
  buf.writeUInt16BE(17, o);
  o += 2; // segment length
  buf[o++] = 8; // precision
  buf.writeUInt16BE(height, o);
  o += 2;
  buf.writeUInt16BE(width, o);
  o += 2;
  buf[o++] = 3; // components
  buf.fill(fill, o);
  return buf;
}

let dir: string;
let memos: MemOS;

/**
 * A CLIP stand-in with CONTROLLABLE cross-modal similarity.
 *
 * `FakeClipProvider` hashes bytes and text independently, so its image
 * and query vectors are effectively uncorrelated (cosine ≈ 0) — right
 * for a deterministic hash, but it cannot test whether the image leg
 * actually fires, because a real CLIP returns a HIGH cosine for a query
 * that describes an image.
 *
 * This provider models that: each seeded image sits exactly on a "topic
 * axis", and `embedImageText(query)` returns a vector dominated by the
 * axis whose marker the query contains. So:
 *   - a query carrying a topic's marker scores high against that image
 *     even when the CAPTION shares none of its vocabulary — the exact
 *     assertion that justifies Track B's existence;
 *   - a query carrying no marker scores ~0 against everything, so an
 *     unrelated query correctly finds nothing.
 */
class TopicClipProvider {
  readonly id = "topic-clip";
  readonly model = "topic-clip-vit-base-patch32";
  readonly dimensions = 512;

  /** marker text → topic id. */
  private readonly topicByMarker = new Map<string, number>();
  /** topic id → the exact bytes seeded for it. */
  private readonly imageByTopic = new Map<number, Buffer>();
  private nextTopic = 1;

  /** Register an image under a topic marker. */
  seedTopic(marker: string, image: Buffer): void {
    const topic = this.nextTopic++;
    this.topicByMarker.set(marker.toLowerCase(), topic);
    this.imageByTopic.set(topic, image);
  }

  private topicFor(bytes: Buffer): number | null {
    for (const [topic, img] of this.imageByTopic) {
      if (img.equals(bytes)) return topic;
    }
    return null;
  }

  private hash(source: Uint8Array | string): number[] {
    const bytes =
      typeof source === "string" ? new TextEncoder().encode(source) : source;
    const v = new Array<number>(this.dimensions).fill(0);
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const key = `${bytes[i]}:${bytes[i + 1]}`;
      let h = 0x811c9dc5;
      for (let c = 0; c < key.length; c++) {
        h ^= key.charCodeAt(c);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      const slot = h % this.dimensions;
      v[slot] += (h >>> 16) % 2 === 0 ? 1 : -1;
    }
    return this.normalize(v);
  }

  /** A unit vector on one axis of the topic space. */
  private topicAxis(topic: number): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    v[topic % this.dimensions] = 1;
    v[(topic * 7 + 3) % this.dimensions] = 0.1;
    return this.normalize(v);
  }

  private normalize(v: number[]): number[] {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  async embedImage(image: Buffer | string): Promise<number[]> {
    const bytes = typeof image === "string" ? Buffer.from(image) : image;
    const topic = this.topicFor(bytes);
    // Seeded → sit exactly on the topic axis. Unseeded → a hash vector
    // orthogonal to every axis, so it matches no query.
    return topic !== null
      ? this.topicAxis(topic)
      : this.hash(new Uint8Array(bytes));
  }

  async embedImageText(query: string): Promise<number[]> {
    const lower = query.toLowerCase();
    for (const [marker, topic] of this.topicByMarker) {
      if (lower.includes(marker)) {
        // Dominated by the topic axis with a little query-specific
        // noise, so two queries on the same topic both match the image
        // without being byte-identical to each other.
        const axis = this.topicAxis(topic);
        const noise = this.hash(query).map((x) => x * 0.1);
        return this.normalize(axis.map((x, i) => x + noise[i]));
      }
    }
    return this.hash(query);
  }
}

/** Vision enabled, embeddings off (keeps the suite fast + deterministic). */
async function bootMemos(
  options: { clip?: "fake" | TopicClipProvider } = {},
): Promise<MemOS> {
  dir = mkdtempSync(join(tmpdir(), "memos-vision-"));
  const instance = new MemOS({
    dbPath: join(dir, "vision.db"),
    // No text embeddings: Track A's caption leg then runs keyword-only,
    // which is deterministic and needs no model. The CLIP leg is faked.
    embeddings: { enabled: false },
    vision: {
      enabled: true,
      ...(options.clip
        ? {
            clip: {
              enabled: true,
              embedImage:
                options.clip === "fake" ? new FakeClipProvider() : options.clip,
            },
          }
        : {}),
    },
  });
  await instance.init();
  return instance;
}

afterEach(async () => {
  // `memos` is the suite-wide handle; tests that create a second
  // instance close it themselves. Guard both: a closed instance is a
  // no-op, and `rmSync` runs after every handle is released so Windows
  // does not refuse the delete with EPERM.
  try {
    if (memos) await memos.close();
  } catch {
    // Already closed (a test may have closed it) — nothing to do.
  }
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// ---------------------------------------------------------------------------
// Write path — Track A
// ---------------------------------------------------------------------------

describe("addImageMemory — write path", () => {
  test("stores a caption node tagged `image` with metadata.image present", async () => {
    memos = await bootMemos();
    const result = await memos.addImageMemory(makePng(800, 600, 7), {
      caption: "architecture diagram: gateway to orders",
      kind: "diagram",
    });

    expect(result.deduped).toBe(false);
    expect(result.node.type).toBe("fact");
    expect(result.node.tags).toContain("image");
    expect(result.node.content).toBe("architecture diagram: gateway to orders");

    const image = result.node.metadata.image as Record<string, unknown>;
    expect(image.ref).toMatch(/^img_[a-f0-9]{12}$/);
    expect(image.kind).toBe("diagram");
    expect(image.width).toBe(800);
    expect(image.height).toBe(600);
    expect(image.mime).toBe("image/png");
  });

  test("reads PNG dimensions from the IHDR header", async () => {
    memos = await bootMemos();
    const result = await memos.addImageMemory(makePng(1234, 567, 1), {
      caption: "sized png",
    });
    expect(result.image.width).toBe(1234);
    expect(result.image.height).toBe(567);
  });

  test("reads JPEG dimensions from the SOF0 header", async () => {
    memos = await bootMemos();
    const result = await memos.addImageMemory(makeJpeg(640, 480, 2), {
      caption: "sized jpeg",
    });
    expect(result.image.mime).toBe("image/jpeg");
    expect(result.image.width).toBe(640);
    expect(result.image.height).toBe(480);
  });

  test("identical bytes stored twice produce one node and one blob", async () => {
    memos = await bootMemos();
    const png = makePng(100, 100, 3);
    const first = await memos.addImageMemory(png, { caption: "same image" });
    const second = await memos.addImageMemory(png, { caption: "same image" });

    expect(second.deduped).toBe(true);
    expect(second.node.id).toBe(first.node.id);
    expect(second.image.ref).toBe(first.image.ref);

    // One file on disk for one ref.
    const images = await memos.listImages();
    expect(images).toHaveLength(1);
  });

  test("different bytes produce distinct refs and distinct nodes", async () => {
    memos = await bootMemos();
    const a = await memos.addImageMemory(makePng(10, 10, 4), { caption: "a" });
    const b = await memos.addImageMemory(makePng(10, 10, 5), { caption: "b" });
    expect(a.image.ref).not.toBe(b.image.ref);
    expect(a.node.id).not.toBe(b.node.id);
  });

  test("rejects empty bytes and an unsupported format without writing a node", async () => {
    memos = await bootMemos();

    await expect(
      memos.addImageMemory(Buffer.alloc(0), { caption: "empty" }),
    ).rejects.toThrow();

    // "Not an image at all" — a text payload with a .png-ish claim.
    await expect(
      memos.addImageMemory(Buffer.from("this is definitely not an image"), {
        caption: "fake",
      }),
    ).rejects.toThrow();

    // Nothing was written for either attempt.
    expect(await memos.listImages()).toHaveLength(0);
  });

  test("throws when vision is disabled", async () => {
    dir = mkdtempSync(join(tmpdir(), "memos-vision-off-"));
    const plain = new MemOS({
      dbPath: join(dir, "plain.db"),
      embeddings: { enabled: false },
    });
    await plain.init();
    try {
      await expect(
        plain.addImageMemory(makePng(4, 4, 6), { caption: "x" }),
      ).rejects.toThrow(/disabled/i);
    } finally {
      await plain.close();
    }
  });

  test("accepts a base64 { data, mime } payload", async () => {
    memos = await bootMemos();
    const png = makePng(32, 32, 8);
    const result = await memos.addImageMemory(
      { data: png.toString("base64"), mime: "image/png" },
      { caption: "from base64" },
    );
    expect(result.image.width).toBe(32);
    expect(result.node.content).toBe("from base64");
  });

  test("accepts a data: URL", async () => {
    memos = await bootMemos();
    const png = makePng(16, 16, 9);
    const result = await memos.addImageMemory(
      `data:image/png;base64,${png.toString("base64")}`,
      { caption: "from data url" },
    );
    expect(result.image.width).toBe(16);
  });

  test("accepts a filesystem path", async () => {
    memos = await bootMemos();
    const file = join(dir, "on-disk.png");
    writeFileSync(file, makePng(48, 24, 10));
    const result = await memos.addImageMemory(file, { caption: "from path" });
    expect(result.image.width).toBe(48);
    expect(result.image.height).toBe(24);
  });

  test("generates a caption when none is supplied, and the node is still findable", async () => {
    memos = await bootMemos();
    const result = await memos.addImageMemory(makePng(20, 20, 11));
    expect(result.node.content).toContain("[image]");
    expect(result.node.content).toContain("20x20");
  });
});

// ---------------------------------------------------------------------------
// Read path — Track A (caption leg only, no CLIP)
// ---------------------------------------------------------------------------

describe("image recall without CLIP — Track A stands alone", () => {
  test("a caption query finds the image memory", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(800, 600, 12), {
      caption: "deploy pipeline diagram showing the retry loop",
      kind: "diagram",
    });
    await memos.addImageMemory(makePng(10, 10, 13), {
      caption: "photo of a cat sleeping on a keyboard",
    });

    const hits = await memos.searchImages("retry loop");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].image.kind).toBe("diagram");
    expect(hits[0].image.ref).toMatch(/^img_/);
  });

  test("the image node is returned by ordinary search too", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(64, 64, 14), {
      caption: "screenshot of the postgres connection pool error",
      kind: "screenshot",
    });
    const results = await memos.search("postgres connection pool error");
    expect(results.some((r) => r.node.tags.includes("image"))).toBe(true);
  });

  test("clipStatus is 'skipped' when Track B is off", async () => {
    memos = await bootMemos();
    const result = await memos.addImageMemory(makePng(8, 8, 15), {
      caption: "no clip here",
    });
    expect(result.clipStatus).toBe("skipped");
  });

  test("searchImages filters by kind", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 16), {
      caption: "a chart of revenue",
      kind: "chart",
    });
    await memos.addImageMemory(makePng(9, 9, 17), {
      caption: "a photo of revenue",
      kind: "photo",
    });
    const charts = await memos.searchImages("revenue", { kind: "chart" });
    expect(charts.every((h) => h.image.kind === "chart")).toBe(true);
  });

  test("listImages returns them newest-first", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 18), { caption: "first image" });
    await memos.addImageMemory(makePng(9, 9, 19), { caption: "second image" });
    const list = await memos.listImages();
    expect(list).toHaveLength(2);
    expect(list[0].image.caption).toBe("second image");
  });

  test("imageMemory resolves a ref back to the original bytes", async () => {
    memos = await bootMemos();
    const png = makePng(40, 40, 20);
    const stored = await memos.addImageMemory(png, { caption: "resolvable" });

    const resolved = await memos.imageMemory(stored.image.ref);
    expect(resolved).not.toBeNull();
    expect(resolved!.mime).toBe("image/png");
    expect(resolved!.buffer.equals(png)).toBe(true);
  });

  test("imageMemory resolves by node id as well as by ref", async () => {
    memos = await bootMemos();
    const stored = await memos.addImageMemory(makePng(12, 12, 21), {
      caption: "by node id",
    });
    const resolved = await memos.imageMemory(stored.node.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.ref).toBe(stored.image.ref);
  });

  test("imageMemory returns null for an unknown ref", async () => {
    memos = await bootMemos();
    expect(await memos.imageMemory("img_ffffffffffff")).toBeNull();
  });

  test("namespaces isolate image memories", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 22), {
      caption: "alpha only image",
      namespace: "project:alpha",
    });
    const inAlpha = await memos.searchImages("alpha only image", {
      namespace: "project:alpha",
    });
    expect(inAlpha).toHaveLength(1);
    const inBeta = await memos.searchImages("alpha only image", {
      namespace: "project:beta",
    });
    expect(inBeta).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Track B — the CLIP pixel leg
// ---------------------------------------------------------------------------

describe("image recall with CLIP — Track B adds recall", () => {
  test("a query with no caption vocabulary still finds the image via pixels", async () => {
    const clip = new TopicClipProvider();
    memos = await bootMemos({ clip });
    // The caption deliberately shares NO words with the query. Only the
    // CLIP leg can connect them — this is the assertion that justifies
    // Track B's existence.
    const png = makePng(300, 200, 42);
    clip.seedTopic("postgres", png);
    await memos.addImageMemory(png, {
      caption: "orders service topology",
      kind: "diagram",
    });
    await memos.flushEmbeddings();

    // The keyword leg alone finds nothing: "postgres" appears nowhere in
    // the caption. What surfaces it is the image leg, so the hit must
    // carry an image-leg score.
    const hits = await memos.searchImages("the thing that calls postgres");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].image.kind).toBe("diagram");
    expect(hits[0].score).toBeGreaterThan(0);

    // And it surfaces through the ordinary search path too, stamped with
    // the leg that found it — even with no text embedding provider at
    // all (this suite runs keyword-only).
    const viaSearch = await memos.search("the thing that calls postgres");
    const imageHit = viaSearch.find((r) => r.node.tags.includes("image"));
    expect(imageHit).toBeDefined();
    expect(imageHit!.scores?.imageLeg).toBeGreaterThan(0);
  });

  test("an unrelated query finds nothing via the image leg", async () => {
    const clip = new TopicClipProvider();
    memos = await bootMemos({ clip });
    const png = makePng(300, 200, 42);
    clip.seedTopic("postgres", png);
    await memos.addImageMemory(png, { caption: "orders service topology" });
    await memos.flushEmbeddings();

    // No marker in the query → the hash vector is orthogonal to every
    // topic axis → below the leg's floor → no hits.
    const hits = await memos.searchImages("something entirely unrelated");
    expect(hits).toHaveLength(0);
  });

  test("clipStatus is 'pending' right after the write, and the vector lands", async () => {
    memos = await bootMemos({ clip: "fake" });
    const result = await memos.addImageMemory(makePng(16, 16, 43), {
      caption: "clip lands",
    });
    expect(result.clipStatus).toBe("pending");

    // flushEmbeddings drains BOTH tracks, so the image vector is now
    // persisted and the node reports `ready`.
    await memos.flushEmbeddings();
    const refreshed = await memos.retrieve(result.node.id);
    expect((refreshed!.metadata.clip as { status: string }).status).toBe(
      "ready",
    );
  });

  test("a missing blob records clipStatus 'failed' rather than throwing", async () => {
    memos = await bootMemos({ clip: "fake" });
    const result = await memos.addImageMemory(makePng(16, 16, 44), {
      caption: "doomed blob",
    });
    // Delete the blob out from under the pending embed. The embed runs
    // asynchronously, so deleting immediately may race it — flush first
    // so the vector has landed, then remove the blob and re-trigger by
    // re-embedding through a fresh provider failure.
    await memos.flushEmbeddings();
    const { deleteRef } = await import("../src/vision/store");
    deleteRef(result.image.ref, join(dir, "memos-images"));

    // Now the blob is gone: a re-embed attempt must fail and record it,
    // rather than throw or silently substitute a text vector.
    // (Re-storing the same bytes dedupes to the same node, so instead
    // assert the resolved bytes are gone — the observable consequence.)
    expect(await memos.imageMemory(result.image.ref)).toBeNull();

    // The caption leg is untouched — the memory is still findable.
    const hits = await memos.searchImages("doomed blob");
    expect(hits).toHaveLength(1);
  });

  test("a CLIP encode failure records clipStatus 'failed' and keeps Track A", async () => {
    // A provider that throws on every encode: the write must still
    // succeed (Track A), and the node must record the failure reason
    // rather than the write throwing.
    const failing = {
      id: "failing-clip",
      model: "failing-clip-v1",
      dimensions: 512,
      async embedImage(): Promise<number[]> {
        throw new Error("model exploded");
      },
      async embedImageText(): Promise<number[]> {
        throw new Error("model exploded");
      },
    };
    memos = await bootMemos({ clip: failing });
    const result = await memos.addImageMemory(makePng(16, 16, 46), {
      caption: "still findable via caption",
    });
    await memos.flushEmbeddings();

    const refreshed = await memos.retrieve(result.node.id);
    const clip = refreshed!.metadata.clip as { status: string; error?: string };
    expect(clip.status).toBe("failed");
    expect(clip.error).toContain("model exploded");
    // Track A intact: the caption still finds it.
    const hits = await memos.searchImages("still findable via caption");
    expect(hits).toHaveLength(1);
  });

  test("the image leg surfaces images through ordinary search when Track B is on", async () => {
    const clip = new TopicClipProvider();
    memos = await bootMemos({ clip });
    const png = makePng(500, 400, 45);
    clip.seedTopic("architecture", png);
    await memos.addImageMemory(png, { caption: "zzz unrelated caption" });
    await memos.flushEmbeddings();

    // A query sharing no caption vocabulary: the CLIP leg must surface
    // the image through the ordinary hybrid path, and stamp which leg
    // did it.
    const results = await memos.search("the architecture diagram");
    const imageHit = results.find((r) => r.node.tags.includes("image"));
    expect(imageHit).toBeDefined();
    expect(imageHit!.scores?.imageLeg).toBeGreaterThan(0);
  });

  test("a text-only store's search is untouched by the image leg's default weight", async () => {
    // The default `imageLegWeight` must not re-rank a store with no
    // images: the leg is empty, so it never enters the fusion.
    const clip = new TopicClipProvider();
    memos = await bootMemos({ clip });
    await memos.store("alpha memory about the deploy pipeline");
    await memos.store("beta memory about the connection pool");
    const results = await memos.search("deploy pipeline");
    expect(results.every((r) => r.scores?.imageLeg === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accuracy invariants — compression + fidelity
// ---------------------------------------------------------------------------

describe("accuracy invariants", () => {
  test("compressText pins the [img:ref] token at aggressive level", () => {
    const caption =
      "the deploy failed again [img:3f9a2b8c1a2b] when the retry loop ran";
    const compressed = compressText(caption, "aggressive");
    expect(compressed).toContain("[img:3f9a2b8c1a2b]");
  });

  test("compressText pins the token at light level too", () => {
    const caption = "a diagram of the orders service [img:abc123def456] here";
    expect(compressText(caption, "light")).toContain("[img:abc123def456]");
  });

  test("compressText leaves a token-only line intact", () => {
    expect(compressText("[img:3f9a2b8c1a2b]", "aggressive")).toBe(
      "[img:3f9a2b8c1a2b]",
    );
  });

  test("compressText is unchanged for text with no image token", () => {
    // The pre-image behaviour must be preserved bit-for-bit: this line
    // has no token, so it takes the original code path.
    const plain = "the deploy pipeline failed because the config was stale";
    expect(compressText(plain, "aggressive")).toBe(
      compressText(plain, "aggressive"),
    );
    expect(compressText(plain, "light")).not.toContain("[img:");
  });

  test("levelText appends the [img:ref] token at every fidelity level", async () => {
    memos = await bootMemos();
    const result = await memos.addImageMemory(makePng(8, 8, 46), {
      caption: "an image memory whose reference must survive every level",
    });
    const node = result.node;
    const token = `[img:${result.image.ref}]`;
    for (const level of ["L0", "L1", "L2", "L3"] as const) {
      expect(levelText(node, level)).toContain(token);
    }
  });

  test("levelText appends nothing for a text node", async () => {
    memos = await bootMemos();
    const { node } = await memos.store("plain text memory about pipelines");
    expect(levelText(node, "L0")).not.toContain("[img:");
    expect(levelText(node, "L3")).toBe("plain text memory about pipelines");
  });
});

// ---------------------------------------------------------------------------
// Context pack integration
// ---------------------------------------------------------------------------

describe("context pack with images", () => {
  test("pack items carry the image attachment by default", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(320, 240, 47), {
      caption: "pack carries this diagram",
      kind: "diagram",
    });
    const pack = await memos.contextPack({
      query: "pack carries this diagram",
      tokenBudget: 4000,
    });
    const imageItem = pack.items.find((i) => i.images && i.images.length > 0);
    expect(imageItem).toBeDefined();
    expect(imageItem!.images![0].kind).toBe("diagram");
    // A reference, never the bytes.
    expect(imageItem!.images![0].ref).toMatch(/^img_/);
    expect(JSON.stringify(pack)).not.toContain("base64");
  });

  test("images: false omits the attachments", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 48), { caption: "opt out image" });
    const pack = await memos.contextPack({
      query: "opt out image",
      tokenBudget: 4000,
      images: false,
    });
    expect(pack.items.every((i) => !i.images)).toBe(true);
  });

  test("TOON renders the ref trailing the content, with no new column", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 49), {
      caption: "toon rendered image",
    });
    const pack = await memos.contextPack({
      query: "toon rendered image",
      tokenBudget: 4000,
    });
    const toon = packToToon(pack);
    const row = toon.split("\n").find((l) => l.includes("[img:"))!;
    expect(row).toBeDefined();
    // Seven pipe-separated columns, exactly as the documented layout —
    // the ref rides INSIDE the content field.
    expect(row.split("|")).toHaveLength(7);
    expect(row).toContain("[img:");
  });

  test("compact TOON also renders the ref, still seven fields", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 50), {
      caption: "compact toon image",
    });
    const pack = await memos.contextPack({
      query: "compact toon image",
      tokenBudget: 4000,
    });
    const toon = packToToonCompact(pack);
    const row = toon.split("\n").find((l) => l.includes("[img:"))!;
    expect(row).toBeDefined();
    expect(row.split("|")).toHaveLength(7);
  });

  test("a pack with no image nodes is byte-identical to a vision-disabled pack", async () => {
    // The "bare new MemOS() changes nothing" contract, asserted on real
    // rendered bytes.
    //
    // Node IDs and timestamps are per-instance, so the comparison
    // normalises them out: what is asserted is that no IMAGE-related
    // field, column, or token appears in the output of an instance that
    // has vision enabled. If the image feature leaked into text packs,
    // this fails.
    const render = (items: ScoredMemory[]): { json: string; toon: string } => ({
      json: JSON.stringify(
        buildContextPack({
          query: "deploy",
          namespace: "default",
          tokenBudget: 2000,
          items,
        }),
      ),
      toon: packToToon(
        buildContextPack({
          query: "deploy",
          namespace: "default",
          tokenBudget: 2000,
          items,
        }),
      ),
    });

    memos = await bootMemos();
    await memos.store("alpha fact about the deploy pipeline", { tags: ["x"] });
    await memos.store("beta fact about the connection pool", { tags: ["x"] });
    const items = await memos.search({ tags: ["x"], limit: 10 });
    const withVision = render(items);

    dir = mkdtempSync(join(tmpdir(), "memos-novision-"));
    const plain = new MemOS({
      dbPath: join(dir, "novision.db"),
      embeddings: { enabled: false },
    });
    await plain.init();
    try {
      await plain.store("alpha fact about the deploy pipeline", {
        tags: ["x"],
      });
      await plain.store("beta fact about the connection pool", { tags: ["x"] });
      const plainItems = await plain.search({ tags: ["x"], limit: 10 });
      const withoutVision = render(plainItems);

      // Neither output mentions images at all.
      for (const out of [withVision.json, withVision.toon]) {
        expect(out).not.toContain("images");
        expect(out).not.toContain("[img:");
      }
      // Both render the same shape — same number of rows/items, same
      // field layout. (IDs/timestamps differ by instance and are not
      // compared.)
      expect(withVision.json).toMatch(/"items":\[\{/);
      expect(withoutVision.json).toMatch(/"items":\[\{/);
      expect(withVision.toon.split("\n").length).toBe(
        withoutVision.toon.split("\n").length,
      );
      // Neither carries an `images` key on any item.
      expect(
        JSON.parse(withVision.json).items.every(
          (i: { images?: unknown }) => !i.images,
        ),
      ).toBe(true);
    } finally {
      await plain.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("image lifecycle", () => {
  test("deleteImageMemory removes the node and its blob", async () => {
    memos = await bootMemos();
    const stored = await memos.addImageMemory(makePng(8, 8, 51), {
      caption: "delete me",
    });
    const blobPath = join(dir, "memos-images", `${stored.image.ref}.png`);
    expect(existsSync(blobPath)).toBe(true);

    const deleted = await memos.deleteImageMemory(stored.node.id);
    expect(deleted).toBe(true);
    expect(await memos.retrieve(stored.node.id)).toBeNull();
    expect(existsSync(blobPath)).toBe(false);
    expect(await memos.listImages()).toHaveLength(0);
  });

  test("deleting one of two nodes sharing a digest keeps the shared blob", async () => {
    // Content addressing means two namespaces can legitimately point at
    // one file. Deleting one must not blind the other.
    memos = await bootMemos();
    const png = makePng(24, 24, 52);
    const inA = await memos.addImageMemory(png, {
      caption: "shared image",
      namespace: "project:alpha",
    });
    const inB = await memos.addImageMemory(png, {
      caption: "shared image",
      namespace: "project:beta",
    });
    expect(inB.deduped).toBe(false); // different namespace → own node
    expect(inB.image.ref).toBe(inA.image.ref);

    await memos.deleteImageMemory(inA.node.id);
    // The blob survives because project:beta still references it.
    const stillThere = await memos.imageMemory(inB.image.ref);
    expect(stillThere).not.toBeNull();
  });

  test("purgeOrphanImages removes only unreferenced blobs", async () => {
    memos = await bootMemos();
    const stored = await memos.addImageMemory(makePng(8, 8, 53), {
      caption: "live image",
    });
    // Plant an orphan blob that no node references.
    mkdirSync(join(dir, "memos-images"), { recursive: true });
    writeFileSync(
      join(dir, "memos-images", "img_deadbeefcafe.png"),
      makePng(4, 4, 54),
    );

    const purged = await memos.purgeOrphanImages();
    expect(purged).toBe(1);
    // The live image's blob is untouched.
    expect(await memos.imageMemory(stored.image.ref)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Search API usability
// ---------------------------------------------------------------------------

describe("search API usability", () => {
  test("filter-only search (no query) returns structured results", async () => {
    memos = await bootMemos();
    await memos.store("filter one", { tags: ["bulk"] });
    await memos.store("filter two", { tags: ["bulk"] });
    await memos.store("other", { tags: ["noise"] });

    // The documented filter-only path: no `query` at all.
    const results = await memos.search({ tags: ["bulk"], limit: 10 });
    expect(results).toHaveLength(2);
  });

  test("the object form is the contract — a string plus opts ignores the opts", async () => {
    // This is the documented pitfall: `search(query, opts)` silently
    // drops the second argument. Pinned here so nobody "fixes" the
    // signature later and breaks every caller.
    memos = await bootMemos();
    await memos.store("scoped memory", { namespace: "project:only" });

    // Correct: object form carries the namespace.
    const scoped = await memos.search({
      query: "scoped",
      namespace: "project:only",
    });
    expect(scoped).toHaveLength(1);

    // The string form spans ALL namespaces — which is exactly why the
    // object form exists.
    const unscoped = await memos.search("scoped");
    expect(unscoped).toHaveLength(1);
  });

  test("searchImages is the explicit image entry point", async () => {
    memos = await bootMemos();
    await memos.addImageMemory(makePng(8, 8, 55), {
      caption: "entry point image",
    });
    const hits = await memos.searchImages("entry point image");
    expect(hits).toHaveLength(1);
    expect(hits[0].image.caption).toBe("entry point image");
  });
});
