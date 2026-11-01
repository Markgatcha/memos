import { MemOS } from "../src/memory.js";
import {
  MemOSVercelPlugin,
  memosRecallMiddleware,
  type AISDKCallParams,
} from "../src/adapters/vercel.js";

async function fresh(): Promise<MemOS> {
  const memos = new MemOS({
    dbPath: ":memory:",
    embeddings: { enabled: false },
  });
  await memos.init();
  return memos;
}

describe("AI SDK recall middleware", () => {
  it("injects a memory system message before the prompt", async () => {
    const memos = await fresh();
    try {
      await memos.store("User prefers the solarized dark theme");
      const plugin = new MemOSVercelPlugin(memos);
      const middleware = memosRecallMiddleware({ plugin });

      const params: AISDKCallParams = {
        prompt: [{ role: "user", content: "Which theme do I like?" }],
        temperature: 0.2,
      };
      const transformed = await middleware.transformParams!({
        type: "generate",
        params,
        model: {},
      });

      expect(transformed.temperature).toBe(0.2);
      expect(transformed.prompt).toHaveLength(2);
      expect(transformed.prompt![0]!.role).toBe("system");
      expect(String(transformed.prompt![0]!.content)).toContain("solarized");
      expect(transformed.prompt![1]!.role).toBe("user");
    } finally {
      await memos.close();
    }
  });

  it("passes the prompt through when nothing is stored", async () => {
    const memos = await fresh();
    try {
      const plugin = new MemOSVercelPlugin(memos);
      const middleware = memosRecallMiddleware({ plugin });
      const params: AISDKCallParams = {
        prompt: [{ role: "user", content: "What is the airspeed velocity?" }],
      };
      const transformed = await middleware.transformParams!({
        type: "stream",
        params,
        model: {},
      });
      expect(transformed).toBe(params);
    } finally {
      await memos.close();
    }
  });

  it("exposes an ingest tool alongside search/store/forget", async () => {
    const memos = await fresh();
    try {
      const plugin = new MemOSVercelPlugin(memos);
      expect(Object.keys(plugin.tools).sort()).toEqual([
        "forget_memory",
        "ingest_documents",
        "search_memories",
        "store_memory",
      ]);
    } finally {
      await memos.close();
    }
  });
});
