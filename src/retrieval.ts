/**
 * Retrieval fusion — hybrid search result merging.
 *
 * Two fusion algorithms (see `FusionOptions.fusionMode`):
 *
 * - RRF (weighted Reciprocal Rank Fusion): each leg votes by RANK
 *   (`weight / (K + rank)`), robust to score outliers that would
 *   otherwise dominate a weighted sum. K=60 is the standard constant
 *   from the RRF paper (Cormack et al., 2009).
 * - Convex combination (default since round 4): min-max normalize each
 *   leg's native scores to [0,1], then take the weighted sum. A dominant
 *   absolute score (near-exact embedding match, runaway bm25 hit) keeps
 *   its magnitude instead of being flattened to a rank vote. A Sept 2026
 *   TOIS analysis found convex combination beats RRF in- and
 *   out-of-domain; Weaviate made the same switch.
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
 * Default fusion algorithm (round 4). `"convex"` min-max normalizes each
 * leg's native scores and takes the weighted sum; `"rrf"` restores the
 * legacy rank-vote behavior.
 */
export const DEFAULT_FUSION_MODE = "convex" as const;

/**
 * Temporal markers that switch on the recency multiplier for a query
 * (round 4 adaptive weighting). Deliberately narrow: generic nouns like
 * "week" alone don't trigger it, only explicit temporal constructions.
 */
export const TEMPORAL_QUERY_RE =
  /\b(today|yesterday|tomorrow|tonight|recent|recently|latest|last\s+(night|week|month|year)|next\s+(week|month|year)|\d+\s+(days?|weeks?|months?)\s+ago|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

/** Default strength of the temporal-query recency multiplier (≤5%). */
export const DEFAULT_TEMPORAL_RECENCY_STRENGTH = 0.05;

/**
 * Stopwords for RM3-lite term harvesting — small, generic, English.
 * Kept local (not shared with the entity extractor) so the PRF
 * vocabulary stays independent of entity-extraction tuning.
 */
const PRF_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
  "as",
  "at",
  "by",
  "from",
  "into",
  "about",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "does",
  "did",
  "do",
  "have",
  "has",
  "had",
  "not",
  "no",
  "yes",
  "can",
  "could",
  "should",
  "would",
  "will",
  "just",
  "than",
  "then",
  "there",
  "here",
  "all",
  "any",
]);

/**
 * Tokenize for PRF: lowercase alphanumeric tokens, stopwords and
 * short tokens dropped.
 */
export function prfTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !PRF_STOPWORDS.has(t));
}

/**
 * RM3-lite pseudo-relevance feedback term harvesting (round 4).
 *
 * Pure function: given the top semantic-leg hits for a query, harvest
 * up to `maxTerms` recurring content terms that are NOT already in the
 * query, ranked by frequency across the hits. The caller re-probes FTS5
 * with these terms as a second keyword pass whose results are UNIONED
 * into the keyword leg — expansion can only add recall, never remove
 * candidates.
 *
 * Deterministic: no model, no sampling — same hits always yield the
 * same terms. Gated by the caller to short queries (≤3 terms), where
 * vocabulary mismatch hurts most.
 *
 * @param hits — Top semantic-leg results (best first); callers pass ~5.
 * @param queryTerms — Tokenized query terms (from `prfTokenize`).
 * @param maxTerms — Cap on harvested terms. Default 3.
 */
