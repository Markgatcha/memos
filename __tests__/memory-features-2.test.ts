/**
 * Tests for the second 2026-09 feature wave:
 *   - entity aliasing / canonicalization (F2)
 *   - LLM-assisted note distillation hook (F3)
 *   - external import (ChatGPT / Claude exports) (F4)
 *   - bounded graph expansion in context packs (F5)
 *   - context-pack token telemetry + usageStats (F6)
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  canonicalizeEntities,
  BUILTIN_ENTITY_ALIASES,
} from "../src/entity-extraction";
import { parseExternalMemoryExport } from "../src/external-import";
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

async function makeMemos(extra: Record<string, unknown> = {}) {
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider: new VectorProvider(ORTHO) },
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
};

// ---------------------------------------------------------------------------
// F2: entity aliasing
// ---------------------------------------------------------------------------

describe("entity aliasing", () => {
  test("builtin table canonicalizes vendor spellings", () => {
    expect(canonicalizeEntities(["postgresql", "pg", "k8s"])).toEqual([
      "postgres",
      "kubernetes",
    ]);
    expect(BUILTIN_ENTITY_ALIASES["gh"]).toBe("github");
  });

  test("deployment aliases override builtins", () => {
    expect(
      canonicalizeEntities(["okta", "sso"], { sso: "auth", okta: "auth" }),
    ).toEqual(["auth"]);
  });

  test("stored entities are canonicalized at write time", async () => {
    const memos = await makeMemos({
      entityAliases: { okta: "auth", sso: "auth" },
    });
    const { node } = await memos.store(
      "We run PostgreSQL in production behind pgbouncer",
    );
    const entities = node.metadata.entities as string[];
    expect(entities).toContain("postgres");
    expect(entities).not.toContain("postgresql");
  });
});

// ---------------------------------------------------------------------------
// F3: LLM-assisted note distillation
// ---------------------------------------------------------------------------

describe("summarizeClusterLlm hook", () => {
  const seedCluster = async (memos: MemOS) => {
    for (const text of [
      "Kafka consumer lag alarm fired",
      "Kafka consumer lag alert fired twice",
      "Kafka consumer lag paged the on-call",
    ]) {
      await memos.store(text);
    }
    await memos.flushEmbeddings();
  };

  test("uses the hook's abstractive summary when provided", async () => {
    const memos = await makeMemos({
      summarizeClusterLlm: ({ contents }) =>
        `RUNBOOK: ${contents.length} kafka lag notes — restart consumer group, then check broker partitions.`,
    });
    await seedCluster(memos);
    const result = await memos.summarizeCluster({ minClusterSize: 3 });
    expect(result.clusters.length).toBe(1);
    const node = await memos.retrieve(result.clusters[0]!.summaryId!);
    expect(node?.content).toContain("RUNBOOK");
  });

  test("falls back to extractive on hook failure or empty output", async () => {
    const memos = await makeMemos({
      summarizeClusterLlm: () => {
        throw new Error("local model down");
      },
    });
    await seedCluster(memos);
    const result = await memos.summarizeCluster({ minClusterSize: 3 });
    expect(result.clusters.length).toBe(1);
    const node = await memos.retrieve(result.clusters[0]!.summaryId!);
    // Extractive fallback produced a non-empty summary.
    expect((node?.content ?? "").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F4: external import (ChatGPT / Claude exports)
// ---------------------------------------------------------------------------

describe("parseExternalMemoryExport", () => {
  test("parses ChatGPT mapping trees, user turns only", () => {
    const parsed = parseExternalMemoryExport([
      {
        title: "Deploy chat",
        mapping: {
          a: {
            message: {
              author: { role: "user" },
              content: {
                parts: ["We deploy on Fridays.", "Never on Mondays."],
              },
            },
          },
          b: {
            message: {
              author: { role: "assistant" },
              content: { parts: ["Understood."] },
            },
          },
        },
      },
    ]);
    expect(parsed.detected).toBe("chatgpt");
    expect(parsed.items.map((i) => i.content)).toEqual([
      "We deploy on Fridays.\nNever on Mondays.",
    ]);
  });

  test("parses Claude chat_messages exports, human turns only", () => {
    const parsed = parseExternalMemoryExport([
      {
        name: "Memory chat",
        chat_messages: [
          {
            sender: "human",
            text: "Remember: I use dark mode.",
            created_at: "2026-08-01T10:00:00Z",
          },
          { sender: "assistant", text: "Noted." },
        ],
      },
    ]);
    expect(parsed.detected).toBe("claude");
    expect(parsed.items.length).toBe(1);
    expect(parsed.items[0]!.content).toBe("Remember: I use dark mode.");
    expect(parsed.items[0]!.createdAt).toBe(Date.parse("2026-08-01T10:00:00Z"));
  });

  test("flat lists, dedupe, and cap all work", () => {
    const parsed = parseExternalMemoryExport(
      ["Prefers dark mode", "Prefers dark mode", "", { content: "Uses pnpm" }],
      "generic",
      10,
    );
    expect(parsed.detected).toBe("generic");
    expect(parsed.items.length).toBe(2);
    expect(parsed.skipped).toBe(2);
  });

  test("cap enforcement via maxItems", () => {
    const parsed = parseExternalMemoryExport(
      ["one", "two", "three"],
      "generic",
      2,
    );
    expect(parsed.items.length).toBe(2);
    expect(parsed.skipped).toBe(1);
  });
});

describe("MemOS.importExternal", () => {
  test("imports a ChatGPT export with external_data provenance", async () => {
    const memos = await makeMemos();
    const result = await memos.importExternal({
      data: [
        {
          title: "Deploy chat",
          mapping: {
            a: {
              message: {
                author: { role: "user" },
                content: { parts: ["We deploy on Fridays."] },
              },
            },
          },
        },
      ],
    });
    expect(result.detected).toBe("chatgpt");
    expect(result.imported).toBe(1);

    const found = await memos.search({
      query: "deploy",
      includeHistorical: true,
    });
    const imported = found.find((r) => r.node.content.includes("Fridays"));
    expect(imported).toBeDefined();
    expect(imported!.node.source).toBe("external_data");
    expect(imported!.node.tags).toContain("imported");
    expect(imported!.node.tags).toContain("chatgpt");
  });

  test("dryRun reports without writing", async () => {
    const memos = await makeMemos();
    const result = await memos.importExternal({
      data: ["Prefers dark mode"],
      dryRun: true,
    });
    expect(result.total).toBe(1);
    expect(result.imported).toBe(0);
    const found = await memos.search({ query: "dark mode" });
    expect(found.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F5: bounded graph expansion in packs
// ---------------------------------------------------------------------------

describe("pack graph expansion", () => {
  test("1-hop neighbours join the pack and can be disabled", async () => {
    // Register real vectors for every text AND the query BEFORE storing
    // (the synchronous queue embeds at store time) so the semantic leg is
    // deterministic: only the seed matches the query; the neighbour is
    // reachable exclusively through the derived edge.
    const seedText = "The deploy pipeline runs on GitHub Actions";
    const neighbourText = "The deploy pipeline posts to the #deploys channel";
    const provider = new VectorProvider({
      [seedText]: ORTHO.a,
      [neighbourText]: ORTHO.b,
      "Unrelated note about office plants": ORTHO.c,
      "GitHub Actions CI": ORTHO.a,
    });
    const memos = await makeMemos({ embeddings: { enabled: true, provider } });

    const seed = await memos.store(seedText);
    await memos.store("Unrelated note about office plants");
    const neighbour = await memos.store(neighbourText);
    await memos.link(seed.node.id, neighbour.node.id, "relates_to", 0.9);
    await memos.flushEmbeddings();

    const pack = (await memos.contextPack({
      query: "GitHub Actions CI",
      tokenBudget: 2000,
    })) as { items?: Array<{ content?: string }> };
    const contents = JSON.stringify(pack.items ?? pack);
    // The neighbour rides along through the derived edge even though the
    // query alone does not surface it.
    expect(contents).toContain("#deploys channel");

    const narrow = (await memos.contextPack({
      query: "GitHub Actions CI",
      tokenBudget: 2000,
      graphExpansion: false,
    })) as { items?: Array<{ content?: string }> };
    const narrowContents = JSON.stringify(narrow.items ?? narrow);
    expect(narrowContents).not.toContain("#deploys channel");
  });
});

// ---------------------------------------------------------------------------
// F6: token telemetry
// ---------------------------------------------------------------------------

describe("usageStats", () => {
  test("packs build counters and savings stay in [0, 100]", async () => {
    const memos = await makeMemos();
    // Enough items that toon-compact packing shows its savings over the
    // readable naive baseline.
    for (const text of [
      "Deploy ran on Friday",
      "Postgres pool capped at 20",
      "Kubernetes scales 3 to 12 replicas",
      "Standup is Tuesdays at 14:00",
      "SSO comes from Okta",
    ]) {
      await memos.store(text);
    }
    await memos.flushEmbeddings();

    const before = memos.usageStats();
    expect(before.packsBuilt).toBe(0);

    await memos.contextPack({
      query: "deploy",
      tokenBudget: 2000,
      format: "toon-compact",
    });
    await memos.contextPack({
      query: "deploy",
      tokenBudget: 2000,
    });

    const usage = memos.usageStats();
    expect(usage.packsBuilt).toBe(2);
    expect(usage.packTokens).toBeGreaterThan(0);
    expect(usage.naiveBaselineTokens).toBeGreaterThan(0);
    expect(usage.savedPct).toBeGreaterThan(0);
    expect(usage.savedPct).toBeLessThanOrEqual(100);
  });
});
