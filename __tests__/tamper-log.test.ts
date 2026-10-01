/**
 * Tests for the tamper-evident mutation log (src/tamper-log.ts).
 *
 * Every mutation (store / import / update / forget) must append a
 * hash-chained entry, and verifyTamperLog() must catch: edited log
 * rows, deleted log rows, direct DB edits, direct DB deletes, and
 * resurrected nodes.
 */

import { describe, it, expect } from "@jest/globals";
import type Database from "better-sqlite3";
import { MemOS } from "../src/memory.js";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import {
  contentHash,
  entryHash,
  GENESIS_PREV,
  verifyTamperLog,
} from "../src/tamper-log.js";
import type { TamperLogEntry } from "../src/types.js";

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

describe("tamper-log hashing", () => {
  it("entryHash is deterministic and covers every field", () => {
    const base = {
      ts: 123,
      op: "store" as const,
      nodeId: "abc",
      contentHash: "ch",
      prevHash: GENESIS_PREV,
    };
    const h1 = entryHash(base);
    expect(entryHash(base)).toBe(h1);
    expect(entryHash({ ...base, op: "forget" })).not.toBe(h1);
    expect(entryHash({ ...base, contentHash: "other" })).not.toBe(h1);
  });

  it("contentHash distinguishes content", () => {
    expect(contentHash("hello")).not.toBe(contentHash("hello "));
  });
});

describe("mutation logging", () => {
  it("store appends a chained store entry", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("the cat sat on the mat");
    const log = await storage.readTamperLog!();
    expect(log).toHaveLength(1);
    const e = log[0]!;
    expect(e.seq).toBe(1);
    expect(e.op).toBe("store");
    expect(e.nodeId).toBe(node.id);
    expect(e.contentHash).toBe(contentHash("the cat sat on the mat"));
    expect(e.prevHash).toBe(GENESIS_PREV);
    expect(e.entryHash).toBe(
      entryHash({
        ts: e.ts,
        op: e.op,
        nodeId: e.nodeId,
        contentHash: e.contentHash,
        prevHash: e.prevHash,
      }),
    );
  });

  it("update and forget append chained entries", async () => {
    const { memos, storage } = await makeMemos();
    const { node } = await memos.store("original content here");
    await memos.update(node.id, { tags: ["t"] });
    await memos.forget(node.id);
    const log = await storage.readTamperLog!();
    expect(log.map((e) => e.op)).toEqual(["store", "update", "forget"]);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Chain linkage.
    expect(log[1]!.prevHash).toBe(log[0]!.entryHash);
    expect(log[2]!.prevHash).toBe(log[1]!.entryHash);
    // Forget entry records the deleted content's hash.
    expect(log[2]!.contentHash).toBe(contentHash("original content here"));
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
      .prepare("UPDATE tamper_log SET content_hash = 'deadbeef' WHERE seq = 1")
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
    storage.appendTamperEntry = async (_e: TamperLogEntry) => {
      throw new Error("disk on fire");
    };
    const { node } = await memos.store("must still store");
    expect(node.content).toBe("must still store");
    expect(await memos.forget(node.id)).toBe(true);
  });
});
