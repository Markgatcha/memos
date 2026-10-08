/**
 * Regression tests for the Ebbinghaus reinforcement write path.
 *
 * `bumpAccessCounters` used to call `storage.updateNode()`, which
 * stamps `updatedAt` and silently ignores the `accessCount` /
 * `lastAccessed` fields in its UPDATE statement. That made a plain
 * `search()` do two damaging things:
 *
 *  1. Rewrite `updated_at` on recalled nodes with no tamper-log entry,
 *     so `verifyTamperLog()` reported the whole store as "edited
 *     without logging" â€” a false tamper alarm triggered by a read. The
 *     phantom `updatedAt` also made recalled memories look freshly
 *     written to recency sorts, sync last-write-wins, and the
 *     embedding-freshness check.
 *  2. Never persist the reinforcement it existed to record, so
 *     `accessCount` stayed 0 and the forgetting curve could never
 *     strengthen a frequently-recalled memory.
 */

import { describe, test, expect } from "@jest/globals";
import { SQLiteStorage } from "../src/storage/sqlite";
import { MemOS } from "../src/memory";
import { verifyTamperLog } from "../src/tamper-log";

function makeStore() {
  const storage = new SQLiteStorage(":memory:", true);
  const memos = new MemOS({
    storage,
    experimental: { ebbinghaus: true },
    embeddings: { enabled: false },
    embeddingQueue: { synchronous: true },
  });
  return { storage, memos };
}

describe("Ebbinghaus reinforcement must not mutate updatedAt", () => {
  test("a search leaves updatedAt untouched", async () => {
    const { storage, memos } = makeStore();
    await memos.init();
    const a = await memos.store("the cat sat on the mat today");
    await memos.store("a dog ran through the park quickly");

    const before = await storage.peekNode(a.node.id);

    await memos.search("cat mat", { limit: 5 });
    await new Promise((r) => setTimeout(r, 400));

    const after = await storage.peekNode(a.node.id);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });

  test("a search does not invalidate the tamper-evident log", async () => {
    const { storage, memos } = makeStore();
    await memos.init();
    await memos.store("the cat sat on the mat today");
    await memos.store("a dog ran through the park quickly");

    const clean = await verifyTamperLog(storage);
    expect(clean.ok).toBe(true);

    await memos.search("cat mat", { limit: 5 });
    await new Promise((r) => setTimeout(r, 400));

    const after = await verifyTamperLog(storage);
    expect(after.ok).toBe(true);
    expect(after.issues).toEqual([]);
  });

  test("access reinforcement is persisted by the debounced counter", async () => {
    const { storage, memos } = makeStore();
    await memos.init();
    const a = await memos.store("the cat sat on the mat today");
    await memos.store("a dog ran through the park quickly");

    // Distinct queries: the search cache short-circuits repeat queries
    // before postSortResults (and therefore before reinforcement).
    for (const q of ["cat", "mat", "cat sat mat"]) {
      await memos.search(q, { limit: 5 });
      await new Promise((r) => setTimeout(r, 400));
      storage.flushAccessCounts();
    }

    const node = await storage.peekNode(a.node.id);
    expect(node!.accessCount).toBeGreaterThanOrEqual(3);
  });

  test("lastAccessed advances so LRU eviction ordering stays correct", async () => {
    const { storage, memos } = makeStore();
    await memos.init();
    const a = await memos.store("the cat sat on the mat today");
    await memos.store("a dog ran through the park quickly");
    const before = await storage.peekNode(a.node.id);

    await memos.search("cat mat", { limit: 5 });
    storage.flushAccessCounts();

    const after = await storage.peekNode(a.node.id);
    expect(after!.lastAccessed).toBeGreaterThan(before!.lastAccessed);
  });
});

describe("recordAccess adapter contract", () => {
  test("updateNode still refuses to persist access telemetry silently", async () => {
    // Documents why read telemetry must not use updateNode: the fields
    // are absent from its UPDATE statement, so they are dropped.
    const { storage, memos } = makeStore();
    await memos.init();
    const a = await memos.store("the cat sat on the mat today");
    const before = await storage.peekNode(a.node.id);

    await storage.updateNode(a.node.id, {
      accessCount: (before!.accessCount || 0) + 1,
      lastAccessed: 9999999999999,
    });

    const after = await storage.peekNode(a.node.id);
    expect(after!.lastAccessed).not.toBe(9999999999999);
  });

  test("recordAccess bumps access_count in SQL without touching updated_at", async () => {
    const { storage, memos } = makeStore();
    await memos.init();
    const a = await memos.store("the cat sat on the mat today");
    const before = await storage.peekNode(a.node.id);

    storage.recordAccess(a.node.id);
    storage.flushAccessCounts();

    const after = await storage.peekNode(a.node.id);
    expect(after!.accessCount).toBe((before!.accessCount || 0) + 1);
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });
});
