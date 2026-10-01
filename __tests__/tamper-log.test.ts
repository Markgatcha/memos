/**
 * Tests for the tamper-evident mutation log (src/tamper-log.ts).
 *
 * Every mutation (store / import / update / forget) must append a
 * hash-chained entry, and verifyTamperLog() must catch: edited log
 * rows, deleted log rows, direct DB edits (content AND metadata),
 * direct DB deletes, and resurrected nodes.
 */

import { describe, it, expect } from "@jest/globals";
import type Database from "better-sqlite3";
import { MemOS } from "../src/memory.js";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import {
  canonicalJson,
  nodeHash,
  entryHash,
  GENESIS_PREV,
  verifyTamperLog,
} from "../src/tamper-log.js";
import type { MemoryNode, TamperLogEntry } from "../src/types.js";

async function makeMemos() {
  const storage = new SQLiteStorage(":memory:", true);
  const memos = new MemOS({ storage, embeddingQueue: { synchronous: true } });
  await memos.init();
  return { memos, storage };
}

/** Raw handle to the test DB for simulating an attacker. */
function rawDb(storage: SQLiteStorage): Database.Database {
  return (storage as unknown as { db: Database.Database }).db;
}

/** Minimal node for hashing tests. */
function fakeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id: "node-1",
    content: "hello",
    summary: "hello",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    ...overrides,
  } as MemoryNode;
}

describe("tamper-log hashing", () => {
  it("entryHash is deterministic and covers every field, including seq", () => {
    const base = {
      seq: 7,
      ts: 123,
      op: "store" as const,
      nodeId: "abc",
      nodeHash: "nh",
      prevHash: GENESIS_PREV,
    };
    const h1 = entryHash(base);
    expect(entryHash(base)).toBe(h1);
    expect(entryHash({ ...base, seq: 8 })).not.toBe(h1);
    expect(entryHash({ ...base, op: "forget" })).not.toBe(h1);
    expect(entryHash({ ...base, nodeHash: "other" })).not.toBe(h1);
  });

  it("nodeHash covers the full mutable state, not just content", () => {
    const base = fakeNode();
    const h = nodeHash(base);
    // Every mutable field moves the hash…
    expect(nodeHash(fakeNode({ content: "hello!" }))).not.toBe(h);
    expect(nodeHash(fakeNode({ tags: ["x"] }))).not.toBe(h);
    expect(nodeHash(fakeNode({ importance: 0.9 }))).not.toBe(h);
    expect(nodeHash(fakeNode({ metadata: { a: 1 } }))).not.toBe(h);
    expect(nodeHash(fakeNode({ namespace: "other" }))).not.toBe(h);
    expect(nodeHash(fakeNode({ validTo: 9999 }))).not.toBe(h);
    expect(nodeHash(fakeNode({ expiresAt: 9999 }))).not.toBe(h);
    // …but volatile read stats do not (reads aren't logged).
    expect(nodeHash(fakeNode({ accessCount: 42 }))).toBe(h);
    expect(nodeHash(fakeNode({ lastAccessed: 5555 }))).toBe(h);
  });

  it("nodeHash is order-insensitive for tags and metadata keys", () => {
    const a = fakeNode({ tags: ["x", "y"], metadata: { b: 2, a: 1 } });
    const b = fakeNode({ tags: ["y", "x"], metadata: { a: 1, b: 2 } });
    expect(nodeHash(a)).toBe(nodeHash(b));
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
});

describe("mutation logging", () => {
  it("store appends a chained store entry with a seq-bound hash", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("the cat sat on the mat");
    const log = await storage.readTamperLog!();
    expect(log).toHaveLength(1);
    const e = log[0]!;
    expect(e.seq).toBe(1);
    expect(e.op).toBe("store");
    expect(e.nodeId).toBe(node.id);
    expect(e.nodeHash).toBe(nodeHash(node));
    expect(e.prevHash).toBe(GENESIS_PREV);
    expect(e.entryHash).toBe(
      entryHash({
        seq: e.seq,
        ts: e.ts,
        op: e.op,
        nodeId: e.nodeId,
        nodeHash: e.nodeHash,
        prevHash: e.prevHash,
      }),
    );
  });

  it("update and forget append chained entries", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("original content here");
    const afterUpdate = (await memos.update(node.id, { tags: ["t"] }))!;
    await memos.forget(node.id);
    const log = await storage.readTamperLog!();
    expect(log.map((e) => e.op)).toEqual(["store", "update", "forget"]);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Chain linkage.
    expect(log[1]!.prevHash).toBe(log[0]!.entryHash);
    expect(log[2]!.prevHash).toBe(log[1]!.entryHash);
    // Update entry records the post-update full state (tags included).
    expect(log[1]!.nodeHash).toBe(nodeHash(afterUpdate));
    // Forget entry records the deleted node's final state.
    expect(await memos.retrieve(node.id)).toBeNull();
  });

  it("importRecord logs an import entry", async () => {
    const { memos, storage } = await makeMemos();
    await memos.importRecord({
      id: "imported-1",
      content: "imported content",
      type: "fact",
      createdAt: 1,
      updatedAt: 1,
    });
    const log = await storage.readTamperLog!();
    expect(log).toHaveLength(1);
    expect(log[0]!.op).toBe("import");
  });

  it("concurrent appends get unique seqs and a valid chain", async () => {
    const { storage } = await makeMemos();
    const mk = (i: number) =>
      storage.appendTamperEntry!({
        ts: 1000 + i,
        op: "store",
        nodeId: `n${i}`,
        nodeHash: `h${i}`,
      });
    const results = await Promise.all([mk(1), mk(2), mk(3), mk(4), mk(5)]);
    const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    // Every returned entry carries its own valid chain position.
    for (const r of results) {
      expect(r.entryHash).toBe(
        entryHash({
          seq: r.seq,
          ts: r.ts,
          op: r.op,
          nodeId: r.nodeId,
          nodeHash: r.nodeHash,
          prevHash: r.prevHash,
        }),
      );
    }
    const stored = await storage.readTamperLog!();
    expect(stored.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < stored.length; i++) {
      expect(stored[i]!.prevHash).toBe(stored[i - 1]!.entryHash);
    }
  });
});

