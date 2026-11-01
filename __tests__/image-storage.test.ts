/**
 * Storage-layer tests for image memory (Track B foundation).
 *
 * Covers the second vector space (`image_embeddings`), the shared
 * `scanSimilar` scan, and — most importantly — the vectorCache namespace
 * guarantee: an image node carries BOTH a text and a CLIP embedding
 * under the same nodeId, and a query in one space must never see the
 * other space's vector. That bug is invisible when it happens (no
 * error, just unexplainable scores), so it is pinned here explicitly.
 *
 * Uses real SQLite in a temp dir (repo convention) and the fake CLIP
 * provider — no network, no model downloads.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStorage } from "../src/storage/sqlite";
import { FakeClipProvider } from "../src/vision/fake-clip";
import type { EmbeddingVector, MemoryNode, ScoredMemory } from "../src/types";

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const TEXT_MODEL = "BAAI/bge-small-en-v1.5";

let dir: string;
let storage: SQLiteStorage;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "memos-image-storage-"));
  storage = new SQLiteStorage(join(dir, "test.db"), true);
  await storage.init();
});

afterEach(async () => {
  await storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeNode(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessed: 0,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

async function seedNode(id: string, content: string): Promise<MemoryNode> {
  const node = makeNode(id, content);
  await storage.saveNode(node);
  return node;
}

describe("image_embeddings table", () => {
  test("is created empty on a fresh store — existing text queries unaffected", async () => {
    const counts = await storage.getImageEmbeddingModelCounts();
    expect(counts).toEqual([]);
    // The text side still works and is still empty.
    expect(await storage.getEmbeddingModelCounts()).toEqual([]);
  });

  test("saveImageEmbedding persists and round-trips via getAllImageEmbeddings", async () => {
    const node = await seedNode("img-node-1", "a photo of a cat");
    const clip = new FakeClipProvider();
    const vector = await clip.embedImage(Buffer.from([1, 2, 3, 4]));

    await storage.saveImageEmbedding(node.id, vector, CLIP_MODEL);

    const all = await storage.getAllImageEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0].nodeId).toBe(node.id);
    expect(all[0].model).toBe(CLIP_MODEL);
    expect(all[0].vector).toHaveLength(512);
    // Values survive the float32 serialization closely enough for cosine.
    for (let i = 0; i < vector.length; i += 1) {
      expect(all[0].vector[i]).toBeCloseTo(vector[i], 5);
    }
  });

  test("upsert overwrites the previous vector for the same node", async () => {
    const node = await seedNode("img-node-upsert", "photo");
    const clip = new FakeClipProvider();
    const first = await clip.embedImage(Buffer.from([9, 9, 9]));
    const second = await clip.embedImage(Buffer.from([7, 7, 7]));

    await storage.saveImageEmbedding(node.id, first, CLIP_MODEL);
    await storage.saveImageEmbedding(node.id, second, CLIP_MODEL);

    const all = await storage.getAllImageEmbeddings();
    expect(all).toHaveLength(1);
    expect(all[0].vector[0]).toBeCloseTo(second[0], 5);
  });

  test("image rows cascade-delete with the node (ON DELETE CASCADE)", async () => {
    const node = await seedNode("img-node-cascade", "photo");
    const clip = new FakeClipProvider();
    await storage.saveImageEmbedding(
      node.id,
      await clip.embedImage(Buffer.from([5, 5])),
      CLIP_MODEL,
    );

    await storage.deleteNode(node.id);

    expect(await storage.getAllImageEmbeddings()).toEqual([]);
    // A query after the delete must not resurrect it from cache.
    const results = await storage.querySimilarImages(
      await clip.embedImage(Buffer.from([5, 5])),
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(results).toEqual([]);
  });

  test("deleteImageEmbedding removes the row and reports it", async () => {
    const node = await seedNode("img-node-del", "photo");
    const clip = new FakeClipProvider();
    await storage.saveImageEmbedding(
      node.id,
      await clip.embedImage(Buffer.from([3, 1])),
      CLIP_MODEL,
    );

    expect(await storage.deleteImageEmbedding(node.id)).toBe(true);
    expect(await storage.deleteImageEmbedding(node.id)).toBe(false);
    expect(await storage.getAllImageEmbeddings()).toEqual([]);
  });

  test("getImageEmbeddingModelCounts groups by model", async () => {
    const a = await seedNode("n-a", "a");
    const b = await seedNode("n-b", "b");
    const clip = new FakeClipProvider();
    await storage.saveImageEmbedding(
      a.id,
      await clip.embedImage(Buffer.from([1])),
      CLIP_MODEL,
    );
    await storage.saveImageEmbedding(
      b.id,
      await clip.embedImage(Buffer.from([2])),
      CLIP_MODEL,
    );

    const counts = await storage.getImageEmbeddingModelCounts();
    expect(counts).toEqual([{ model: CLIP_MODEL, count: 2 }]);
  });
});

describe("querySimilarImages", () => {
  test("returns [] on a store with zero image rows and never touches the text table", async () => {
    // Plant a decoy TEXT embedding that must never appear in image results.
    const textNode = await seedNode("text-decoy", "plain text memory");
    await storage.saveEmbedding(textNode.id, [0.1, 0.2, 0.3, 0.4], TEXT_MODEL);

    const clip = new FakeClipProvider();
    const results = await storage.querySimilarImages(
      await clip.embedImage(Buffer.from([1, 2, 3])),
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(results).toEqual([]);
  });

  test("finds the nearest image by CLIP vector", async () => {
    const clip = new FakeClipProvider();
    const target = await seedNode("img-target", "photo of target");
    const other = await seedNode("img-other", "photo of other");
    await storage.saveImageEmbedding(
      target.id,
      await clip.embedImage(Buffer.from([42, 42, 42])),
      CLIP_MODEL,
    );
    await storage.saveImageEmbedding(
      other.id,
      await clip.embedImage(Buffer.from([1, 2, 3])),
      CLIP_MODEL,
    );

    const results = await storage.querySimilarImages(
      await clip.embedImage(Buffer.from([42, 42, 42])),
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].node.id).toBe(target.id);
    expect(results[0].score).toBeCloseTo(1, 4);
  });

  test("filters by model — a wrong-model CLIP query scores nothing", async () => {
    const clip = new FakeClipProvider();
    const node = await seedNode("img-model-filter", "photo");
    await storage.saveImageEmbedding(
      node.id,
      await clip.embedImage(Buffer.from([8, 8])),
      CLIP_MODEL,
    );

    const results = await storage.querySimilarImages(
      await clip.embedImage(Buffer.from([8, 8])),
      {},
      10,
      0,
      "some-other-clip-model",
    );
    expect(results).toEqual([]);
  });

  test("filters by dimensions — a 384-d text query is never scored against 512-d CLIP rows", async () => {
    // This is the space-collision guard: dimension equality alone is not
    // enough, but a dimension MISMATCH must never be scored either.
    const clip = new FakeClipProvider();
    const node = await seedNode("img-dim-guard", "photo");
    await storage.saveImageEmbedding(
      node.id,
      await clip.embedImage(Buffer.from([2, 2])),
      CLIP_MODEL,
    );

    const textQuery: EmbeddingVector = new Array(384).fill(0.01);
    const results = await storage.querySimilarImages(
      textQuery,
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(results).toEqual([]);
  });

  test("respects threshold", async () => {
    const clip = new FakeClipProvider();
    const node = await seedNode("img-threshold", "photo");
    await storage.saveImageEmbedding(
      node.id,
      await clip.embedImage(Buffer.from([6, 6])),
      CLIP_MODEL,
    );

    const query = await clip.embedImage(Buffer.from([9, 9]));
    const strict = await storage.querySimilarImages(
      query,
      {},
      10,
      0.99,
      CLIP_MODEL,
    );
    // The fake hash of [6,6] vs [9,9] is unrelated — below 0.99 cosine.
    expect(strict).toEqual([]);
    const loose = await storage.querySimilarImages(
      query,
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(loose.length).toBeGreaterThanOrEqual(0);
  });
});

describe("vectorCache namespace isolation (the design's #1 trap)", () => {
  test("a node with BOTH text and CLIP embeddings answers each query with its own space", async () => {
    const clip = new FakeClipProvider();
    const node = await seedNode("dual-node", "an image memory with a caption");

    // Text embedding (384-d, text model) — distinct, unrelated values.
    const textVector: EmbeddingVector = new Array(384)
      .fill(0)
      .map((_, i) => Math.sin(i) * 0.05);
    await storage.saveEmbedding(node.id, textVector, TEXT_MODEL);

    // CLIP embedding (512-d, clip model) — same nodeId, different space.
    const clipVector = await clip.embedImage(Buffer.from([11, 22, 33]));
    await storage.saveImageEmbedding(node.id, clipVector, CLIP_MODEL);

    // --- Image query: must return the CLIP score, not the text score ---
    const imageResults = await storage.querySimilarImages(
      await clip.embedImage(Buffer.from([11, 22, 33])),
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(imageResults).toHaveLength(1);
    expect(imageResults[0].node.id).toBe(node.id);
    expect(imageResults[0].score).toBeCloseTo(1, 4);

    // --- Text query: must return the text score, not the CLIP score ---
    const textResults = await storage.querySimilarEmbeddings(
      textVector,
      {},
      10,
      0,
      TEXT_MODEL,
    );
    expect(textResults).toHaveLength(1);
    expect(textResults[0].node.id).toBe(node.id);
    expect(textResults[0].score).toBeCloseTo(1, 4);
  });

  test("a stale text-cache entry is never served to an image query", async () => {
    // Write the TEXT embedding FIRST so the nodeId is cached in the text
    // space; then write the CLIP embedding. Without the namespace tag,
    // the second write would overwrite the first and one of the two
    // queries would silently see the other space's vector.
    const clip = new FakeClipProvider();
    const node = await seedNode("dual-order", "caption text");

    const textVector: EmbeddingVector = new Array(384).fill(0.02);
    await storage.saveEmbedding(node.id, textVector, TEXT_MODEL);
    const clipVector = await clip.embedImage(Buffer.from([4, 5, 6]));
    await storage.saveImageEmbedding(node.id, clipVector, CLIP_MODEL);

    const imageResults = await storage.querySimilarImages(
      await clip.embedImage(Buffer.from([4, 5, 6])),
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(imageResults).toHaveLength(1);
    expect(imageResults[0].score).toBeCloseTo(1, 4);

    const textResults = await storage.querySimilarEmbeddings(
      textVector,
      {},
      10,
      0,
      TEXT_MODEL,
    );
    expect(textResults).toHaveLength(1);
    expect(textResults[0].score).toBeCloseTo(1, 4);
  });

  test("getEmbeddingVectors (text-side bulk read) never returns a CLIP vector", async () => {
    const clip = new FakeClipProvider();
    const node = await seedNode("dual-bulk", "caption");
    const clipVector = await clip.embedImage(Buffer.from([7, 7, 7]));
    await storage.saveImageEmbedding(node.id, clipVector, CLIP_MODEL);

    // Only a CLIP row exists for this node — the text bulk read must not
    // surface it (that would hand a 512-d CLIP vector to the text
    // contradiction scan, which expects the text space).
    const vectors = await storage.getEmbeddingVectors([node.id]);
    expect(vectors.has(node.id)).toBe(false);
  });
});

describe("deleteAllNodes clears both vector spaces", () => {
  test("text and image embeddings are both gone", async () => {
    const clip = new FakeClipProvider();
    const node = await seedNode("all-node", "caption");
    await storage.saveEmbedding(node.id, new Array(384).fill(0.1), TEXT_MODEL);
    await storage.saveImageEmbedding(
      node.id,
      await clip.embedImage(Buffer.from([1, 1])),
      CLIP_MODEL,
    );

    await storage.deleteAllNodes();

    expect(await storage.getAllImageEmbeddings()).toEqual([]);
    expect(await storage.getAllEmbeddings()).toEqual([]);
  });
});

describe("existing text behavior is unchanged by the new table", () => {
  test("querySimilarEmbeddings still ranks text memories correctly", async () => {
    const a = await seedNode("t-a", "the quick brown fox");
    const b = await seedNode("t-b", "jumps over the lazy dog");
    const va: EmbeddingVector = [1, 0, 0, 0];
    const vb: EmbeddingVector = [0, 1, 0, 0];
    await storage.saveEmbedding(a.id, va, TEXT_MODEL);
    await storage.saveEmbedding(b.id, vb, TEXT_MODEL);

    const results: ScoredMemory[] = await storage.querySimilarEmbeddings(
      [1, 0, 0, 0],
      {},
      10,
      0,
      TEXT_MODEL,
    );
    expect(results[0].node.id).toBe(a.id);
    expect(results[0].score).toBeCloseTo(1, 4);
  });

  test("image rows do not leak into text queries", async () => {
    const clip = new FakeClipProvider();
    const imgNode = await seedNode("img-only", "photo with no text embedding");
    await storage.saveImageEmbedding(
      imgNode.id,
      await clip.embedImage(Buffer.from([5, 5, 5])),
      CLIP_MODEL,
    );

    // A text query that would match the image row if the spaces shared
    // a table must return nothing.
    const results = await storage.querySimilarEmbeddings(
      await clip.embedImage(Buffer.from([5, 5, 5])),
      {},
      10,
      0,
      CLIP_MODEL,
    );
    expect(results).toEqual([]);
  });
});
