/**
 * Deterministic retrieval-quality metrics shared by every MemOS benchmark.
 *
 * These functions are pure: no I/O, no model calls, no randomness. They
 * exist so that every benchmark script (synthetic smoke, LoCoMo, LongMemEval)
 * computes Hit@K, Recall@K, Precision@K, MRR, and nDCG@K the SAME way, from
 * direct ground-truth ID comparison — never from fuzzy text matching.
 *
 * Core contract (see docs/benchmark-quality.md):
 *   - `retrieved` is the ranked list of source IDs the system returned
 *     (best first, duplicates already removed by the caller).
 *   - `relevant` is the COMPLETE set of evidence IDs the dataset says a
 *     question requires. For multi-evidence questions, partial retrieval is
 *     NOT success for All-Evidence Recall.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-question evaluation record. */
export interface EvalQueryResult {
  questionId: string;
  /** Ground-truth evidence IDs (LoCoMo dia_ids / LongMemEval session ids). */
  relevantIds: string[];
  /** Ranked retrieved source IDs, best first. */
  retrievedIds: string[];
  /** Human-readable category for per-category breakdowns. */
  category: string;
  /** Retrieval wall-time in ms (informational; not part of scoring). */
  latencyMs?: number;
}

/** Metrics at a single K. */
export interface MetricsAtK {
  /** Fraction of questions where ≥1 relevant item was in top-K. */
  hitRate: number;
  /** Mean of per-question (relevant retrieved in top-K / total relevant). */
  evidenceRecall: number;
  /** Pooled micro variant: sum(relevant in top-K) / sum(total relevant). */
  evidenceRecallMicro: number;
  /** Fraction of questions where EVERY relevant item was in top-K. */
  allEvidenceRecall: number;
  /** Mean of per-question (relevant in top-K / scored depth). */
  precision: number;
  /** Pooled micro variant: sum(relevant in top-K) / sum(scored depth). */
  precisionMicro: number;
  /** Mean reciprocal rank of the first relevant item. */
  mrr: number;
  /** Normalized discounted cumulative gain at K, binary relevance. */
  ndcg: number;
  /** Number of questions contributing to these numbers. */
  questionCount: number;
}

/** Full per-question evaluation output. */
export interface EvaluatedQuery extends EvalQueryResult {
  relevantRetrievedAt5: number;
  relevantRetrievedAt10: number;
}

export interface MetricsReport {
  at5: MetricsAtK;
  at10: MetricsAtK;
  perQuestion: EvaluatedQuery[];
  /** Macro-average across categories (unweighted mean of per-category
   *  overall scores) — reported alongside the micro averages. */
  perCategory: Record<
    string,
    {
      questionCount: number;
      hitAt10: number;
      evidenceRecallAt10: number;
      allEvidenceRecallAt10: number;
      precisionAt10: number;
      mrr: number;
      ndcgAt10: number;
    }
  >;
  /** Percentile latencies across all questions (p50/p95), from latencyMs. */
  latency: { p50: number; p95: number; mean: number };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Deduplicate a ranked ID list, preserving first (best) position. */
export function dedupeRankedIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  // Nearest-rank method: ceil(p/100 * N) - 1, clamped.
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx] ?? 0;
}

/** Count relevant items found in the first K retrieved slots. */
function countRelevantInTopK(
  relevant: Set<string>,
  retrieved: string[],
  k: number,
): number {
  let count = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i += 1) {
    if (relevant.has(retrieved[i] ?? "")) count += 1;
  }
  return count;
}

/**
 * Compute metrics for one query at one K. Exported for unit tests and for
 * benchmark scripts that need per-question numbers (e.g. failure listings).
 */
export function evaluateQueryAtK(
  relevantIds: string[],
  retrievedIds: string[],
  k: number,
): Pick<
  MetricsAtK,
  | "hitRate"
  | "evidenceRecall"
  | "allEvidenceRecall"
  | "precision"
  | "mrr"
  | "ndcg"
