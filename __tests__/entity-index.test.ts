/**
 * Tests for ITEM 2 — first-class entity index (src/entity-index.ts):
 *   - write-time population of the entity→memories inverted table
 *   - lowercase normalization + alias canonicalization (pg → postgres)
 *   - idempotent backfill for databases created before the table existed
 *   - ranked entity lookup (match count desc, node id tiebreak)
 *   - the third RRF leg in fuseResults (recall for entity-only matches)
 *   - end-to-end: hybridSearch surfaces a memory FTS and semantic both miss
 *
 * Write path is `MemOS.store()` (there is no `remember()` API); the index
 * mirror lives in `SQLiteStorage.saveNode` following the `node_tags`
 * join-table pattern.
 */

import Database from "better-sqlite3";

import {
  backfillEntityIndex,
  ensureEntityIndexTable,
  indexNodeEntities,
  removeNodeEntities,
  searchByEntities,
} from "../src/entity-index";
import { SQLiteStorage } from "../src/storage/sqlite";
import { MemOS } from "../src/memory";
import {
  fuseResults,
  DEFAULT_ENTITY_LEG_WEIGHT,
  DEFAULT_RRF_K,
} from "../src/retrieval";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  MemoryNode,
  ScoredMemory,
} from "../src/types";

/** Embeds [1,0] when the text contains the marker word, else [0,1]. */
class MarkerProvider implements EmbeddingProvider {
  public readonly id = "marker";
  public readonly model = "marker-v1";
  public readonly dimensions = 2;

  constructor(private readonly marker = "zebra") {}

  async embed(text: string): Promise<EmbeddingVector> {
    return text.includes(this.marker) ? [1, 0] : [0, 1];
  }
}

/** Minimal in-memory DB with just the tables entity-index needs. */
function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function insertNode(
  db: Database.Database,
  id: string,
  content: string,
  entities?: string[],
): void {
  db.prepare("INSERT INTO nodes (id, content, metadata) VALUES (?, ?, ?)").run(
    id,
    content,
    JSON.stringify(entities ? { entities } : {}),
  );
}
/** Minimal MemoryNode factory for fusion tests. */
function node(id: string, entities: string[] = []): MemoryNode {
  return {
    id,
    content: `content of ${id}`,
    summary: "",
    type: "fact",
    metadata: entities.length > 0 ? { entities } : {},
    importance: 0.5,
    createdAt: 0,
    updatedAt: 0,
    accessCount: 0,
    lastAccessed: 0,
    tags: [],
    namespace: "default",
    expiresAt: null,
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1,
    confidence: 0.5,
  } as MemoryNode;
}

function scored(
  id: string,
  score = 0.9,
  entities: string[] = [],
): ScoredMemory {
  return { node: node(id, entities), score };
}

function makeMemos(provider?: EmbeddingProvider): {
  memos: MemOS;
  storage: SQLiteStorage;
} {
  const storage = new SQLiteStorage(":memory:", true);
  const memos = new MemOS(
    provider
      ? {
          storage,
          experimental: { semanticSearch: true, namespaces: true },
          embeddings: { enabled: true, provider },
        }
      : { storage, embeddings: { enabled: false } },
  );
  return { memos, storage };
}

