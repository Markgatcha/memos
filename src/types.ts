/**
 * MemOS — Universal memory layer for AI agents.
 *
 * Core type definitions. Every interface and type in the system
 * is defined here to provide a single source of truth for the
 * data model across modules.
 *
 * @module @memos/types
 */

// ---------------------------------------------------------------------------
// Memory Nodes
// ---------------------------------------------------------------------------

/**
 * Semantic category for a memory node.
 *
 * - `fact`          — A discrete piece of information.
 * - `preference`    — A user or agent preference.
 * - `context`       — Conversational or situational context.
 * - `relationship`  — An observed relationship between entities.
 * - `entity`        — A named entity (person, place, thing).
 * - `custom`        — Application-defined type.
 */
export type MemoryType =
  | "fact"
  | "preference"
  | "context"
  | "relationship"
  | "entity"
  | "custom";

/**
 * A single unit of memory stored in the graph.
 */
export interface MemoryNode {
  /** Globally unique identifier (UUID v4). */
  id: string;
  /** Raw text content of the memory. */
  content: string;
  /** Extractive summary (auto-generated if not supplied). */
  summary: string;
  /** Semantic type of this memory. */
  type: MemoryType;
  /** Arbitrary metadata bag. Must be JSON-serialisable. */
  metadata: Record<string, unknown>;
  /** Importance score in [0, 1]. Auto-computed from access patterns. */
  importance: number;
  /** Creation timestamp (Unix ms). */
  createdAt: number;
  /** Last-modified timestamp (Unix ms). */
  updatedAt: number;
  /** Number of times this node has been retrieved. */
  accessCount: number;
  /** Timestamp of last access (Unix ms). */
  lastAccessed: number;
}

/**
 * Partial input accepted when creating a new memory.
 * Only `content` is required; everything else has defaults.
 */
export interface CreateMemoryInput {
  content: string;
  type?: MemoryType;
  metadata?: Record<string, unknown>;
  summary?: string;
  importance?: number;
}

/**
 * Partial update for an existing memory node.
 */
export interface UpdateMemoryInput {
  content?: string;
  summary?: string;
  type?: MemoryType;
  metadata?: Record<string, unknown>;
  importance?: number;
}

// ---------------------------------------------------------------------------
// Memory Edges
// ---------------------------------------------------------------------------

/**
 * Semantic relation between two memory nodes.
 *
 * - `relates_to`     — General association.
 * - `contradicts`    — The target contradicts the source.
 * - `supports`       — The target supports the source.
 * - `derived_from`   — The source was derived from the target.
 * - `part_of`        — The source is a part of the target.
 * - `custom`         — Application-defined relation.
 */
export type EdgeRelation =
  | "relates_to"
  | "contradicts"
  | "supports"
  | "derived_from"
  | "part_of"
  | "custom";

/**
 * A directed, weighted edge connecting two memory nodes.
 */
export interface MemoryEdge {
  /** Globally unique identifier (UUID v4). */
  id: string;
  /** Source node ID. */
  sourceId: string;
  /** Target node ID. */
  targetId: string;
  /** Semantic relation label. */
  relation: EdgeRelation;
  /** Edge weight in [0, 1]. */
  weight: number;
  /** Arbitrary metadata bag. */
  metadata: Record<string, unknown>;
  /** Creation timestamp (Unix ms). */
  createdAt: number;
}

/**
 * Input for creating a new edge.
 */
export interface CreateEdgeInput {
  sourceId: string;
  targetId: string;
  relation?: EdgeRelation;
  weight?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Search & Query
// ---------------------------------------------------------------------------

/**
 * Filter criteria for searching memories.
 */
export interface SearchFilter {
  /** Full-text search query. */
  query?: string;
  /** Filter by memory type. */
  type?: MemoryType;
  /** Minimum importance threshold [0, 1]. */
  minImportance?: number;
  /** Maximum importance threshold [0, 1]. */
  maxImportance?: number;
  /** Metadata key-value filter. */
  metadata?: Record<string, unknown>;
  /** Limit the number of results. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /** Sort field. */
  sortBy?: "importance" | "createdAt" | "updatedAt" | "accessCount" | "relevance";
  /** Sort direction. */
  sortOrder?: "asc" | "desc";
}

/**
 * A memory node bundled with its relevance score after a search.
 */
export interface ScoredMemory {
  node: MemoryNode;
  /** Relevance score returned by the search algorithm. */
  score: number;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * Full in-memory graph snapshot.
 */
export interface GraphSnapshot {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}

// ---------------------------------------------------------------------------
// Storage Adapter Interface
// ---------------------------------------------------------------------------

/**
 * Backend-agnostic storage contract.
 *
 * Any persistence backend (SQLite, Postgres, Redis, Qdrant …) must
 * implement this interface. The core engine only depends on this
 * contract, never on a concrete backend.
 */
export interface StorageAdapter {
  /** Initialise tables / indices / connections. Called once at startup. */
  init(): Promise<void>;

  /** Persist a new memory node. Returns the created node. */
  saveNode(node: MemoryNode): Promise<MemoryNode>;

  /** Retrieve a node by ID. Returns `null` when not found. */
  getNode(id: string): Promise<MemoryNode | null>;

  /** Partially update a node. Returns the updated node. */
  updateNode(id: string, input: UpdateMemoryInput): Promise<MemoryNode | null>;

  /** Delete a node and all connected edges. */
  deleteNode(id: string): Promise<boolean>;

  /** Persist a new edge. Returns the created edge. */
  saveEdge(edge: MemoryEdge): Promise<MemoryEdge>;

  /** Retrieve an edge by ID. */
  getEdge(id: string): Promise<MemoryEdge | null>;

  /** Delete an edge by ID. */
  deleteEdge(id: string): Promise<boolean>;

  /** Query nodes with filters. */
  queryNodes(filter: SearchFilter): Promise<ScoredMemory[]>;

  /** Query edges, optionally filtered by source/target. */
  queryEdges(filter?: {
    sourceId?: string;
    targetId?: string;
    relation?: EdgeRelation;
  }): Promise<MemoryEdge[]>;

  /** Return the full graph (nodes + edges). */
  getGraph(): Promise<GraphSnapshot>;

  /** Close connections and release resources. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration options for a MemOS instance.
 */
export interface MemOSConfig {
  /**
   * Path to the SQLite database file.
   * @default "~/.memos/memos.db"
   */
  dbPath?: string;

  /**
   * Enable WAL mode for SQLite.
   * @default true
   */
  wal?: boolean;

  /**
   * Maximum number of memories to keep before LRU eviction.
   * Set to `0` to disable eviction.
   * @default 0
   */
  maxMemories?: number;

  /**
   * Auto-link threshold: minimum cosine-similarity score (bag-of-words)
   * between two nodes to automatically create an edge.
   * Set to `0` to disable auto-linking.
   * @default 0.3
   */
  autoLinkThreshold?: number;

  /**
   * Custom storage adapter. When provided, `dbPath` is ignored.
   */
  storage?: StorageAdapter;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Events emitted by the MemoryManager. */
export type MemOSEvent =
  | "node:created"
  | "node:updated"
  | "node:deleted"
  | "edge:created"
  | "edge:deleted"
  | "link:auto"
  | "eviction";

/** Event listener signature. */
export type MemOSEventListener = (data: unknown) => void;
