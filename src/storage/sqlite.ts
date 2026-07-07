/**
 * SQLite-backed storage adapter for MemOS.
 *
 * Uses `better-sqlite3` for synchronous, high-performance local persistence.
 * Full-text search is powered by SQLite FTS5.
 *
 * @module @memos/storage/sqlite
 */

import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  StorageAdapter,
  MemoryNode,
  MemoryEdge,
  SearchFilter,
  ScoredMemory,
  GraphSnapshot,
  UpdateMemoryInput,
  EdgeRelation,
  EmbeddingVector,
  EmbeddingRecordInfo,
} from "../types.js";
import { cosineSimilarity } from "../embeddings.js";

/**
 * Default database path: `~/.memos/memos.db`.
 */
export function defaultDbPath(): string {
  const home = homedir() || process.env.USERPROFILE || process.env.HOME || ".";
  return join(home, ".memos", "memos.db");
}

/**
 * SQLite storage implementation.
 */
export class SQLiteStorage implements StorageAdapter {
  private db!: Database.Database;
  private readonly path: string;
  private readonly wal: boolean;
  /**
   * Per-id access count delta buffer. Batched into a single UPDATE per
   * id on a 500 ms debounce. Removes the read-modify-write write that
   * was previously amplified to a `SET access_count = access_count + 1`
   * on every `getNode` call. See {@link flushAccessCounts}.
   */
  private readonly accessBuffer: Map<
    string,
    { count: number; lastAccessed: number }
  > = new Map();
  private accessFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private accessFlushIntervalMs: number;

  /**
   * Create a new SQLiteStorage instance.
   *
   * @param path — Filesystem path to the `.db` file.
   * @param wal  — Enable WAL journal mode (recommended).
   */
  constructor(path: string, wal = true) {
    this.path = path;
    this.wal = wal;
    // 500 ms is the sweet spot — long enough to coalesce rapid reads,
    // short enough that the persisted value is never far behind the
    // in-memory truth.
    this.accessFlushIntervalMs = 500;
  }

  /**
   * Open the database and create tables / indices if they do not exist.
   */
  async init(): Promise<void> {
    const fs = await import("fs");
    const { dirname } = await import("path");
    const dir = dirname(this.path);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.path);

    if (this.wal) {
      this.db.pragma("journal_mode = WAL");
    }
    this.db.pragma("foreign_keys = ON");

    // Cross-OS performance pragmas. `synchronous = NORMAL` is safe with WAL
    // (the WAL file itself is still fsynced) and gives ~10x faster writes
    // compared to FULL on macOS / Windows where fsync is expensive. The
    // 32 MiB page cache and 256 MiB mmap cut read latency for medium
    // stores without bumping RSS materially. Temp tables in memory keep
    // ORDER BY and GROUP BY on heavy queries from spilling to disk.
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -32000");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("wal_autocheckpoint = 1000");
    this.db.pragma("mmap_size = 268435456");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
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

      CREATE TABLE IF NOT EXISTS edges (
        id          TEXT PRIMARY KEY,
        source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        relation    TEXT NOT NULL DEFAULT 'relates_to',
        weight      REAL NOT NULL DEFAULT 0.5,
        metadata    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        UNIQUE(source_id, target_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
      CREATE INDEX IF NOT EXISTS idx_nodes_importance ON nodes(importance);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

      -- Store vectors as float32 BLOBs instead of JSON to keep local DBs smaller
      -- and avoid OS-specific JSON number formatting differences.
      CREATE TABLE IF NOT EXISTS embeddings (
        node_id    TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        vector     BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        model      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Migration: add expires_at column if missing
    this.migrateAddColumn("nodes", "expires_at", "INTEGER DEFAULT NULL");
    // Migration: add tags column if missing
    this.migrateAddColumn("nodes", "tags", "TEXT NOT NULL DEFAULT '[]'");
    // Migration: add namespace column if missing
    this.migrateAddColumn(
      "nodes",
      "namespace",
      "TEXT NOT NULL DEFAULT 'default'",
    );
    // Migration: temporal validity columns
    this.migrateAddColumn("nodes", "valid_from", "INTEGER DEFAULT NULL");
    this.migrateAddColumn("nodes", "valid_to", "INTEGER DEFAULT NULL");
    // Migration: provenance & trust columns
    this.migrateAddColumn(
      "nodes",
      "source",
      "TEXT NOT NULL DEFAULT 'user_input'",
    );
    this.migrateAddColumn("nodes", "trust_score", "REAL NOT NULL DEFAULT 1.0");

    // Index for TTL sweep
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_expires_at ON nodes(expires_at);
    `);

    // Index for temporal queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_valid_from ON nodes(valid_from);
      CREATE INDEX IF NOT EXISTS idx_nodes_valid_to ON nodes(valid_to);
      CREATE INDEX IF NOT EXISTS idx_nodes_trust_score ON nodes(trust_score);
      CREATE INDEX IF NOT EXISTS idx_nodes_source ON nodes(source);
    `);

    // FTS5 virtual table for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        content,
        summary,
        content='nodes',
        content_rowid='rowid'
      );
    `);

    // Triggers to keep FTS index in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
        INSERT INTO nodes_fts(rowid, content, summary)
        VALUES (new.rowid, new.content, new.summary);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, content, summary)
        VALUES ('delete', old.rowid, old.content, old.summary);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
        INSERT INTO nodes_fts(nodes_fts, rowid, content, summary)
        VALUES ('delete', old.rowid, old.content, old.summary);
        INSERT INTO nodes_fts(rowid, content, summary)
        VALUES (new.rowid, new.content, new.summary);
      END;
    `);

