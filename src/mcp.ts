/**
 * MCP server for MemOS — Model Context Protocol 2026-07-28.
 *
 * Built on the official `@modelcontextprotocol/server` v2 SDK, which
 * implements the 2026-07-28 spec (stateless core, `server/discover`,
 * per-request `_meta` envelope, `ttlMs`/`cacheScope` on list results,
 * `outputSchema` on tools). The SDK's `serveStdio` entry is dual-era:
 * it speaks the modern 2026-07-28 protocol AND falls back to the legacy
 * 2025-era `initialize` handshake for older clients.
 *
 * Transport: stdio only (the shipped transport). HTTP/SSE is deferred.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { MemOS } from "./memory.js";
import type { MemOSConfig } from "./types.js";
import { getSdkVersion } from "./version.js";

// ---------------------------------------------------------------------------
// Zod schemas for MemoryNode / MemoryEdge / ScoredMemory (output validation)
// ---------------------------------------------------------------------------

const memoryNodeSchema = z.object({
  id: z.string(),
  content: z.string(),
  summary: z.string(),
  type: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  importance: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  accessCount: z.number(),
  lastAccessed: z.number(),
  tags: z.array(z.string()),
  expiresAt: z.number().nullable(),
  namespace: z.string(),
  validFrom: z.number().nullable(),
  validTo: z.number().nullable(),
  source: z.string(),
  trustScore: z.number(),
  confidence: z.number().optional(),
  evidenceCount: z.number().optional(),
});

const memoryEdgeSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  relation: z.string(),
  weight: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});

const scoredMemorySchema = z.object({
  node: memoryNodeSchema,
  score: z.number(),
  scores: z
    .object({
      keyword: z.number().optional(),
      semantic: z.number().optional(),
      hybrid: z.number().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(server: McpServer, memos: MemOS): void {
  server.registerTool(
    "memos_store",
    {
      title: "Store Memory",
      description: "Store a durable local memory in MemOS.",
      inputSchema: z.object({
        content: z.string().describe("Memory text to store."),
        type: z
          .string()
          .optional()
          .describe("Memory type, such as fact, preference, or context."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags for filtering."),
        ttl: z.number().optional().describe("Optional expiration in seconds."),
        namespace: z
          .string()
          .optional()
          .describe(
            "Optional namespace when experimental namespaces are enabled.",
          ),
      }),
      outputSchema: z.object({
        node: memoryNodeSchema,
        links: z.array(memoryEdgeSchema),
      }),
    },
    async ({ content, type, tags, ttl, namespace }) => {
      const stored = await memos.store(content, {
        type:
          (type as
            | "fact"
            | "preference"
            | "context"
            | "relationship"
            | "entity"
            | "custom") ?? "fact",
        ...(tags ? { tags } : {}),
        ...(ttl !== undefined ? { ttl } : {}),
        ...(namespace ? { namespace } : {}),
      });
      return {
        content: [
          { type: "text" as const, text: `Stored memory ${stored.node.id}.` },
        ],
        structuredContent: stored,
      };
    },
  );

  server.registerTool(
    "memos_search",
    {
      title: "Search Memories",
      description: "Search local memories by full-text query.",
      inputSchema: z.object({
        query: z.string().describe("Search query."),
        limit: z.number().optional().describe("Maximum result count."),
        tags: z.array(z.string()).optional().describe("Optional tag filter."),
        namespace: z.string().optional().describe("Optional namespace filter."),
      }),
      outputSchema: z.object({
        results: z.array(scoredMemorySchema),
      }),
    },
    async ({ query, limit, tags, namespace }) => {
      const found = await memos.search({
        query,
        limit: limit ?? 10,
        ...(tags ? { tags } : {}),
        ...(namespace ? { namespace } : {}),
      });
      return {
        content: [
          { type: "text" as const, text: `Found ${found.length} memories.` },
        ],
        structuredContent: { results: found },
      };
    },
  );

  server.registerTool(
    "memos_retrieve",
    {
      title: "Retrieve Memory",
      description: "Retrieve one memory by ID.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
      }),
      outputSchema: z.object({
        node: memoryNodeSchema.nullable(),
      }),
    },
    async ({ id }) => {
      const node = await memos.retrieve(id);
      return {
        content: [
          {
            type: "text" as const,
            text: node ? node.content : `Memory not found: ${id}`,
          },
        ],
        structuredContent: { node },
      };
    },
  );

  server.registerTool(
    "memos_forget",
    {
      title: "Forget Memory",
      description: "Delete one memory by ID.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
      }),
      outputSchema: z.object({
        id: z.string(),
        deleted: z.boolean(),
      }),
    },
    async ({ id }) => {
      const deleted = await memos.forget(id);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted ? `Forgot memory ${id}.` : `Memory not found: ${id}.`,
          },
        ],
        structuredContent: { id, deleted },
      };
    },
  );

  server.registerTool(
    "memos_graph",
    {
      title: "Memory Graph",
      description: "Return the current memory graph.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        nodes: z.array(memoryNodeSchema),
        edges: z.array(memoryEdgeSchema),
      }),
    },
    async () => {
      const graph = await memos.getGraph();
      return {
        content: [
          {
            type: "text" as const,
            text: `Memory graph has ${graph.nodes.length} nodes and ${graph.edges.length} edges.`,
          },
        ],
        structuredContent: graph,
      };
    },
  );

  server.registerTool(
    "memos_context",
    {
      title: "Memory Context",
      description: "Build graph-neighbour context around a memory.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
        depth: z.number().optional().describe("Graph walk depth."),
        maxChars: z
          .number()
          .optional()
          .describe("Maximum returned context length."),
      }),
      outputSchema: z.object({
        id: z.string(),
        context: z.string(),
      }),
    },
    async ({ id, depth, maxChars }) => {
      const context = await memos.injectContext(
        id,
        depth ?? 1,
        maxChars ?? 2000,
      );
      return {
        content: [{ type: "text" as const, text: context }],
        structuredContent: { id, context },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured McpServer instance for MemOS.
 * Exported for testing and advanced use cases.
 */