describe("entity-index module", () => {
  test("indexNodeEntities extracts and stores lowercase-normalized entities", () => {
    const db = makeDb();
    ensureEntityIndexTable(db);
    insertNode(db, "a", "Our data layer uses Postgres and Redis");
    indexNodeEntities(db, "a", "Our data layer uses Postgres and Redis");

    const rows = db
      .prepare(
        "SELECT entity FROM entity_index WHERE node_id = ? ORDER BY entity",
      )
      .all("a") as Array<{ entity: string }>;
    expect(rows.map((r) => r.entity)).toEqual(["postgres", "redis"]);
    // Every stored entity is lowercase by construction.
    for (const row of rows) {
      expect(row.entity).toBe(row.entity.toLowerCase());
    }
    db.close();
  });

  test("aliases resolve to canonical entities (PG → postgres)", () => {
    const db = makeDb();
    ensureEntityIndexTable(db);
    insertNode(db, "x", "We migrated from PG last week");
    indexNodeEntities(db, "x", "We migrated from PG last week");

    const hits = searchByEntities(db, ["postgres"], 10);
    expect(hits).toEqual([{ nodeId: "x", matches: 1 }]);
    db.close();
  });

  test("searchByEntities ranks by match count desc, node id tiebreak", () => {
    const db = makeDb();
    ensureEntityIndexTable(db);
    insertNode(db, "a", "Our data layer uses Postgres and Redis");
    insertNode(db, "b", "We cache with Redis daily");
    insertNode(db, "c", "Our primary store is Postgres today");
    indexNodeEntities(db, "a", "Our data layer uses Postgres and Redis");
    indexNodeEntities(db, "b", "We cache with Redis daily");
    indexNodeEntities(db, "c", "Our primary store is Postgres today");

    const hits = searchByEntities(db, ["postgres", "redis"], 10);
    expect(hits).toEqual([
      { nodeId: "a", matches: 2 },
      // b and c each match 1 entity — deterministic node id tiebreak.
      { nodeId: "b", matches: 1 },
      { nodeId: "c", matches: 1 },
    ]);

    expect(searchByEntities(db, ["redis"], 1)).toEqual([
      { nodeId: "a", matches: 1 },
    ]);
    db.close();
  });

  test("searchByEntities is a no-op on empty entities or non-positive limit", () => {
    const db = makeDb();
    ensureEntityIndexTable(db);
    insertNode(db, "a", "Our data layer uses Postgres and Redis");
    indexNodeEntities(db, "a", "Our data layer uses Postgres and Redis");
    expect(searchByEntities(db, [], 10)).toEqual([]);
    expect(searchByEntities(db, ["postgres"], 0)).toEqual([]);
    expect(searchByEntities(db, ["nonexistent"], 10)).toEqual([]);
    db.close();
  });

  test("removeNodeEntities clears a node's rows", () => {
    const db = makeDb();
    ensureEntityIndexTable(db);
    insertNode(db, "a", "Our data layer uses Postgres and Redis");
    indexNodeEntities(db, "a", "Our data layer uses Postgres and Redis");
    expect(searchByEntities(db, ["postgres"], 10)).toHaveLength(1);

    removeNodeEntities(db, "a");
    expect(searchByEntities(db, ["postgres"], 10)).toEqual([]);
    expect(searchByEntities(db, ["redis"], 10)).toEqual([]);
    db.close();
  });

  test("backfill populates a table-less database and is idempotent", () => {
    const db = makeDb();
    // Simulate a database created before the table existed: nodes exist,
    // entity_index does not.
    insertNode(db, "old1", "Our data layer uses Postgres and Redis", [
      "custom-thing",
    ]);
    insertNode(db, "old2", "We cache with Redis daily");

    ensureEntityIndexTable(db);
    backfillEntityIndex(db);

    // old1 used its stored (pre-canonicalized) metadata.entities …
    expect(searchByEntities(db, ["custom-thing"], 10)).toEqual([
      { nodeId: "old1", matches: 1 },
    ]);
    // … old2 fell back to content extraction ("redis" is mid-sentence).
    // old1 indexed only its stored metadata.entities, so it has no
    // "redis" row despite mentioning Redis in its content.
    expect(searchByEntities(db, ["redis"], 10)).toEqual([
      { nodeId: "old2", matches: 1 },
    ]);

    const countBefore = (
      db.prepare("SELECT COUNT(*) AS n FROM entity_index").get() as {
        n: number;
      }
    ).n;
    // Second run is a no-op: already-indexed nodes are skipped.
    backfillEntityIndex(db);
    const countAfter = (
      db.prepare("SELECT COUNT(*) AS n FROM entity_index").get() as {
        n: number;
      }
    ).n;
    expect(countAfter).toBe(countBefore);
    expect(countAfter).toBeGreaterThan(0);
    db.close();
  });
});

describe("entity index write path (SQLiteStorage)", () => {
  test("store() populates entity_index; aliases canonicalized", async () => {
    const { memos, storage } = makeMemos();
    await memos.init();
    try {
      await memos.store("The team runs Postgres for the billing service");
      await memos.store("We migrated from PG last week");

      // "PG" canonicalizes to "postgres", so both nodes match.
      const hits = await storage.searchByEntities!(["postgres"], 10);
      expect(hits).toHaveLength(2);
      expect(hits[0]!.matches).toBe(1);
    } finally {
      await memos.close();
    }
  });

  test("updateNode re-syncs the index when content/metadata changes", async () => {
    const { memos, storage } = makeMemos();
    await memos.init();
    try {
      const { node } = await memos.store(
        "The team runs Postgres for the billing service",
      );
      expect(await storage.searchByEntities!(["postgres"], 10)).toHaveLength(1);

      // The index mirrors metadata.entities (canonicalized at write time
      // with the deployment's aliases), falling back to content extraction
      // only when no stored entities exist.
      await memos.update(node.id, {
        content: "The team runs Kubernetes for the billing service",
        metadata: { entities: ["kubernetes"] },
      });
      expect(await storage.searchByEntities!(["postgres"], 10)).toHaveLength(0);
      const k8s = await storage.searchByEntities!(["kubernetes"], 10);
      expect(k8s).toEqual([{ nodeId: node.id, matches: 1 }]);
    } finally {
      await memos.close();
    }
  });

  test("deleteNode cascades to the entity index", async () => {
    const { memos, storage } = makeMemos();
    await memos.init();
    try {
      const { node } = await memos.store(
        "The team runs Postgres for the billing service",
      );
      expect(await storage.searchByEntities!(["postgres"], 10)).toHaveLength(1);

      await storage.deleteNode(node.id);
      expect(await storage.searchByEntities!(["postgres"], 10)).toEqual([]);
    } finally {
      await memos.close();
    }
  });
});