    // Tag join table. Replaces the JSON-LIKE scan on every tag query with
    // a real B-tree index. The (node_id, tag) primary key makes writes
    // O(tags) and the (tag) secondary index makes reverse lookups O(1).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_tags (
        node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        tag     TEXT NOT NULL,
        PRIMARY KEY (node_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_node_tags_tag ON node_tags(tag);
    `);

    // Migration: back-fill node_tags from the JSON column for any pre-
    // existing rows. Safe to run on every init — INSERT OR IGNORE means
    // already-synced rows are no-ops.
    this.migrateBackfillNodeTags();
  }

  /**
   * One-time backfill: for every node, read the JSON `tags` column and
   * ensure each tag exists in `node_tags`. Idempotent thanks to
   * `INSERT OR IGNORE`. Runs inside a single transaction so a 100k-node
   * database finishes in well under a second on a warm cache.
   */
  private migrateBackfillNodeTags(): void {
    const rows = this.db.prepare("SELECT id, tags FROM nodes").all() as Array<{
      id: string;
      tags: string;
    }>;
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)",
    );
    const seen = new Map<string, Set<string>>();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        let tags: unknown;
        try {
          tags = JSON.parse(row.tags);
        } catch {
          continue;
        }
        if (!Array.isArray(tags)) continue;
        let ids = seen.get(row.id);
        if (!ids) {
          ids = new Set<string>();
          seen.set(row.id, ids);
        }
        for (const tag of tags) {
          if (typeof tag !== "string" || tag.length === 0) continue;
          if (ids.has(tag)) continue;
          ids.add(tag);
          insert.run(row.id, tag);
        }
      }
    });
    tx();
  }

  /**
   * Replace the `node_tags` rows for a single node. Used after
   * `saveNode` / `updateNode` to keep the join table in lockstep with
   * the JSON column.
   */
  private writeNodeTags(nodeId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM node_tags WHERE node_id = ?").run(nodeId);
    if (tags.length === 0) return;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO node_tags (node_id, tag) VALUES (?, ?)",
    );
    const seen = new Set<string>();
    const tx = this.db.transaction(() => {
      for (const tag of tags) {
        if (typeof tag !== "string" || tag.length === 0) continue;
        if (seen.has(tag)) continue;
        seen.add(tag);
        insert.run(nodeId, tag);
      }
    });
    tx();
  }

  /**
   * Migration-safe column addition. Checks if column exists before ALTER TABLE.
   * SQLite does not support ALTER TABLE IF NOT EXISTS, so we check pragmatically.
   */
  private migrateAddColumn(
    table: string,
    column: string,
    definition: string,
  ): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Record<
      string,
      unknown
    >[];
    const exists = cols.some((c) => c.name === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // -----------------------------------------------------------------------
  // Nodes
  // -----------------------------------------------------------------------

  async saveNode(node: MemoryNode): Promise<MemoryNode> {
    const stmt = this.getPreparedStatement(
      "saveNode",
      `INSERT INTO nodes (id, content, summary, type, metadata, importance, created_at, updated_at, access_count, last_accessed, expires_at, tags, namespace, valid_from, valid_to, source, trust_score)
       VALUES (@id, @content, @summary, @type, @metadata, @importance, @createdAt, @updatedAt, @accessCount, @lastAccessed, @expiresAt, @tags, @namespace, @validFrom, @validTo, @source, @trustScore)`,
    );

    stmt.run({
      id: node.id,
      content: node.content,
      summary: node.summary,
      type: node.type,
      metadata: JSON.stringify(node.metadata),
      importance: node.importance,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      accessCount: node.accessCount,
      lastAccessed: node.lastAccessed,
      expiresAt: node.expiresAt,
      tags: JSON.stringify(node.tags),
      namespace: node.namespace,
      validFrom: node.validFrom,
      validTo: node.validTo,
      source: node.source,
      trustScore: node.trustScore,
    });

    // Mirror to the join table for index-backed tag lookups.
    this.writeNodeTags(node.id, node.tags);

    return node;
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const stmt = this.getPreparedStatement(
      "getNode",
      "SELECT * FROM nodes WHERE id = ?",
    );
    const row = stmt.get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    // Buffer the access stats instead of writing immediately. Coalesces
    // bursts of reads (e.g. a search that re-fetches the same node) into
    // a single UPDATE per id.
    this.bufferAccess(id, Date.now());
    return this.rowToNode(row);
  }

  private bufferAccess(id: string, now: number): void {
    const existing = this.accessBuffer.get(id);
    if (existing) {
      existing.count += 1;
      existing.lastAccessed = now;
    } else {
      this.accessBuffer.set(id, { count: 1, lastAccessed: now });
    }
    this.scheduleAccessFlush();
  }

  private scheduleAccessFlush(): void {
    if (this.accessFlushTimer !== null) return;
    this.accessFlushTimer = setTimeout(() => {
      this.accessFlushTimer = null;
      try {
        this.flushAccessCounts();
      } catch {
        // Flush errors are non-fatal; we'll retry on the next buffer hit.
      }
    }, this.accessFlushIntervalMs);
    // Don't keep the process alive for a flush.
    if (
      this.accessFlushTimer &&
      typeof this.accessFlushTimer.unref === "function"
    ) {
      this.accessFlushTimer.unref();
    }
  }

  /** Drain the buffered access counters to SQLite. */
  flushAccessCounts(): void {
    if (this.accessBuffer.size === 0) return;
    const updates = this.db.prepare(
      "UPDATE nodes SET access_count = access_count + ?, last_accessed = MAX(last_accessed, ?) WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const [id, { count, lastAccessed }] of this.accessBuffer) {
        updates.run(count, lastAccessed, id);
      }
      this.accessBuffer.clear();
    });
    tx();
  }

  async peekNode(id: string): Promise<MemoryNode | null> {
    const stmt = this.getPreparedStatement(
      "peekNode",
      "SELECT * FROM nodes WHERE id = ?",
    );
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToNode(row) : null;
  }

  async evictLeastImportant(): Promise<string | null> {
    // Pick the least important + oldest-accessed node in a single SQL
    // statement. Avoids loading the whole table into memory.
    const row = this.db
      .prepare(
        "SELECT id FROM nodes ORDER BY importance ASC, last_accessed ASC, created_at ASC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const id = row.id as string;
    const result = this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    if (result.changes > 0) return id;
    return null;
  }

  async updateNode(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<MemoryNode | null> {
    const existing = await this.getNode(id);
    if (!existing) return null;

    const updated: MemoryNode = {
      ...existing,
      ...input,
      metadata: input.metadata ?? existing.metadata,
      tags: input.tags ?? existing.tags,
      namespace: input.namespace ?? existing.namespace,
      validFrom:
        input.validFrom !== undefined ? input.validFrom : existing.validFrom,
      validTo: input.validTo !== undefined ? input.validTo : existing.validTo,
      source: input.source ?? existing.source,
      trustScore:
        input.trustScore !== undefined ? input.trustScore : existing.trustScore,
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE nodes SET content = @content, summary = @summary, type = @type,
         metadata = @metadata, importance = @importance, updated_at = @updatedAt,
         tags = @tags, namespace = @namespace,
         valid_from = @validFrom, valid_to = @validTo, source = @source, trust_score = @trustScore
         WHERE id = @id`,
      )
      .run({
        id: updated.id,
        content: updated.content,
        summary: updated.summary,
        type: updated.type,
        metadata: JSON.stringify(updated.metadata),
        importance: updated.importance,
        updatedAt: updated.updatedAt,
        tags: JSON.stringify(updated.tags),
        namespace: updated.namespace,
        validFrom: updated.validFrom,
        validTo: updated.validTo,
        source: updated.source,
        trustScore: updated.trustScore,
      });

