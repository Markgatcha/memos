/**
 * Single-step PPR-lite graph expansion (HippoRAG-style retrieval).
 *
 * After hybrid fusion produces a ranked candidate list, the top seeds are
 * used as the personalization (restart) vector of a personalized PageRank
 * walk over the 1–2 hop neighbourhood of graph edges + shared-entity
 * links. The walk is a single sparse matrix-vector power iteration — no
 * LLM calls, no extra embedding calls, no iterative retrieval rounds
 * (the whole point: HippoRAG reaches iterative-IRCoT-level multi-hop
 * accuracy at 10–30x lower cost with one PPR pass).
 *
 * Evidence notes (see `~/workspace/your_files/memos-memory-accuracy-
 * research.md` §1a/§5-item-5):
 * - PPR damping 0.5, as in HippoRAG.
 * - Keep BOTH memory (passage) and entity nodes in the graph: dropping
 *   passage nodes costs −6.1 multi-hop F1. This implementation returns
 *   scores for every visited node, including the seeds themselves —
 *   callers must not filter down to entity-only.
 * - Query-to-triple linking beat NER-to-node by +12.5 R@5; the analogue
 *   here is seeding the walk from fused retrieval hits (which already
 *   carry the query match) rather than from extracted entities alone.
 *
 * The module is intentionally storage-free: the neighbourhood is injected
 * via a `getNeighbors` callback so the walk is a pure function and
 * unit-testable on synthetic graphs. `MemOS` wires it up in
 * `applyPprGraphExpansion` (`src/memory.ts`) using the in-memory
 * `GraphEngine` adjacency plus shared-entity links derived from the
 * fused candidate set.
 */

/** Tuning knobs for {@link personalizedPageRank}. */
export interface PersonalizedPageRankOptions {
  /**
   * Follow-link probability per power-iteration step; `1 - damping` is
   * the teleport (restart) mass returned to the personalization vector.
   * HippoRAG uses 0.5. Default 0.5.
   */
  damping?: number;
  /** BFS neighbourhood depth explored from the seed set. Default 2. */
  maxHops?: number;
  /**
   * Per-node neighbour cap, applied after de-duplication and sorting.
   * Bounds both the explored subgraph and the per-iteration work.
   * Default 64.
   */
  maxFanout?: number;
  /**
   * Cap on total visited nodes (safety bound for very dense graphs:
   * without it, `seeds × maxFanout^maxHops` bounds the subgraph only
   * loosely). BFS explores in sorted-frontier order, so which nodes are
   * kept is deterministic. Default 2048.
   */
  maxNodes?: number;
  /** Power-iteration cap. Default 50. */
  maxIterations?: number;
  /** L1 convergence tolerance between iterations. Default 1e-6. */
  tolerance?: number;
}

/** Default PPR damping (follow-link probability), per HippoRAG. */
export const DEFAULT_PPR_DAMPING = 0.5;
/** Default neighbourhood depth (1–2 hop expansion). */
export const DEFAULT_PPR_MAX_HOPS = 2;
/** Default per-node fan-out safety cap. */
export const DEFAULT_PPR_MAX_FANOUT = 64;
/** Default cap on total visited nodes. */
export const DEFAULT_PPR_MAX_NODES = 2048;
/** Default power-iteration cap. */
export const DEFAULT_PPR_MAX_ITERATIONS = 50;
/** Default L1 convergence tolerance. */
export const DEFAULT_PPR_TOLERANCE = 1e-6;

/**
 * Default blend weight of the normalized PPR score in the post-fusion
 * blend (`final = (1 - alpha) * fused + alpha * pprNorm`).
 */
export const DEFAULT_GRAPH_EXPANSION_ALPHA = 0.2;
/** Default number of top fused results that seed the PPR walk. */
export const DEFAULT_GRAPH_EXPANSION_SEEDS = 10;
/** Default PPR neighbourhood depth from each seed. */
export const DEFAULT_GRAPH_EXPANSION_HOPS = 2;
/**
 * Cap on graph neighbours injected into the results per query. Bounds
 * the extra storage reads (one `peekNode` per injected candidate).
 */
export const DEFAULT_PPR_MAX_INJECTED = 10;
/**
 * Minimum normalized PPR score for a neighbour to be injected. Filters
 * the long tail of barely-visited nodes so expansion only surfaces
 * candidates the walk actually concentrated on.
 */
export const DEFAULT_PPR_MIN_INJECT_SCORE = 0.05;

/**
 * Personalized PageRank over a bounded neighbourhood of the seed set.
 *
 * - The personalization (restart) vector is the seed scores, clamped to
 *   >= 0 and normalized to sum 1 (uniform over seeds when every seed
 *   score is <= 0).
 * - The explored subgraph is the BFS neighbourhood up to `maxHops`
 *   from the seeds; neighbour lists are de-duplicated, sorted, and
 *   fan-out capped, so exploration is deterministic regardless of the
 *   order `getNeighbors` returns.
 * - Power iteration: `r ← damping · Mᵀr + (1 − damping) · p`, with
 *   dangling-node mass redistributed through the personalization vector
 *   (standard PPR handling so rank cannot leak out of the subgraph).
 * - Returns scores for ALL visited nodes, INCLUDING the seed/memory
 *   (passage) nodes — never filter to entity-only (HippoRAG ablation:
 *   −6.1 F1 when passage nodes are dropped).
 *
 * Pure function: no storage, no I/O, no randomness. Deterministic for
 * deterministic `getNeighbors`.
 *
 * @param seeds — Seed node ids mapped to their (non-negative) scores,
 *   e.g. fused hybrid-search scores for the top-K candidates.
 * @param getNeighbors — Neighbour ids for a node id. Directionality is
 *   the caller's choice; MemOS passes both edge endpoints (undirected
 *   traversal) plus shared-entity links.
 * @param opts — Damping / hops / fan-out / iteration tuning.
 * @returns PPR score per visited node id (unnormalized; sums to ~1).
 */
