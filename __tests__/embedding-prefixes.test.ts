import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEmbeddingPrefixes } from "../src/embedding-prefixes";
import { createEmbeddingProvider } from "../src/embeddings";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { MemoryNode } from "../src/types";

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

describe("resolveEmbeddingPrefixes", () => {
  test("Nomic gets the required search_query/search_document instructions", () => {
    expect(resolveEmbeddingPrefixes({ model: "nomic-embed-text" })).toEqual({
      queryPrefix: "search_query: ",
      documentPrefix: "search_document: ",
      matched: "nomic",
    });
  });

  test("e5 gets query/passage", () => {
    expect(
      resolveEmbeddingPrefixes({ model: "intfloat/multilingual-e5-small" }),
    ).toEqual({
      queryPrefix: "query: ",
      documentPrefix: "passage: ",
      matched: "e5",
    });
  });

  test("EmbeddingGemma gets its task instruction before the generic e5 rule", () => {
    expect(
      resolveEmbeddingPrefixes({ model: "Xenova/gemma-300m-e5-it-v1" }).matched,
    ).toBe("embeddinggemma");
  });

  test("BGE gets the retrieval instruction on the query side only", () => {
    const resolved = resolveEmbeddingPrefixes({
      model: "BAAI/bge-small-en-v1.5",
    });
    expect(resolved.queryPrefix).toContain("Represent this sentence");
    expect(resolved.documentPrefix).toBe("");
  });

  test("explicit config wins, including an explicit empty string", () => {
    expect(
      resolveEmbeddingPrefixes({
        model: "nomic-embed-text",
        queryPrefix: "Q: ",
        documentPrefix: "",
      }),
    ).toMatchObject({ queryPrefix: "Q: ", documentPrefix: "" });
  });

  test("API-side providers do not get text prefixes", () => {
    expect(
      resolveEmbeddingPrefixes({ provider: "voyage", model: "voyage-3" }),
    ).toMatchObject({
      queryPrefix: "",
      documentPrefix: "",
      matched: "api-input-type",
    });
  });
});

describe("createEmbeddingProvider applies prefixes", () => {
  test("Ollama nomic gets both instructions automatically", () => {
    const provider = createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
    });
    expect(provider.queryPrefix).toBe("search_query: ");
    expect(provider.documentPrefix).toBe("search_document: ");
  });

  test("FastEmbed bge gets a query instruction", () => {
    const provider = createEmbeddingProvider({ provider: "fastembed" });
    expect(provider.queryPrefix).toContain("Represent this sentence");
    expect(provider.documentPrefix).toBe("");
  });

  test("a custom provider object is returned untouched", () => {
    const custom = {
      id: "custom",
      model: "custom-v1",
      dimensions: 2,
      async embed() {
        return [1, 0];
      },
    };
    expect(createEmbeddingProvider({ provider: custom })).toBe(custom);
  });
});

describe("embedding prefix storage isolation", () => {
  let dir: string;
  let storage: SQLiteStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memos-prefix-"));
    storage = new SQLiteStorage(join(dir, "test.db"), true);
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("vectors produced with different prefixes are never compared", async () => {
    const node = makeNode("prefix-node", "the deploy window is friday");
    await storage.saveNode(node);
    await storage.saveEmbedding(
      node.id,
      [1, 0, 0],
      "test-model",
      "search_document: ",
    );

    const matching = await storage.querySimilarEmbeddings(
      [1, 0, 0],
      {},
      5,
      0,
      "test-model",
      "search_document: ",
    );
    expect(matching.map((hit) => hit.node.id)).toEqual([node.id]);

    const wrongPrefix = await storage.querySimilarEmbeddings(
      [1, 0, 0],
      {},
      5,
      0,
      "test-model",
      "query: ",
    );
    expect(wrongPrefix).toEqual([]);

    const unprefixed = await storage.querySimilarEmbeddings(
      [1, 0, 0],
      {},
      5,
      0,
      "test-model",
      "",
    );
    expect(unprefixed).toEqual([]);
  });

  test("getEmbeddingInfo round-trips the stored prefix", async () => {
    const node = makeNode("prefix-info-node", "a fact");
    await storage.saveNode(node);
    await storage.saveEmbedding(node.id, [0, 1, 0], "test-model", "passage: ");
    expect(await storage.getEmbeddingInfo(node.id)).toMatchObject({
      model: "test-model",
      prefix: "passage: ",
    });
  });

  test("semanticScan auto stays exact for small candidate sets", async () => {
    const auto = new SQLiteStorage(join(dir, "auto.db"), true, {
      semanticScan: "auto",
    });
    await auto.init();
    try {
      const node = makeNode("auto-node", "a small store stays exact");
      await auto.saveNode(node);
      await auto.saveEmbedding(node.id, [1, 0, 0], "test-model", "");
      const hits = await auto.querySimilarEmbeddings(
        [1, 0, 0],
        {},
        5,
        0,
        "test-model",
        "",
      );
      expect(hits.map((hit) => hit.node.id)).toEqual([node.id]);
    } finally {
      await auto.close();
    }
  });
});
