/**
 * MCP protocol tests — verifies the MemOS MCP server speaks the
 * 2026-07-28 protocol revision correctly (modern stateless core)
 * and maintains backward compatibility with the legacy 2025-era
 * initialize handshake.
 *
 * Uses serveStdio with a custom InMemoryTransport to exercise the full
 * era-classification and envelope-validation logic that the SDK entry
 * point owns.
 */

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MemOS } from "../src/memory";
import { createMcpServer, getMcpTools } from "../src/mcp";
import { getSdkVersion } from "../src/version";

const TEST_DB = ":memory:";

// The modern protocol version this server must support.
const MODERN_VERSION = "2026-07-28";

// Meta keys per the 2026-07-28 spec.
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Helper: create a serveStdio-backed server connected via InMemoryTransport.
 * Returns the client-side transport for sending raw JSON-RPC messages.
 */
async function setupServer(): Promise<{
  clientTransport: InMemoryTransport;
  memos: MemOS;
  cleanup: () => Promise<void>;
}> {
  const memos = new MemOS({
    dbPath: TEST_DB,
    experimental: {
      semanticSearch: true,
      graphViz: true,
      namespaces: true,
      contextInjection: true,
    },
  });
  await memos.init();

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(memos), {
    transport: serverTransport,
  });

  const cleanup = async () => {
    await handle.close();
    await memos.close();
  };

  return { clientTransport, memos, cleanup };
}

/**
 * Send a JSON-RPC request over the transport and wait for the matching response.
 */
function sendRequest(
  transport: InMemoryTransport,
  method: string,
  params: Record<string, unknown> | undefined,
  id: number,
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`Timeout waiting for response to ${method} (id=${id})`),
        ),
      10_000,
    );

    const handler = (message: unknown) => {
      const msg = message as JsonRpcResponse;
      if (msg.id === id) {
        clearTimeout(timeout);
        transport.onmessage = undefined;
        resolve(msg);
      }
    };
    transport.onmessage = handler;

    void transport.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });
  });
}

/** Build the modern _meta envelope for a request. */
function modernMeta(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_KEY]: MODERN_VERSION,
    [CLIENT_CAPABILITIES_KEY]: {},
    [CLIENT_INFO_KEY]: { name: "test-client", version: "1.0.0" },
  };
}

