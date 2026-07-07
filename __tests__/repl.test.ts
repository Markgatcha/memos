/**
 * Tests for the `memos repl` interactive shell.
 *
 * We exercise the command-dispatch function directly (not the readline
 * loop) so the tests don't need to drive a real TTY.
 */

import { createReplHandlers } from "../src/repl";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class FixedProvider implements EmbeddingProvider {
  public readonly id = "fixed";
  public readonly model = "fixed-v1";
  public readonly dimensions = 4;
  async embed(_text: string): Promise<EmbeddingVector> {
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

describe("memos repl handlers", () => {
  test("help command lists available commands", async () => {
    const memos = makeMemos();
    await memos.init();
    const handlers = createReplHandlers(memos);
    const out: string[] = [];
    await handlers.dispatch("help", out);
    expect(out.join("\n")).toMatch(/Available commands/);
    expect(out.join("\n")).toMatch(/store/);
    expect(out.join("\n")).toMatch(/search/);
    expect(out.join("\n")).toMatch(/graph/);
    expect(out.join("\n")).toMatch(/flush-embeddings/);
    await memos.close();
  });

  test("empty input is a no-op", async () => {
    const memos = makeMemos();
    await memos.init();
    const handlers = createReplHandlers(memos);
    const out: string[] = [];
    await handlers.dispatch("", out);
    expect(out).toEqual([]);
    await memos.close();
  });

  test("store command persists and prints id", async () => {
    const memos = makeMemos();
    await memos.init();
    const handlers = createReplHandlers(memos);
    const out: string[] = [];
    await handlers.dispatch(`store "hello world"`, out);
    expect(out.join("\n")).toMatch(/Stored memory/);
    const ids = await memos.listByTag("");
    // "hello world" is stored as content; listByTag("") matches no tag
    // but we want to verify the memory exists. Use a tagged variant.
    const all = await memos.search({});
    expect(all.length).toBe(1);
    await memos.close();
  });

  test("count command prints the memory count", async () => {
    const memos = makeMemos();
    await memos.init();
    const handlers = createReplHandlers(memos);
    await memos.store("alpha");
    await memos.store("beta");
    const out: string[] = [];
    await handlers.dispatch("count", out);
    expect(out.join("\n")).toMatch(/2 memories/);
    await memos.close();
  });

  test("unknown command prints a hint", async () => {
    const memos = makeMemos();
    await memos.init();
    const handlers = createReplHandlers(memos);
    const out: string[] = [];
    await handlers.dispatch("banana", out);
    expect(out.join("\n")).toMatch(/Unknown command/);
    await memos.close();
  });

  test("search command returns ranked results", async () => {
    const memos = makeMemos();
    await memos.init();
    await memos.store("dark mode preference");
    await memos.store("light mode preference");
    const handlers = createReplHandlers(memos);
    const out: string[] = [];
    await handlers.dispatch("search dark mode", out);
    const joined = out.join("\n");
    expect(joined).toMatch(/Found/);
    expect(joined).toMatch(/dark mode preference/);
    await memos.close();
  });

  test("graph command prints node + edge counts", async () => {
    const memos = makeMemos();
    await memos.init();
    const a = await memos.store("alpha");
    const b = await memos.store("beta");
    await memos.link(a.node.id, b.node.id);
    const handlers = createReplHandlers(memos);
    const out: string[] = [];
    await handlers.dispatch("graph", out);
    expect(out.join("\n")).toMatch(/Memory Graph: 2 nodes, 1 edges/);
    await memos.close();
  });

  test("exit command is recognized", async () => {
    const memos = makeMemos();
    await memos.init();
    const handlers = createReplHandlers(memos);
    expect(handlers.shouldExit("exit")).toBe(true);
    expect(handlers.shouldExit("quit")).toBe(true);
    expect(handlers.shouldExit("q")).toBe(true);
    expect(handlers.shouldExit("graph")).toBe(false);
    await memos.close();
  });
});
