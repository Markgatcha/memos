/**
 * Retrieval fusion — Reciprocal Rank Fusion (RRF) for hybrid search.
 *
 * Extracted from `MemOS.hybridSearch()` so the fusion logic is a pure,
 * dependency-free function that can be unit-tested without storage,
 * embeddings, or a MemOS instance.
 *
 * Why RRF instead of a weighted score sum: FTS5 bm25 ranks and cosine
 * similarities live on different scales, so raw scores are not directly
 * comparable. RRF lets each retrieval leg vote for candidates by RANK
 * (`weight / (K + rank)`), which is robust to score outliers that would
 * otherwise dominate a weighted sum. K=60 is the standard constant from
 * the RRF paper (Cormack et al., 2009).
 *
 * The keyword leg carries the larger weight by default (0.8 vs 0.2):
 * exact term matches are highly reliable for factoid memory queries,
 * while embeddings rescue paraphrases that share no vocabulary.
 */

import type { MemoryNode, ScoredMemory } from "./types.js";

/** Default RRF constant (Cormack et al., 2009). */
export const DEFAULT_RRF_K = 60;

/** Default weight for the keyword (FTS5) leg. */
export const DEFAULT_KEYWORD_WEIGHT = 0.8;

/** Default weight for the semantic (embedding) leg. */
export const DEFAULT_SEMANTIC_WEIGHT = 0.2;

/**
 * Lower bound of the trust multiplier. A memory with trustScore 0 is
 * multiplied by `trustFloor`; trustScore 1 by 1.0. Kept gentle (0.7)
 * so trust nudges ranking without dominating pure relevance.
 */
export const DEFAULT_TRUST_FLOOR = 0.7;

export interface FusionOptions {
  /** RRF constant K. Larger K flattens rank differences. Default 60. */
  rrfK?: number;
  /** Weight of the keyword leg. Default 0.8. */
  keywordWeight?: number;
  /** Weight of the semantic leg. Default 0.2. */
  semanticWeight?: number;
  /**
   * Lower bound of the trust multiplier (applied as
   * `trustFloor + trustScore * (1 - trustFloor)`). Default 0.7.
   * Set to 1.0 to disable trust weighting.
   */
  trustFloor?: number;
}

/**
 * Fuse two ranked retrieval lists into one via weighted Reciprocal Rank
 * Fusion, then apply trust weighting.
 *
 * Both legs are expected to be pre-ranked best-first (as returned by
 * FTS5 bm25 and cosine-similarity search). Candidates appearing in both
 * legs accumulate both RRF contributions.
 *
 * @param keywordResults — Ranked keyword/FTS5 leg (best first).
 * @param semanticResults — Ranked semantic/embedding leg (best first).
 * @param options — Tunable weights; see {@link FusionOptions}.
 * @returns Fused list sorted by descending hybrid score, with a
 *   `scores` breakdown (`keyword`, `semantic`, `hybrid`) on each entry.
 */
export function fuseResults(
  keywordResults: ScoredMemory[],
  semanticResults: ScoredMemory[],
  options: FusionOptions = {},
): ScoredMemory[] {
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
  const semanticWeight = options.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT;
  const trustFloor = options.trustFloor ?? DEFAULT_TRUST_FLOOR;

  const merged = new Map<
    string,
    { node: MemoryNode; score: number; scores: Record<string, number> }
  >();

  for (const [index, result] of keywordResults.entries()) {
    const keywordRrf = keywordWeight / (rrfK + index + 1);
    merged.set(result.node.id, {
      node: result.node,
      score: keywordRrf,
      scores: { keyword: 1 - index / Math.max(keywordResults.length, 1) },
    });
  }

  for (const [index, result] of semanticResults.entries()) {
    const semanticRrf = semanticWeight / (rrfK + index + 1);
    const existing = merged.get(result.node.id);
    if (existing) {
      existing.score += semanticRrf;
      existing.scores.semantic = Math.max(0, result.score);
      existing.scores.hybrid = existing.score;
    } else {
      merged.set(result.node.id, {
        node: result.node,
        score: semanticRrf,
        scores: {
          keyword: 0,
          semantic: Math.max(0, result.score),
          hybrid: semanticRrf,
        },
      });
    }
  }

  // Trust weighting: a gentle multiplier (trustFloor–1.0) so high-trust
  // memories get a small boost without dominating pure relevance.
  for (const entry of merged.values()) {
    entry.score *=
      trustFloor + (entry.node.trustScore ?? 1.0) * (1 - trustFloor);
    entry.scores.hybrid = entry.score;
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      node: entry.node,
      score: entry.score,
      scores: entry.scores,
    }));
}