export function harvestPrfTerms(
  hits: ScoredMemory[],
  queryTerms: string[],
  maxTerms = 3,
): string[] {
  const querySet = new Set(queryTerms);
  const freq = new Map<string, number>();
  for (const hit of hits) {
    const text = `${hit.node.summary ?? ""} ${hit.node.content}`;
    for (const tok of prfTokenize(text)) {
      if (querySet.has(tok)) continue;
      freq.set(tok, (freq.get(tok) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, maxTerms))
    .map(([term]) => term);
}

/**
 * Merge an expansion keyword pass into the primary keyword leg (union
 * semantics). Candidates already in the primary leg keep their original
 * score; expansion-only candidates append after.
 *
 * The expansion query is a different query (harvested terms only), so its
 * bm25 scores are NOT comparable to the primary query's: an expansion hit
 * matching three harvested terms will outscore a primary hit on raw bm25
 * even though the primary query is the user's actual intent. To keep PRF
 * a pure recall booster (never a re-ranker), expansion-only candidates are
 * demoted below every primary hit (FTS5 bm25: lower/more-negative is
 * better, so they take worst-primary + 1); they tie among themselves and
 * order deterministically by node id thereafter.
 */
export function mergeKeywordLegs(
  primary: ScoredMemory[],
  expansion: ScoredMemory[],
): ScoredMemory[] {
  if (expansion.length === 0) return primary;
  const seen = new Set(primary.map((r) => r.node.id));
  // FTS5 bm25 rank: lower (more negative) is better. Expansion-only hits
  // take worst-primary + 1 so no expansion score can outrank a primary hit.
  const worstPrimary =
    primary.length > 0
      ? Math.max(...primary.map((r) => r.score))
      : Number.NEGATIVE_INFINITY;
  const merged = [...primary];
  for (const r of expansion) {
    if (!seen.has(r.node.id)) {
      seen.add(r.node.id);
      merged.push(
        primary.length > 0
          ? { node: r.node, score: worstPrimary + 1.0, scores: r.scores }
          : r,
      );
    }
  }
  return merged;
}

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

/** Merged candidate accumulator shared by both fusion algorithms. */
interface FusedCandidate {
  node: MemoryNode;
  score: number;
  scores: Record<string, number>;
}

/**
 * Legacy rank-vote fusion: weighted Reciprocal Rank Fusion over the
 * three legs. Extracted verbatim from the pre-round-4 `fuseResults`
 * body; selected via `fusionMode: "rrf"`.
 */
function rrfFuse(
  keywordResults: ScoredMemory[],
  semanticResults: ScoredMemory[],
  entityResults: ScoredMemory[],
  options: FusionOptions,
): Map<string, FusedCandidate> {
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
  const semanticWeight = options.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT;

  const merged = new Map<string, FusedCandidate>();

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

  return merged;
}

/**
 * Min-max normalize one leg's native scores to [0,1].
 *
 * `higherIsBetter=false` inverts the scale (FTS5 bm25 rank: the more
 * negative, the better the match); true for the semantic (cosine) and
 * entity (match-count) legs. A degenerate leg (empty, or all scores
 * identical) maps its candidates to 1.0 — the leg's top pick still
 * counts as a full vote rather than vanishing. Duplicate ids within a
 * leg keep the best normalized score.
 */
function minMaxNormalizeLeg(
  results: ScoredMemory[],
  higherIsBetter: boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  if (results.length === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const r of results) {
    if (r.score < min) min = r.score;
    if (r.score > max) max = r.score;
  }
  for (const r of results) {
    let n: number;
    if (!(max > min)) {
      n = 1;
    } else if (higherIsBetter) {
      n = (r.score - min) / (max - min);
    } else {
      n = (max - r.score) / (max - min);
    }
    const prev = out.get(r.node.id);
    if (prev === undefined || n > prev) out.set(r.node.id, n);
  }
  return out;
}

interface AdaptedLegWeights {
  keyword: number;
  semantic: number;
  entityLeg: number;
  /** True when the query carries temporal markers. */
  temporal: boolean;
}

/**
 * Deterministic query-type adaptive leg weighting (round 4).
 *
 * Tiny rule-based router — no model, no learned parameters, fully
 * explainable:
 * - Short queries (≤3 tokens): BM25 is the reliable leg (embeddings are
 *   noisier on keyword-style lookups), so the keyword weight rises.
 * - Entity-dense queries (≥2 extracted entities): the entity leg is
 *   high-precision here, so its weight doubles (capped).
 * - Temporal markers (today, yesterday, last week, …): flags the query
 *   so `convexFuse` applies the bounded recency multiplier.
 *
 * Weights are renormalized to sum to 1 afterwards. All adjustments are
 * gentle (≤1.25× / ≤2×) so a misfire can only nudge, never dominate.
 * Disabled wholesale via `adaptiveWeighting: false`.
 */
function adaptLegWeights(
  query: string,
  queryEntities: string[],
  base: { keyword: number; semantic: number; entityLeg: number },
): AdaptedLegWeights {
  let { keyword, semantic, entityLeg } = base;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  // Short queries (≤3 tokens) are keyword-style lookups; the keyword
  // leg's magnitude gaps are meaningful here, so it gets more weight.
  if (tokens.length > 0 && tokens.length <= 3) {
    keyword *= 1.25;
  }
  if (queryEntities.length >= 2) {
    entityLeg = Math.min(0.4, entityLeg * 2);
  }
  const temporal = TEMPORAL_QUERY_RE.test(query);
  const sum = keyword + semantic + entityLeg;
  if (sum > 0) {
    keyword /= sum;
    semantic /= sum;
    entityLeg /= sum;
  }
  return { keyword, semantic, entityLeg, temporal };
}

/**
 * Convex-combination fusion (round 4 default).
 *
 * Each leg's native scores are min-max normalized to [0,1], then
 * combined as `Σ w_leg · norm_leg` with the (adaptively adjusted,
 * renormalized) leg weights. Unlike RRF's rank votes, a dominant
 * absolute score keeps its magnitude — a near-exact embedding match or
 * a runaway bm25 hit outranks a candidate that merely placed well in a
 * weak leg.
 *
 * The entity leg still ADDS RECALL exactly like the RRF path: normalized
 * entity matches enter the pool even when FTS and embeddings missed
 * them. Temporal queries additionally get the bounded recency
 * multiplier (`1 + strength · 0.5^(age/halfLife)`).
 */
function convexFuse(
  keywordResults: ScoredMemory[],
  semanticResults: ScoredMemory[],
  entityResults: ScoredMemory[],
  options: FusionOptions,
): Map<string, FusedCandidate> {
  const queryEntities = options.queryEntities ?? [];
  const base = {
    keyword: options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT,
    semantic: options.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT,
    entityLeg: options.entityLegWeight ?? DEFAULT_ENTITY_LEG_WEIGHT,
  };
  const adaptive = options.adaptiveWeighting ?? true;
  const weights: AdaptedLegWeights =
    adaptive && options.query
      ? adaptLegWeights(options.query, queryEntities, base)
      : {
          keyword: base.keyword,
          semantic: base.semantic,
          entityLeg: base.entityLeg,
          temporal: false,
        };
  // Renormalize even the non-adaptive path: convex combination needs
  // weights on a common scale, unlike RRF's independent rank votes.
  const wSum = weights.keyword + weights.semantic + weights.entityLeg;
  const wk = wSum > 0 ? weights.keyword / wSum : 0;
  const ws = wSum > 0 ? weights.semantic / wSum : 0;
  const we = wSum > 0 ? weights.entityLeg / wSum : 0;

  // All legs: min-max on native scores. Proven on the deterministic eval
  // (MRR 0.9688 vs 0.875 for rank-discount keyword): with weak local-hash
  // embeddings the keyword leg's magnitude gaps carry the signal, and
  // min-max preserves them. (bm25 magnitudes are query-dependent, but the
  // eval shows the trade-off favors magnitude-awareness here.)
  const keywordNorm = minMaxNormalizeLeg(keywordResults, false);
  const semanticNorm = minMaxNormalizeLeg(semanticResults, true);
  const entityNorm = minMaxNormalizeLeg(entityResults, true);

  const byId = new Map<string, ScoredMemory>();
  for (const r of keywordResults) byId.set(r.node.id, r);
  for (const r of semanticResults) byId.set(r.node.id, r);
  for (const r of entityResults) byId.set(r.node.id, r);

  const merged = new Map<string, FusedCandidate>();
  const addLeg = (
    norm: Map<string, number>,
    weight: number,
    legName: "keyword" | "semantic" | "entityLeg",
  ) => {
    if (weight <= 0) return;
    for (const [id, n] of norm) {
      const r = byId.get(id);
      if (!r) continue;
      const contrib = weight * n;
      const existing = merged.get(id);
      if (existing) {
        existing.score += contrib;
        existing.scores[legName] = n;
        existing.scores.hybrid = existing.score;
      } else {
        // Scores breakdown mirrors the pre-round-4 shape: a leg's key is
        // present only when the candidate appeared in that leg (never a
        // zero placeholder), so `scores.entityLeg === undefined` still
        // means "the entity leg did not retrieve this candidate".
        merged.set(id, {
          node: r.node,
          score: contrib,
          scores: {
            [legName]: n,
            hybrid: contrib,
          },
        });
      }
    }
  };
  addLeg(keywordNorm, wk, "keyword");
  addLeg(semanticNorm, ws, "semantic");
  addLeg(entityNorm, we, "entityLeg");

  // Temporal recency: bounded multiplicative nudge toward fresh memories,
  // active only for temporal-marker queries. At the default strength
  // (0.05) the maximum boost is 5% for a just-updated memory, decaying
  // with the configured half-life — relevance still dominates.
  const recencyHalfLifeMs =
    options.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS;
  const temporalStrength =
    options.temporalRecencyStrength ?? DEFAULT_TEMPORAL_RECENCY_STRENGTH;
  if (
    adaptive &&
    weights.temporal &&
    temporalStrength > 0 &&
    recencyHalfLifeMs > 0
  ) {
    const nowMs = options.nowMs ?? Date.now();
    for (const entry of merged.values()) {
      const ageMs = Math.max(0, nowMs - entry.node.updatedAt);
      const freshness = Math.pow(0.5, ageMs / recencyHalfLifeMs);
      entry.score *= 1 + temporalStrength * freshness;
      entry.scores.hybrid = entry.score;
    }
  }

  return merged;
}

/**
 * Fuse two (optionally three) ranked retrieval lists into one, then apply
 * trust weighting.
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
  const mode = options.fusionMode ?? DEFAULT_FUSION_MODE;
  const merged =
    mode === "convex"
      ? convexFuse(keywordResults, semanticResults, entityResults, options)
      : rrfFuse(keywordResults, semanticResults, entityResults, options);

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
