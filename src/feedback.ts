/**
 * Outcome-conditioned memory: closing the loop between recall and results.
 *
 * Every other signal in the retrieval pipeline is a *prediction*: keyword
 * overlap, embedding similarity, trust, recency. None of them knows whether
 * injecting a memory actually helped the agent. This module turns explicit
 * task outcomes into a small, auditable ranking signal:
 *
 * - a memory used in successful tasks gains utility;
 * - a memory used in failed tasks loses it;
 * - `uplift` compares outcomes when the memory was used against outcomes
 *   when it was not, which is the closest thing to a counterfactual that
 *   observational feedback can provide.
 *
 * Everything here is pure math over plain records. Persistence lives in the
 * storage adapter; orchestration lives in `MemOS`. No LLM, no network.
 *
 * @module @mem-os/feedback
 */

import type {
  MemoryUtility,
  RecallBatchOutcome,
  RecallFeedbackStat,
  RecallOutcome,
} from "./types.js";

/** Numeric score for each outcome label. */
export const OUTCOME_SCORES: Record<RecallOutcome, number> = {
  success: 1,
  partial: 0.5,
  failure: 0,
};

/** Utility of a memory with no evidence (Beta prior mean). */
export const NEUTRAL_UTILITY = 0.5;

/** Default maximum ranking swing from feedback (±20%). */
export const DEFAULT_OUTCOME_WEIGHT = 0.2;

/** Convert an outcome label to its [0, 1] score. */
export function outcomeScore(outcome: RecallOutcome): number {
  return OUTCOME_SCORES[outcome] ?? 0.5;
}

/** A zeroed stat record. */
export function emptyRecallStat(memoryId: string): RecallFeedbackStat {
  return {
    memoryId,
    success: 0,
    partial: 0,
    failure: 0,
    observations: 0,
    lastAt: null,
  };
}

/**
 * Add one weighted outcome to a stat record. Returns a new object so the
 * caller's cache entry can be replaced atomically.
 */
export function addOutcomeToStat(
  stat: RecallFeedbackStat,
  outcome: RecallOutcome,
  weight: number,
  ts: number,
): RecallFeedbackStat {
  const w = normaliseWeight(weight);
  return {
    memoryId: stat.memoryId,
    success: stat.success + (outcome === "success" ? w : 0),
    partial: stat.partial + (outcome === "partial" ? w : 0),
    failure: stat.failure + (outcome === "failure" ? w : 0),
    observations: stat.observations + w,
    lastAt: stat.lastAt === null ? ts : Math.max(stat.lastAt, ts),
  };
}

/**
 * Beta-smoothed success probability for a stat record.
 *
 * A `partial` outcome contributes half a success and half a failure, so it
 * pulls utility toward neutral rather than being ignored. The prior
 * (1 success, 1 failure) means one observation moves utility to 1/3 or 2/3,
 * never to an extreme.
 */
export function utilityFromStat(stat: RecallFeedbackStat | undefined): number {
  if (!stat) return NEUTRAL_UTILITY;
  const successes = stat.success + stat.partial * 0.5;
  const failures = stat.failure + stat.partial * 0.5;
  return (successes + 1) / (successes + failures + 2);
}

/**
 * Ranking multiplier for a utility value.
 *
 * `weight` is the maximum proportional swing: `0.2` maps utility 0..1 to
 * multipliers 0.8..1.2. Utility 0.5 is always the identity, so neutral
 * evidence cannot change historical ranking.
 */
export function outcomeMultiplier(utility: number, weight: number): number {
  const w = Math.min(1, Math.max(0, weight));
  const u = Math.min(1, Math.max(0, utility));
  return 1 + w * (u - NEUTRAL_UTILITY) * 2;
}

/** Weighted mean outcome score across batches, or null when empty. */
export function meanOutcome(batches: RecallBatchOutcome[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const batch of batches) {
    const w = normaliseWeight(batch.weight);
    weighted += outcomeScore(batch.outcome) * w;
    total += w;
  }
  return total === 0 ? null : weighted / total;
}

/**
 * Build the full utility view for one memory.
 *
 * `uplift` is the difference between the mean outcome of batches that used
 * this memory and the mean outcome of batches that did not. It is null when
 * either side has no samples. Observational caveat: memories are used when
 * they look relevant, so a positive uplift can reflect the query topic
 * rather than the memory's value.
 */
export function buildMemoryUtility(
  memoryId: string,
  stat: RecallFeedbackStat | undefined,
  batches: RecallBatchOutcome[],
): MemoryUtility {
  const used: RecallBatchOutcome[] = [];
  const unused: RecallBatchOutcome[] = [];
  for (const batch of batches) {
    if (batch.memoryIds.includes(memoryId)) used.push(batch);
    else unused.push(batch);
  }
  const usedMean = meanOutcome(used);
  const unusedMean = meanOutcome(unused);
  return {
    memoryId,
    success: stat?.success ?? 0,
    partial: stat?.partial ?? 0,
    failure: stat?.failure ?? 0,
    observations: stat?.observations ?? 0,
    utility: utilityFromStat(stat),
    uplift:
      usedMean === null || unusedMean === null ? null : usedMean - unusedMean,
    usedBatches: used.length,
    unusedBatches: unused.length,
    lastAt: stat?.lastAt ?? null,
  };
}

/** Clamp a caller-provided weight to a sane positive range. */
export function normaliseWeight(weight: number | undefined): number {
  if (weight === undefined || !Number.isFinite(weight)) return 1;
  return Math.min(100, Math.max(0.01, weight));
}

/** Distinct memory ids across a batch list (for health metrics). */
export function memoriesWithFeedback(batches: RecallBatchOutcome[]): number {
  const ids = new Set<string>();
  for (const batch of batches) {
    for (const id of batch.memoryIds) ids.add(id);
  }
  return ids.size;
}
