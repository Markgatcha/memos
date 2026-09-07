/**
 * Tests for the search/retrieval upgrades:
 *   - full-filter search-cache key (no cross-filter cache pollution)
 *   - `config.fusion` threading into the hybrid fusion
 *   - `ftsOperator: "OR"` forced-recall keyword leg
 *   - `filter.sessionExpansion` session-sibling injection
 *   - `experimental.graphExpansion` neighbour injection
 *   - `reindexEmbeddings` (model switch + purgeStale)
 *   - `embeddings.embedText` content-only embedding
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

/** Embeds [1,0] when the text contains the marker word, else [0,1]. */
class MarkerProvider implements EmbeddingProvider {
  public readonly id = "marker";
  public readonly model: string;
  public readonly dimensions = 2;
  public readonly calls: string[] = [];
  public delayMs = 0;
  private readonly marker: string;

  constructor(model = "marker-v1", marker = "zebra") {
    this.model = model;
    this.marker = marker;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls.push(text);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return text.includes(this.marker) ? [1, 0] : [0, 1];
  }
}

function makeMemos(
  provider: EmbeddingProvider | null,
  extra: Record<string, unknown> = {},
): MemOS {
  const storage = new SQLiteStorage(":memory:", true);
  return new MemOS({
    storage,
    ...(provider
      ? {
          experimental: { semanticSearch: true, namespaces: true },
          embeddings: { enabled: true, provider },
        }
      : {}),
    ...extra,
  });
}

describe("search cache key covers the full filter", () => {
  test("same query with different type filters does not collide", async () => {
    const memos = makeMemos(null);
    await memos.init();
    await memos.store("Dark mode preference", { type: "preference" });
    await memos.store("Dark mode fix shipped", { type: "fact" });

    const prefs = await memos.search({
      query: "dark mode",
      type: "preference",
    });
    const facts = await memos.search({ query: "dark mode", type: "fact" });

    expect(prefs).toHaveLength(1);
    expect(facts).toHaveLength(1);
    expect(prefs[0].node.type).toBe("preference");
    expect(facts[0].node.type).toBe("fact");
    await memos.close();
  });

  test("same query with different offset does not return page one", async () => {
    const memos = makeMemos(null);
    await memos.init();
    await memos.store("note one alpha");
    await memos.store("note two alpha");

    const pageOne = await memos.search({ query: "alpha", limit: 1, offset: 0 });
    const pageTwo = await memos.search({ query: "alpha", limit: 1, offset: 1 });

    expect(pageTwo).toHaveLength(1);
    expect(pageTwo[0].node.id).not.toBe(pageOne[0].node.id);
    await memos.close();
  });
});

describe("fusion config threading", () => {
  test("semanticWeight 1 / keywordWeight 0 lets a paraphrase outrank the keyword match", async () => {
    // Query terms match node K exactly. Node S shares no FTS-searchable
    // vocabulary (its only overlap is the stopword "the", which
    // buildFtsTerms strips) but carries the marker word for the semantic
    // leg — the pure paraphrase-rescue case.
    const seed = async (memos: MemOS): Promise<void> => {
      await memos.store("zebra habitat plains");
      await memos.store("striped horse of the savanna");
    };
    const provider = () => new MarkerProvider("marker-v1", "the");

    const defaults = makeMemos(provider());
    await defaults.init();
    await seed(defaults);
    const defaultOrder = await defaults.search("zebra habitat the", {
      limit: 2,
    });
    await defaults.close();

    const semanticFirst = makeMemos(provider(), {
      fusion: { keywordWeight: 0, semanticWeight: 1 },
    });
    await semanticFirst.init();
    await seed(semanticFirst);
    const semanticOrder = await semanticFirst.search("zebra habitat the", {
      limit: 2,
    });
    await semanticFirst.close();

    // Default (keyword-heavy): the exact match leads.
    expect(defaultOrder[0].node.content).toBe("zebra habitat plains");
    // Semantic-only fusion: the paraphrase leads.
    expect(semanticOrder[0].node.content).toBe("striped horse of the savanna");
  });
});