> & {
  /** Number of retrieved rows actually scored (≤ k). */
  scoredDepth: number;
  /** Absolute count of relevant items found in the top-K window. */
  relevantInTop: number;
} {
  const relevant = new Set(relevantIds);
  const relevantTotal = relevant.size;
  const scoredDepth = Math.min(k, retrievedIds.length);

  // Questions with zero relevant items cannot be scored for recall-family
  // metrics; treat hit/all-evidence as 1-vacuous only if something was
  // returned? No — the honest convention is to EXCLUDE them from recall
  // aggregates (handled by the caller) and score precision-only here.
  const relevantInTop = countRelevantInTopK(relevant, retrievedIds, k);
  const hit = relevantTotal > 0 && relevantInTop > 0 ? 1 : 0;

  // First relevant rank (1-based) for MRR.
  let rr = 0;
  for (let i = 0; i < scoredDepth; i += 1) {
    if (relevant.has(retrievedIds[i] ?? "")) {
      rr = 1 / (i + 1);
      break;
    }
  }

  // nDCG@K with binary relevance gains.
  let dcg = 0;
  for (let i = 0; i < scoredDepth; i += 1) {
    if (relevant.has(retrievedIds[i] ?? "")) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  // Ideal DCG: all |relevant| items at ranks 1..|relevant| (capped by k).
  const idealCount = Math.min(relevantTotal, k);
  let idcg = 0;
  for (let i = 0; i < idealCount; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  const ndcg = idcg > 0 ? dcg / idcg : 0;

  return {
    hitRate: hit,
    evidenceRecall: relevantTotal > 0 ? relevantInTop / relevantTotal : 0,
    allEvidenceRecall:
      relevantTotal > 0 && relevantInTop >= relevantTotal ? 1 : 0,
    precision: scoredDepth > 0 ? relevantInTop / scoredDepth : 0,
    mrr: rr,
    ndcg,
    scoredDepth,
    relevantInTop,
  };
}

// ─── Report ──────────────────────────────────────────────────────────────────

/**
 * Aggregate metrics over a set of evaluated questions.
 *
 * Averages are MICRO (per-question mean) for Hit/All-Evidence/precision/MRR/
 * nDCG; Evidence Recall is the mean of per-question recall (each question
 * weighted equally regardless of evidence count). Questions with an empty
 * `relevantIds` (LoCoMo has 4 such questions, all category 3) are excluded
 * from all recall-family metrics and reported separately in the per-question
 * table; they never count as successes.
 */
export function aggregateMetrics(queries: EvalQueryResult[]): MetricsReport {
  const perQuestion: EvaluatedQuery[] = queries.map((q) => ({
    ...q,
    relevantRetrievedAt5: countRelevantInTopK(
      new Set(q.relevantIds),
      dedupeRankedIds(q.retrievedIds),
      5,
    ),
    relevantRetrievedAt10: countRelevantInTopK(
      new Set(q.relevantIds),
      dedupeRankedIds(q.retrievedIds),
      10,
    ),
  }));

  const scoreable = perQuestion.filter((q) => q.relevantIds.length > 0);

  const at = (k: number): MetricsAtK => {
    if (scoreable.length === 0) {
      return {
        hitRate: 0,
        evidenceRecall: 0,
        evidenceRecallMicro: 0,
        allEvidenceRecall: 0,
        precision: 0,
        precisionMicro: 0,
        mrr: 0,
        ndcg: 0,
        questionCount: 0,
      };
    }
    let hitSum = 0;
    let evidenceRecallSum = 0;
    let allEvidenceSum = 0;
    let precisionSum = 0;
    let mrrSum = 0;
    let ndcgSum = 0;
    // Pooled (micro) accumulators.
    let relevantRetrievedTotal = 0;
    let relevantTotalSum = 0;
    let scoredDepthTotal = 0;
    for (const q of scoreable) {
      const r = evaluateQueryAtK(
        q.relevantIds,
        dedupeRankedIds(q.retrievedIds),
        k,
      );
      hitSum += r.hitRate;
      evidenceRecallSum += r.evidenceRecall;
      allEvidenceSum += r.allEvidenceRecall;
      precisionSum += r.precision;
      mrrSum += r.mrr;
      ndcgSum += r.ndcg;
      relevantRetrievedTotal += r.relevantInTop;
      relevantTotalSum += q.relevantIds.length;
      scoredDepthTotal += r.scoredDepth;
    }
    const n = scoreable.length;
    return {
      hitRate: hitSum / n,
      evidenceRecall: evidenceRecallSum / n,
      evidenceRecallMicro:
        relevantTotalSum > 0 ? relevantRetrievedTotal / relevantTotalSum : 0,
      allEvidenceRecall: allEvidenceSum / n,
      precision: precisionSum / n,
      precisionMicro:
        scoredDepthTotal > 0 ? relevantRetrievedTotal / scoredDepthTotal : 0,
      mrr: mrrSum / n,
      ndcg: ndcgSum / n,
      questionCount: n,
    };
  };

  // Per-category macro rows (computed at K=10 — the reporting depth).
  const perCategory: MetricsReport["perCategory"] = {};
  const cats = [...new Set(scoreable.map((q) => q.category))].sort();
  for (const cat of cats) {
    const rows = scoreable.filter((q) => q.category === cat);
    const r10 = evaluateSet(rows, 10);
    perCategory[cat] = {
      questionCount: rows.length,
      ...r10,
    };
  }

  const latencies = perQuestion
    .map((q) => q.latencyMs ?? 0)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);

  return {
    at5: at(5),
    at10: at(10),
    perQuestion,
    perCategory,
    latency: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      mean:
        latencies.length > 0
          ? latencies.reduce((s, x) => s + x, 0) / latencies.length
          : 0,
    },
  };
}

/** Mean-over-questions metrics for a question subset (used per category). */
function evaluateSet(
  rows: EvaluatedQuery[],
  k: number,
): {
  hitAt10: number;
  evidenceRecallAt10: number;
  allEvidenceRecallAt10: number;
  precisionAt10: number;
  mrr: number;
  ndcgAt10: number;
} {
  if (rows.length === 0) {
    return {
      hitAt10: 0,
      evidenceRecallAt10: 0,
      allEvidenceRecallAt10: 0,
      precisionAt10: 0,
      mrr: 0,
      ndcgAt10: 0,
    };
  }
  let hit = 0;
  let evRecall = 0;
  let allEv = 0;
  let prec = 0;
  let mrr = 0;
  let ndcg = 0;
  for (const q of rows) {
    const r = evaluateQueryAtK(
      q.relevantIds,
      dedupeRankedIds(q.retrievedIds),
      k,
    );
    hit += r.hitRate;
    evRecall += r.evidenceRecall;
    allEv += r.allEvidenceRecall;
    prec += r.precision;
    mrr += r.mrr;
    ndcg += r.ndcg;
  }
  const n = rows.length;
  return {
    hitAt10: hit / n,
    evidenceRecallAt10: evRecall / n,
    allEvidenceRecallAt10: allEv / n,
    precisionAt10: prec / n,
    mrr: mrr / n,
    ndcgAt10: ndcg / n,
  };
}
