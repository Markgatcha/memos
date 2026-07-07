/**
 * Tests for the MCP server changes: new tools, version from package.json,
 * AI Trio context pack wiring, metadata/importance preservation.
 *
 * We exercise the exported `callTool` and `getMcpTools` directly — no
 * stdio loop is required.
 */

import { callTool, getMcpTools, MCP_PROTOCOL_VERSION } from "../src/mcp";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";
import { CONTEXT_PACK_SCHEMA } from "../src/context-pack";

class VectorProvider implements EmbeddingProvider {
  public readonly id = "vector";
  public readonly model = "vector-v1";
  public readonly dimensions = 4;
  async embed(text: string): Promise<EmbeddingVector> {
    // Crude "keyword" vector: each slot lights up for a keyword in the text.
    const v = [0, 0, 0, 0];
    if (/dark|theme|preference/.test(text)) v[0] = 1;
    if (/light|bright/.test(text)) v[1] = 1;
    if (/work|project/.test(text)) v[2] = 1;
    if (/unrelated|other/.test(text)) v[3] = 1;
    return v;
  }
}

function makeMemos() {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: {
      semanticSearch: true,
      graphViz: true,
      namespaces: true,
      contextInjection: true,
    },
    embeddings: { enabled: true, provider: new VectorProvider() },
    embeddingQueue: { synchronous: true },
  });
}

describe("MCP tool registration", () => {
  test("advertises the 2025-06-18 protocol version", () => {
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  test("exposes the new context-pack and queue tools", () => {
    const names = getMcpTools().map((t) => t.name);
    expect(names).toContain("memos_context_pack");
    expect(names).toContain("memos_flush_embeddings");
    expect(names).toContain("memos_embedding_status");
    // Original tools still present.
    expect(names).toContain("memos_store");
    expect(names).toContain("memos_search");
  });

  test("memos_store input schema advertises the new fields", () => {
    const store = getMcpTools().find((t) => t.name === "memos_store")!;
    const props = store.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("metadata");
    expect(props).toHaveProperty("importance");
    expect(props).toHaveProperty("summary");
  });
});

describe("MCP callTool behaviors", () => {
  test("memos_store preserves metadata, importance, and summary", async () => {
    const memos = makeMemos();
    await memos.init();
    const response = (await callTool(memos, "memos_store", {
      content: "user likes dark mode",
      type: "preference",
      tags: ["ui"],
      importance: 0.9,
      summary: "user preference",
      metadata: { source: "interview" },
    })) as { structuredContent: { node: { id: string; metadata: { source: string }; importance: number; summary: string } } };
    const node = response.structuredContent.node;
    expect(node.importance).toBe(0.9);
    expect(node.summary).toBe("user preference");
    expect(node.metadata.source).toBe("interview");
    await memos.close();
  });

  test("memos_context_pack returns the AI Trio v1 envelope", async () => {
    const memos = makeMemos();
    await memos.init();
    await callTool(memos, "memos_store", { content: "dark mode preference" });
    await callTool(memos, "memos_store", { content: "light mode is fine" });

    const response = (await callTool(memos, "memos_context_pack", {
      query: "dark mode",
      tokenBudget: 1200,
      namespace: "default",
    })) as { structuredContent: { schema: string; items: unknown[] } };
    expect(response.structuredContent.schema).toBe(CONTEXT_PACK_SCHEMA);
    expect(Array.isArray(response.structuredContent.items)).toBe(true);
    await memos.close();
  });

  test("memos_flush_embeddings resolves and reports queue state", async () => {
    const memos = makeMemos();
    await memos.init();
    await callTool(memos, "memos_store", { content: "alpha" });
    await callTool(memos, "memos_store", { content: "beta" });
    const response = (await callTool(memos, "memos_flush_embeddings", {})) as {
      structuredContent: { total: number };
    };
    expect(response.structuredContent.total).toBeGreaterThanOrEqual(2);
    await memos.close();
  });

  test("memos_embedding_status returns the full snapshot with no args", async () => {
    const memos = makeMemos();
    await memos.init();
    const response = (await callTool(memos, "memos_embedding_status", {})) as {
      structuredContent: { total: number; pending: number; running: number; nodes: unknown[] };
    };
    expect(response.structuredContent).toMatchObject({
      total: expect.any(Number),
      pending: expect.any(Number),
      running: expect.any(Number),
      nodes: expect.any(Array),
    });
    await memos.close();
  });

  test("memos_embedding_status returns null for unknown node ids", async () => {
    const memos = makeMemos();
    await memos.init();
    const response = (await callTool(memos, "memos_embedding_status", {
      nodeId: "does-not-exist",
    })) as { structuredContent: null };
    expect(response.structuredContent).toBeNull();
    await memos.close();
  });
});