describe("ftsOperator", () => {
  async function seed(): Promise<MemOS> {
    const memos = makeMemos(null);
    await memos.init();
    await memos.store("zebra plains roaming");
    await memos.store("zebra habitat savanna");
    return memos;
  }

  test("AUTO keeps the precise AND result set", async () => {
    const memos = await seed();
    const results = await memos.search({ query: "zebra habitat", limit: 5 });
    expect(results.map((r) => r.node.content)).toEqual([
      "zebra habitat savanna",
    ]);
    await memos.close();
  });

  test("OR surfaces partial-term matches the AND hides", async () => {
    const memos = await seed();
    const results = await memos.search({
      query: "zebra habitat",
      limit: 5,
      ftsOperator: "OR",
    });
    const contents = results.map((r) => r.node.content);
    expect(contents).toContain("zebra habitat savanna");
    expect(contents).toContain("zebra plains roaming");
    await memos.close();
  });
});

describe("sessionExpansion", () => {
  async function seed(): Promise<MemOS> {
    const memos = makeMemos(new MarkerProvider());
    await memos.init();
    await memos.store("zebra sighting at the zoo", {
      metadata: { sessionId: "s-1" },
    });
    await memos.store("lunch was sandwiches", {
      metadata: { sessionId: "s-1" },
    });
    await memos.store("totally unrelated stock prices");
    return memos;
  }

  test("off by default: no result carries a session score", async () => {
    const memos = await seed();
    const results = await memos.search({ query: "zebra sighting", limit: 5 });
    expect(results[0].node.content).toBe("zebra sighting at the zoo");
    for (const r of results) {
      expect(r.scores?.session).toBeUndefined();
    }
    await memos.close();
  });

  test("on: the seed's session siblings are injected above organic tails", async () => {
    const memos = await seed();
    const results = await memos.search({
      query: "zebra sighting",
      limit: 5,
      sessionExpansion: true,
    });
    const lunch = results.find(
      (r) => r.node.content === "lunch was sandwiches",
    );
    expect(lunch).toBeDefined();
    expect(lunch?.scores?.session).toBeGreaterThan(0);
    // The injected sibling outranks everything that was not retrieved
    // organically (organic tail nodes carry no session score).
    const afterLunch = results.slice(results.indexOf(lunch) + 1);
    for (const r of afterLunch) {
      expect(r.scores?.session).toBeUndefined();
    }
    await memos.close();
  });
});

describe("graphExpansion", () => {
  async function seed(enabled: boolean): Promise<MemOS> {
    const memos = makeMemos(new MarkerProvider(), {
      experimental: {
        semanticSearch: true,
        namespaces: true,
        graphExpansion: { enabled },
      },
    });
    await memos.init();
    const seedNode = await memos.store("zebra sighting at the zoo");
    const linked = await memos.store("zoo map and opening hours");
    await memos.store("totally unrelated stock prices");
    await memos.link(seedNode.node.id, linked.node.id);
    return memos;
  }

  test("off by default: no result carries a graph score", async () => {
    const memos = await seed(false);
    const results = await memos.search({ query: "zebra sighting", limit: 5 });
    expect(results[0].node.content).toBe("zebra sighting at the zoo");
    for (const r of results) {
      expect(r.scores?.graph).toBeUndefined();
    }
    await memos.close();
  });

  test("on: neighbours of a top seed are injected above organic tails", async () => {
    const memos = await seed(true);
    const results = await memos.search({ query: "zebra sighting", limit: 5 });
    const linked = results.find(
      (r) => r.node.content === "zoo map and opening hours",
    );
    expect(linked).toBeDefined();
    expect(linked?.scores?.graph).toBeGreaterThan(0);
    await memos.close();
  });
});