export function personalizedPageRank(
  seeds: Map<string, number>,
  getNeighbors: (id: string) => string[],
  opts: PersonalizedPageRankOptions = {},
): Map<string, number> {
  const damping = opts.damping ?? DEFAULT_PPR_DAMPING;
  const maxHops = opts.maxHops ?? DEFAULT_PPR_MAX_HOPS;
  const maxFanout = opts.maxFanout ?? DEFAULT_PPR_MAX_FANOUT;
  const maxNodes = opts.maxNodes ?? DEFAULT_PPR_MAX_NODES;
  const maxIterations = opts.maxIterations ?? DEFAULT_PPR_MAX_ITERATIONS;
  const tolerance = opts.tolerance ?? DEFAULT_PPR_TOLERANCE;

  const scores = new Map<string, number>();
  if (seeds.size === 0) return scores;

  // Personalization vector: seed scores, clamped >= 0, normalized to sum 1.
  const seedIds = [...seeds.keys()].sort();
  let totalMass = 0;
  const clamped = new Map<string, number>();
  for (const id of seedIds) {
    const mass = Math.max(0, seeds.get(id) ?? 0);
    clamped.set(id, mass);
    totalMass += mass;
  }
  const personalization = new Map<string, number>();
  if (totalMass > 0) {
    for (const id of seedIds) {
      personalization.set(id, clamped.get(id)! / totalMass);
    }
  } else {
    // Degenerate (all seed scores <= 0): uniform restart over seeds so
    // the walk still explores the seed neighbourhood deterministically.
    for (const id of seedIds) {
      personalization.set(id, 1 / seedIds.length);
    }
  }

  // Bounded BFS neighbourhood exploration. Neighbour lists are
  // de-duplicated, sorted, and fan-out capped at every step, so both the
  // visited set and the iteration are deterministic regardless of the
  // order `getNeighbors` returns. Results are cached: the adjacency
  // build below re-queries the same nodes the BFS already visited.
  const fanout = Math.max(0, maxFanout);
  const neighborCache = new Map<string, string[]>();
  const cachedNeighbors = (id: string): string[] => {
    let neighbours = neighborCache.get(id);
    if (!neighbours) {
      neighbours = uniqueSorted(getNeighbors(id)).slice(0, fanout);
      neighborCache.set(id, neighbours);
    }
    return neighbours;
  };
  const visited = new Set<string>(seedIds);
  let frontier = seedIds;
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of cachedNeighbors(id)) {
        if (neighbour === id || visited.has(neighbour)) continue;
        // Safety cap: stop growing the subgraph once it is large enough
        // that power iteration would dominate the hot path. Frontier
        // order is sorted, so the kept set is deterministic.
        if (visited.size >= Math.max(seedIds.length, maxNodes)) break;
        visited.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next.sort();
  }

  // Induced subgraph adjacency: neighbours restricted to visited nodes,
  // sorted and fan-out capped for deterministic, bounded iteration.
  // Integer-indexed so the power-iteration hot loop avoids Map lookups.
  const nodes = [...visited].sort();
  const indexOf = new Map<string, number>();
  nodes.forEach((id, i) => indexOf.set(id, i));
  const adjacency: number[][] = nodes.map((id) =>
    cachedNeighbors(id)
      .filter((n) => n !== id && visited.has(n))
      .map((n) => indexOf.get(n)!),
  );
  const restart = new Float64Array(nodes.length);
  for (const id of seedIds) {
    restart[indexOf.get(id)!] = personalization.get(id) ?? 0;
  }

  // Power iteration from the personalization vector.
  let rank = Float64Array.from(restart);
  let next = new Float64Array(nodes.length);
  for (let iter = 0; iter < maxIterations; iter += 1) {
    next.fill(0);
    let danglingMass = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const r = rank[i]!;
      if (r === 0) continue;
      const neighbours = adjacency[i]!;
      if (neighbours.length === 0) {
        // Dangling node: its mass would leak out of the subgraph, so
        // redistribute it through the personalization vector below.
        danglingMass += r;
      } else {
        const share = (damping * r) / neighbours.length;
        for (const j of neighbours) next[j]! += share;
      }
    }
    let delta = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      const value =
        next[i]! +
        (1 - damping) * restart[i]! +
        damping * danglingMass * restart[i]!;
      delta += Math.abs(value - rank[i]!);
      next[i] = value;
    }
    const tmp = rank;
    rank = next;
    next = tmp;
    if (delta < tolerance) break;
  }

  for (let i = 0; i < nodes.length; i += 1) scores.set(nodes[i]!, rank[i]!);
  return scores;
}

/** De-duplicated, sorted copy of a neighbour list (deterministic order). */
function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}
