/**
 * MemoryManager — the public API surface of MemOS.
 *
 * Orchestrates graph operations, persistence, auto-linking, and
 * extractive summarisation. This is the class that application
 * code interacts with.
 *
 * @module @memos/memory
 */

import { GraphEngine, generateId, textSimilarity } from "./graph";
import { SQLiteStorage } from "./storage/sqlite";
import { defaultDbPath } from "./storage/sqlite";
import type {
  MemoryNode,
  MemoryEdge,
  MemoryType,
  CreateMemoryInput,
  UpdateMemoryInput,
  ScoredMemory,
  SearchFilter,
  GraphSnapshot,
  MemOSConfig,
  StorageAdapter,
  MemOSEvent,
  MemOSEventListener,
} from "./types";

/**
 * Extractive summariser — picks the most important sentence from the text.
 *
 * Scores each sentence by word frequency (excluding stop words) and
 * returns the top-scoring sentence. Entirely local, no API calls.
 *
 * @param text — Raw text to summarise.
 * @returns Extractive summary sentence.
 */
function extractiveSummary(text: string): string {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  if (sentences.length === 0) return text.slice(0, 120);
  if (sentences.length === 1) return sentences[0];

  const stopWords = new Set([
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "shall",
    "should",
    "may",
    "might",
    "must",
    "can",
    "could",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "and",
    "but",
    "or",
    "not",
    "it",
    "its",
    "this",
    "that",
  ]);

  // Build word frequency across all sentences
  const freq = new Map<string, number>();
  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    for (const w of words) {
      if (w.length > 1 && !stopWords.has(w)) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }

  // Score each sentence
  let bestScore = -1;
  let bestSentence = sentences[0];

  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    let score = 0;
    for (const w of words) {
      score += freq.get(w) || 0;
    }
    // Normalise by sentence length to avoid favouring long sentences
    score = score / Math.max(words.length, 1);

    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }

  return bestSentence;
}

/**
 * Core MemOS instance. This is the primary entry point for all
 * memory operations.
 *
 * @example
 * ```ts
 * import { MemOS } from "@memos/sdk";
 *
 * const memos = new MemOS({ dbPath: "./my-app.db" });
 * await memos.init();
 *
 * const { node } = await memos.store("User prefers dark mode", { type: "preference" });
 * const results = await memos.search("dark mode");
 * ```
 */
export class MemOS {
  private graph: GraphEngine;
  private storage: StorageAdapter;
  private config: Required<Omit<MemOSConfig, "storage">> & {
    storage?: StorageAdapter;
  };
  private listeners: Map<MemOSEvent, MemOSEventListener[]> = new Map();
  private initialised = false;

  /**
   * Create a new MemOS instance.
   *
   * @param config — Configuration options. All fields are optional.
   */
  constructor(config: MemOSConfig = {}) {
    this.config = {
      dbPath: config.dbPath ?? defaultDbPath(),
      wal: config.wal ?? true,
      maxMemories: config.maxMemories ?? 0,
      autoLinkThreshold: config.autoLinkThreshold ?? 0.3,
      storage: config.storage,
    };

    this.graph = new GraphEngine();
    this.storage =
      this.config.storage ??
      new SQLiteStorage(this.config.dbPath, this.config.wal);
  }

  /**
   * Initialise the storage backend and hydrate the in-memory graph.
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    await this.storage.init();

    // Hydrate graph from storage
    const snapshot = await this.storage.getGraph();
    for (const node of snapshot.nodes) {
      this.graph.addNode(node);
    }
    for (const edge of snapshot.edges) {
      this.graph.addEdge({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relation: edge.relation,
        weight: edge.weight,
        metadata: edge.metadata,
      });
    }

    this.initialised = true;
  }

  // -----------------------------------------------------------------------
  // Core API
  // -----------------------------------------------------------------------

  /**
   * Store a new memory.
   *
   * Automatically generates a summary (if not provided) and attempts
   * to link the new node to existing nodes based on text similarity.
   *
   * @param content — Text content to remember.
   * @param opts    — Optional metadata, type, summary, importance.
   * @returns The created node and any auto-created edges.
   */
  async store(
    content: string,
    opts: Omit<CreateMemoryInput, "content"> = {},
  ): Promise<{ node: MemoryNode; links: MemoryEdge[] }> {
    this.assertInit();

    const now = Date.now();
    const node: MemoryNode = {
      id: generateId(),
      content,
      summary: opts.summary ?? extractiveSummary(content),
      type: opts.type ?? "fact",
      metadata: opts.metadata ?? {},
      importance: opts.importance ?? 0.5,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
    };

    await this.storage.saveNode(node);
    this.graph.addNode(node);

    // Auto-link
    const links: MemoryEdge[] = [];
    if (this.config.autoLinkThreshold > 0) {
      const autoEdges = this.graph.autoLink(
        node,
        this.config.autoLinkThreshold,
      );
      for (const edge of autoEdges) {
        await this.storage.saveEdge(edge);
        links.push(edge);
      }
      if (links.length > 0) {
        this.emit("link:auto", { node, edges: links });
      }
    }

    this.emit("node:created", node);

    // Eviction
    if (this.config.maxMemories > 0) {
      await this.evict();
    }

    return { node, links };
  }

  /**
   * Retrieve a single memory by ID.
   *
   * @param id — Memory node ID.
   * @returns The node, or `null` if not found.
   */
  async retrieve(id: string): Promise<MemoryNode | null> {
    this.assertInit();
    const node = await this.storage.getNode(id);
    if (node) {
      this.graph.updateNode(node);
      this.emit("node:updated", node);
    }
    return node;
  }

