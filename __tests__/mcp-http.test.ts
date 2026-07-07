/**
 * Tests for the HTTP+SSE MCP transport. Uses Node's built-in
 * `http` module to avoid pulling in Express.
 */

import { startMcpHttpServer, MCP_PROTOCOL_VERSION, getMcpTools } from "../src/mcp";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class FixedProvider implements EmbeddingProvider {
  public readonly id = "fixed";
  public readonly model = "fixed-v1";
  public readonly dimensions = 4;
  async embed(_t: string): Promise<EmbeddingVector> {
    return [1, 0, 0, 0];
  }
}

function makeMemos() {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider: new FixedProvider() },
    embeddingQueue: { synchronous: true },
  });
}

describe("HTTP+SSE MCP transport", () => {
  let memos: MemOS;
  let server: { port: number; close: () => Promise<void> } | null = null;

  beforeEach(async () => {
    memos = makeMemos();
    await memos.init();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await memos.close();
  });

  test("starts on a random port and exposes the same tool list", async () => {
    server = await startMcpHttpServer(memos, { port: 0, host: "127.0.0.1" });
    expect(server.port).toBeGreaterThan(0);
    // The wire shape is unchanged — getMcpTools still works.
    expect(getMcpTools().map((t) => t.name)).toContain("memos_store");
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  test("responds to POST /mcp/messages with the right JSON-RPC shape", async () => {
    server = await startMcpHttpServer(memos, { port: 0, host: "127.0.0.1" });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; id: number; result: { tools: Array<{ name: string }> } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.find((t) => t.name === "memos_store")).toBeDefined();
  });

  test("handles tools/call by name and returns the structured content", async () => {
    server = await startMcpHttpServer(memos, { port: 0, host: "127.0.0.1" });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memos_store", arguments: { content: "hello http+sse" } },
      }),
    });
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; structuredContent: { node: { id: string } } };
    };
    expect(body.result.content[0].text).toMatch(/Stored memory/);
    expect(body.result.structuredContent.node.id).toMatch(/.+/);
  });

  test("returns a JSON-RPC error for unknown methods", async () => {
    server = await startMcpHttpServer(memos, { port: 0, host: "127.0.0.1" });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "does/not/exist" }),
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toMatch(/Method not found/);
  });

  test("SSE endpoint responds with text/event-stream and advertises the message URL", async () => {
    server = await startMcpHttpServer(memos, { port: 0, host: "127.0.0.1" });
    const port = server.port;
    const res = await fetch(`http://127.0.0.1:${port}/mcp/sse`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    // Read just the first event (the `endpoint` advertisement) and close.
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    if (reader) {
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toMatch(/event: endpoint/);
      expect(chunk).toMatch(/\/mcp\/messages/);
      await reader.cancel();
    }
  });
});