describe("verifyTamperLog", () => {
  it("passes on a clean log", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("clean memory content");
    await memos.update(node.id, { importance: 0.9 });
    const result = await memos.verifyTamperLog();
    expect(result.supported).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(2);
    expect(result.issues).toEqual([]);
    expect(result.tipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a read (access-count bump) does not break verification", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("read me often");
    await memos.retrieve(node.id);
    await memos.retrieve(node.id);
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(true);
  });

  it("passes on an empty log", async () => {
    const { memos } = await makeMemos();
    const result = await memos.verifyTamperLog();
    expect(result.ok).toBe(true);
    expect(result.entriesChecked).toBe(0);
    expect(result.tipHash).toBeNull();
  });

  it("detects an edited log row", async () => {
    const { memos, storage } = await makeMemos();
    await memos.store("untouched memory");
    rawDb(storage)
      .prepare("UPDATE tamper_log SET node_hash = 'deadbeef' WHERE seq = 1")
      .run();
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("broken_chain");
    expect(result.issues[0]!.seq).toBe(1);
  });

  it("detects a deleted log row", async () => {
    const { memos, storage } = await makeMemos();
    await memos.store("first memory here");
    await memos.store("second memory here");
    rawDb(storage).prepare("DELETE FROM tamper_log WHERE seq = 1").run();
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("broken_chain");
  });

  it("detects a node edited directly in the DB", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("original db content");
    rawDb(storage)
      .prepare("UPDATE nodes SET content = 'attacker edited this' WHERE id = ?")
      .run(node.id);
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("content_mismatch");
    expect(result.issues[0]!.nodeId).toBe(node.id);
  });

  it("detects a metadata-only edit made directly in the DB", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("metadata tamper target");
    // Attacker changes importance without touching content.
    rawDb(storage)
      .prepare("UPDATE nodes SET importance = 0.99 WHERE id = ?")
      .run(node.id);
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("content_mismatch");
    expect(result.issues[0]!.nodeId).toBe(node.id);
  });

  it("detects a node deleted directly from the DB", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("doomed db content");
    rawDb(storage).prepare("DELETE FROM nodes WHERE id = ?").run(node.id);
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("deleted_without_log");
  });

  it("detects a node resurrected after forget", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("resurrected content");
    await memos.forget(node.id);
    // Attacker re-inserts the row directly.
    rawDb(storage)
      .prepare(
        "INSERT INTO nodes (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(node.id, "resurrected content", 1, 1);
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.kind).toBe("resurrected");
  });

  it("checkpoint anchoring: matching expectTip passes, wrong fails", async () => {
    const { memos, storage } = await makeMemos();
    await memos.store("checkpointed memory");
    const tip = (await memos.verifyTamperLog()).tipHash!;
    expect((await memos.verifyTamperLog({ expectTip: tip })).ok).toBe(true);
    const bad = await memos.verifyTamperLog({ expectTip: "0".repeat(64) });
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]!.kind).toBe("tip_mismatch");
  });

  it("reports pre-log nodes as unlogged, not tampered", async () => {
    const { memos, storage } = await makeMemos();
    // Simulate a node created before the log existed.
    rawDb(storage)
      .prepare(
        "INSERT INTO nodes (id, content, created_at, updated_at) VALUES ('old-1', 'legacy', 1, 1)",
      )
      .run();
    const result = await verifyTamperLog(storage);
    expect(result.ok).toBe(true);
    expect(result.unloggedNodes).toBe(1);
  });

  it("reports unsupported on adapters without the log", async () => {
    const result = await verifyTamperLog({} as never);
    expect(result.supported).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("fail-open logging", () => {
  it("mutations succeed even when the log write throws", async () => {
    const { memos, storage } = await makeMemos();
    storage.appendTamperEntry = async (): Promise<TamperLogEntry> => {
      throw new Error("disk on fire");
    };
    const { node } = await memos.store("must still store");
    expect(node.content).toBe("must still store");
    expect(await memos.forget(node.id)).toBe(true);
  });
});

describe("v1 schema migration", () => {
  it("migrates content_hash rows and verifies them as legacy", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const { createHash } = await import("node:crypto");
    const sha = (s: string) =>
      createHash("sha256").update(s, "utf8").digest("hex");

    // Build a DB with the first-day schema: content_hash, no node_hash,
    // one v1 entry (content-only hash, seq unbound).
    const dir = mkdtempSync(join(tmpdir(), "memos-tamper-mig-"));
    const dbPath = join(dir, "test.db");
    const setup = new BetterSqlite3(dbPath);
    const ts = 1700000000000;
    const contentHash = sha("memos-node-content-v1:legacy content");
    const prevHash =
      "memos-tamper-log-genesis-v1:" + sha("memos-tamper-log-genesis-v1");
    const entryHashV1 = sha(
      [
        "memos-tamper-entry-v1",
        ts,
        "store",
        "legacy-1",
        contentHash,
        prevHash,
      ].join("|"),
    );
    setup.exec(`
      CREATE TABLE tamper_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        op TEXT NOT NULL,
        node_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL
      );
      INSERT INTO tamper_log (ts, op, node_id, content_hash, prev_hash, entry_hash)
      VALUES (${ts}, 'store', 'legacy-1', '${contentHash}', '${prevHash}', '${entryHashV1}');
    `);
    setup.close();

    // Opening with the current code migrates the schema…
    const storage = new SQLiteStorage(dbPath, true);
    const memos = new MemOS({ storage, embeddingQueue: { synchronous: true } });
    await memos.init();
    const cols = (
      rawDb(storage).prepare(`PRAGMA table_info(tamper_log)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain("node_hash");

    // …and verification passes with the old row counted as legacy.
    // Insert the matching node directly (it predates MemOS logging).
    rawDb(storage)
      .prepare(
        "INSERT INTO nodes (id, content, created_at, updated_at) VALUES ('legacy-1', 'legacy content', 1, 1)",
      )
      .run();
    const result = await memos.verifyTamperLog();
    expect(result.ok).toBe(true);
    expect(result.legacyEntries).toBe(1);

    // New appends chain onto the legacy tip as v2 entries.
    await memos.store("brand new memory");
    const result2 = await memos.verifyTamperLog();
    expect(result2.ok).toBe(true);
    expect(result2.legacyEntries).toBe(1);
    expect(result2.entriesChecked).toBe(2);
    const log = await storage.readTamperLog!();
    expect(log[1]!.prevHash).toBe(log[0]!.entryHash);
  });
});
