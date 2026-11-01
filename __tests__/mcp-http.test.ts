import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startMcpHttpServer, type McpHttpServerHandle } from "../src/mcp.js";

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/**
 * Streamable HTTP is the transport that makes the MCP server reachable by
 * hosted clients and registry probes. These tests exercise the transport
 * itself — not the tools — so they use an embedding-free MemOS and a
 * throwaway database.
 */
describe("MCP Streamable HTTP transport", () => {
  let server: McpHttpServerHandle;
  let dir: string;
  const previousMcpTools = process.env.MEMOS_MCP_TOOLS;

  beforeAll(async () => {
    // This suite exercises the full transport surface, not the default
    // 10-tool core profile.
    process.env.MEMOS_MCP_TOOLS = "all";
    dir = mkdtempSync(join(tmpdir(), "memos-mcp-http-"));
    server = await startMcpHttpServer(
      {
        dbPath: join(dir, "http.db"),
        embeddings: { enabled: false },
      } as never,
      { port: 0 },
    );
  });

  afterAll(async () => {
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (previousMcpTools === undefined) delete process.env.MEMOS_MCP_TOOLS;
    else process.env.MEMOS_MCP_TOOLS = previousMcpTools;
  });

  it("binds loopback by default", () => {
    expect(server.host).toBe("127.0.0.1");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.port).toBeGreaterThan(0);
  });

  it("answers a legacy initialize handshake and advertises tools", async () => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "jest", version: "0.0.0" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("MemOS");
  });

  it("serves tools/list over HTTP", async () => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const names = body.match(/"name"\s*:\s*"memos_[a-z_]+"/g) ?? [];
    expect(names.length).toBeGreaterThanOrEqual(20);
    expect(body).toContain("memos_search");
  });

  it("404s any path other than the configured endpoint", async () => {
    const res = await fetch(server.url.replace(/\/mcp$/, "/other"), {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("closes idempotently", async () => {
    const second = await startMcpHttpServer(
      {
        dbPath: join(dir, "second.db"),
        embeddings: { enabled: false },
      } as never,
      { port: 0 },
    );
    await second.close();
    await second.close();
    expect(true).toBe(true);
  });
});
