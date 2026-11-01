/**
 * Vercel AI SDK adapter tests.
 *
 * These cover the contract the `ai` package relies on: the AI SDK 5 tool
 * shape (`description` / `inputSchema` / `execute`, NOT v4's `parameters`),
 * schema validation actually rejecting bad model output, and the tools
 * round-tripping through a real MemOS instance.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemOSVercelPlugin, createVercelMemory } from "../src/adapters/vercel";
import { MemOS } from "../src/memory";

let dir: string;

// Real-embedding seam: the default `fastembed` provider loads an ONNX model,
// which cannot run under Jest's `--experimental-vm-modules` (the native
// onnxruntime addon's Float32Array lives in a different realm than the VM's —
// every embed throws "A float32 tensor's data must be type of function
// Float32Array()"). The built-in `local-hash` provider is the repo's standard
// offline seam: deterministic, no model download, and synonym-aware so
// paraphrase queries still reach the semantic leg.
const OFFLINE_EMBEDDINGS = {
  enabled: true,
  provider: "local-hash",
} as const;

async function makePlugin(): Promise<{
  memos: MemOS;
  plugin: MemOSVercelPlugin;
}> {
  const { memos, plugin } = await createVercelMemory({
    dbPath: join(dir, "vercel.db"),
    embeddings: OFFLINE_EMBEDDINGS,
  });
  return { memos, plugin };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memos-vercel-"));
});

afterEach(() => {
  // The sandbox can hold a lock on the SQLite file briefly; a failed
  // cleanup must never fail the suite.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("tool shape", () => {
  test("exposes the four memory tools", async () => {
    const { memos, plugin } = await makePlugin();
    expect(Object.keys(plugin.tools).sort()).toEqual([
      "forget_memory",
      "ingest_documents",
      "search_memories",
      "store_memory",
    ]);
    await memos.close();
  });

  test("uses the AI SDK 5 shape: description + inputSchema + execute", async () => {
    const { memos, plugin } = await makePlugin();
    for (const [name, tool] of Object.entries(plugin.tools)) {
      // Jest's expect takes no custom message, so assert the whole shape in
      // one object — a failure then names the offending tool in the diff.
      expect({
        name,
        hasDescription:
          typeof tool.description === "string" && tool.description.length > 0,
        hasExecute: typeof tool.execute === "function",
        hasInputSchema: tool.inputSchema !== undefined,
        // AI SDK 5 renamed `parameters` to `inputSchema`; a leftover
        // `parameters` key would be silently ignored by the SDK.
        hasLegacyParameters: "parameters" in tool,
      }).toEqual({
        name,
        hasDescription: true,
        hasExecute: true,
        hasInputSchema: true,
        hasLegacyParameters: false,
      });
    }
    await memos.close();
  });

  test("inputSchema is a real Zod schema", async () => {
    const { memos, plugin } = await makePlugin();
    const schema = plugin.tools.search_memories.inputSchema;
    expect(typeof schema.safeParse).toBe("function");
    expect(schema.safeParse({ query: "hello" }).success).toBe(true);
    await memos.close();
  });
});

describe("schema validation", () => {
  test("search_memories rejects an empty query", async () => {
    const { memos, plugin } = await makePlugin();
    const result = plugin.tools.search_memories.inputSchema.safeParse({
      query: "",
    });
    expect(result.success).toBe(false);
    await memos.close();
  });

  test("search_memories rejects a limit above the cap", async () => {
    const { memos, plugin } = await makePlugin();
    const result = plugin.tools.search_memories.inputSchema.safeParse({
      query: "x",
      limit: 500,
    });
    expect(result.success).toBe(false);
    await memos.close();
  });

  test("store_memory rejects an unknown memory type", async () => {
    const { memos, plugin } = await makePlugin();
    const result = plugin.tools.store_memory.inputSchema.safeParse({
      content: "something",
      type: "not-a-type",
    });
    expect(result.success).toBe(false);
    await memos.close();
  });

  test("store_memory accepts a valid payload", async () => {
    const { memos, plugin } = await makePlugin();
    const result = plugin.tools.store_memory.inputSchema.safeParse({
      content: "The user prefers dark mode",
      type: "preference",
      tags: ["ui"],
    });
    expect(result.success).toBe(true);
    await memos.close();
  });
});

describe("tools round-trip through MemOS", () => {
  test("store then search finds the memory", async () => {
    const { memos, plugin } = await makePlugin();

    const stored = (await plugin.tools.store_memory.execute({
      content: "The user's favourite editor is Neovim",
      type: "preference",
    })) as { id: string; stored: boolean };
    expect(stored.stored).toBe(true);
    expect(stored.id.length).toBeGreaterThan(0);

    const found = (await plugin.tools.search_memories.execute({
      query: "favourite editor",
    })) as { memories: Array<{ id: string; content: string }> };

    expect(found.memories.some((m) => m.id === stored.id)).toBe(true);
    await memos.close();
  });

  test("forget_memory removes the memory", async () => {
    const { memos, plugin } = await makePlugin();

    const stored = (await plugin.tools.store_memory.execute({
      content: "A fact that will be deleted",
    })) as { id: string };

    const forgotten = (await plugin.tools.forget_memory.execute({
      memoryId: stored.id,
    })) as { id: string; forgotten: boolean };

    expect(forgotten.forgotten).toBe(true);
    expect(plugin.getMemoryCount()).toBe(0);
    await memos.close();
  });

  test("search on an empty store returns no memories", async () => {
    const { memos, plugin } = await makePlugin();
    const found = (await plugin.tools.search_memories.execute({
      query: "anything at all",
    })) as { memories: unknown[] };
    expect(found.memories).toEqual([]);
    await memos.close();
  });
});

describe("plugin helpers", () => {
  test("remember and recall work directly", async () => {
    const { memos, plugin } = await makePlugin();
    const node = await plugin.remember("The user lives in Toronto");
    expect(node.id.length).toBeGreaterThan(0);

    const results = await plugin.recall("where does the user live");
    expect(results.length).toBeGreaterThan(0);
    await memos.close();
  });

  test("getMemoryContext returns empty string when nothing is relevant", async () => {
    const { memos, plugin } = await makePlugin();
    const context = await plugin.getMemoryContext(
      [{ role: "user", content: "what is the capital of Peru" }],
      { extract: false },
    );
    expect(context).toBe("");
    await memos.close();
  });

  test("getMemoryContext surfaces a stored preference", async () => {
    const { memos, plugin } = await makePlugin();
    await plugin.remember("The user prefers dark mode in every editor");

    const context = await plugin.getMemoryContext(
      [{ role: "user", content: "what theme do I prefer" }],
      { extract: false },
    );
    expect(context).toContain("dark mode");
    expect(context).toContain("Relevant memories");
    await memos.close();
  });

  test("clearMemories empties the store", async () => {
    const { memos, plugin } = await makePlugin();
    await plugin.remember("something");
    expect(plugin.getMemoryCount()).toBeGreaterThan(0);
    await plugin.clearMemories();
    expect(plugin.getMemoryCount()).toBe(0);
    await memos.close();
  });

  test("wraps an existing MemOS instance without re-initialising it", async () => {
    const memos = new MemOS({
      dbPath: join(dir, "wrapped.db"),
      embeddings: OFFLINE_EMBEDDINGS,
    });
    await memos.init();
    const plugin = new MemOSVercelPlugin(memos, { maxContextMemories: 3 });
    expect(plugin.memos).toBe(memos);
    await plugin.remember("wrapped instance memory");
    expect(plugin.getMemoryCount()).toBe(1);
    await memos.close();
  });
});