describe("reindexEmbeddings", () => {
  test("model switch isolates the semantic leg until vectors are rebuilt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-reindex-"));
    const dbPath = join(dir, "test.db");
    try {
      const first = new MemOS({
        dbPath,
        experimental: { semanticSearch: true },
        embeddings: {
          enabled: true,
          provider: new MarkerProvider("marker-v1"),
        },
      });
      await first.init();
      await first.store("zebra facts one");
      await first.store("zebra facts two");
      await first.close();

      // Re-open with a DIFFERENT model (same dimensions): the startup
      // backfill rebuilds every vector under marker-v2.
      const second = new MemOS({
        dbPath,
        experimental: { semanticSearch: true },
        embeddings: {
          enabled: true,
          provider: new MarkerProvider("marker-v2"),
        },
      });
      await second.init();
      await second.flushEmbeddings();

      // Simulate an interrupted backfill: one row left tagged with the
      // old model. The model-aware semantic leg must refuse to compare
      // the query against it — dimension equality alone is not safety.
      const storage = (second as unknown as { storage: SQLiteStorage }).storage;
      const fresh = await second.semanticSearch("zebra facts one");
      expect(fresh).toHaveLength(2);
      const db = (
        storage as unknown as {
          db: {
            prepare: (sql: string) => { run: (...p: unknown[]) => unknown };
          };
        }
      ).db;
      db.prepare(
        `UPDATE embeddings SET model = 'marker-v1'
         WHERE node_id = (SELECT id FROM nodes WHERE content = 'zebra facts one')`,
      ).run();
      expect(await second.semanticSearch("zebra")).toHaveLength(1);

      // reindexEmbeddings rebuilds everything under the current model and
      // purges the stale-tagged row.
      const summary = await second.reindexEmbeddings({ purgeStale: true });
      expect(summary.model).toBe("marker-v2");
      expect(summary.reembedded).toBe(2);
      expect(summary.purged).toBe(1);
      expect(summary.failed).toBe(0);
      expect(await storage.getEmbeddingModelCounts!()).toEqual([
        { model: "marker-v2", count: 2 },
      ]);
      expect(await second.semanticSearch("zebra")).toHaveLength(2);
      await second.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can hold the WAL file briefly after close — cleanup is
        // best-effort and not worth failing the test over.
      }
    }
  });

  test("reindexEmbeddings re-embeds under the configured embedText", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-reindex2-"));
    const dbPath = join(dir, "test.db");
    try {
      const first = new MemOS({
        dbPath,
        experimental: { semanticSearch: true },
        embeddings: {
          enabled: true,
          provider: new MarkerProvider("marker-v1"),
        },
      });
      await first.init();
      await first.store("zebra facts one");
      await first.store("zebra facts two");
      await first.close();

      // Same model + dimensions, so the startup backfill considers every
      // embedding fresh — but the node was stored with embedText content
      // now, so reindex is the explicit way to rebuild the vectors.
      const provider = new MarkerProvider("marker-v1");
      const second = new MemOS({
        dbPath,
        experimental: { semanticSearch: true },
        embeddings: { enabled: true, provider, embedText: "content" },
      });
      await second.init();
      await second.flushEmbeddings();

      const summary = await second.reindexEmbeddings({ purgeStale: true });
      expect(summary.model).toBe("marker-v1");
      expect(summary.reembedded).toBe(2);
      expect(summary.purged).toBe(0);
      expect(summary.failed).toBe(0);
      // Re-embedded with the NEW text selection: raw content, no summary.
      // (Row order out of queryNodes is not guaranteed — compare as sets.)
      expect(provider.calls.slice(-2).sort()).toEqual([
        "zebra facts one",
        "zebra facts two",
      ]);

      const after = await second.semanticSearch("zebra");
      expect(after).toHaveLength(2);
      await second.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup (Windows WAL file locking).
      }
    }
  });
});

