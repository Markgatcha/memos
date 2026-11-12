/**
 * Recall budgets: per-query latency/token control for the retrieval pipeline.
 *
 * A budget turns `search()` from "always run the full pipeline" into
 * "run as much as the caller can afford". The tier chosen up front sets a
 * ceiling (keyword-only, parallel legs, expansions, full rerank); the clock
 * can only lower it further as the deadline approaches.
 *
 * This module is pure: no storage, no embeddings, no I/O. `memory.ts` owns
 * the actual stage gating and reports timings back through
 * {@link recordRecallStage}.
 *
 * @module @mem-os/sdk/recall-budget
 */

import { performance } from "node:perf_hooks";
import { estimateTokens } from "./context-pack.js";
import type {
  RecallBudget,
  RecallReceipt,
  RecallSkipReason,
  RecallStageTiming,
  RecallTier,
} from "./types.js";

/** Retrieval stages that a budget can gate. */
export type RecallStage =
  | "fts"
  | "semantic"
  | "entity"
  | "clip"
  | "prf"
  | "graph"
  | "ppr"
  | "session"
  | "rerank"
  | "mmr"
  | "multihop";

/** Lowest tier at which each stage is allowed to run. */
const STAGE_MIN_TIER: Record<RecallStage, RecallTier> = {
  fts: 0,
  semantic: 1,
  entity: 1,
  clip: 1,
  prf: 2,
  graph: 2,
  ppr: 2,
  session: 2,
  rerank: 3,
  mmr: 3,
  multihop: 3,
};

/** Human-readable tier names, indexed by tier. */
export const RECALL_TIER_LABELS = [
  "keyword-only",
  "parallel-legs",
  "full-retrieval",
  "full-plus-rerank",
] as const;

/** Monotonic deadline state for one search call. */
export interface RecallClock {
  startedAt: number;
  softDeadline: number;
  hardDeadline: number;
}

/** A live budget plan threaded through one retrieval call. */
export interface RecallPlan {
  tier: RecallTier;
  clock: RecallClock;
  receipt: RecallReceipt;
}

function clampTier(value: number | undefined): RecallTier | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  if (rounded >= 3) return 3;
  return rounded as RecallTier;
}

/**
 * Choose the starting tier for a budget.
 *
 * Thresholds are deliberately coarse: they are a policy statement about
 * what a millisecond buys, not a benchmark fit. Callers can override with
 * `minTier` / `maxTier`.
 */
export function selectRecallTier(budget?: RecallBudget | null): RecallTier {
  if (!budget) return 3;

  let tier: RecallTier = 3;
  if (budget.maxMs !== undefined && Number.isFinite(budget.maxMs)) {
    if (budget.maxMs <= 25) tier = 0;
    else if (budget.maxMs <= 80) tier = 1;
    else if (budget.maxMs <= 250) tier = 2;
  } else if (
    budget.maxTokens !== undefined &&
    Number.isFinite(budget.maxTokens) &&
    budget.maxTokens <= 400
  ) {
    // A very small token cap implies the caller wants a fast, shallow
    // answer; a full rerank would spend more time than the result is worth.
    tier = 1;
  }

  const min = clampTier(budget.minTier);
  const max = clampTier(budget.maxTier);
  if (min !== undefined && tier < min) tier = min;
  if (max !== undefined && tier > max) tier = max;
  return tier;
}

/** Create monotonic soft/hard deadlines for a budget. */
export function createRecallClock(
  budget?: RecallBudget | null,
  now: number = performance.now(),
): RecallClock {
  const maxMs =
    budget?.maxMs !== undefined && Number.isFinite(budget.maxMs)
      ? Math.max(0, budget.maxMs)
      : undefined;
  if (maxMs === undefined) {
    return {
      startedAt: now,
      softDeadline: Number.POSITIVE_INFINITY,
      hardDeadline: Number.POSITIVE_INFINITY,
    };
  }
  return {
    startedAt: now,
    softDeadline: now + maxMs * 0.75,
    hardDeadline: now + maxMs,
  };
}

/**
 * Build a plan for one call, or `null` when the caller set no budget.
 * A budget object with no fields still yields a tier-3 plan and a receipt.
 */
export function createRecallPlan(
  budget?: RecallBudget | null,
  now: number = performance.now(),
): RecallPlan | null {
  if (budget === undefined || budget === null) return null;
  const tier = selectRecallTier(budget);
  const clock = createRecallClock(budget, now);
  // An empty object means "give me a receipt for a full-pipeline call",
  // not "a budget of zero". Report `null` so receipts are unambiguous.
  const reportedBudget = Object.keys(budget).length > 0 ? budget : null;
  return {
    tier,
    clock,
    receipt: {
      budget: reportedBudget,
      tier,
      elapsedMs: 0,
      degraded: false,
      stages: [],
      skipped: [],
      resultCount: 0,
      estimatedTokens: 0,
      tokenCapped: false,
    },
  };
}

/** True when the soft deadline (75% of `maxMs`) has passed. */
export function isOverSoftDeadline(
  plan: RecallPlan | null,
  now: number = performance.now(),
): boolean {
  return plan !== null && now > plan.clock.softDeadline;
}

/** True when the hard deadline (`maxMs`) has passed. */
export function isOverHardDeadline(
  plan: RecallPlan | null,
  now: number = performance.now(),
): boolean {
  return plan !== null && now > plan.clock.hardDeadline;
}

/**
 * Whether a stage may run under this plan.
 *
 * Tier is a hard ceiling. Stages at tier 2 and above are also skipped once
 * the soft deadline passes, so the call degrades gracefully instead of
 * blowing the deadline.
 */
