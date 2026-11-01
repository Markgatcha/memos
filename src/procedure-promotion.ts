/**
 * Promote repeated, successful recall patterns into reviewable procedures.
 *
 * This is the "importance discovered by use" step: a query that keeps
 * succeeding with the same attributed memories is a candidate for a durable
 * procedural lesson. Nothing is written here — the caller reviews the
 * candidates (CLI dry-run) and applies the ones it trusts.
 *
 * Honest scope: a `RecallBatchOutcome` is observational. Two successes may be
 * coincidence, so the candidate carries its evidence count and the caller
 * decides. This is not a causal uplift claim.
 */

import type { MemoryNode, RecallBatchOutcome } from "./types.js";
import { citationToken } from "./citations.js";

export interface ProcedureCandidate {
  /** Normalized query pattern used for grouping. */
  pattern: string;
  /** Original query from the first matching batch. */
  query: string;
  successes: number;
  partials: number;
  failures: number;
  confidence: number;
  memoryIds: string[];
  /** Short previews of the attributed memories, best-first. */
  evidence: string[];
  lesson: string;
  reason: string;
}

export interface PromotionOptions {
  /** Minimum successful batches before a pattern is eligible. Default 2. */
  minSuccesses?: number;
  /** Maximum failure ratio for eligibility. Default 0.2. */
  maxFailureRatio?: number;
  /** Maximum candidates to return. Default 20. */
  limit?: number;
}

export function deriveProcedureCandidates(
  batches: RecallBatchOutcome[],
  nodesById: Map<string, MemoryNode>,
  opts: PromotionOptions = {},
): ProcedureCandidate[] {
  const minSuccesses = Math.max(1, Math.floor(opts.minSuccesses ?? 2));
  const maxFailureRatio = Math.max(0, opts.maxFailureRatio ?? 0.2);
  const groups = new Map<
    string,
    {
      query: string;
      successes: number;
      partials: number;
      failures: number;
      memoryCounts: Map<string, number>;
    }
  >();

  for (const batch of batches) {
    const pattern = normalizeQuery(batch.query);
    if (!pattern) continue;
    const group = groups.get(pattern) ?? {
      query: batch.query,
      successes: 0,
      partials: 0,
      failures: 0,
      memoryCounts: new Map<string, number>(),
    };
    if (batch.outcome === "success") {
      group.successes += 1;
      for (const id of batch.memoryIds) {
        group.memoryCounts.set(id, (group.memoryCounts.get(id) ?? 0) + 1);
      }
    } else if (batch.outcome === "partial") {
      group.partials += 1;
    } else {
      group.failures += 1;
    }
    groups.set(pattern, group);
  }

  const candidates: ProcedureCandidate[] = [];
  for (const [pattern, group] of groups) {
    if (group.successes < minSuccesses) continue;
    const total = group.successes + group.partials + group.failures;
    if (total === 0) continue;
    if (group.failures / total > maxFailureRatio) continue;

    const memoryIds = [...group.memoryCounts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id]) => id)
      .filter((id) => nodesById.has(id));
    if (memoryIds.length === 0) continue;

    const evidence = memoryIds.slice(0, 3).map((id) => {
      const node = nodesById.get(id)!;
      return `${preview(node.summary || node.content)} ${citationToken(id)}`;
    });
    const confidence = Math.min(
      0.95,
      0.55 + group.successes * 0.05 - (group.failures / total) * 0.2,
    );
    const lesson =
      `When handling "${truncate(group.query, 120)}", reuse the validated ` +
      `approach and recalled evidence: ${evidence.join("; ")}`;

    candidates.push({
      pattern,
      query: group.query,
      successes: group.successes,
      partials: group.partials,
      failures: group.failures,
      confidence: Number(confidence.toFixed(3)),
      memoryIds,
      evidence,
      lesson,
      reason:
        `${group.successes} success${group.successes === 1 ? "" : "es"}` +
        (group.partials > 0 ? `, ${group.partials} partial` : "") +
        (group.failures > 0 ? `, ${group.failures} failure` : "") +
        `; ${memoryIds.length} attributed memor${memoryIds.length === 1 ? "y" : "ies"}.`,
    });
  }

  return candidates
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        b.successes - a.successes ||
        a.pattern.localeCompare(b.pattern),
    )
    .slice(0, Math.max(1, opts.limit ?? 20));
}

export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 8)
    .join(" ");
}

function preview(text: string): string {
  return truncate(text.replace(/\s+/g, " ").trim(), 100);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
