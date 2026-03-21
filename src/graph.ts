/**
 * In-memory graph engine for MemOS.
 *
 * Maintains an adjacency-list representation of the memory graph for
 * fast traversal, clustering, and auto-linking. The graph mirrors
 * what is persisted in the storage backend.
 *
 * @module @memos/graph
 */

import type {
  MemoryNode,
  MemoryEdge,
  CreateEdgeInput,
  EdgeRelation,
} from "./types";

/**
 * Bag-of-words cosine similarity between two strings.
 *
 * This is intentionally lightweight — no external embedding model needed.
 * For production use-cases requiring semantic similarity, supply your own
 * embedding-based linker via the adapter interface.
 *
 * @param a — First text.
 * @param b — Second text.
 * @returns Cosine similarity in [0, 1].
 */
export function textSimilarity(a: string, b: string): number {
  const tokensA = bagOfWords(a);
  const tokensB = bagOfWords(b);

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersection = new Set<string>();
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection.add(token);
  }

  // Cosine similarity with binary term frequency
  return intersection.size / Math.sqrt(tokensA.size * tokensB.size);
}

/**
 * Tokenise text into a set of lowercased, de-stopped words.
 */
function bagOfWords(text: string): Set<string> {
  const STOP_WORDS = new Set([
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
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "and",
    "but",
    "or",
    "nor",
    "not",
    "so",
    "yet",
    "both",
    "either",
    "neither",
    "each",
    "every",
    "all",
    "any",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "only",
    "own",
    "same",
    "than",
    "too",
    "very",
    "just",
    "because",
    "about",
    "up",
    "out",
    "it",
    "its",
    "this",
    "that",
    "these",
    "those",
    "i",
    "me",
    "my",
    "we",
    "our",
    "you",
    "your",
    "he",
    "him",
    "his",
    "she",
    "her",
    "they",
    "them",
    "their",
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );
}

/**
 * Graph engine managing the in-memory representation of the memory graph.
 */
export class GraphEngine {
  /** Adjacency list: nodeId → Set of edge IDs. */
  private adjacency: Map<string, Set<string>> = new Map();
  /** Edge lookup: edgeId → MemoryEdge. */
  private edges: Map<string, MemoryEdge> = new Map();
  /** Node lookup: nodeId → MemoryNode. */
  private nodes: Map<string, MemoryNode> = new Map();

  /**
   * Add a node to the graph.
   *
   * @param node — The memory node to add.
   */
  addNode(node: MemoryNode): void {
    this.nodes.set(node.id, node);
    if (!this.adjacency.has(node.id)) {
      this.adjacency.set(node.id, new Set());
    }
  }

  /**
   * Remove a node and all its connected edges from the graph.
   *
   * @param id — Node ID to remove.
   * @returns `true` if the node existed.
   */
  removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false;

    // Remove connected edges
    const edgeIds = this.adjacency.get(id);
    if (edgeIds) {
      for (const edgeId of [...edgeIds]) {
        this.removeEdge(edgeId);
      }
    }

    this.nodes.delete(id);
    this.adjacency.delete(id);
    return true;
  }

  /**
   * Update a node in the graph.
   */
  updateNode(node: MemoryNode): void {
    this.nodes.set(node.id, node);
  }

  /**
   * Add an edge to the graph.
   *
   * @param input — Edge creation input.
   * @returns The created edge.
   */
  addEdge(input: CreateEdgeInput): MemoryEdge {
    const edge: MemoryEdge = {
      id: generateId(),
      sourceId: input.sourceId,
      targetId: input.targetId,
      relation: input.relation ?? "relates_to",
      weight: input.weight ?? 0.5,
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
    };

    this.edges.set(edge.id, edge);

    if (!this.adjacency.has(edge.sourceId)) {
      this.adjacency.set(edge.sourceId, new Set());
    }
    this.adjacency.get(edge.sourceId)!.add(edge.id);

    if (!this.adjacency.has(edge.targetId)) {
      this.adjacency.set(edge.targetId, new Set());
    }
    this.adjacency.get(edge.targetId)!.add(edge.id);

    return edge;
  }

  /**
   * Remove an edge from the graph.
   */
  removeEdge(id: string): boolean {
    const edge = this.edges.get(id);
    if (!edge) return false;

    this.adjacency.get(edge.sourceId)?.delete(id);
    this.adjacency.get(edge.targetId)?.delete(id);
    this.edges.delete(id);
    return true;
  }

  /**
   * Get all edges connected to a node.
   */
  getEdgesForNode(nodeId: string): MemoryEdge[] {
    const edgeIds = this.adjacency.get(nodeId);
    if (!edgeIds) return [];

    const result: MemoryEdge[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (edge) result.push(edge);
    }
    return result;
  }

  /**
   * Get neighbours of a node (nodes connected by an edge).
   */
  getNeighbours(nodeId: string): MemoryNode[] {
    const edges = this.getEdgesForNode(nodeId);
    const neighbourIds = new Set<string>();

    for (const edge of edges) {
      if (edge.sourceId === nodeId) neighbourIds.add(edge.targetId);
      else neighbourIds.add(edge.sourceId);
    }

    const result: MemoryNode[] = [];
    for (const id of neighbourIds) {
      const node = this.nodes.get(id);
      if (node) result.push(node);
    }
    return result;
  }

  /**
   * Attempt to auto-link a node to existing nodes based on text similarity.
   *
   * @param node     — The node to link.
   * @param threshold — Minimum similarity score to create an edge [0, 1].
   * @returns Array of created edges.
   */
  autoLink(node: MemoryNode, threshold: number): MemoryEdge[] {
    const created: MemoryEdge[] = [];

    for (const [id, existing] of this.nodes) {
      if (id === node.id) continue;

      const sim = textSimilarity(node.content, existing.content);
      if (sim >= threshold) {
        const edge = this.addEdge({
          sourceId: node.id,
          targetId: existing.id,
          relation: "relates_to",
          weight: sim,
        });
        created.push(edge);
      }
    }

    return created;
  }

  /**
   * Find clusters of strongly connected nodes using a simple BFS approach.
   *
   * @param minClusterSize — Minimum number of nodes per cluster.
   * @returns Array of clusters (each cluster is an array of node IDs).
   */
  findClusters(minClusterSize = 2): string[][] {
    const visited = new Set<string>();
    const clusters: string[][] = [];

    for (const nodeId of this.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      const cluster: string[] = [];
      const queue: string[] = [nodeId];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        cluster.push(current);

        const neighbours = this.getNeighbours(current);
        for (const n of neighbours) {
          if (!visited.has(n.id)) queue.push(n);
        }
      }

      if (cluster.length >= minClusterSize) {
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Get a node by ID.
   */
  getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get all nodes.
   */
  getAllNodes(): MemoryNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Get all edges.
   */
  getAllEdges(): MemoryEdge[] {
    return [...this.edges.values()];
  }

  /**
   * Node count.
   */
  get size(): number {
    return this.nodes.size;
  }

  /**
   * Clear the entire graph.
   */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
  }
}

/**
 * Generate a UUID v4.
 */
export function generateId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
