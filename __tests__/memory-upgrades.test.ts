/**
 * Tests for the 2026-09 memory upgrades:
 *   - multi-granularity pools (`event` / `note` / `procedure`)
 *   - entity-fused scoring (third retrieval signal)
 *   - write-time contextual enrichment (contextual retrieval)
 *   - decay-based algorithmic forgetting (`forgetByDecay`, wired into
 *     `consolidate`)
 *   - multi-stream context packs
 *
 * Companion coverage for the existing consolidation stages lives in
 * `consolidation.test.ts`; entity extraction is pure-function tested here.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { extractQueryEntities, entityOverlap } from "../src/entity-extraction";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class VectorProvider implements EmbeddingProvider {
  public readonly id = "vector";
  public readonly model = "vector-v1";
  public readonly dimensions = 4;
  public readonly vectors = new Map<string, EmbeddingVector>();

  constructor(seed: Record<string, EmbeddingVector> = {}) {
    for (const [k, v] of Object.entries(seed)) this.vectors.set(k, v);
  }

  async embed(text: string): Promise<EmbeddingVector> {
    if (this.vectors.has(text)) return this.vectors.get(text)!;
    for (const [key, vec] of this.vectors) {
      if (text.includes(key)) return vec;
    }
    return [0, 0, 0, 0];
  }
}

async function makeMemos(
  provider: EmbeddingProvider,
  extra: Record<string, unknown> = {},
) {
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { synchronous: true },
    ...extra,
  });
  await memos.init();
  return memos;
}

const ORTHO = {
  a: [1, 0, 0, 0] as EmbeddingVector,
  b: [0, 1, 0, 0] as EmbeddingVector,
  c: [0, 0, 1, 0] as EmbeddingVector,
  d: [0, 0, 0, 1] as EmbeddingVector,
};

// ---------------------------------------------------------------------------
// Entity extraction (pure functions)
// ---------------------------------------------------------------------------

describe("extractQueryEntities()", () => {
  test("captures mid-sentence proper-noun phrases", () => {
    const entities = extractQueryEntities("How do we scale the Acme Pipeline?");
    expect(entities).toContain("acme pipeline");
  });

  test("captures code identifiers and acronyms anywhere", () => {
    const entities = extractQueryEntities(
      "the deploy_pipeline job failed on CI again",
    );
    expect(entities).toContain("deploy_pipeline");
    expect(entities).toContain("ci");
  });

  test("ignores sentence-initial capitalization and stopwords", () => {
    const entities = extractQueryEntities(
      "Fix the login bug. The parser breaks.",
    );
    expect(entities).not.toContain("fix");
    expect(entities).not.toContain("the");
    expect(entities).not.toContain("parser");
  });

  test("returns empty for empty input", () => {
    expect(extractQueryEntities("")).toEqual([]);
  });
});

describe("entityOverlap()", () => {
  test("matches via tags", () => {
    expect(
      entityOverlap(["acme"], { tags: ["acme", "deploy"], metadata: {} }),
    ).toBe(1);
  });

  test("matches via metadata.entities with substring tolerance", () => {
    expect(
      entityOverlap(["acme"], {
        tags: [],
        metadata: { entities: ["acme pipeline"] },
      }),
    ).toBe(1);
  });

  test("returns 0 with no stored entities", () => {
    expect(entityOverlap(["acme"], { tags: [], metadata: {} })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Entity-fused ranking
// ---------------------------------------------------------------------------

describe("entity-fused scoring", () => {
  test("boosts the memory whose tags match the query entities", async () => {
    const memos = await makeMemos(
      new VectorProvider({
        "Deploy the acme service": ORTHO.a,
        "Water the office plants": ORTHO.b,
      }),
    );
    await memos.store("Deploy the acme service", { tags: ["acme", "deploy"] });
    await memos.store("Water the office plants", { tags: ["office"] });

    // Both memories match the query through the FTS OR-fallback; the
    // entity boost must put the acme-tagged one first.
    const results = await memos.search(
      "Redeploy Acme and water the office plants?",
    );
    expect(results.length).toBe(2);
    expect(results[0]!.node.tags).toContain("acme");
    expect(results[0]!.scores?.entity).toBeGreaterThan(0);
  });

  test("captures entities at write time into metadata", async () => {
    const memos = await makeMemos(new VectorProvider());
    const { node } = await memos.store(
      "Met with PostgresGuru about the connection_pool limits",
    );
    const entities = node.metadata.entities as string[];
    expect(entities).toContain("postgresguru");
    expect(entities).toContain("connection_pool");
  });
});

// ---------------------------------------------------------------------------
// Multi-granularity pools
// ---------------------------------------------------------------------------

describe("retrieval pools", () => {
  test("store defaults to the event pool and round-trips pools", async () => {
    const memos = await makeMemos(new VectorProvider());
    const def = await memos.store("Default pool memory");
    expect(def.node.pool).toBe("event");

    const proc = await memos.store("Run migrations before deploy", {
      pool: "procedure",
    });
    expect(proc.node.pool).toBe("procedure");
  });

  test("pool filters partition search results", async () => {
    const memos = await makeMemos(
      new VectorProvider({
        "Run migrations before deploy": ORTHO.a,
        "Deploy ran on Friday": ORTHO.a,
      }),
    );
    await memos.store("Run migrations before deploy", { pool: "procedure" });
    await memos.store("Deploy ran on Friday");

    const procedures = await memos.search({
      query: "deploy",
      pool: "procedure",
    });
    expect(procedures.length).toBe(1);
    expect(procedures[0]!.node.pool).toBe("procedure");

    const events = await memos.search({ query: "deploy", pool: ["event"] });
    expect(events.length).toBe(1);
    expect(events[0]!.node.pool ?? "event").toBe("event");
  });

  test("consolidated cluster summaries land in the note pool", async () => {
    const vectors = new VectorProvider(ORTHO);
    const memos = await makeMemos(vectors);
    // Three near-identical memories form one cluster (threshold 0.78).
    for (const text of [
      "Kafka consumer lag alarm",
      "Kafka consumer lag alert",
      "Kafka consumer lag page",
    ]) {
      vectors.vectors.set(text, ORTHO.a);
      await memos.store(text);
    }
    await memos.flushEmbeddings();
    const result = await memos.summarizeCluster({ minClusterSize: 3 });
    expect(result.clusters.length).toBe(1);
    const summaryId = result.clusters[0]!.summaryId!;
    const node = await memos.retrieve(summaryId);
    expect(node?.pool).toBe("note");
  });
});

// ---------------------------------------------------------------------------
// Write-time contextual enrichment
// ---------------------------------------------------------------------------

describe("contextual enrichment", () => {
  test("config hook stores context in metadata and explicit context wins", async () => {
    const memos = await makeMemos(new VectorProvider(), {
      enrichMemory: () => "hook context line",
    });
    const viaHook = await memos.store("First memory");
    expect(viaHook.node.metadata.context).toBe("hook context line");

    const explicit = await memos.store("Second memory", {
      context: "explicit wins",
    });
    expect(explicit.node.metadata.context).toBe("explicit wins");
  });

  test("an enricher error never blocks the write", async () => {
    const memos = await makeMemos(new VectorProvider(), {
      enrichMemory: () => {
        throw new Error("enricher down");
      },
    });
    const { node } = await memos.store("Still stored");
    expect(node.metadata.context).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Decay-based forgetting
// ---------------------------------------------------------------------------

describe("forgetByDecay()", () => {
  test("supersedes low-retention memories and keeps strong ones", async () => {
    const memos = await makeMemos(new VectorProvider(ORTHO));
    await memos.store("trivial: colors of the lobby rug", { importance: 0.1 });
    await memos.store("critical: production database credentials", {
      importance: 1.0,
    });
    await memos.flushEmbeddings();

    // Fresh memories score ~importance*0.35 + 0.15 + 0.35 (recency=1);
    // minScore 0.6 splits the two.
    const result = await memos.forgetByDecay({
      olderThanDays: 0,
      minScore: 0.6,
    });
    expect(result.superseded.length).toBe(1);

    // Superseded = historical, not deleted: default search excludes it,
    // historical search still finds it.
    const live = await memos.search({ query: "colors of the lobby rug" });
    expect(
      live.find((r) => r.node.content.includes("lobby rug")),
    ).toBeUndefined();
    const historical = await memos.search({
      query: "colors of the lobby rug",
      includeHistorical: true,
    });
    expect(
      historical.find((r) => r.node.content.includes("lobby rug")),
    ).toBeDefined();
  });

  test("dryRun reports without mutating", async () => {
    const memos = await makeMemos(new VectorProvider(ORTHO));
    await memos.store("trivial: colors of the lobby rug", { importance: 0.1 });
    await memos.flushEmbeddings();

    const preview = await memos.forgetByDecay({
      olderThanDays: 0,
      minScore: 0.6,
      dryRun: true,
    });
    expect(preview.superseded.length).toBe(1);

    const stillLive = await memos.search({
      query: "colors of the lobby rug",
      includeHistorical: true,
    });
    expect(stillLive.length).toBe(1);
    expect(stillLive[0]!.node.validTo).toBeNull();
  });

  test("consolidate() includes the decay stage in its report", async () => {
    const memos = await makeMemos(new VectorProvider(ORTHO));
    await memos.store("trivial: colors of the lobby rug", { importance: 0.1 });
    await memos.flushEmbeddings();

    const report = await memos.consolidate({
      olderThanDays: 0,
      minRetentionScore: 0.6,
      summarize: false,
    });
    expect(report.decayed.length).toBe(1);
    expect(report.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-stream context packs
// ---------------------------------------------------------------------------

describe("multi-stream context packs", () => {
  test("packs include procedure-pool memories via the dedicated stream", async () => {
    const memos = await makeMemos(
      new VectorProvider({
        "Deploy ran on Friday": ORTHO.a,
        "Run migrations before deploy": ORTHO.b,
      }),
    );
    await memos.store("Deploy ran on Friday");
    await memos.store("Run migrations before deploy", { pool: "procedure" });
    await memos.flushEmbeddings();

    const pack = (await memos.contextPack({
      query: "deploy",
      tokenBudget: 2000,
    })) as { items?: Array<{ content?: string; pool?: string }> };
    const contents = JSON.stringify(pack);
    expect(contents).toContain("Run migrations before deploy");
  });

  test("multiStream: false stays single-stream and still works", async () => {
    const memos = await makeMemos(new VectorProvider(ORTHO));
    await memos.store("Deploy ran on Friday");
    await memos.flushEmbeddings();

    const pack = await memos.contextPack({
      query: "deploy",
      tokenBudget: 2000,
      multiStream: false,
    });
    expect(pack).toBeDefined();
  });
});