describe("embedText: content-only embedding", () => {
  test("content mode embeds exactly the node content", async () => {
    const provider = new MarkerProvider();
    const memos = makeMemos(provider, {
      embeddings: { enabled: true, provider, embedText: "content" },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();
    await memos.store("a zebra fact worth keeping");
    expect(provider.calls[provider.calls.length - 1]).toBe(
      "a zebra fact worth keeping",
    );
    await memos.close();
  });

  test("default keeps the summary+content blend", async () => {
    const provider = new MarkerProvider();
    const memos = makeMemos(provider, {
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();
    await memos.store("a zebra fact worth keeping");
    const embedded = provider.calls[provider.calls.length - 1];
    expect(embedded).not.toBe("a zebra fact worth keeping");
    expect(embedded).toContain("a zebra fact worth keeping");
    await memos.close();
  });
});

// ─── two-stage reranking ─────────────────────────────────────────────────────

describe("experimental.rerank", () => {
  function makeRerankableMemos(
    rerankResponse: unknown,
    fetchImpl?: typeof fetch,
  ): MemOS {
    const storage = new SQLiteStorage(":memory:", true);
    return new MemOS({
      storage,
      experimental: {
        semanticSearch: true,
        namespaces: true,
        rerank: {
          endpoint: "http://127.0.0.1:8081",
          model: "test-reranker",
          candidates: 10,
        },
      },
      embeddings: { enabled: true, provider: new MarkerProvider() },
    });
  }

  afterEach(() => {
    (global.fetch as unknown as jest.Mock | undefined)?.mockRestore?.();
    jest.restoreAllMocks();
  });

  test("reorders fused results by cross-encoder score and tags scores.rerank", async () => {
    // The marker embedder ranks "zebra" content first; the fake reranker
    // insists the third candidate is the best one.
    const fetchMock = jest.fn(async (_url: unknown, init: unknown) => ({
      ok: true,
      json: async () => ({
        results: [
          { index: 2, relevance_score: 5 },
          { index: 0, relevance_score: 0.5 },
          { index: 1, relevance_score: -3 },
        ],
      }),
    }));
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as never);

    const memos = makeRerankableMemos(null);
    await memos.init();
    await memos.store("zebra sighting at the zoo");
    await memos.store("zebra habitat savanna");
    await memos.store("zebra feeding schedule here");

    const results = await memos.search("zebra", { limit: 3 });
    // The reranked head is ordered by the squashed cross-encoder score,
    // regardless of the fused pre-order (which depends on bm25 internals).
    const rerankScores = results.map((r) => r.scores?.rerank);
    expect(rerankScores).toHaveLength(3);
    for (const score of rerankScores) {
      expect(score).toBeDefined();
    }
    expect(
      [...rerankScores].every((v, i) => i === 0 || v <= rerankScores[i - 1]),
    ).toBe(true);
    expect(results[0].scores?.rerank).toBeCloseTo(1 / (1 + Math.exp(-5)), 5);
    await memos.close();
  });

  test("downed rerank endpoint degrades gracefully to fused order", async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error("connection refused");
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as never);

    const memos = makeRerankableMemos(null);
    await memos.init();
    await memos.store("zebra sighting at the zoo");
    const results = await memos.search("zebra", { limit: 3 });
    expect(results).toHaveLength(1);
    expect(results[0].scores?.rerank).toBeUndefined();
    await memos.close();
  });

  test("submits at most `candidates` documents", async () => {
    const fetchMock = jest.fn(async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { documents: string[] };
      return {
        ok: true,
        json: async () => ({
          results: body.documents.map((_, index) => ({
            index,
            relevance_score: -index,
          })),
        }),
      };
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as never);

    const storage = new SQLiteStorage(":memory:", true);
    const memos = new MemOS({
      storage,
      experimental: {
        semanticSearch: true,
        rerank: { endpoint: "http://127.0.0.1:8081", candidates: 3 },
      },
      embeddings: { enabled: true, provider: new MarkerProvider() },
    });
    await memos.init();
    for (let i = 0; i < 8; i += 1) await memos.store(`zebra fact number ${i}`);
    await memos.search("zebra", { limit: 5 });

    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    ) as { documents: string[] };
    expect(body.documents).toHaveLength(3);
    await memos.close();
  });
});
