/**
 * Tests for the AI Trio context pack contract.
 *
 * Validates `ai-trio.memos.context-pack.v1` from `docs/ai-trio-contracts.md`:
 *   - schema field is exactly "ai-trio.memos.context-pack.v1"
 *   - items are sorted by descending relevance
 *   - content is plain text
 *   - trust and source are preserved on every item
 *   - score is reproducible for the same query/provider/model
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  buildContextPack,
  CONTEXT_PACK_SCHEMA,
  packToToon,
  packToToonCompact,
  serializeContextPack,
  type ContextPack,
  type ContextPackItem,
} from "../src/context-pack";
import { compareScoredMemories } from "../src/retrieval";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  ScoredMemory,
  MemoryNode,
} from "../src/types";

class FixedProvider implements EmbeddingProvider {
  public readonly id = "fixed";
  public readonly model = "fixed-v1";
  public readonly dimensions = 4;
  /** Per-text deterministic vector. */
  public readonly vectors = new Map<string, EmbeddingVector>();

  async embed(text: string): Promise<EmbeddingVector> {
    return this.vectors.get(text) ?? [0, 0, 0, 0];
  }
}

function makeMemos(provider: EmbeddingProvider) {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { synchronous: true },
  });
}

function memosToScoredMemory(node: MemoryNode, score: number): ScoredMemory {
  return { node, score };
}

describe("AI Trio context pack contract", () => {
  test("buildContextPack produces the v1 schema envelope", () => {
    const items = [
      memosToScoredMemory(
        {
          id: "n1",
          content: "First fact",
          summary: "First fact",
          type: "fact",
          metadata: {},
          importance: 0.7,
          createdAt: 1000,
          updatedAt: 1000,
          accessCount: 0,
          lastAccessed: 1000,
          tags: ["work"],
          expiresAt: null,
          namespace: "default",
          validFrom: null,
          validTo: null,
          source: "user_input",
          trustScore: 1.0,
        },
        0.9,
      ),
    ];
    const pack = buildContextPack({
      query: "test query",
      namespace: "default",
      tokenBudget: 1000,
      items,
    });
    expect(pack.schema).toBe("ai-trio.memos.context-pack.v1");
    expect(pack.query).toBe("test query");
    expect(pack.namespace).toBe("default");
    expect(pack.tokenBudget).toBe(1000);
    expect(pack.items).toHaveLength(1);
  });

  test("items are sorted by descending relevance", () => {
    const items = [
      memosToScoredMemory(makeNode("a", 0.1, ["t1"]), 0.1),
      memosToScoredMemory(makeNode("b", 0.9, ["t2"]), 0.9),
      memosToScoredMemory(makeNode("c", 0.5, ["t3"]), 0.5),
    ];
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items,
    });
    expect(pack.items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  test("trust and source are preserved on every item", () => {
    const items = [memosToScoredMemory(makeNode("a", 0.5, []), 0.5)];
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items,
      trust: "guardian",
      source: "external",
    });
    expect(pack.items[0].trust).toBe("guardian");
    expect(pack.items[0].source).toBe("external");
  });

  test("tags are preserved on every item", () => {
    const items = [memosToScoredMemory(makeNode("a", 0.5, ["x", "y"]), 0.5)];
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items,
    });
    expect(pack.items[0].tags).toEqual(["x", "y"]);
  });

  test("content is plain text (no script/object payloads)", () => {
    const items = [
      memosToScoredMemory(
        makeNode("a", 0.5, [], "<b>not bold</b>\nplain text"),
        0.5,
      ),
    ];
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items,
    });
    expect(pack.items[0].content).toBe("<b>not bold</b>\nplain text");
    expect(typeof pack.items[0].content).toBe("string");
  });

  test("tokenBudget is honored — items past the budget are dropped", () => {
    const items = [
      memosToScoredMemory(makeNode("a", 0.9, [], "a".repeat(100)), 0.9),
      memosToScoredMemory(makeNode("b", 0.8, [], "b".repeat(100)), 0.8),
      memosToScoredMemory(makeNode("c", 0.7, [], "c".repeat(100)), 0.7),
    ];
    // ~25 tokens per item (100 chars / 4 chars per token).
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 30, // room for at most 1 item
      items,
      // Disable summary to make the math predictable.
      includeSummary: false,
    });
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].id).toBe("a");
  });

  test("the contract schema id is exposed for downstream consumers", () => {
    expect(CONTEXT_PACK_SCHEMA).toBe("ai-trio.memos.context-pack.v1");
  });
});

