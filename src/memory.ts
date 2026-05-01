/**
 * MemoryManager — the public API surface of MemOS.
 *
 * Orchestrates graph operations, persistence, auto-linking, and
 * extractive summarisation. This is the class that application
 * code interacts with.
 *
 * @module @memos/memory
 */

import { GraphEngine, generateId, textSimilarity } from "./graph.js";
import { SQLiteStorage } from "./storage/sqlite.js";
import { defaultDbPath } from "./storage/sqlite.js";
import type {
  MemoryNode,
  MemoryEdge,
  CreateMemoryInput,
  UpdateMemoryInput,
  ScoredMemory,
  SearchFilter,
  GraphSnapshot,
  MemOSConfig,
  StorageAdapter,
  MemOSEvent,
  MemOSEventListener,
  ExportOptions,
  ExportResult,
  ExperimentalConfig,
} from "./types.js";

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
  private experimental: ExperimentalConfig;
  private listeners: Map<MemOSEvent, MemOSEventListener[]> = new Map();
  private initialised = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
      sweepInterval: config.sweepInterval ?? 60,
      experimental: config.experimental ?? {},
    };

    this.experimental = this.config.experimental;

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

    // Start TTL sweep
    this.startSweep();

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
   * @param opts    — Optional metadata, type, summary, importance, ttl, tags.
   * @returns The created node and any auto-created edges.
   */
  async store(
    content: string,
    opts: Omit<CreateMemoryInput, "content"> = {},
  ): Promise<{ node: MemoryNode; links: MemoryEdge[] }> {
    this.assertInit();

    const now = Date.now();
    const namespace = this.experimental.namespaces
      ? (opts.namespace ?? "default")
      : "default";

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
      tags: opts.tags ?? [],
      expiresAt: opts.ttl ? Math.floor(now / 1000) + opts.ttl : null,
      namespace,
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

    if (this.experimental.namespaces) {
      filter.namespace = filter.namespace ?? "default";
    }

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
  // TTL API
  // -----------------------------------------------------------------------

  /**
   * Set a time-to-live on a memory node.
   *
   * @param id — Memory node ID.
   * @param seconds — TTL in seconds from now.
   */
  async setTTL(id: string, seconds: number): Promise<void> {
    this.assertInit();
    await this.storage.setTTL(id, seconds);
  }

  /**
   * Clear the TTL on a memory node (make it persist indefinitely).
   *
   * @param id — Memory node ID.
   */
  async clearTTL(id: string): Promise<void> {
    this.assertInit();
    await this.storage.clearTTL(id);
  }

  // -----------------------------------------------------------------------
  // Tags API
  // -----------------------------------------------------------------------

  /**
   * Add tags to a memory node.
   *
   * @param id — Memory node ID.
   * @param tags — Tags to add.
   */
  async tag(id: string, tags: string[]): Promise<void> {
    this.assertInit();
    const node = await this.storage.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const merged = [...new Set([...node.tags, ...tags])];
    await this.storage.updateNode(id, { tags: merged });

    const updated = await this.storage.getNode(id);
    if (updated) this.graph.updateNode(updated);
  }

  /**
   * Remove tags from a memory node.
   *
   * @param id — Memory node ID.
   * @param tags — Tags to remove.
   */
  async untag(id: string, tags: string[]): Promise<void> {
    this.assertInit();
    const node = await this.storage.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const tagSet = new Set(tags);
    const filtered = node.tags.filter((t) => !tagSet.has(t));
    await this.storage.updateNode(id, { tags: filtered });

    const updated = await this.storage.getNode(id);
    if (updated) this.graph.updateNode(updated);
  }

  /**
   * List all memories with a specific tag.
   *
   * @param tag — Tag to filter by.
   * @returns Array of memory nodes with the tag.
   */
  async listByTag(tag: string): Promise<MemoryNode[]> {
    this.assertInit();
    return this.storage.queryNodesByTag(tag);
  }

  // -----------------------------------------------------------------------
  // Export API
  // -----------------------------------------------------------------------

  /**
   * Export memories in the specified format.
   */
  async export(opts: ExportOptions = {}): Promise<ExportResult> {
    this.assertInit();

    const format = opts.format ?? "json";
    let nodes: MemoryNode[];

    if (opts.tag) {
      nodes = await this.storage.queryNodesByTag(opts.tag);
    } else {
      nodes = this.graph.getAllNodes();
    }

    if (format === "json") {
      const data = JSON.stringify(nodes, null, 2);
      return { format, data, count: nodes.length };
    }

    // markdown or obsidian
    const { mkdirSync, writeSync, openSync, closeSync } = await import("fs");
    const { join } = await import("path");
    const outputDir = opts.output ?? "./memos-export";
    mkdirSync(outputDir, { recursive: true });

    for (const node of nodes) {
      const filename = `${node.id}.md`;
      const filepath = join(outputDir, filename);
      const content = this.nodeToMarkdown(node, format);
      const fd = openSync(filepath, "w");
      writeSync(fd, content);
      closeSync(fd);
    }

    return { format, data: outputDir, count: nodes.length };
  }

  // -----------------------------------------------------------------------
  // Experimental: Semantic Search
  // -----------------------------------------------------------------------

  /**
   * Semantic search using bag-of-words similarity against all nodes.
   * This is the experimental semantic search — a lightweight local alternative.
   */
  async semanticSearch(
    query: string,
    limit = 20,
    threshold = 0.1,
  ): Promise<ScoredMemory[]> {
    this.assertInit();
    if (!this.experimental.semanticSearch) {
      throw new Error(
        "Semantic search is experimental. Enable it with experimental: { semanticSearch: true }",
      );
    }

    const nodes = this.graph.getAllNodes();
    const scored: ScoredMemory[] = [];

    for (const node of nodes) {
      const score = textSimilarity(query, node.content);
      if (score >= threshold) {
        scored.push({ node, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // -----------------------------------------------------------------------
  // Experimental: Graph Visualization
  // -----------------------------------------------------------------------

  /**
   * Generate a DOT-format graph visualization string.
   */
  async graphViz(): Promise<string> {
    this.assertInit();
    if (!this.experimental.graphViz) {
      throw new Error(
        "Graph visualization is experimental. Enable it with experimental: { graphViz: true }",
      );
    }

    const nodes = this.graph.getAllNodes();
    const edges = this.graph.getAllEdges();

    let dot = "digraph MemOS {\n";
    dot += "  rankdir=LR;\n";
    dot += "  node [shape=box, style=rounded];\n\n";

    for (const node of nodes) {
      const label =
        node.summary.length > 40
          ? node.summary.slice(0, 37) + "..."
          : node.summary;
      dot += `  "${node.id.slice(0, 8)}" [label="${this.escapeDot(label)}"];\n`;
    }

    dot += "\n";

    for (const edge of edges) {
      dot += `  "${edge.sourceId.slice(0, 8)}" -> "${edge.targetId.slice(0, 8)}" [label="${edge.relation}", weight=${edge.weight.toFixed(2)}];\n`;
    }

    dot += "}\n";
    return dot;
  }

  // -----------------------------------------------------------------------
  // Experimental: Namespaces
  // -----------------------------------------------------------------------

  /**
   * List all namespaces.
   */
  async listNamespaces(): Promise<string[]> {
    this.assertInit();
    if (!this.experimental.namespaces) {
      throw new Error(
        "Namespaces are experimental. Enable them with experimental: { namespaces: true }",
      );
    }

    const nodes = this.graph.getAllNodes();
    const nsSet = new Set<string>();
    for (const n of nodes) {
      nsSet.add(n.namespace);
    }
    return [...nsSet];
  }

  /**
   * Get the count of memories in a namespace.
   */
  async namespaceCount(ns: string): Promise<number> {
    this.assertInit();
    if (!this.experimental.namespaces) {
      throw new Error(
        "Namespaces are experimental. Enable them with experimental: { namespaces: true }",
      );
    }

    return this.graph.getAllNodes().filter((n) => n.namespace === ns).length;
  }

  // -----------------------------------------------------------------------
  // Experimental: Context Injection
  // -----------------------------------------------------------------------

  /**
   * Get context for a node by walking the graph to a given depth.
   * Returns the node's content plus contents of neighbours up to `depth` hops.
   */
  async injectContext(id: string, depth = 1, maxChars = 2000): Promise<string> {
    this.assertInit();
    if (!this.experimental.contextInjection) {
      throw new Error(
        "Context injection is experimental. Enable it with experimental: { contextInjection: true }",
      );
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id, d: 0 }];
    const parts: string[] = [];

    while (queue.length > 0) {
      const { id: currentId, d } = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const node = this.graph.getNode(currentId);
      if (!node) continue;

      const prefix =
        d === 0 ? "Current memory:" : `Related memory (depth ${d}):`;
      parts.push(`${prefix}\n${node.content}`);

      if (d < depth) {
        const neighbours = this.graph.getNeighbours(currentId);
        for (const n of neighbours) {
          if (!visited.has(n.id)) {
            queue.push({ id: n.id, d: d + 1 });
          }
        }
      }
    }

    let context = parts.join("\n\n---\n\n");
    if (context.length > maxChars) {
      context = context.slice(0, maxChars) + "\n...[truncated]";
    }
    return context;
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
    this.stopSweep();
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

  /**
   * Start the background TTL sweep timer.
   */
  private startSweep(): void {
    const intervalSec = this.config.sweepInterval;
    if (intervalSec <= 0) return;

    this.sweepTimer = setInterval(async () => {
      try {
        const count = await this.storage.sweepExpired();
        if (count > 0) {
          // Remove expired nodes from in-memory graph
          const allNodes = this.graph.getAllNodes();
          const now = Math.floor(Date.now() / 1000);
          for (const n of allNodes) {
            if (n.expiresAt !== null && n.expiresAt <= now) {
              this.graph.removeNode(n.id);
              this.emit("ttl:expired", n);
            }
          }
        }
      } catch {
        // Sweep errors are non-fatal
      }
    }, intervalSec * 1000);

    // Unref so the timer doesn't prevent process exit
    if (
      this.sweepTimer &&
      typeof this.sweepTimer === "object" &&
      "unref" in this.sweepTimer
    ) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Stop the background TTL sweep timer.
   */
  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Convert a memory node to markdown with YAML frontmatter.
   */
  private nodeToMarkdown(
    node: MemoryNode,
    format: "markdown" | "obsidian",
  ): string {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`id: "${node.id}"`);
    lines.push(`type: "${node.type}"`);
    lines.push(`tags: [${node.tags.map((t) => `"${t}"`).join(", ")}]`);
    lines.push(`created_at: "${new Date(node.createdAt).toISOString()}"`);
    if (node.expiresAt) {
      lines.push(
        `expires_at: "${new Date(node.expiresAt * 1000).toISOString()}"`,
      );
    }
    lines.push("---");
    lines.push("");

    if (format === "obsidian") {
      // Convert linked memories to wikilinks
      const neighbours = this.graph.getNeighbours(node.id);
      let content = node.content;
      for (const n of neighbours) {
        const title = n.content.slice(0, 50).replace(/[[\]]/g, "");
        content = content.replace(
          new RegExp(this.escapeRegex(n.content.slice(0, 30)), "gi"),
          `[[${title}]]`,
        );
      }
      lines.push(content);
    } else {
      lines.push(node.content);
    }

    return lines.join("\n");
  }

  private escapeDot(str: string): string {
    return str.replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  ExportOptions,
  ExportResult,
  ExperimentalConfig,
} from "./types.js";
export { GraphEngine, textSimilarity } from "./graph.js";
export { SQLiteStorage } from "./storage/sqlite.js";
