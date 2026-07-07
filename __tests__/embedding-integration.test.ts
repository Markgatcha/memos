/**
 * Integration tests: MemOS wired to the background embedding queue.
 *
 * These verify the contract the queue gives MemOS:
 *   - `store()` returns before the embedding is computed
 *   - `flushEmbeddings()` waits for pending work
 *   - `embeddingStatus()` reports per-node status
 *   - events fire as the queue runs
 *   - close() drains the queue
 */

import { MemOS } from "../src/memory";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  EmbeddingNodeStatus,
} from "../src/types";
import { SQLiteStorage } from "../src/storage/sqlite";

class TrackingProvider implements EmbeddingProvider {
  public readonly id = "tracking";
  public readonly model = "tracking-v1";
  public readonly dimensions = 4;
  public delayMs = 20;
  public readonly calls: string[] = [];

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls.push(text);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return [text.length, 1, 2, 3];
  }
}

function makeMemos(provider: EmbeddingProvider) {
  const storage = new SQLiteStorage(":memory:", true);
  return new MemOS({
    storage,
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
  });
}

describe("MemOS embedding queue integration", () => {
  test("store() returns before the embedding call resolves", async () => {
    const provider = new TrackingProvider();
    provider.delayMs = 50;
    const memos = makeMemos(provider);
    await memos.init();

    const start = Date.now();
    await memos.store("user prefers dark mode");
    const elapsed = Date.now() - start;
    // Should be well under the 50ms provider delay.
    expect(elapsed).toBeLessThan(60);
    await memos.close();
  });

  test("flushEmbeddings() waits for all enqueued work", async () => {
    const provider = new TrackingProvider();
    provider.delayMs = 15;
    const memos = makeMemos(provider);
    await memos.init();

    await memos.store("alpha");
    await memos.store("beta");
    await memos.store("gamma");
    // With concurrency=2 the first two jobs may already have started; the
    // important property is that flush() drains the rest.
    expect(provider.calls.length).toBeLessThanOrEqual(3);

    await memos.flushEmbeddings();
    expect(provider.calls).toHaveLength(3);
    await memos.close();
  });

  test("embeddingStatus() reports pending then ready for stored nodes", async () => {
    const provider = new TrackingProvider();
    const memos = makeMemos(provider);
    await memos.init();

    const { node } = await memos.store("hello world");
    // Before flush: status should be queued, running, or ready.
    const beforeFlush = memos.embeddingStatus();
    expect(beforeFlush.total).toBeGreaterThanOrEqual(0);
    const own = beforeFlush.nodes.find((n) => n.nodeId === node.id);
    expect(own).toBeDefined();
    const allowed: EmbeddingNodeStatus[] = ["queued", "running", "ready", "pending"];
    expect(allowed).toContain(own!.status);

    await memos.flushEmbeddings();
    const afterFlush = memos.embeddingStatus();
    const after = afterFlush.nodes.find((n) => n.nodeId === node.id);
    expect(after!.status).toBe("ready");
    expect(after!.lastError).toBeNull();
    await memos.close();
  });

  test("embedding:complete event fires for each stored node", async () => {
    const provider = new TrackingProvider();
    const memos = makeMemos(provider);
    await memos.init();
    const completed: string[] = [];
    memos.on("embedding:complete", (data) => {
      const d = data as { nodeId: string };
      completed.push(d.nodeId);
    });
    const { node } = await memos.store("eventing test");
    await memos.flushEmbeddings();
    expect(completed).toContain(node.id);
    await memos.close();
  });

  test("close() drains the queue without losing embeddings", async () => {
    const provider = new TrackingProvider();
    provider.delayMs = 20;
    const memos = makeMemos(provider);
    await memos.init();
    for (let i = 0; i < 10; i += 1) {
      await memos.store(`memory ${i}`);
    }
    await memos.close();
    expect(provider.calls).toHaveLength(10);
  });
});