describe("TOON serialization (token-efficient format)", () => {
  test("packToToon produces pipe-delimited output with header", () => {
    const pack: ContextPack = {
      schema: CONTEXT_PACK_SCHEMA,
      query: "test query",
      namespace: "default",
      tokenBudget: 1000,
      items: [
        {
          id: "mem_abc",
          content: "User likes dark mode",
          summary: null,
          score: 0.95,
          scores: {},
          trust: "local",
          source: "user_input",
          tags: ["preference", "ui"],
          updatedAt: "2026-06-18T12:00:00.000Z",
        },
      ],
      tokensSaved: 0,
    };
    const toon = packToToon(pack);
    expect(toon).toContain("# ai-trio.memos.context-pack.v1");
    expect(toon).toContain("# toon:pipe-delimited");
    expect(toon).toContain("mem_abc|0.950|local|user_input");
    expect(toon).toContain("preference;ui");
  });

  test("TOON format is significantly smaller than JSON", () => {
    const items: ContextPackItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `mem_${i}`,
      content: `This is a test memory entry with some content about topic number ${i}.`,
      summary: null,
      score: 1 - i * 0.1,
      scores: {},
      trust: "local",
      source: "user_input",
      tags: ["tag1", "tag2", "tag3"],
      updatedAt: "2026-06-18T12:00:00.000Z",
    }));
    const pack: ContextPack = {
      schema: CONTEXT_PACK_SCHEMA,
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items,
      tokensSaved: 0,
    };
    const json = JSON.stringify(pack);
    const toon = packToToon(pack);
    // TOON should be at least 40% smaller than JSON for structured data
    expect(toon.length).toBeLessThan(json.length * 0.6);
  });

  test("escapes pipe characters in content", () => {
    const pack: ContextPack = {
      schema: CONTEXT_PACK_SCHEMA,
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items: [
        {
          id: "mem_1",
          content: "Content with | pipe and | multiple pipes",
          summary: null,
          score: 0.9,
          scores: {},
          trust: "local",
          source: "user_input",
          tags: [],
          updatedAt: "2026-06-18T12:00:00.000Z",
        },
      ],
      tokensSaved: 0,
    };
    const toon = packToToon(pack);
    // Pipes in content should be replaced with ¦
    expect(toon).toContain("Content with ¦ pipe and ¦ multiple pipes");
  });

  test("serializeContextPack dispatches by format", () => {
    const pack: ContextPack = {
      schema: CONTEXT_PACK_SCHEMA,
      query: "q",
      namespace: "default",
      tokenBudget: 100,
      items: [],
      tokensSaved: 0,
    };
    const jsonResult = serializeContextPack(pack, "json");
    expect(jsonResult).toBe(pack);
    const toonResult = serializeContextPack(pack, "toon");
    expect(typeof toonResult).toBe("string");
    expect(toonResult).toContain("# toon:pipe-delimited");
  });
});

describe("MemOS.contextPack() end-to-end", () => {
  test("returns a v1 pack sorted by relevance, reproducible", async () => {
    const provider = new FixedProvider();
    provider.vectors.set("dark mode", [1, 0, 0, 0]);
    provider.vectors.set("light mode is fine", [0, 1, 0, 0]);
    provider.vectors.set("completely unrelated note", [0, 0, 1, 0]);
    provider.vectors.set("dark themes for code", [0.9, 0, 0, 0.1]);
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("dark mode", { tags: ["preference"] });
    await memos.store("light mode is fine", { tags: ["preference"] });
    await memos.store("completely unrelated note");
    await memos.store("dark themes for code", { tags: ["work"] });

    const pack1 = await memos.contextPack({
      query: "dark mode",
      namespace: "default",
      tokenBudget: 1000,
    });
    const pack2 = await memos.contextPack({
      query: "dark mode",
      namespace: "default",
      tokenBudget: 1000,
    });
    expect(pack1.schema).toBe(CONTEXT_PACK_SCHEMA);
    expect(pack1.items.length).toBeGreaterThan(0);
    // Same query -> same order.
    expect(pack1.items.map((i) => i.id)).toEqual(pack2.items.map((i) => i.id));
    // Highest item is one of the dark-mode notes.
    expect(["dark mode", "dark themes for code"]).toContain(
      pack1.items[0].content,
    );
    // Trust defaults to "local", source defaults to "session".
    expect(pack1.items[0].trust).toBe("local");
    expect(pack1.items[0].source).toBe("session");
    await memos.close();
  });
});