describe("fuseResults — entity leg", () => {
  const noPostFusion = { confidenceWeightStrength: 0, recencyHalfLifeMs: 0 };

  test("an entity-only match (absent from keyword/semantic legs) appears in fused output", () => {
    const keyword = [scored("k1")];
    const semantic = [scored("s1")];
    const entity = [scored("e1", 2, ["postgres"])];

    const fused = fuseResults(keyword, semantic, noPostFusion, entity);
    const byId = new Map(fused.map((r) => [r.node.id, r]));

    expect([...byId.keys()].sort()).toEqual(["e1", "k1", "s1"]);
    // Exact RRF math: entity-only rank-1 → entityLegWeight / (K + 1).
    expect(byId.get("e1")!.score).toBeCloseTo(
      DEFAULT_ENTITY_LEG_WEIGHT / (DEFAULT_RRF_K + 1),
      10,
    );
    // Score breakdown carries the entity-leg key …
    expect(byId.get("e1")!.scores!.entityLeg).toBe(2);
    // … and the pre-existing entity-overlap boost key is untouched
    // (queryEntities drives the boost; overlap is 1.0 here).
    const boosted = fuseResults(
      keyword,
      semantic,
      {
        ...noPostFusion,
        queryEntities: ["postgres"],
      },
      entity,
    );
    const boostedById = new Map(boosted.map((r) => [r.node.id, r]));
    expect(boostedById.get("e1")!.scores!.entityLeg).toBe(2);
    expect(boostedById.get("e1")!.scores!.entity).toBe(1);
  });

  test("candidates in the entity leg and another leg accumulate both RRF votes", () => {
    const keyword = [scored("a"), scored("b")];
    const entity = [scored("a", 1), scored("c", 1)];

    const fused = fuseResults(keyword, [], noPostFusion, entity);
    const byId = new Map(fused.map((r) => [r.node.id, r]));
    // "a" is rank-1 in both legs → outranks entity-only "c" and
    // keyword-only "b" (keyword weight 0.8 > entity leg weight 0.5).
    expect(byId.get("a")!.score).toBeGreaterThan(byId.get("c")!.score);
    expect(byId.get("a")!.score).toBeGreaterThan(byId.get("b")!.score);
    // "c" is rank-2 in the entity leg → entityLegWeight / (K + 2).
    expect(byId.get("c")!.score).toBeCloseTo(
      DEFAULT_ENTITY_LEG_WEIGHT / (DEFAULT_RRF_K + 2),
      10,
    );
  });

  test("entityLegWeight: 0 disables the leg", () => {
    const fused = fuseResults(
      [scored("k1")],
      [],
      {
        ...noPostFusion,
        entityLegWeight: 0,
      },
      [scored("e1", 1)],
    );
    expect(fused.map((r) => r.node.id)).toEqual(["k1"]);
  });

  test("omitting the leg is fully backward compatible", () => {
    // Three-arg call (options third) behaves exactly as before item2.
    const fused = fuseResults([scored("k1")], [scored("s1")], noPostFusion);
    expect(fused.map((r) => [r.node.id, r.scores!.entityLeg])).toEqual([
      ["k1", undefined],
      ["s1", undefined],
    ]);
  });
});

describe("hybridSearch — entity leg end to end", () => {
  test("entity leg surfaces a memory that FTS and semantic both miss", async () => {
    // search() only routes through hybridSearch when an embedding provider
    // is configured; the marker provider makes the semantic leg miss on
    // purpose (query embeds [1,0], content embeds [0,1] → cosine 0).
    const { memos } = makeMemos(new MarkerProvider());
    await memos.init();
    try {
      await memos.store("The team runs Postgres for the billing service");
      await memos.store("The office plants need watering on Fridays");

      // "PG" canonicalizes to "postgres", but neither "pg" nor "outage"
      // nor "zebra" appears in the stored text, so the keyword leg (FTS)
      // and the semantic leg are both empty — only the entity leg can
      // recall this memory.
      const results = await memos.search("PG outage zebra");
      expect(results).toHaveLength(1);
      expect(results[0]!.node.content).toContain("Postgres");
      expect(results[0]!.scores!.entityLeg).toBe(1);
      // The entity-overlap boost fired too (scores.entity), on top of the
      // leg's recall vote (scores.entityLeg).
      expect(results[0]!.scores!.entity).toBeGreaterThan(0);
    } finally {
      await memos.close();
    }
  });

  test("entity leg respects namespace scoping", async () => {
    const { memos } = makeMemos(new MarkerProvider());
    await memos.init();
    try {
      await memos.store("The team runs Postgres for the billing service", {
        namespace: "work",
      });
      await memos.store("The team runs Postgres for the billing service", {
        namespace: "personal",
      });

      const results = await memos.search({
        query: "PG outage zebra",
        namespace: "personal",
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.node.namespace).toBe("personal");
    } finally {
      await memos.close();
    }
  });
});
