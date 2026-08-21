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
import { confidenceWeight } from "./confidence-machine.js";

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

/**
 * Weight of the confidence multiplier applied AFTER fusion. The
 * confidence state machine (`src/confidence-machine.ts`) tracks how
 * consistently a memory has been reinforced vs contradicted over time;
 * `confidenceWeight()` combines that with trust via a geometric mean
 * and heavily suppresses memories below the confidence floor (e.g.
 * superseded or contradicted facts). Applied as
 * `score *= floor + weight * (combinedWeight - floor)` — gentle by
 * default so relevance ordering dominates unless evidence says
 * otherwise. Set to `0` to disable confidence-aware ranking.
 */
export const DEFAULT_CONFIDENCE_WEIGHT = 0.35;

/**
 * Half-life for the recency tie-break, in milliseconds. Among fused
 * candidates whose scores are within `RECENCY_EPSILON` of each other,
 * the newer memory wins; the boost decays with an exponential half-life
 * (default 30 days) so it only ever re-orders near-ties, never overrides
 * a clear relevance gap. This lifts "Knowledge Update" / "Temporal
 * Reasoning" style queries where two versions of a fact both match but
 * only the current one should surface first. Set to `0` to disable.
 */
export const DEFAULT_RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Score window in which candidates are considered TIED for recency
 * tie-breaking. This is a float-noise window (~1e-9), NOT a fuzzy band:
 * adjacent RRF ranks differ by ~w/(K+i)² ≈ 2e-4, three orders of
 * magnitude above this threshold, so genuine rank separation always
 * holds and recency only arbitrates candidates whose fused contributions
 * are mathematically indistinguishable (e.g. rank-1 in the keyword leg
 * vs rank-1 in the semantic leg under equal weights, or duplicate
 * facts ingested twice).
 */
export const RECENCY_EPSILON = 1e-9;

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
  /**
   * Strength of the confidence/trust combined multiplier from the
   * evidence state machine. Default 0.35. Set to 0 to disable
   * confidence-aware ranking.
   */
  confidenceWeightStrength?: number;
  /**
   * Recency half-life in ms for the tie-break among near-equal scores.
   * Default 30 days. Set to 0 to disable recency tie-breaking.
   */
  recencyHalfLifeMs?: number;
  /**
   * Reference "now" for recency computations. Defaults to wall-clock;
   * injectable for deterministic tests/benchmarks.
   */
  nowMs?: number;
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
  const confidenceStrength =
    options.confidenceWeightStrength ?? DEFAULT_CONFIDENCE_WEIGHT;
  const recencyHalfLifeMs =
    options.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
  const nowMs = options.nowMs ?? Date.now();

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

  // Confidence-aware ranking: fold in the evidence state machine. A
  // memory that has been repeatedly reinforced ranks slightly above an
  // equally-relevant but contradicted/superseded one. `confidenceWeight`
  // returns sqrt(trust * confidence) and crushes anything below the
  // confidence floor to ~10%, which is exactly the behavior wanted for
  // "Knowledge Update" / "Contradiction Resolution" queries: the stale
  // version of a fact should not outrank its current version when both
  // match. Blended with `confidenceStrength` so pure relevance still
  // dominates unless evidence is strongly against.
  if (confidenceStrength > 0) {
    for (const entry of merged.values()) {
      const combined = confidenceWeight(
        entry.node.trustScore ?? 1.0,
        entry.node.confidence,
      );
      const multiplier =
        1 - confidenceStrength + confidenceStrength * (combined / 1.0);
      entry.score *= multiplier;
      entry.scores.hybrid = entry.score;
    }
  }

  // Recency tie-break: among candidates whose fused scores are exactly
  // tied (within float noise — see RECENCY_EPSILON), prefer the more
  // recently updated memory. A genuine rank difference is three orders
  // of magnitude above the epsilon window, so this can never reorder
  // meaningfully-separated candidates; it only makes tie order
  // deterministic and knowledge-update-friendly (the current version of
  // a fact surfaces before its stale duplicate).
  if (recencyHalfLifeMs > 0) {
    const recencyBoost = (updatedAt: number): number => {
      const ageMs = Math.max(0, nowMs - updatedAt);
      return Math.pow(0.5, ageMs / recencyHalfLifeMs); // 1.0 → fresh … → 0.0
    };
    const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
    for (let i = 1; i < ranked.length; i += 1) {
      const current = ranked[i]!;
      const prev = ranked[i - 1]!;
      // `ranked` is sorted descending, so the difference is >= 0; the
      // epsilon check admits both exact ties and float-noise trails.
      if (
        prev.score - current.score <= RECENCY_EPSILON &&
        // Only swap when the lower-scored candidate is actually FRESHER
        // — an older candidate trailing within epsilon stays put.
        current.node.updatedAt > prev.node.updatedAt
      ) {
        const boost = recencyBoost(current.node.updatedAt);
        if (boost > 0) {
          // Nudge by a fraction of the epsilon window proportional to
          // freshness — enough to swap the tie, never enough to leapfrog
          // a candidate outside the epsilon band.
          current.score += RECENCY_EPSILON * boost * 0.5;
          current.scores.hybrid = current.score;
        }
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      node: entry.node,
      score: entry.score,
      scores: entry.scores,
    }));
}