function makeNode(
  id: string,
  importance: number,
  tags: string[],
  content: string = id,
): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: "fact",
    metadata: {},
    importance,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags,
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

describe("Cache-prefix stability (prompt-cache friendly layout)", () => {
  const baseOpts = {
    query: "dark mode",
    namespace: "default",
    tokenBudget: 10000,
  };

  /** Same logical items in a given input order, all with tied scores. */
  function tiedItems(order: string[]): ScoredMemory[] {
    return order.map((id) =>
      memosToScoredMemory(
        makeNode(
          id,
          0.7,
          [`tag-${id}`],
          `Fact about ${id}: entirely distinct wording ${id.repeat(4)}`,
        ),
        0.9, // tied score — order must fall back to the id tiebreak
      ),
    );
  }

  function serializeAll(pack: ContextPack): string[] {
    return [
      JSON.stringify(pack),
      packToToon(pack),
      packToToonCompact(pack),
      serializeContextPack(pack, "toon") as string,
    ];
  }

  test("identical inputs produce byte-identical output in every format", () => {
    const pack1 = buildContextPack({
      ...baseOpts,
      items: tiedItems(["a", "b", "c"]),
    });
    const pack2 = buildContextPack({
      ...baseOpts,
      items: tiedItems(["a", "b", "c"]),
    });
    expect(serializeAll(pack1)).toEqual(serializeAll(pack2));
  });

  test("shuffled input order with tied scores still packs byte-identically", () => {
    const packA = buildContextPack({
      ...baseOpts,
      items: tiedItems(["b", "a", "c"]),
    });
    const packB = buildContextPack({
      ...baseOpts,
      items: tiedItems(["c", "b", "a"]),
    });
    // Byte-identical across JSON, TOON, and compact TOON.
    expect(serializeAll(packA)).toEqual(serializeAll(packB));
    // And the tiebreak is by node id, not input order.
    expect(packA.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  test("scores breakdown uses a fixed key order regardless of leg order", () => {
    const withKeyOrder = (keys: string[]): ScoredMemory => ({
      node: makeNode("n1", 0.7, ["t"], "Some unique standalone content one"),
      score: 0.9,
      scores: Object.fromEntries(keys.map((k) => [k, 0.5])),
    });
    const packA = buildContextPack({
      ...baseOpts,
      items: [withKeyOrder(["hybrid", "keyword"])],
    });
    const packB = buildContextPack({
      ...baseOpts,
      items: [withKeyOrder(["keyword", "hybrid"])],
    });
    expect(JSON.stringify(packA)).toBe(JSON.stringify(packB));
    // Fixed order: keyword before hybrid.
    expect(Object.keys(packA.items[0].scores)).toEqual(["keyword", "hybrid"]);
  });

  test("compareScoredMemories breaks score ties by node id", () => {
    const a = memosToScoredMemory(makeNode("b", 0.7, [], "b content"), 0.5);
    const b = memosToScoredMemory(makeNode("a", 0.7, [], "a content"), 0.5);
    expect([a, b].sort(compareScoredMemories).map((s) => s.node.id)).toEqual([
      "a",
      "b",
    ]);
    // Unequal scores still sort by score first.
    const c = memosToScoredMemory(makeNode("z", 0.7, [], "z content"), 0.9);
    expect([a, b, c].sort(compareScoredMemories).map((s) => s.node.id)).toEqual(
      ["z", "a", "b"],
    );
  });
});
