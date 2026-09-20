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

import type { FusionOptions, MemoryNode, ScoredMemory } from "./types.js";

// Re-exported so existing `import { FusionOptions } from "./retrieval.js"`
// callers keep working; the definition lives in `types.ts` because
// `MemOSConfig.fusion` references it and types.ts must stay
// dependency-free.
export type { FusionOptions } from "./types.js";
import { confidenceWeight } from "./confidence-machine.js";
import { entityOverlap } from "./entity-extraction.js";
import {
  DEFAULT_PROVENANCE_WEIGHT_STRENGTH,
  isProvenanceTier,
  provenanceMultiplier,
} from "./provenance.js";

/** Default RRF constant (Cormack et al., 2009). */
export const DEFAULT_RRF_K = 60;

/**
 * Stable ordering for scored memories: descending score, node id as the
 * final tiebreak. The id tiebreak keeps serialized output byte-identical
 * for identical result sets — without it, equal scores surface
 * input/iteration-order noise, which breaks LLM prompt-cache prefixes
 * (providers only discount cached input when the prefix is byte-stable).
 */
export function compareScoredMemories(
  a: ScoredMemory,
  b: ScoredMemory,
): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0;
}

/** Default weight for the keyword (FTS5) leg. */
export const DEFAULT_KEYWORD_WEIGHT = 0.8;

/** Default weight for the semantic (embedding) leg. */
export const DEFAULT_SEMANTIC_WEIGHT = 0.2;

/**
 * Default strength of the entity-overlap boost — the third retrieval
 * signal (semantic + keyword + entity match). Applied as a post-fusion
 * multiplier `score *= 1 + entityWeight * overlap`, so it nudges rather
 * than dominates; only active when `queryEntities` is non-empty.
 */
export const DEFAULT_ENTITY_WEIGHT = 0.15;

/**
 * ── item2: entity leg ── default weight of the entity-inverted-index RRF
 * leg (`entityResults`). Deliberately subordinate to the semantic leg:
 * rank-1 in the entity leg scores `0.1 / (rrfK + 1)`, below a
 * semantic-only rank-1 (`0.2 / (rrfK + 1)`). The extractor is lexical,
 * so on dialogue-heavy corpora a 0.5 weight let entity-matched
 * near-duplicates outrank genuine semantic hits — measured as a LoCoMo
 * nDCG regression at 0.5, neutral at 0.1. The leg's job is recall
 * (surfacing entity-matched memories the other legs missed), not
 * re-ranking.
 */
export const DEFAULT_ENTITY_LEG_WEIGHT = 0.1;

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

/**
 * Fuse two (optionally three) ranked retrieval lists into one via
 * weighted Reciprocal Rank Fusion, then apply trust weighting.
 *
 * All legs are expected to be pre-ranked best-first (as returned by FTS5
 * bm25, cosine-similarity search, and the entity-inverted-index lookup).
 * Candidates appearing in multiple legs accumulate each leg's RRF
 * contribution.
 *
 * @param keywordResults — Ranked keyword/FTS5 leg (best first).
 * @param semanticResults — Ranked semantic/embedding leg (best first).
 * @param options — Tunable weights; see {@link FusionOptions}.
 * @param entityResults — Ranked entity-inverted-index leg (best first).
 *   Optional third RRF leg: memories sharing entities with the query that
 *   the keyword/semantic legs missed still enter the candidate pool.
 * @returns Fused list sorted by descending hybrid score, with a `scores`
 *   breakdown (`keyword`, `semantic`, `entityLeg`, `hybrid`, plus `entity`
 *   when the entity-overlap boost fires) on each entry.
 */
