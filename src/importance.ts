/**
 * Effective importance model for MemOS memory nodes.
 *
 * The stored `importance` field is the *base* score assigned at write time
 * (or manually via `update`). It never changes on its own. This module
 * derives an *effective* importance at read time by combining:
 *
 *   1. Recency decay — memories not accessed recently slide toward a
 *      configurable floor (never below `decayFloor` × base, so a memory
 *      can't vanish by aging alone).
 *   2. Access reinforcement — each retrieval adds a small, logarithmic
 *      boost (capped), so frequently-used memories outrank equally-aged
 *      ones that are never touched.
 *
 * The model is pure computation over node fields — it performs no writes.
 * This deliberately keeps it compatible with the access-count debounce:
 * effective importance is recomputed whenever eviction, archival, or
 * ranking needs it, instead of being materialised back into the row.
 *
 * @module @memos/importance
 */

import type { MemoryNode } from "./types.js";

/** Tuning knobs for the effective importance model. */
export interface ImportanceConfig {
  /**
   * Half-life (in days) of the recency decay applied to the base
   * importance. `0` disables decay. Default 30.
   */
  halfLifeDays?: number;
  /**
   * Floor for the decay factor — the multiplicative decay never drops
   * the base importance below `decayFloor` × base. Default 0.5.
   */
  decayFloor?: number;
  /**
   * Reinforcement gained per `log2(1 + accessCount)` unit. Default 0.1.
   */
  accessGain?: number;
  /**
   * Upper bound on the total access boost. Default 0.3.
   */
  accessCap?: number;
}

/** Resolved defaults for {@link ImportanceConfig}. */
export const DEFAULT_IMPORTANCE_CONFIG: Required<ImportanceConfig> = {
  halfLifeDays: 30,
  decayFloor: 0.5,
  accessGain: 0.1,
  accessCap: 0.3,
};

const MS_PER_DAY = 86_400_000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Compute the effective importance of a node at a point in time.
 *
 * Formula:
 *   decay       = decayFloor + (1 - decayFloor) · e^(−ageDays / halfLifeDays)
 *   accessBoost = min(accessCap, accessGain · log2(1 + accessCount))
 *   effective   = clamp01(importance · decay + accessBoost)
 *
 * @param node — The memory node.
 * @param now  — Current time (Unix ms).
 * @param cfg  — Optional tuning overrides.
 * @returns Effective importance in [0, 1].
 */
export function computeEffectiveImportance(
  node: Pick<MemoryNode, "importance" | "accessCount" | "lastAccessed">,
  now: number,
  cfg: ImportanceConfig = {},
): number {
  const { halfLifeDays, decayFloor, accessGain, accessCap } = {
    ...DEFAULT_IMPORTANCE_CONFIG,
    ...cfg,
  };

  const ageDays = Math.max(0, (now - node.lastAccessed) / MS_PER_DAY);
  const decay =
    halfLifeDays <= 0
      ? 1
      : decayFloor + (1 - decayFloor) * Math.exp(-ageDays / halfLifeDays);
  const accessBoost = Math.min(
    accessCap,
    accessGain * Math.log2(1 + node.accessCount),
  );
  return clamp01(node.importance * decay + accessBoost);
}

/**
 * Recency score for ranking boosts — pure exponential decay from the
 * last access, in [0, 1] (1 = touched right now).
 *
 * @param node — The memory node.
 * @param now  — Current time (Unix ms).
 * @param halfLifeDays — Days for the score to halve. `0` returns 1 (disabled).
 * @returns Recency score in [0, 1].
 */
export function recencyScore(
  node: Pick<MemoryNode, "lastAccessed">,
  now: number,
  halfLifeDays = 14,
): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, (now - node.lastAccessed) / MS_PER_DAY);
  return Math.exp(-ageDays / halfLifeDays);
}