export function planAllowsStage(
  plan: RecallPlan | null,
  stage: RecallStage,
  now: number = performance.now(),
): boolean {
  if (!plan) return true;
  const minTier = STAGE_MIN_TIER[stage];
  if (plan.tier < minTier) return false;
  if (minTier >= 2 && now > plan.clock.softDeadline) return false;
  return true;
}

function skippedReasonFor(
  plan: RecallPlan,
  stage: RecallStage,
  now: number,
): RecallSkipReason {
  if (plan.tier < STAGE_MIN_TIER[stage]) return "tier";
  return "budget";
}

/**
 * Record a stage that ran (with its duration) or was skipped (with a
 * reason). No-op when there is no plan.
 */
export function recordRecallStage(
  plan: RecallPlan | null,
  stage: RecallStage,
  ms: number,
  ran: boolean,
  reason?: RecallSkipReason,
): void {
  if (!plan) return;
  const timing: RecallStageTiming = {
    stage,
    ms: ran ? Math.max(0, ms) : 0,
    ran,
  };
  if (!ran) {
    timing.skippedReason = reason ?? "disabled";
    if (!plan.receipt.skipped.includes(stage)) {
      plan.receipt.skipped.push(stage);
    }
  }
  plan.receipt.stages.push(timing);
}

/** Convenience wrapper: record a stage that was skipped by the plan. */
export function recordSkippedStage(
  plan: RecallPlan | null,
  stage: RecallStage,
  now: number = performance.now(),
): void {
  if (!plan) return;
  recordRecallStage(plan, stage, 0, false, skippedReasonFor(plan, stage, now));
}

/** Estimated tokens for one memory's content (plus summary when present). */
export function estimateResultTokens(result: {
  node: { content: string; summary?: string };
}): number {
  const summary = result.node.summary ?? "";
  return estimateTokens(result.node.content) + estimateTokens(summary);
}

/** Total estimated tokens for a result set. */
export function estimateResultsTokens(
  results: ReadonlyArray<{ node: { content: string; summary?: string } }>,
): number {
  let total = 0;
  for (const result of results) total += estimateResultTokens(result);
  return total;
}

export interface TokenCapResult<T> {
  results: T[];
  tokens: number;
  capped: boolean;
}

/**
 * Trim a best-first result list to an approximate token budget.
 *
 * Always keeps at least one result: returning nothing because the first
 * memory is large is worse than exceeding the cap by one item. The
 * `capped` flag records that the list was trimmed either way.
 */
export function capResultsByTokens<
  T extends {
    node: { content: string; summary?: string };
  },
>(results: T[], maxTokens?: number): TokenCapResult<T> {
  if (
    maxTokens === undefined ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0
  ) {
    return { results, tokens: estimateResultsTokens(results), capped: false };
  }

  const kept: T[] = [];
  let tokens = 0;
  for (const result of results) {
    const cost = estimateResultTokens(result);
    if (kept.length > 0 && tokens + cost > maxTokens) {
      return {
        results: kept,
        tokens,
        capped: kept.length < results.length,
      };
    }
    kept.push(result);
    tokens += cost;
  }
  return { results: kept, tokens, capped: false };
}

/** Finalize a plan after the pipeline returns. */
export function finishRecallPlan(
  plan: RecallPlan,
  resultCount: number,
  estimatedTokens: number,
  tokenCapped: boolean,
  now: number = performance.now(),
): RecallReceipt {
  const receipt = plan.receipt;
  receipt.elapsedMs = Math.max(0, now - plan.clock.startedAt);
  receipt.resultCount = resultCount;
  receipt.estimatedTokens = estimatedTokens;
  receipt.tokenCapped = tokenCapped;
  receipt.degraded =
    receipt.skipped.length > 0 || tokenCapped || receipt.tier < 3;
  return receipt;
}

/** Human-readable tier name. */
export function describeRecallTier(tier: RecallTier): string {
  return `${tier} (${RECALL_TIER_LABELS[tier] ?? "unknown"})`;
}

/** One-line-per-stage text rendering used by the CLI and MCP output. */
export function formatRecallReceipt(receipt: RecallReceipt): string {
  const budget = receipt.budget ?? {};
  const parts: string[] = [];
  const ms = budget.maxMs !== undefined ? `${budget.maxMs}ms` : "unbounded";
  const tokens =
    budget.maxTokens !== undefined ? `${budget.maxTokens} tokens` : "unbounded";
  parts.push(`Recall budget: ${ms} / ${tokens}`);
  parts.push(
    `Tier: ${describeRecallTier(receipt.tier)}  Elapsed: ${receipt.elapsedMs.toFixed(1)}ms`,
  );

  const ran = receipt.stages
    .filter((stage) => stage.ran)
    .map((stage) => `${stage.stage} ${stage.ms.toFixed(1)}ms`);
  const skipped = receipt.stages
    .filter((stage) => !stage.ran)
    .map((stage) => `${stage.stage} (${stage.skippedReason ?? "skipped"})`);
  if (ran.length > 0) parts.push(`Ran: ${ran.join(", ")}`);
  if (skipped.length > 0) parts.push(`Skipped: ${skipped.join(", ")}`);

  parts.push(
    `Results: ${receipt.resultCount}  ~${receipt.estimatedTokens} tokens` +
      (receipt.tokenCapped ? " (token-capped)" : ""),
  );
  if (receipt.degraded) parts.push("Degraded: yes");
  return parts.join("\n");
}
