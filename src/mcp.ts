import { createInterface } from "node:readline";

import { MemOS } from "./memory.js";
import type { CreateMemoryInput, MemOSConfig } from "./types.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const toolList: McpTool[] = [
  {
    name: "memos_store",
    description: "Store a durable local memory in MemOS.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "Memory text to store." },
        type: {
          type: "string",
          description: "Memory type, such as fact, preference, or context.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for filtering.",
        },
        ttl: { type: "number", description: "Optional expiration in seconds." },
        namespace: {
          type: "string",
          description:
            "Optional namespace when experimental namespaces are enabled.",
        },
      },
    },
  },
  {
    name: "memos_search",
    description: "Search local memories by full-text query.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Maximum result count." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tag filter.",
        },
        namespace: {
          type: "string",
          description: "Optional namespace filter.",
        },
      },
    },
  },
  {
    name: "memos_retrieve",
    description: "Retrieve one memory by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Memory ID." },
      },
    },
  },
  {
    name: "memos_forget",
    description: "Delete one memory by ID.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Memory ID." },
      },
    },
  },
  {
    name: "memos_graph",
    description: "Return the current memory graph.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "memos_context",
    description: "Build graph-neighbour context around a memory.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "Memory ID." },
        depth: { type: "number", description: "Graph walk depth." },
        maxChars: {
          type: "number",
          description: "Maximum returned context length.",
        },
      },
    },
  },
];

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcId | undefined, payload: unknown): void {
  send({ jsonrpc: "2.0", id, result: payload });
}

function error(id: JsonRpcId | undefined, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function textResponse(text: string, structuredContent?: unknown): unknown {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

async function callTool(
  memos: MemOS,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "memos_store": {
      const content = asString(input.content, "content");
      const createInput: CreateMemoryInput = {
        content,
        type:
          typeof input.type === "string"
            ? (input.type as CreateMemoryInput["type"])
            : "fact",
      };
      const tags = asStringArray(input.tags);
      if (tags) createInput.tags = tags;
      if (typeof input.ttl === "number") createInput.ttl = input.ttl;
      if (typeof input.namespace === "string")
        createInput.namespace = input.namespace;
      const stored = await memos.store(content, createInput);
      return textResponse(`Stored memory ${stored.node.id}.`, stored);
    }
    case "memos_search": {
      const query = asString(input.query, "query");
      const found = await memos.search({
        query,
        limit: asNumber(input.limit, 10),
        tags: asStringArray(input.tags),
        namespace:
          typeof input.namespace === "string" ? input.namespace : undefined,
      });
      return textResponse(`Found ${found.length} memories.`, {
        results: found,
      });
    }
    case "memos_retrieve": {
      const id = asString(input.id, "id");
      const node = await memos.retrieve(id);
      return textResponse(node ? node.content : `Memory not found: ${id}`, {
        node,
      });
    }
    case "memos_forget": {
      const id = asString(input.id, "id");
      const deleted = await memos.forget(id);
      return textResponse(
        deleted ? `Forgot memory ${id}.` : `Memory not found: ${id}.`,
        { id, deleted },
      );
    }
    case "memos_graph": {
      const graph = await memos.getGraph();
      return textResponse(
        `Memory graph has ${graph.nodes.length} nodes and ${graph.edges.length} edges.`,
        graph,
      );
    }
    case "memos_context": {
      const id = asString(input.id, "id");
      const context = await memos.injectContext(
        id,
        asNumber(input.depth, 1),
        asNumber(input.maxChars, 2000),
      );
      return textResponse(context, { id, context });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  const close = async (): Promise<void> => {
    rl.close();
    await memos.close();
  };

  process.once("SIGINT", () => {
    void close().then(() => process.exit(0));
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      error(null, -32700, "Parse error");
      continue;
    }

    try {
      switch (request.method) {
        case "initialize":
          result(request.id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "memos", version: "1.5.0-beta.1" },
          });
          break;
        case "notifications/initialized":
          break;
        case "tools/list":
          result(request.id, { tools: toolList });
          break;
        case "tools/call": {
          const params = asObject(request.params);
          const name = asString(params.name, "name");
          const args = asObject(params.arguments);
          result(request.id, await callTool(memos, name, args));
          break;
        }
        default:
          if (request.id !== undefined) {
            error(
              request.id,
              -32601,
              `Method not found: ${request.method ?? ""}`,
            );
          }
      }
    } catch (err) {
      error(
        request.id,
        -32000,
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }

  await memos.close();
}

export function getMcpTools(): readonly McpTool[] {
  return toolList;
}
