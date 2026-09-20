/**
 * Tests for bitemporal edges + read-time invalidation.
 *
 * Covers:
 *   - edge CRUD with validity intervals (GraphEngine + storage round-trip)
 *   - migration adds valid_from/valid_to to a pre-existing edges table
 *     without data loss
 *   - GraphEngine.edgesValidAt() as-of semantics (NULL bounds open-ended,
 *     expired and not-yet-valid edges excluded)
 *   - storage queryEdges({ validAt }) as-of reads
 *   - closeEdgesForNode() closes only currently-valid edges
 *   - supersede() closes edge validity instead of deleting; as-of read at
 *     an earlier time still returns the edge
 */

import Database from "better-sqlite3";
import { existsSync, unlinkSync } from "node:fs";
import { GraphEngine } from "../src/graph";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { MemoryEdge } from "../src/types";

let dbCounter = 0;
function tmpDb(): string {
  dbCounter += 1;
  return `${process.cwd()}/.tmp-bitemporal-edges-${dbCounter}-${Date.now()}.db`;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

async function withStorage<T>(
  fn: (storage: SQLiteStorage) => Promise<T>,
  dbPath?: string,
): Promise<T> {
  const path = dbPath ?? tmpDb();
  const storage = new SQLiteStorage(path, true);
  await storage.init();
  try {
    return await fn(storage);
  } finally {
    await storage.close();
    if (dbPath === undefined) cleanupDb(path);
  }
}

async function withMemos<T>(
  fn: (memos: MemOS, storage: SQLiteStorage) => Promise<T>,
  dbPath?: string,
): Promise<T> {
  const path = dbPath ?? tmpDb();
  const storage = new SQLiteStorage(path, true);
  const memos = new MemOS({
    storage,
    autoLinkThreshold: 0,
    embeddings: { enabled: false },
  });
  await memos.init();
  try {
    return await fn(memos, storage);
  } finally {
    await memos.close();
    if (dbPath === undefined) cleanupDb(path);
  }
}

// Minimal node rows so FK-enforced edge inserts succeed. Must be called
// AFTER the storage has been initialised (schema created).
function insertLegacyNodes(dbPath: string, ids: string[]): void {
  const db = new Database(dbPath);
  const stmt = db.prepare(
    "INSERT INTO nodes (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
  );
  const now = Date.now();
  for (const id of ids) stmt.run(id, `content ${id}`, now, now);
  db.close();
}

async function withStorageAndNodes<T>(
  nodeIds: string[],
  fn: (storage: SQLiteStorage) => Promise<T>,
): Promise<T> {
  const dbPath = tmpDb();
  const storage = new SQLiteStorage(dbPath, true);
  await storage.init();
  insertLegacyNodes(dbPath, nodeIds);
  try {
    return await fn(storage);
  } finally {
    await storage.close();
    cleanupDb(dbPath);
  }
}

function makeEdge(overrides: Partial<MemoryEdge> & { id: string }): MemoryEdge {
  return {
    sourceId: "a",
    targetId: "b",
    relation: "relates_to",
    weight: 0.5,
    metadata: {},
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("GraphEngine.edgesValidAt", () => {
  test("as-of semantics: open-ended bounds included, expired/future excluded", () => {
    const g = new GraphEngine();
    const t0 = 1_000_000;
    g.addEdge({ sourceId: "a", targetId: "open" }); // both bounds NULL
    g.addEdge({
      sourceId: "a",
      targetId: "bounded",
      validFrom: t0 - 100,
      validTo: t0 + 100,
    });
    g.addEdge({
      sourceId: "a",
      targetId: "expired",
      validFrom: t0 - 200,
      validTo: t0 - 100,
    });
    g.addEdge({ sourceId: "a", targetId: "future", validFrom: t0 + 100 });
    g.addEdge({ sourceId: "a", targetId: "fromOnly", validFrom: t0 - 50 });
    g.addEdge({ sourceId: "a", targetId: "toOnly", validTo: t0 + 50 });

    const at = (t: number) =>
      g
        .edgesValidAt(t)
        .map((e) => e.targetId)
        .sort();

    // t0: open, bounded (t0-100 <= t0 < t0+100), fromOnly, toOnly.
    // expired (validTo t0-100 <= t0) and future (validFrom t0+100 > t0) out.
    expect(at(t0)).toEqual(["bounded", "fromOnly", "open", "toOnly"]);
    // t0-200: open, expired (boundary: validFrom <= t), toOnly.
    expect(at(t0 - 200)).toEqual(["expired", "open", "toOnly"]);
    // t0+100: open, future (validFrom <= t boundary), fromOnly.
    // bounded ends exactly at t0+100 (strict validTo > t) — excluded.
    expect(at(t0 + 100)).toEqual(["fromOnly", "future", "open"]);
  });

  test("addEdge normalises omitted validity bounds to null", () => {
    const g = new GraphEngine();
    const edge = g.addEdge({ sourceId: "a", targetId: "b" });
    expect(edge.validFrom).toBeNull();
    expect(edge.validTo).toBeNull();
    const dated = g.addEdge({
      sourceId: "a",
      targetId: "c",
      validFrom: 123,
      validTo: 456,
    });
    expect(dated.validFrom).toBe(123);
    expect(dated.validTo).toBe(456);
  });

  test("closeEdgesForNode stamps validTo only on currently-valid edges", () => {
    const g = new GraphEngine();
    const t0 = 2_000_000;
    const open = g.addEdge({ sourceId: "n", targetId: "x" });
    const already = g.addEdge({
      sourceId: "n",
      targetId: "y",
      validFrom: t0 - 1000,
      validTo: t0 - 500,
    });
    const other = g.addEdge({ sourceId: "unrelated", targetId: "z" });

    const closed = g.closeEdgesForNode("n", t0);
    expect(closed.map((e) => e.targetId)).toEqual(["x"]);
    expect(open.validTo).toBe(t0);
    // Already-closed edge keeps its earlier validTo.
    expect(already.validTo).toBe(t0 - 500);
    expect(other.validTo).toBeNull();
    // As-of read at t0 excludes the closed edge; earlier read includes it.
    expect(g.edgesValidAt(t0).map((e) => e.targetId)).not.toContain("x");
    expect(g.edgesValidAt(t0 - 1).map((e) => e.targetId)).toContain("x");
  });
});

describe("storage: edge validity columns", () => {
  test("migration adds validity columns to a pre-existing DB without data loss", async () => {
    const dbPath = tmpDb();
    try {
      // Build a legacy DB: nodes use the full pre-existing schema, but the
      // edges table lacks valid_from/valid_to (pre-item-3 shape).
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE nodes (
          id            TEXT PRIMARY KEY,
          content       TEXT NOT NULL,
          summary       TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL DEFAULT 'fact',
          metadata      TEXT NOT NULL DEFAULT '{}',
          importance    REAL NOT NULL DEFAULT 0.5,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          access_count  INTEGER NOT NULL DEFAULT 0,
          last_accessed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE edges (
          id          TEXT PRIMARY KEY,
          source_id   TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          relation    TEXT NOT NULL DEFAULT 'relates_to',
          weight      REAL NOT NULL DEFAULT 0.5,
          metadata    TEXT NOT NULL DEFAULT '{}',
          created_at  INTEGER NOT NULL,
          UNIQUE(source_id, target_id, relation)
        );
        INSERT INTO edges (id, source_id, target_id, relation, weight, metadata, created_at)
        VALUES ('e1', 'a', 'b', 'relates_to', 0.7, '{"legacy":true}', 1000);
      `);
      legacy.close();

      await withStorage(async (storage) => {
        const edge = await storage.getEdge("e1");
        expect(edge).not.toBeNull();
        // Pre-existing row intact.
        expect(edge!.sourceId).toBe("a");
        expect(edge!.targetId).toBe("b");
        expect(edge!.weight).toBe(0.7);
        expect(edge!.createdAt).toBe(1000);
        expect(edge!.metadata).toEqual({ legacy: true });
        // Migrated columns default to NULL (open-ended).
        expect(edge!.validFrom).toBeNull();
        expect(edge!.validTo).toBeNull();

        // Indexes exist for the as-of queries.
        const db = new Database(dbPath, { readonly: true });
        const idx = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_edges_valid_from', 'idx_edges_valid_to')",
          )
          .all() as Array<{ name: string }>;
        db.close();
        expect(idx.map((r) => r.name).sort()).toEqual([
          "idx_edges_valid_from",
          "idx_edges_valid_to",
        ]);
      }, dbPath);
    } finally {
      cleanupDb(dbPath);
    }
  });

  test("saveEdge persists validity intervals; queryEdges({ validAt }) filters", async () => {
    await withStorageAndNodes(["a", "b", "c", "d", "e"], async (storage) => {
      const t0 = 3_000_000;
      const edges = [
        makeEdge({ id: "e-open" }),
        makeEdge({
          id: "e-bounded",
          targetId: "c",
          validFrom: t0 - 100,
          validTo: t0 + 100,
        }),
        makeEdge({
          id: "e-expired",
          targetId: "d",
          validFrom: t0 - 200,
          validTo: t0 - 100,
        }),
        makeEdge({ id: "e-future", targetId: "e", validFrom: t0 + 100 }),
      ];
      await storage.saveEdgesBatch(edges);

      // Default (no validAt) returns all edges — existing callers unaffected.
      expect((await storage.queryEdges()).map((e) => e.id).sort()).toEqual([
        "e-bounded",
        "e-expired",
        "e-future",
        "e-open",
      ]);

      const at = async (t: number) =>
        (await storage.queryEdges({ validAt: t })).map((e) => e.id).sort();
      expect(await at(t0)).toEqual(["e-bounded", "e-open"]);
      expect(await at(t0 - 200)).toEqual(["e-expired", "e-open"]);
      expect(await at(t0 + 100)).toEqual(["e-future", "e-open"]);

      // getEdge round-trips the interval.
      const bounded = await storage.getEdge("e-bounded");
      expect(bounded!.validFrom).toBe(t0 - 100);
      expect(bounded!.validTo).toBe(t0 + 100);
    });
  });

  test("closeEdgesForNode stamps valid_to on incident edges without deleting", async () => {
    await withStorageAndNodes(["n", "x", "y", "w"], async (storage) => {
      const t0 = 4_000_000;
      const edges = [
        makeEdge({ id: "e1", sourceId: "n", targetId: "x" }),
        makeEdge({ id: "e2", sourceId: "y", targetId: "n" }),
        makeEdge({
          id: "e3",
          sourceId: "n",
          targetId: "w",
          validFrom: t0 - 1000,
          validTo: t0 - 500,
        }),
        makeEdge({ id: "e4", sourceId: "y", targetId: "w" }),
      ];
      await storage.saveEdgesBatch(edges);

      const closed = await storage.closeEdgesForNode("n", t0);
      expect(closed).toBe(2); // e1, e2 — e3 was already closed, e4 not incident

      // Nothing deleted.
      expect((await storage.queryEdges()).map((e) => e.id).sort()).toEqual([
        "e1",
        "e2",
        "e3",
        "e4",
      ]);
      // e3 keeps its earlier valid_to.
      expect((await storage.getEdge("e3"))!.validTo).toBe(t0 - 500);
      expect((await storage.getEdge("e1"))!.validTo).toBe(t0);
      expect((await storage.getEdge("e2"))!.validTo).toBe(t0);

      // As-of read at t0 excludes e1/e2; an earlier read still returns them.
      const now = (await storage.queryEdges({ validAt: t0 })).map((e) => e.id);
      expect(now).not.toContain("e1");
      expect(now).not.toContain("e2");
      const earlier = (await storage.queryEdges({ validAt: t0 - 1 })).map(
        (e) => e.id,
      );
      expect(earlier).toContain("e1");
      expect(earlier).toContain("e2");
    });
  });
});

describe("supersede: read-time invalidation of edges", () => {
  test("supersede closes edge validity instead of deleting; time travel works", async () => {
    await withMemos(async (memos, storage) => {
      const { node: a } = await memos.store("User works at Google");
      const { node: b } = await memos.store("User works at Anthropic");
      const linkEdge = await memos.link(a.id, b.id, "relates_to", 0.8);

      const tBefore = Date.now();
      // Guarantee the supersession timestamp is strictly after tBefore.
      await new Promise((r) => setTimeout(r, 10));
      await memos.supersede(a.id, b.id);
      const tAfter = Date.now();

      // The edge row still exists (add-only) with valid_to stamped.
      const stored = await storage.getEdge(linkEdge.id);
      expect(stored).not.toBeNull();
      expect(stored!.validTo).not.toBeNull();
      expect(stored!.validTo).toBeGreaterThanOrEqual(tBefore);

      // As-of read before supersession returns the edge; "now" excludes it.
      const before = (await storage.queryEdges({ validAt: tBefore })).map(
        (e) => e.id,
      );
      expect(before).toContain(linkEdge.id);
      const now = (await storage.queryEdges({ validAt: tAfter })).map(
        (e) => e.id,
      );
      expect(now).not.toContain(linkEdge.id);

      // The supersession link (temporal_precedes) is valid from the
      // supersession moment — visible now, absent from the earlier read.
      const preLinks = await storage.queryEdges({
        validAt: tBefore,
        relation: "temporal_precedes",
      });
      expect(preLinks.map((e) => e.sourceId)).not.toContain(a.id);
      const nowLinks = await storage.queryEdges({
        validAt: tAfter,
        relation: "temporal_precedes",
      });
      const supLink = nowLinks.find((e) => e.sourceId === a.id);
      expect(supLink).toBeDefined();
      expect(supLink!.targetId).toBe(b.id);
      expect(supLink!.validFrom).not.toBeNull();
    });
  });

  test("supersede without replacement also closes incident edges", async () => {
    await withMemos(async (memos, storage) => {
      const { node: a } = await memos.store("Old fact");
      const { node: b } = await memos.store("Other fact");
      const edge = await memos.link(a.id, b.id, "supports", 0.9);

      await memos.supersede(a.id);
      const stored = await storage.getEdge(edge.id);
      expect(stored).not.toBeNull();
      expect(stored!.validTo).not.toBeNull();
      // No temporal_precedes link was created.
      const links = await storage.queryEdges({ relation: "temporal_precedes" });
      expect(links).toHaveLength(0);
    });
  });
});
