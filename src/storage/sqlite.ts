/**
 * SQLite-backed storage adapter for MemOS.
 *
 * Uses `better-sqlite3` for synchronous, high-performance local persistence.
 * Full-text search is powered by SQLite FTS5.
 *
 * @module @memos/storage/sqlite
 */

import Database from "better-sqlite3";
import type {
  StorageAdapter,
  MemoryNode,
  MemoryEdge,
  SearchFilter,
  ScoredMemory,
  GraphSnapshot,
  UpdateMemoryInput,
  EdgeRelation,
} from "../types.js";

/**
 * Default database path: `~/.memos/memos.db`.
 */
export function defaultDbPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return `${home}/.memos/memos.db`;
}

/**
 * SQLite storage implementation.
 */
export class SQLiteStorage implements StorageAdapter {
  private db!: Database.Database;
  private readonly path: string;
  private readonly wal: boolean;

  /**
   * Create a new SQLiteStorage instance.
   *
   * @param path — Filesystem path to the `.db` file.
   * @param wal  — Enable WAL journal mode (recommended).
   */
  constructor(path: string, wal = true) {
    this.path = path;
    this.wal = wal;
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

    // Index for TTL sweep
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_expires_at ON nodes(expires_at);
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
    const stmt = this.db.prepare(`
      INSERT INTO nodes (id, content, summary, type, metadata, importance, created_at, updated_at, access_count, last_accessed, expires_at, tags, namespace)
      VALUES (@id, @content, @summary, @type, @metadata, @importance, @createdAt, @updatedAt, @accessCount, @lastAccessed, @expiresAt, @tags, @namespace)
    `);

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
    });

    return node;
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    // Update access stats
    this.db
      .prepare(
        "UPDATE nodes SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
      )
      .run(Date.now(), id);

    return this.rowToNode(row);
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
      updatedAt: Date.now(),
    };

    this.db
      .prepare(
        `UPDATE nodes SET content = @content, summary = @summary, type = @type,
         metadata = @metadata, importance = @importance, updated_at = @updatedAt,
         tags = @tags, namespace = @namespace
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
      });

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
    const stmt = this.db.prepare(`
      INSERT INTO edges (id, source_id, target_id, relation, weight, metadata, created_at)
      VALUES (@id, @sourceId, @targetId, @relation, @weight, @metadata, @createdAt)
    `);

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

  async getEdge(id: string): Promise<MemoryEdge | null> {
    const row = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;

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
    let rows: Record<string, unknown>[] = [];

    if (filter.query) {
      // Full-text search via FTS5
      const tagFilter = this.buildTagFilter(filter.tags, "n");
      const namespaceFilter = filter.namespace ? " AND n.namespace = ?" : "";
      const whereExtra = tagFilter ? ` AND ${tagFilter}` : "";

      const ftsSql = `SELECT n.*, rank
           FROM nodes_fts fts
           JOIN nodes n ON n.rowid = fts.rowid
           WHERE nodes_fts MATCH ?${whereExtra}${namespaceFilter}
           ORDER BY rank
           LIMIT ? OFFSET ?`;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any[] = [filter.query];
      if (filter.tags && filter.tags.length > 0) {
        for (const tag of filter.tags) {
          params.push(`%${JSON.stringify(tag)}%`);
        }
      }
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
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE tags LIKE ?")
      .all(`%${JSON.stringify(tag)}%`) as Record<string, unknown>[];
    return rows.map((r) => this.rowToNode(r));
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async close(): Promise<void> {
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
      case "relevance":
      default:
        return "updated_at";
    }
  }

  private buildTagFilter(tags?: string[], tableAlias?: string): string {
    if (!tags || tags.length === 0) return "";
    const prefix = tableAlias ? `${tableAlias}.` : "";
    return tags.map(() => `${prefix}tags LIKE ?`).join(" AND ");
  }
}