describe("MCP Protocol — 2026-07-28 (modern)", () => {
  let clientTransport: InMemoryTransport;
  let memos: MemOS;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ clientTransport, memos, cleanup } = await setupServer());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("server/discover returns supported versions and capabilities", async () => {
    const response = await sendRequest(
      clientTransport,
      "server/discover",
      {
        _meta: modernMeta(),
      },
      1,
    );

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    const result = response.result!;
    expect(result.supportedVersions).toContain(MODERN_VERSION);
    expect(result.capabilities).toBeDefined();
    expect(
      (result.capabilities as Record<string, unknown>).tools,
    ).toBeDefined();
  });

  test("tools/list returns all 6 tools with outputSchema", async () => {
    const response = await sendRequest(
      clientTransport,
      "tools/list",
      {
        _meta: modernMeta(),
      },
      2,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(6);

    const expectedNames = [
      "memos_store",
      "memos_search",
      "memos_retrieve",
      "memos_forget",
      "memos_graph",
      "memos_context",
    ];
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toEqual(expectedNames);

    // Every tool MUST have an outputSchema (spec requirement since 2025-06-18)
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(typeof tool.outputSchema).toBe("object");
    }
  });

  test("tools/list includes ttlMs and cacheScope (2026-07-28 cache hints)", async () => {
    const response = await sendRequest(
      clientTransport,
      "tools/list",
      {
        _meta: modernMeta(),
      },
      3,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    // The 2026-07-28 spec requires ttlMs and cacheScope on cacheable list results
    expect(result.ttlMs).toBeDefined();
    expect(typeof result.ttlMs).toBe("number");
    expect(result.cacheScope).toBeDefined();
    expect(["public", "private"]).toContain(result.cacheScope);
  });

  test("tools/list result includes serverInfo in _meta", async () => {
    const response = await sendRequest(
      clientTransport,
      "tools/list",
      {
        _meta: modernMeta(),
      },
      4,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    const serverInfo = meta![SERVER_INFO_KEY] as Record<string, unknown>;
    expect(serverInfo).toBeDefined();
    expect(serverInfo.name).toBe("memos");
    expect(serverInfo.version).toBe(getSdkVersion());
  });

  test("memos_store end-to-end: stores and returns structured content", async () => {
    const response = await sendRequest(
      clientTransport,
      "tools/call",
      {
        _meta: modernMeta(),
        name: "memos_store",
        arguments: {
          content: "The user prefers dark mode.",
          type: "preference",
          tags: ["ui", "settings"],
        },
      },
      5,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    expect(result.isError).toBeFalsy();

    // Check content array
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Stored memory");

    // Check structuredContent matches outputSchema shape
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toBeDefined();
    const node = structured.node as Record<string, unknown>;
    expect(node).toBeDefined();
    expect(node.id).toBeDefined();
    expect(node.content).toBe("The user prefers dark mode.");
    expect(node.type).toBe("preference");
    expect(node.tags).toEqual(["ui", "settings"]);
    expect(structured.links).toBeDefined();
    expect(Array.isArray(structured.links)).toBe(true);
  });

  test("memos_search end-to-end: finds stored memory", async () => {
    // Store first
    await memos.store("TypeScript is a typed superset of JavaScript.", {
      type: "fact",
      tags: ["programming"],
    });

    const response = await sendRequest(
      clientTransport,
      "tools/call",
      {
        _meta: modernMeta(),
        name: "memos_search",
        arguments: { query: "TypeScript" },
      },
      6,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured).toBeDefined();
    const results = structured.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    const firstNode = results[0].node as Record<string, unknown>;
    expect(firstNode.content).toContain("TypeScript");
  });

  test("memos_forget end-to-end: deletes a memory", async () => {
    const stored = await memos.store("Temporary memory to delete.");
    const id = stored.node.id;

    const response = await sendRequest(
      clientTransport,
      "tools/call",
      {
        _meta: modernMeta(),
        name: "memos_forget",
        arguments: { id },
      },
      7,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    expect(result.isError).toBeFalsy();

    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.id).toBe(id);
    expect(structured.deleted).toBe(true);

    // Verify it's actually gone
    const retrieved = await memos.retrieve(id);
    expect(retrieved).toBeNull();
  });

  test("unsupported protocol version returns error -32022", async () => {
    const response = await sendRequest(
      clientTransport,
      "tools/list",
      {
        _meta: {
          [PROTOCOL_VERSION_KEY]: "1900-01-01",
          [CLIENT_CAPABILITIES_KEY]: {},
        },
      },
      8,
    );

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32022);
    const data = response.error!.data as Record<string, unknown>;
    expect(data.supported).toContain(MODERN_VERSION);
  });
});

describe("MCP Protocol — legacy 2025-era backward compatibility", () => {
  let clientTransport: InMemoryTransport;
  let memos: MemOS;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ clientTransport, memos, cleanup } = await setupServer());
  });

  afterEach(async () => {
    await cleanup();
  });

  test("legacy initialize handshake still works", async () => {
    const response = await sendRequest(
      clientTransport,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
      10,
    );

    expect(response.error).toBeUndefined();
    const result = response.result!;
    expect(result.protocolVersion).toBeDefined();
    expect(result.capabilities).toBeDefined();
    expect(result.serverInfo).toBeDefined();
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("memos");
    expect(serverInfo.version).toBe(getSdkVersion());
  });

  test("legacy tools/list works after initialize", async () => {
    // Initialize first
    await sendRequest(
      clientTransport,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "legacy-client", version: "1.0.0" },
      },
      11,
    );

    // Send initialized notification
    void clientTransport.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // Now list tools
    const response = await sendRequest(clientTransport, "tools/list", {}, 12);
    expect(response.error).toBeUndefined();
    const result = response.result!;
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(6);
  });
});

describe("getMcpTools static metadata", () => {
  test("returns 6 tools with outputSchema", () => {
    const tools = getMcpTools();
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
    }
  });

  test("tool names match expected set", () => {
    const names = getMcpTools().map((t) => t.name);
    expect(names).toEqual([
      "memos_store",
      "memos_search",
      "memos_retrieve",
      "memos_forget",
      "memos_graph",
      "memos_context",
    ]);
  });
});