    // Keep the tag join table in sync when the tag set changed.
    if (input.tags !== undefined) {
      this.writeNodeTags(updated.id, updated.tags);
    }

    return updated;
  }

  async deleteNode(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // -----------------------------------------------------------------------
  // Edges
  // -----------------------------------------------------------------------

  async saveEdge(edge: MemoryEdge): Promise<MemoryEdge> {
    const stmt = this.getPreparedStatement(
      "saveEdge",
      `INSERT INTO edges (id, source_id, target_id, relation, weight, metadata, created_at)
       VALUES (@id, @sourceId, @targetId, @relation, @weight, @metadata, @createdAt)`,
    );

    stmt.run({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      relation: edge.relation,
      weight: edge.weight,
      metadata: JSON.stringify(edge.metadata),
      createdAt: edge.createdAt,
    });

    return edge;
  }

  /**
   * Batch-insert multiple edges in a single transaction.
   * Uses a cached prepared statement — ~10x faster than calling
   * saveEdge() in a loop for 10+ edges.
   */
  async saveEdgesBatch(edges: MemoryEdge[]): Promise<MemoryEdge[]> {
    if (edges.length === 0) return [];
    const stmt = this.getPreparedStatement(
      "saveEdge",
      `INSERT INTO edges (id, source_id, target_id, relation, weight, metadata, created_at)
       VALUES (@id, @sourceId, @targetId, @relation, @weight, @metadata, @createdAt)`,
    );
    const insert = (edge: MemoryEdge) =>
      stmt.run({
        id: edge.id,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relation: edge.relation,
        weight: edge.weight,
        metadata: JSON.stringify(edge.metadata),
        createdAt: edge.createdAt,
      });
    const tx = this.db.transaction(() => {
      for (const edge of edges) insert(edge);
    });
    tx();
    return edges;
  }

  /**
   * Prepared statement cache. better-sqlite3 caches at the C++ level,
   * but the JS Statement wrapper is still recreated on each prepare()
   * call. Caching the JS object avoids that overhead on hot paths.
   */
  private readonly stmtCache = new Map<string, Statement>();

  private getPreparedStatement(key: string, sql: string): Statement {
    let stmt = this.stmtCache.get(key);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(key, stmt);
    }
    return stmt;
  }

  async getEdge(id: string): Promise<MemoryEdge | null> {
    const row = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToEdge(row);
  }

  async deleteEdge(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM edges WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  async queryNodes(filter: SearchFilter = {}): Promise<ScoredMemory[]> {
    let rows: Record<string, unknown>[];

    // Build the extra filters that apply to both FTS and structured paths.
    const extraConds: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extraParams: any[] = [];

    if (filter.source) {
      extraConds.push("n.source = ?");
      extraParams.push(filter.source);
    }
    if (filter.minTrustScore !== undefined) {
      extraConds.push("n.trust_score >= ?");
      extraParams.push(filter.minTrustScore);
    }
    // Temporal: exclude historical (validTo in the past) unless
    // includeHistorical is explicitly true. Also support validAt.
    const now = Date.now();
    if (filter.validAt !== undefined) {
      extraConds.push("(n.valid_from IS NULL OR n.valid_from <= ?)");
      extraParams.push(filter.validAt);
      extraConds.push("(n.valid_to IS NULL OR n.valid_to >= ?)");
      extraParams.push(filter.validAt);
    } else if (filter.includeHistorical !== true) {
      // Default and explicit false: exclude historical memories.
      // Strict `>` (not `>=`): a memory superseded in the same millisecond
      // as this query (validTo === now) is already historical and must be
      // excluded. `>=` would keep it. validAt below intentionally stays `>=`.
      extraConds.push("(n.valid_to IS NULL OR n.valid_to > ?)");
      extraParams.push(now);
    }

    if (filter.query) {
      // Full-text search via FTS5 — escape special characters
      const safeQuery = filter.query.replace(/"/g, '""');
      const ftsQuery = `"${safeQuery}"`;
      const tagFilter = this.buildTagFilter(filter.tags, "n");
      const metadata = this.buildMetadataFilter(filter.metadata, "n");
      const namespaceFilter = filter.namespace ? " AND n.namespace = ?" : "";
      const whereParts = [
        tagFilter,
        ...metadata.conditions,
        ...extraConds,
      ].filter(Boolean);
      const whereExtra = whereParts.length
        ? ` AND ${whereParts.join(" AND ")}`
        : "";

      const ftsSql = `SELECT n.*, rank
           FROM nodes n
           INNER JOIN nodes_fts fts ON fts.rowid = n.rowid
           WHERE nodes_fts MATCH ?${whereExtra}${namespaceFilter}
           ORDER BY rank
           LIMIT ? OFFSET ?`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [ftsQuery];
      if (filter.tags && filter.tags.length > 0) {
        for (const tag of filter.tags) {
          params.push(tag);
        }
      }
      params.push(...metadata.params);
      params.push(...extraParams);
      if (filter.namespace) {
        params.push(filter.namespace);
      }
      params.push(filter.limit ?? 50, filter.offset ?? 0);

      rows = this.db.prepare(ftsSql).all(...params) as Record<
        string,
        unknown
      >[];
    } else {
      // Structured query
      const conditions: string[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [];

      if (filter.type) {
        conditions.push("type = ?");
        params.push(filter.type);
      }
      if (filter.minImportance !== undefined) {
        conditions.push("importance >= ?");
        params.push(filter.minImportance);
      }
      if (filter.maxImportance !== undefined) {
        conditions.push("importance <= ?");
        params.push(filter.maxImportance);
      }
      if (filter.namespace) {
        conditions.push("namespace = ?");
        params.push(filter.namespace);
      }
      if (filter.source) {
        conditions.push("source = ?");
        params.push(filter.source);
      }
      if (filter.minTrustScore !== undefined) {
        conditions.push("trust_score >= ?");
        params.push(filter.minTrustScore);
      }
      // Temporal filters (structured path)
      if (filter.validAt !== undefined) {
        conditions.push("(valid_from IS NULL OR valid_from <= ?)");
        params.push(filter.validAt);
        conditions.push("(valid_to IS NULL OR valid_to >= ?)");
        params.push(filter.validAt);
      } else if (filter.includeHistorical !== true) {
        // Strict `>`: a memory superseded in the same millisecond as the
        // query (validTo === now) is historical and must be excluded.
        conditions.push("(valid_to IS NULL OR valid_to > ?)");
        params.push(now);
      }

      const metadata = this.buildMetadataFilter(filter.metadata);
      conditions.push(...metadata.conditions);
      params.push(...metadata.params);

      // Tag filter: node must contain ALL specified tags
      if (filter.tags && filter.tags.length > 0) {
        for (const tag of filter.tags) {
          conditions.push("tags LIKE ?");
          params.push(`%${JSON.stringify(tag)}%`);
        }
      }

      const where = conditions.length
        ? "WHERE " + conditions.join(" AND ")
        : "";

      const sortField = this.mapSortField(filter.sortBy);
      const order = filter.sortOrder ?? "desc";

      rows = this.db
        .prepare(
          `SELECT * FROM nodes ${where} ORDER BY ${sortField} ${order} LIMIT ? OFFSET ?`,
        )
        .all(...params, filter.limit ?? 50, filter.offset ?? 0) as Record<
        string,
        unknown
      >[];
    }

    return rows.map((row) => ({
      node: this.rowToNode(row),
      score: typeof row.rank === "number" ? row.rank : 1,
    }));
  }

  async saveEmbedding(
    nodeId: string,
    vector: EmbeddingVector,
    model: string,
  ): Promise<void> {
    const normalized = this.serializeEmbedding(vector);
    this.db
      .prepare(
        `INSERT INTO embeddings (node_id, vector, dimensions, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           vector = excluded.vector,
           dimensions = excluded.dimensions,
           model = excluded.model,
           updated_at = excluded.updated_at`,
      )
      .run(nodeId, normalized, vector.length, model, Date.now());
  }

  async getEmbeddingInfo(nodeId: string): Promise<EmbeddingRecordInfo | null> {
    const row = this.db
      .prepare(
        "SELECT model, dimensions, updated_at FROM embeddings WHERE node_id = ?",
      )
      .get(nodeId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return {
      model: row.model as string,
      dimensions: row.dimensions as number,
      updatedAt: row.updated_at as number,
    };
  }

  async getAllEmbeddings(): Promise<
    Array<{ nodeId: string; vector: EmbeddingVector; model: string }>
  > {
    const rows = this.db
      .prepare("SELECT node_id, vector, model, dimensions FROM embeddings")
      .all() as Array<{
      node_id: string;
      vector: Buffer;
      model: string;
      dimensions: number;
    }>;
    return rows.map((r) => ({
      nodeId: r.node_id,
      model: r.model,
      vector: this.parseEmbedding(r.vector),
    }));
  }

  async setNodeNamespace(id: string, namespace: string): Promise<void> {
    this.db
      .prepare("UPDATE nodes SET namespace = ? WHERE id = ?")
      .run(namespace, id);
  }

  async querySimilarEmbeddings(
    vector: EmbeddingVector,
    filter: SearchFilter = {},
    limit: number,
    threshold = 0,
  ): Promise<ScoredMemory[]> {
    const conditions: string[] = [];
    const params: unknown[] = [vector.length];

    // Only compare vectors produced by compatible models/dimensions; cosine
    // similarity is meaningless when the stored vector length differs.
    conditions.push("e.dimensions = ?");
    if (filter.type) {
      conditions.push("n.type = ?");
      params.push(filter.type);
    }
    if (filter.minImportance !== undefined) {
      conditions.push("n.importance >= ?");
      params.push(filter.minImportance);
    }
    if (filter.maxImportance !== undefined) {
      conditions.push("n.importance <= ?");
      params.push(filter.maxImportance);
    }
    if (filter.namespace) {
      conditions.push("n.namespace = ?");
      params.push(filter.namespace);
    }
    const metadata = this.buildMetadataFilter(filter.metadata, "n");
    conditions.push(...metadata.conditions);
    params.push(...metadata.params);
    if (filter.tags && filter.tags.length > 0) {
      for (const tag of filter.tags) {
        conditions.push("n.tags LIKE ?");
        params.push(`%${JSON.stringify(tag)}%`);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT n.*, e.vector
         FROM embeddings e
         JOIN nodes n ON n.id = e.node_id
         ${where}`,
      )
      .all(...params) as Record<string, unknown>[];

    const scored: ScoredMemory[] = [];
    for (const row of rows) {
      const storedVector = this.parseEmbedding(row.vector);
      const score = cosineSimilarity(vector, storedVector);
      if (score >= threshold) {
        scored.push({
          node: this.rowToNode(row),
          score,
          scores: { semantic: score },
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async queryEdges(
    filter: {
      sourceId?: string;
      targetId?: string;
      relation?: EdgeRelation;
    } = {},
  ): Promise<MemoryEdge[]> {
    const conditions: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: any[] = [];

    if (filter.sourceId) {
      conditions.push("source_id = ?");
      params.push(filter.sourceId);
    }
    if (filter.targetId) {
      conditions.push("target_id = ?");
      params.push(filter.targetId);
    }
    if (filter.relation) {
      conditions.push("relation = ?");
      params.push(filter.relation);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const rows = this.db
      .prepare(`SELECT * FROM edges ${where}`)
      .all(...params) as Record<string, unknown>[];

    return rows.map((r) => this.rowToEdge(r));
  }

  async getGraph(): Promise<GraphSnapshot> {
    const nodes = this.db.prepare("SELECT * FROM nodes").all() as Record<
      string,
      unknown
    >[];
    const edges = this.db.prepare("SELECT * FROM edges").all() as Record<
      string,
      unknown
    >[];

    return {
      nodes: nodes.map((r) => this.rowToNode(r)),
      edges: edges.map((r) => this.rowToEdge(r)),
    };
  }

  // -----------------------------------------------------------------------
  // TTL
  // -----------------------------------------------------------------------

  async setTTL(id: string, seconds: number): Promise<void> {
    const expiresAt = Math.floor(Date.now() / 1000) + seconds;
    this.db
      .prepare("UPDATE nodes SET expires_at = ? WHERE id = ?")
      .run(expiresAt, id);
  }

  async clearTTL(id: string): Promise<void> {
    this.db.prepare("UPDATE nodes SET expires_at = NULL WHERE id = ?").run(id);
  }

  async sweepExpired(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db
      .prepare(
        "DELETE FROM nodes WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .run(now);
    return result.changes;
  }

  // -----------------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------------

  async queryNodesByTag(tag: string): Promise<MemoryNode[]> {
    // Uses the (tag) secondary index on node_tags — O(log n) lookup, no
    // JSON scan.
    const rows = this.db
      .prepare(
        `SELECT n.* FROM nodes n
         INNER JOIN node_tags nt ON nt.node_id = n.id
         WHERE nt.tag = ?`,
      )
      .all(tag) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  // -----------------------------------------------------------------------
  // Bulk Operations
  // -----------------------------------------------------------------------

  async deleteAllNodes(): Promise<void> {
    this.db.exec("DELETE FROM embeddings");
    this.db.exec("DELETE FROM edges");
    this.db.exec("DELETE FROM nodes");
    // Rebuild FTS index
    this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.accessFlushTimer !== null) {
      clearTimeout(this.accessFlushTimer);
      this.accessFlushTimer = null;
    }
    this.flushAccessCounts();
    if (this.db) {
      this.db.close();
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private rowToNode(row: Record<string, unknown>): MemoryNode {
    return {
      id: row.id as string,
      content: row.content as string,
      summary: row.summary as string,
      type: row.type as MemoryNode["type"],
      metadata: JSON.parse((row.metadata as string) || "{}"),
      importance: row.importance as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      accessCount: row.access_count as number,
      lastAccessed: row.last_accessed as number,
      tags: JSON.parse((row.tags as string) || "[]"),
      expiresAt: (row.expires_at as number) ?? null,
      namespace: (row.namespace as string) || "default",
      validFrom: (row.valid_from as number) ?? null,
      validTo: (row.valid_to as number) ?? null,
      source: (row.source as MemoryNode["source"]) || "user_input",
      trustScore: (row.trust_score as number) ?? 1.0,
    };
  }

  private rowToEdge(row: Record<string, unknown>): MemoryEdge {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      relation: row.relation as EdgeRelation,
      weight: row.weight as number,
      metadata: JSON.parse((row.metadata as string) || "{}"),
      createdAt: row.created_at as number,
    };
  }

  private parseEmbedding(value: unknown): EmbeddingVector {
    // Current databases store compact float32 blobs. The JSON branch keeps old
    // databases readable so users do not need a manual migration.
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const buffer = Buffer.from(value);
      const vector: number[] = [];
      for (let offset = 0; offset + 3 < buffer.length; offset += 4) {
        vector.push(buffer.readFloatLE(offset));
      }
      return vector;
    }
    if (typeof value !== "string") return [];
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is number => typeof item === "number")
      : [];
  }

  private serializeEmbedding(vector: EmbeddingVector): Buffer {
    // Float32 precision is enough for retrieval ranking and cuts storage size
    // roughly in half compared with float64 arrays.
    const buffer = Buffer.allocUnsafe(vector.length * 4);
    for (let index = 0; index < vector.length; index += 1) {
      buffer.writeFloatLE(vector[index], index * 4);
    }
    return buffer;
  }

  private mapSortField(field?: SearchFilter["sortBy"]): string {
    switch (field) {
      case "importance":
        return "importance";
      case "createdAt":
        return "created_at";
      case "updatedAt":
        return "updated_at";
      case "accessCount":
        return "access_count";
      case "trustScore":
        return "trust_score";
      case "relevance":
      default:
        return "updated_at";
    }
  }

  private buildTagFilter(tags?: string[], tableAlias?: string): string {
    if (!tags || tags.length === 0) return "";
    const prefix = tableAlias ? `${tableAlias}.` : "";
    // AND across tags via EXISTS subqueries on the indexed node_tags
    // table. The planner uses the (tag) index for each subquery, which
    // is dramatically faster than the legacy `tags LIKE '%"tag"%'`.
    return tags
      .map(
        () =>
          `EXISTS (SELECT 1 FROM node_tags nt ` +
          `WHERE nt.node_id = ${prefix}id AND nt.tag = ?)`,
      )
      .join(" AND ");
  }

  private buildMetadataFilter(
    metadata?: Record<string, unknown>,
    tableAlias?: string,
  ): { conditions: string[]; params: unknown[] } {
    if (!metadata || Object.keys(metadata).length === 0) {
      return { conditions: [], params: [] };
    }
    const prefix = tableAlias ? `${tableAlias}.` : "";
    const conditions: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(metadata)) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
      conditions.push(`json_extract(${prefix}metadata, ?) = ?`);
      params.push(
        `$.${key}`,
        typeof value === "object" ? JSON.stringify(value) : value,
      );
    }
    return { conditions, params };
  }
}