  /**
   * Search memories by text query and/or structured filters.
   *
   * @param queryOrFilter — A plain text query string, or a full SearchFilter object.
   * @returns Array of scored memories, ordered by relevance.
   */
  async search(queryOrFilter: string | SearchFilter): Promise<ScoredMemory[]> {
    this.assertInit();

    const filter: SearchFilter =
      typeof queryOrFilter === "string"
        ? { query: queryOrFilter, limit: 20 }
        : { limit: 20, ...queryOrFilter };

    return this.storage.queryNodes(filter);
  }

  /**
   * Permanently forget a memory and all its connected edges.
   *
   * @param id — Memory node ID to forget.
   * @returns `true` if the memory existed and was deleted.
   */
  async forget(id: string): Promise<boolean> {
    this.assertInit();

    const deleted = await this.storage.deleteNode(id);
    if (deleted) {
      this.graph.removeNode(id);
      this.emit("node:deleted", id);
    }
    return deleted;
  }

  /**
   * Generate a summary of all stored memories.
   *
   * Concatenates all node summaries and produces an extractive
   * summary of the combined text.
   *
   * @returns A summary string.
   */
  async summarize(): Promise<string> {
    this.assertInit();

    const nodes = this.graph.getAllNodes();
    if (nodes.length === 0) return "No memories stored.";

    const combined = nodes.map((n) => n.summary).join(". ");
    return extractiveSummary(combined);
  }

  /**
   * Manually create a link (edge) between two memories.
   *
   * @param sourceId — Source node ID.
   * @param targetId — Target node ID.
   * @param relation — Semantic relation type.
   * @param weight   — Edge weight [0, 1].
   * @returns The created edge.
   */
  async link(
    sourceId: string,
    targetId: string,
    relation: MemoryEdge["relation"] = "relates_to",
    weight = 0.5,
  ): Promise<MemoryEdge> {
    this.assertInit();

    const source = this.graph.getNode(sourceId);
    const target = this.graph.getNode(targetId);
    if (!source) throw new Error(`Node not found: ${sourceId}`);
    if (!target) throw new Error(`Node not found: ${targetId}`);

    const edge = this.graph.addEdge({ sourceId, targetId, relation, weight });
    await this.storage.saveEdge(edge);
    this.emit("edge:created", edge);
    return edge;
  }

  // -----------------------------------------------------------------------
  // Extended API
  // -----------------------------------------------------------------------

  /**
   * Update an existing memory node.
   */
  async update(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<MemoryNode | null> {
    this.assertInit();
    const node = await this.storage.updateNode(id, input);
    if (node) {
      this.graph.updateNode(node);
      this.emit("node:updated", node);
    }
    return node;
  }

  /**
   * Get the full graph snapshot (nodes + edges).
   */
  async getGraph(): Promise<GraphSnapshot> {
    this.assertInit();
    return {
      nodes: this.graph.getAllNodes(),
      edges: this.graph.getAllEdges(),
    };
  }

  /**
   * Get direct neighbours of a memory node.
   */
  async getNeighbours(nodeId: string): Promise<MemoryNode[]> {
    this.assertInit();
    return this.graph.getNeighbours(nodeId);
  }

  /**
   * Get all edges connected to a memory node.
   */
  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    this.assertInit();
    return this.graph.getEdgesForNode(nodeId);
  }

  /**
   * Find clusters of related memories.
   */
  async clusters(minSize = 2): Promise<string[][]> {
    this.assertInit();
    return this.graph.findClusters(minSize);
  }

  /**
   * Return the total number of stored memories.
   */
  get count(): number {
    return this.graph.size;
  }

  /**
   * Remove all memories and edges.
   */
  async clear(): Promise<void> {
    this.assertInit();
    const nodes = this.graph.getAllNodes();
    for (const node of nodes) {
      await this.storage.deleteNode(node.id);
    }
    this.graph.clear();
  }

  /**
   * Shut down MemOS and release resources.
   */
  async close(): Promise<void> {
    await this.storage.close();
    this.graph.clear();
    this.initialised = false;
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * Register an event listener.
   */
  on(event: MemOSEvent, listener: MemOSEventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  /**
   * Remove an event listener.
   */
  off(event: MemOSEvent, listener: MemOSEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  private emit(event: MemOSEvent, data: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const fn of arr) {
      try {
        fn(data);
      } catch {
        // Swallow listener errors to avoid crashing the pipeline.
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private assertInit(): void {
    if (!this.initialised) {
      throw new Error(
        "MemOS not initialised. Call `await memos.init()` before using the API.",
      );
    }
  }

  /**
   * Evict the least-important memory when `maxMemories` is exceeded.
   */
  private async evict(): Promise<void> {
    const max = this.config.maxMemories;
    if (max <= 0) return;

    while (this.graph.size > max) {
      const nodes = this.graph.getAllNodes();
      // Sort by importance ascending, then by lastAccessed ascending
      nodes.sort((a, b) => {
        if (a.importance !== b.importance) return a.importance - b.importance;
        return a.lastAccessed - b.lastAccessed;
      });

      const victim = nodes[0];
      await this.forget(victim.id);
      this.emit("eviction", victim);
    }
  }
}

// Re-export for convenience
export type {
  MemoryNode,
  MemoryEdge,
  SearchFilter,
  ScoredMemory,
  GraphSnapshot,
  MemOSConfig,
} from "./types";
export { GraphEngine, textSimilarity } from "./graph";
export { SQLiteStorage } from "./storage/sqlite";