export function createMcpServer(memos: MemOS): McpServer {
  const server = new McpServer(
    { name: "memos", version: getSdkVersion() },
    {
      capabilities: { tools: {} },
      instructions:
        "MemOS local-first agent memory. Use memos_store to persist memories, " +
        "memos_search to find them, memos_retrieve/memos_forget for individual " +
        "records, memos_graph for the full graph, and memos_context for " +
        "graph-neighbour context around a memory.",
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
        "server/discover": { ttlMs: 600_000, cacheScope: "private" },
      },
    },
  );
  registerTools(server, memos);
  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the MemOS MCP server over stdio.
 *
 * Speaks MCP protocol revision 2026-07-28 (modern stateless core with
 * `server/discover`) and falls back to the legacy 2025-era `initialize`
 * handshake for older clients. Blocks until the connection closes.
 */
export async function runMcpServer(config: MemOSConfig = {}): Promise<void> {
  const memos = new MemOS({
    ...config,
    experimental: {
      semanticSearch: true,
      graphViz: true,
      namespaces: true,
      contextInjection: true,
      ...config.experimental,
    },
  });
  await memos.init();

  const handle = serveStdio(() => createMcpServer(memos));

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await handle.close();
    await memos.close();
  };

  process.once("SIGINT", () => {
    void cleanup().then(() => process.exit(0));
  });

  // Block until stdin closes (client disconnects). The StdioServerTransport
  // keeps the event loop alive via its stdin "data" listener; when the
  // client disconnects, stdin emits "end" and we clean up.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
  });

  await cleanup();
}

// ---------------------------------------------------------------------------
// Static tool metadata (for programmatic consumers / tests)
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const TOOL_METADATA: McpToolInfo[] = [
  {
    name: "memos_store",
    description: "Store a durable local memory in MemOS.",
    inputSchema: z.toJSONSchema(
      z.object({
        content: z.string(),
        type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        ttl: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema, links: z.array(memoryEdgeSchema) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_search",
    description: "Search local memories by full-text query.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        limit: z.number().optional(),
        tags: z.array(z.string()).optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ results: z.array(scoredMemorySchema) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_retrieve",
    description: "Retrieve one memory by ID.",
    inputSchema: z.toJSONSchema(z.object({ id: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema.nullable() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_forget",
    description: "Delete one memory by ID.",
    inputSchema: z.toJSONSchema(z.object({ id: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(
      z.object({ id: z.string(), deleted: z.boolean() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_graph",
    description: "Return the current memory graph.",
    inputSchema: z.toJSONSchema(z.object({})) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        nodes: z.array(memoryNodeSchema),
        edges: z.array(memoryEdgeSchema),
      }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_context",
    description: "Build graph-neighbour context around a memory.",
    inputSchema: z.toJSONSchema(
      z.object({
        id: z.string(),
        depth: z.number().optional(),
        maxChars: z.number().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ id: z.string(), context: z.string() }),
    ) as Record<string, unknown>,
  },
];

/**
 * Return static metadata about the MCP tools exposed by MemOS.
 * Useful for programmatic consumers and tests that need tool definitions
 * without spinning up a live server connection.
 */
export function getMcpTools(): readonly McpToolInfo[] {
  return TOOL_METADATA;
}