export function fuseResults(
  keywordResults: ScoredMemory[],
  semanticResults: ScoredMemory[],
  options: FusionOptions = {},
  entityResults: ScoredMemory[] = [],
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
  const queryEntities = options.queryEntities ?? [];
  const entityWeight =
    options.entityWeight ??
    (queryEntities.length > 0 ? DEFAULT_ENTITY_WEIGHT : 0);

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

  // ── item2: entity leg ── third RRF leg from the entity→memories
  // inverted index (`src/entity-index.ts`). Unlike the multiplicative
  // entity-overlap boost below — which only re-scores candidates the
  // keyword/semantic legs already retrieved — this leg ADDS RECALL:
  // entity-matched memories that FTS and embeddings both missed enter
  // the candidate pool here.
  //
  // Score-breakdown naming: this leg records `scores.entityLeg` (the
  // per-candidate matched-entity count feeding the RRF vote), while the
  // boost below records `scores.entity` (the [0,1] query/candidate
  // entity-overlap multiplier). Same signal family, different roles —
  // recall vs scoring.
  const entityLegWeight = options.entityLegWeight ?? DEFAULT_ENTITY_LEG_WEIGHT;
  if (entityLegWeight > 0 && entityResults.length > 0) {
    for (const [index, result] of entityResults.entries()) {
      const entityRrf = entityLegWeight / (rrfK + index + 1);
      const existing = merged.get(result.node.id);
      if (existing) {
        existing.score += entityRrf;
        existing.scores.entityLeg = Math.max(0, result.score);
        existing.scores.hybrid = existing.score;
      } else {
        merged.set(result.node.id, {
          node: result.node,
          score: entityRrf,
          scores: {
            keyword: 0,
            semantic: 0,
            entityLeg: Math.max(0, result.score),
            hybrid: entityRrf,
          },
        });
      }
    }
  }

  // Entity-fused scoring: a third signal on top of keyword + semantic.
  // Memories whose stored entities / tags overlap the query's entities get
  // a gentle multiplicative boost. No-op unless the caller supplied query
  // entities (hybridSearch extracts them per query). Records
  // `scores.entity` — the overlap ratio — distinct from the
  // `scores.entityLeg` RRF-leg vote above (see the item2 comment).
  if (entityWeight > 0 && queryEntities.length > 0) {
    for (const entry of merged.values()) {
      const overlap = entityOverlap(queryEntities, {
        tags: entry.node.tags,
        metadata: entry.node.metadata,
      });
      if (overlap > 0) {
        entry.score *= 1 + entityWeight * overlap;
        entry.scores.entity = overlap;
        entry.scores.hybrid = entry.score;
      }
    }
  }

  // Trust weighting: a gentle multiplier (trustFloor–1.0) so high-trust
  // memories get a small boost without dominating pure relevance.
  for (const entry of merged.values()) {
    entry.score *=
      trustFloor + (entry.node.trustScore ?? 1.0) * (1 - trustFloor);
    entry.scores.hybrid = entry.score;
  }

  // Provenance-trust weighting: fold the write-time provenance tier into
  // scoring alongside relevance. Low-trust channels (imported,
  // tool-output, chat) are gently down-ranked via
  // `score *= 1 - strength * (1 - tierTrust)` — the maximum penalty at
  // the default strength (0.5) is ~14% for the imported tier, so
  // relevance ordering dominates unless channels genuinely differ.
  // Uniform across same-tier result sets, so single-channel corpora
  // (including the retrieval eval) keep byte-identical ranking —
  // neutral-or-better by construction. Records `scores.provenance`.
  const provenanceStrength =
    options.provenanceWeightStrength ?? DEFAULT_PROVENANCE_WEIGHT_STRENGTH;
  if (provenanceStrength > 0) {
    for (const entry of merged.values()) {
      // Nodes without a tier (legacy fixtures, custom adapters that
      // predate the layer) are left exactly neutral — the weighting is
      // additive and never rewrites historical scores.
      const tier = entry.node.provenance;
      if (!isProvenanceTier(tier)) continue;
      const multiplier = provenanceMultiplier(tier, provenanceStrength);
      entry.score *= multiplier;
      entry.scores.provenance = multiplier;
      entry.scores.hybrid = entry.score;
    }
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
    const ranked = [...merged.values()].sort(compareScoredMemories);
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

  return [...merged.values()].sort(compareScoredMemories).map((entry) => ({
    node: entry.node,
    score: entry.score,
    scores: entry.scores,
  }));
}
