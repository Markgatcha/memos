/** MCP 2026-07-28 negotiation: server/discover and cache hints. */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { createMcpServer } from "../src/mcp";
import { createMcpHandler } from "@modelcontextprotocol/server";

const MODERN = "2026-07-28";

function envelope() {
  return {
    "io.modelcontextprotocol/protocolVersion": MODERN,
    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
}

async function rpc(
  handler: ReturnType<typeof createMcpHandler>,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": method,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta: envelope() },
      }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

describe("MCP 2026-07-28", () => {
  test("server/discover advertises the modern revision", async () => {
    const memos = new MemOS({
      storage: new SQLiteStorage(":memory:", true),
      embeddings: { enabled: false },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();
    const handler = createMcpHandler(() => createMcpServer(memos));
    try {
      const { status, body } = await rpc(handler, "server/discover");
      expect(status).toBe(200);
      expect(body.result.supportedVersions).toContain(MODERN);
      expect(body.result.capabilities.tools).toBeDefined();
    } finally {
      await memos.close();
    }
  });

  test("tools/list carries ttlMs and cacheScope", async () => {
    const memos = new MemOS({
      storage: new SQLiteStorage(":memory:", true),
      embeddings: { enabled: false },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();
    const handler = createMcpHandler(() => createMcpServer(memos));
    try {
      const { status, body } = await rpc(handler, "tools/list");
      expect(status).toBe(200);
      expect(body.result.tools.length).toBeGreaterThan(0);
      expect(body.result.ttlMs).toBeGreaterThan(0);
      expect(["public", "private"]).toContain(body.result.cacheScope);
    } finally {
      await memos.close();
    }
  });
});
