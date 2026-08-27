/**
 * Tests for the access-count debounce in SQLiteStorage.
 *
 * The storage buffers `access_count` deltas in memory and flushes on a
 * 500 ms timer (or on `close()`). These tests pin that behavior so
 * future refactors don't accidentally re-introduce a write per read.
 */

import { SQLiteStorage } from "../src/storage/sqlite";
import { MemOS } from "../src/memory";
import type { MemoryNode } from "../src/types";
import { existsSync, unlinkSync } from "node:fs";

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function makeNode(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessed: 0,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

describe("SQLiteStorage access-count debounce", () => {
  test("many rapid reads coalesce; persisted count jumps to the total on flush", async () => {
    const path = `${process.cwd()}/.tmp-access-debounce-1.db`;
    if (existsSync(path)) unlinkSync(path);
    const storage = new SQLiteStorage(path, true);
    const memos = new MemOS({ storage });
    await memos.init();
    await memos.store("alpha", { tags: [] });
    const node = (await memos.listByTag(""))[0] ?? (await memos.search({}))[0]?.node;
    if (!node) throw new Error("seed failed");
    const id = node.id;

    for (let i = 0; i < 100; i += 1) {
      await memos.retrieve(id);
    }
    storage.flushAccessCounts();
    const reloaded = (await memos.retrieve(id))!;
    expect(reloaded.accessCount).toBe(100);

    await memos.close();
    cleanupDb(path);
  });

  test("flushAccessCounts is a no-op when nothing is buffered", async () => {
    const path = `${process.cwd()}/.tmp-access-debounce-2.db`;
    if (existsSync(path)) unlinkSync(path);
    const storage = new SQLiteStorage(path, true);
    const memos = new MemOS({ storage });
    await memos.init();
    await memos.store("seed");

    storage.flushAccessCounts();

    // Open a fresh read-only connection to inspect the persisted value.
    const Database = (await import("better-sqlite3")).default;
    const probe = new Database(path, { readonly: true });
    const row = probe
      .prepare("SELECT access_count FROM nodes LIMIT 1")
      .get() as { access_count: number };
    probe.close();
    expect(row.access_count).toBe(0);

    await memos.close();
    cleanupDb(path);
  });

  test("close() flushes any pending access counts", async () => {
    const path = `${process.cwd()}/.tmp-access-debounce-3.db`;
    if (existsSync(path)) unlinkSync(path);
    const storage = new SQLiteStorage(path, true);
    const memos = new MemOS({ storage });
    await memos.init();
    await memos.store("seed");
    const node = (await memos.search({}))[0]!.node;
    for (let i = 0; i < 5; i += 1) {
      await memos.retrieve(node.id);
    }
    // Don't call flush explicitly — close() must do it.
    await memos.close();

    const Database = (await import("better-sqlite3")).default;
    const probe = new Database(path, { readonly: true });
    const row = probe
      .prepare("SELECT access_count FROM nodes LIMIT 1")
      .get() as { access_count: number };
    probe.close();
    expect(row.access_count).toBe(5);

    cleanupDb(path);
  });
});
