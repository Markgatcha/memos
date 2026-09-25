/**
 * MCP tool annotation tests — every tool registered by MemOS must carry
 * explicit readOnlyHint / destructiveHint / idempotentHint / openWorldHint
 * annotations, both in the static getMcpTools() metadata and on the wire
 * (tools/list). The MCP defaults when annotations are absent are
 * readOnlyHint=false, destructiveHint=true, openWorldHint=true, so a tool
 * missing annotations would trigger "Allow" prompts on pure reads.
 */

import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { MemOS } from "../src/memory";
import { createMcpServer, getMcpTools, TOOL_ANNOTATIONS } from "../src/mcp";

const TEST_DB = ":memory:";
const MODERN_VERSION = "2026-07-28";

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

const HINT_KEYS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

describe("getMcpTools() annotations", () => {
  test("all 21 tools carry all four annotation hints", () => {
    const tools = getMcpTools();
    expect(tools).toHaveLength(21);
    const failures: string[] = [];
    for (const tool of tools) {
      if (!tool.annotations || typeof tool.annotations !== "object") {
        failures.push(`${tool.name}: annotations missing`);
        continue;
      }
      for (const key of HINT_KEYS) {
        if (typeof tool.annotations[key] !== "boolean") {
          failures.push(`${tool.name}: ${key} missing or not boolean`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("static metadata annotations match the shared TOOL_ANNOTATIONS map", () => {
    for (const tool of getMcpTools()) {
      expect(TOOL_ANNOTATIONS[tool.name]).toBeDefined();
      expect(tool.annotations).toEqual(TOOL_ANNOTATIONS[tool.name]);
    }
  });

  test("spot-check: pure read (memos_search)", () => {
    const tool = getMcpTools().find((t) => t.name === "memos_search")!;
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("spot-check: destructive op (memos_forget)", () => {
    const tool = getMcpTools().find((t) => t.name === "memos_forget")!;
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("spot-check: idempotent op (memos_reindex)", () => {
    const tool = getMcpTools().find((t) => t.name === "memos_reindex")!;
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  test("spot-check: write (memos_store)", () => {
    const tool = getMcpTools().find((t) => t.name === "memos_store")!;
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("spot-check: destructive ops (memos_revert, memos_consolidate)", () => {
    for (const name of ["memos_revert", "memos_consolidate"]) {
      const tool = getMcpTools().find((t) => t.name === name)!;
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(tool.annotations.destructiveHint).toBe(true);
    }
  });

  test("no tool reaches outside the local DB: openWorldHint is false everywhere", () => {
    for (const tool of getMcpTools()) {
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  test("titles are unchanged (annotations only)", () => {
    // Sanity: this stream must not reword human-facing titles. Spot-check
    // that wire-relevant metadata besides annotations is untouched.
    const names = getMcpTools().map((t) => t.name);
    expect(names).toEqual([
      "memos_store",
      "memos_search",
      "memos_retrieve",
      "memos_forget",
      "memos_link",
      "memos_quarantine_release",
      "memos_graph",
      "memos_context",
      "memos_context_pack",
      "memos_search_temporal",
      "memos_set_validity",
      "memos_supersede",
      "memos_set_trust",
      "memos_extract_facts",
      "memos_diagnostics",
      "memos_reindex",
      "memos_consolidate",
      "memos_usage",
      "memos_history",
      "memos_revert",
      "memos_reminders",
    ]);
  });
});

describe("tools/list wire annotations", () => {
  let clientTransport: InMemoryTransport;
  let memos: MemOS;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    memos = new MemOS({
      dbPath: TEST_DB,
      embeddings: { enabled: false },
    });
    await memos.init();
    const [client, server] = InMemoryTransport.createLinkedPair();
    clientTransport = client;
    const handle = serveStdio(() => createMcpServer(memos), {
      transport: server,
    });
    cleanup = async () => {
      await handle.close();
      await memos.close();
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  test("every tool on the wire carries all four hints matching static metadata", async () => {
    const id = 1;
    const response = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timeout waiting for tools/list")),
          10_000,
        );
        clientTransport.onmessage = (message: unknown) => {
          const msg = message as { id?: number; result?: unknown };
          if (msg.id === id) {
            clearTimeout(timeout);
            clientTransport.onmessage = undefined;
            resolve(msg as Record<string, unknown>);
          }
        };
        void clientTransport.send({
          jsonrpc: "2.0",
          id,
          method: "tools/list",
          params: {
            _meta: {
              [PROTOCOL_VERSION_KEY]: MODERN_VERSION,
              [CLIENT_CAPABILITIES_KEY]: {},
              [CLIENT_INFO_KEY]: { name: "test-client", version: "1.0.0" },
            },
          },
        });
      },
    );

    const result = response.result as {
      tools: Array<{ name: string; annotations?: Record<string, unknown> }>;
    };
    expect(result.tools).toHaveLength(21);
    const byName = new Map(getMcpTools().map((t) => [t.name, t.annotations]));
    const failures: string[] = [];
    for (const tool of result.tools) {
      const ann = tool.annotations;
      if (!ann || typeof ann !== "object") {
        failures.push(`${tool.name}: annotations missing on wire`);
        continue;
      }
      for (const key of HINT_KEYS) {
        if (typeof ann[key] !== "boolean") {
          failures.push(`${tool.name}: ${key} missing or not boolean on wire`);
        }
      }
      const expected = byName.get(tool.name);
      if (expected && JSON.stringify(ann) !== JSON.stringify(expected)) {
        failures.push(
          `${tool.name}: wire annotations ${JSON.stringify(ann)} != static ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});
