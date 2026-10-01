/**
 * Tests for the local cross-encoder reranker (`src/rerank-local.ts`) and its
 * wiring into `MemOS.applyRerank`:
 *   - `scorePairsLocal` squashes raw logits through a sigmoid, in order
 *   - loader failure / null model degrades to `null` (caller keeps fusion)
 *   - `applyRerank` with `provider: "local"` reorders by local scores and
 *     tags `scores.rerank`
 *   - a broken local loader degrades gracefully to the fused order
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";
import {
  __setLocalRerankLoaderForTests,
  scorePairsLocal,
  type LocalRerankLoader,
  type LocalRerankModel,
} from "../src/rerank-local";

/** Embeds [1,0] when the text contains the marker word, else [0,1]. */
class MarkerProvider implements EmbeddingProvider {
  public readonly id = "marker";
  public readonly model: string;
  public readonly dimensions = 2;
  private readonly marker: string;

  constructor(model = "marker-v1", marker = "zebra") {
    this.model = model;
    this.marker = marker;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return text.includes(this.marker) ? [1, 0] : [0, 1];
  }
}

/** Stub loader: returns fixed raw logits per pair, in order. */
function stubLoader(logits: number[]): LocalRerankLoader {
  return async (): Promise<LocalRerankModel> => ({
    async scorePairs(pairs: Array<[string, string]>): Promise<number[]> {
      if (pairs.length !== logits.length) {
        throw new Error(
          `stub expected ${logits.length} pairs, got ${pairs.length}`,
        );
      }
      return [...logits];
    },
  });
}

afterEach(() => {
  __setLocalRerankLoaderForTests(null);
  delete process.env.MEMOS_RERANK_LOCAL;
});

describe("scorePairsLocal", () => {
  test("squashes raw logits with a sigmoid, preserving input order", async () => {
    __setLocalRerankLoaderForTests(stubLoader([5, 0, -5]));
    const scores = await scorePairsLocal("q", ["a", "b", "c"]);
    expect(scores).toHaveLength(3);
    expect(scores![0]).toBeCloseTo(1 / (1 + Math.exp(-5)), 10);
    expect(scores![1]).toBeCloseTo(0.5, 10);
    expect(scores![2]).toBeCloseTo(1 / (1 + Math.exp(5)), 10);
  });

  test("returns [] for no documents without touching the loader", async () => {
    let called = false;
    __setLocalRerankLoaderForTests(async () => {
      called = true;
      return {
        async scorePairs() {
          return [];
        },
      };
    });
    expect(await scorePairsLocal("q", [])).toEqual([]);
    expect(called).toBe(false);
  });

  test("loader returning null degrades to null", async () => {
    __setLocalRerankLoaderForTests(async () => null);
    expect(await scorePairsLocal("q", ["a"])).toBeNull();
  });

  test("loader throwing degrades to null", async () => {
    __setLocalRerankLoaderForTests(async () => {
      throw new Error("download failed");
    });
    expect(await scorePairsLocal("q", ["a"])).toBeNull();
  });

  test("inference throwing degrades to null", async () => {
    __setLocalRerankLoaderForTests(async () => ({
      async scorePairs() {
        throw new Error("onnx runtime blew up");
      },
    }));
    expect(await scorePairsLocal("q", ["a"])).toBeNull();
  });

  test("logit count mismatch degrades to null", async () => {
    __setLocalRerankLoaderForTests(stubLoader([1, 2, 3]));
    // 2 docs but the stub insists on 3 pairs -> throws -> null.
    expect(await scorePairsLocal("q", ["a", "b"])).toBeNull();
  });
});

describe("applyRerank with the local provider", () => {
  function makeLocalRerankMemos(): MemOS {
    const storage = new SQLiteStorage(":memory:", true);
    return new MemOS({
      storage,
      experimental: {
        semanticSearch: true,
        rerank: { provider: "local", localModel: "stub-model", candidates: 10 },
      },
      embeddings: { enabled: true, provider: new MarkerProvider() },
    });
  }

  test("reorders by local cross-encoder score and tags scores.rerank", async () => {
    // The stub insists the LAST candidate is the best one.
    __setLocalRerankLoaderForTests(async (): Promise<LocalRerankModel> => ({
      async scorePairs(pairs: Array<[string, string]>): Promise<number[]> {
        return pairs.map((_, index) =>
          index === pairs.length - 1 ? 5 : 0.5 - index,
        );
      },
    }));

    const memos = makeLocalRerankMemos();
    await memos.init();
    await memos.store("zebra sighting at the zoo");
    await memos.store("zebra habitat savanna");
    await memos.store("zebra feeding schedule here");

    const results = await memos.search("zebra", { limit: 3 });
    const rerankScores = results.map((r) => r.scores?.rerank);
    expect(rerankScores).toHaveLength(3);
    for (const score of rerankScores) expect(score).toBeDefined();
    expect(
      [...rerankScores].every(
        (v, i) => i === 0 || (v as number) <= (rerankScores[i - 1] as number),
      ),
    ).toBe(true);
    expect(results[0].scores?.rerank).toBeCloseTo(1 / (1 + Math.exp(-5)), 5);
    await memos.close();
  });

  test("broken local loader degrades gracefully to fused order", async () => {
    __setLocalRerankLoaderForTests(async () => {
      throw new Error("no transformers package");
    });

    const memos = makeLocalRerankMemos();
    await memos.init();
    await memos.store("zebra sighting at the zoo");
    const results = await memos.search("zebra", { limit: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].scores?.rerank).toBeUndefined();
    await memos.close();
  });

  test("MEMOS_RERANK_LOCAL=1 enables the local path without config", async () => {
    process.env.MEMOS_RERANK_LOCAL = "1";
    __setLocalRerankLoaderForTests(stubLoader([5, 0]));

    const storage = new SQLiteStorage(":memory:", true);
    const memos = new MemOS({
      storage,
      experimental: { semanticSearch: true },
      embeddings: { enabled: true, provider: new MarkerProvider() },
    });
    await memos.init();
    await memos.store("zebra one");
    await memos.store("zebra two");
    const results = await memos.search("zebra", { limit: 2 });
    expect(results).toHaveLength(2);
    // First fused candidate got logit 5 -> sigmoid(5); both tagged.
    expect(results[0].scores?.rerank).toBeCloseTo(1 / (1 + Math.exp(-5)), 5);
    expect(results[1].scores?.rerank).toBeDefined();
    await memos.close();
  });

  test("respects the candidates cap", async () => {
    let seenPairs = 0;
    __setLocalRerankLoaderForTests(async () => ({
      async scorePairs(pairs: Array<[string, string]>): Promise<number[]> {
        seenPairs = pairs.length;
        return pairs.map((_, index) => -index);
      },
    }));

    const storage = new SQLiteStorage(":memory:", true);
    const memos = new MemOS({
      storage,
      experimental: {
        semanticSearch: true,
        rerank: { provider: "local", localModel: "stub", candidates: 3 },
      },
      embeddings: { enabled: true, provider: new MarkerProvider() },
    });
    await memos.init();
    for (let i = 0; i < 8; i += 1) await memos.store(`zebra fact number ${i}`);
    await memos.search("zebra", { limit: 5 });
    expect(seenPairs).toBe(3);
    await memos.close();
  });
});
