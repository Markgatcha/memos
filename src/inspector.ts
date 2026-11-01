/**
 * Pure helpers for the recall inspector and memory health report.
 *
 * Keeping the wording and classification here makes `explain()` and
 * `health()` testable without storage or embeddings, and keeps
 * `src/memory.ts` focused on orchestration.
 *
 * @module @mem-os/inspector
 */

import type {
  ExplainScoreComponents,
  MemoryHealthFinding,
  MemoryNode,
  MemoryUtility,
} from "./types.js";

const DAY_MS = 86_400_000;

/** Lifecycle status of a memory at a point in time. */
export function memoryStatus(
  node: Pick<MemoryNode, "quarantined" | "validTo" | "expiresAt">,
  now: number = Date.now(),
): "active" | "historical" | "expired" | "quarantined" {
  if (node.quarantined) return "quarantined";
  if (node.validTo !== null && node.validTo <= now) return "historical";
  if (node.expiresAt !== null && node.expiresAt * 1000 < now) return "expired";
  return "active";
}

/** Age in days, rounded to one decimal. */
export function ageDays(createdAt: number, now: number = Date.now()): number {
  return Math.max(0, (now - createdAt) / DAY_MS);
}

/** Days since last access, or null when the memory has never been accessed. */
export function lastAccessedDays(
  node: Pick<MemoryNode, "accessCount" | "lastAccessed">,
  now: number = Date.now(),
): number | null {
  if (node.accessCount <= 0 || !Number.isFinite(node.lastAccessed)) return null;
  return Math.max(0, (now - node.lastAccessed) / DAY_MS);
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function score(value: number | undefined): string {
  return round(value ?? 0).toFixed(3);
}

/**
 * Human-readable ranking evidence for one candidate.
 *
 * These are explanations of the signals present on `ScoredMemory.scores`,
 * not an additive decomposition: fusion already combined and normalized the
 * legs, then post-fusion stages multiplied the result. The strings say which
 * stages contributed, in a stable order, so an operator can see whether a
 * hit came from keywords, vectors, graph expansion, reranking, or feedback.
 */
export function describeRankingEvidence(
  components: ExplainScoreComponents,
): string[] {
  const reasons: string[] = [];

  if (components.keyword !== undefined && components.keyword > 0) {
    reasons.push(`keyword leg contributed ${score(components.keyword)}`);
  }
  if (components.semanticRaw !== undefined) {
    reasons.push(`semantic similarity ${score(components.semanticRaw)}`);
  } else if (components.semantic !== undefined && components.semantic > 0) {
    reasons.push(
      `semantic leg contributed ${score(components.semantic)} (normalized)`,
    );
  }
  if (components.entityLeg !== undefined && components.entityLeg > 0) {
    reasons.push(
      `entity index matched ${components.entityLeg} entit${
        components.entityLeg === 1 ? "y" : "ies"
      }`,
    );
  }
  if (components.entity !== undefined && components.entity > 0) {
    reasons.push(`query-entity overlap boost ${score(components.entity)}`);
  }
  if (components.graph !== undefined && components.graph > 0) {
    reasons.push("reached through graph expansion");
  }
  if (components.ppr !== undefined && components.ppr > 0) {
    reasons.push(`graph PageRank signal ${score(components.ppr)}`);
  }
  if (components.session !== undefined && components.session > 0) {
    reasons.push("chronological session neighbour of a hit");
  }
  if (components.imageLeg !== undefined) {
    reasons.push(`image similarity ${score(components.imageLeg)}`);
  }
  if (components.multiHop !== undefined && components.multiHop > 0) {
    reasons.push(`second-hop entity bridge ${score(components.multiHop)}`);
  }
  if (components.rerank !== undefined) {
    reasons.push(`cross-encoder rerank score ${score(components.rerank)}`);
  }
  if (components.provenance !== undefined && components.provenance < 1) {
    reasons.push(
      `provenance trust multiplier ${score(components.provenance)} applied`,
    );
  }
  if (
    components.contradictionDemotion !== undefined &&
    components.contradictionDemotion < 1
  ) {
    reasons.push(
      `demoted by contradiction resolution (x${score(components.contradictionDemotion)})`,
    );
  }
  if (
    components.retrievalAnomaly !== undefined &&
    components.retrievalAnomaly < 1
  ) {
    reasons.push(
      `demoted by retrieval anomaly scoring (x${score(components.retrievalAnomaly)})`,
    );
  }
  if (components.outcomeUtility !== undefined) {
    reasons.push(
      `outcome feedback multiplier ${score(components.outcomeUtility)} applied`,
    );
  }
  if (components.hybrid !== undefined) {
    reasons.push(`fused hybrid score ${score(components.hybrid)}`);
  }

  if (reasons.length === 0) {
    reasons.push(
      "no per-leg breakdown (keyword-only or custom retrieval path)",
    );
  }
  return reasons;
}

/** Lifecycle caveats appended after ranking evidence. */
export function describeStatus(
  status: ReturnType<typeof memoryStatus>,
  node: Pick<MemoryNode, "validTo" | "expiresAt" | "quarantineReason">,
): string[] {
  switch (status) {
    case "historical":
      return [
        `historical: validity ended at ${new Date(node.validTo ?? 0).toISOString()}; excluded from default search`,
      ];
    case "expired":
      return [
        `TTL expired at ${new Date((node.expiresAt ?? 0) * 1000).toISOString()}; pending sweep`,
      ];
    case "quarantined":
      return [
        `quarantined${
          node.quarantineReason ? ` (${node.quarantineReason})` : ""
        }; excluded from recall until released`,
      ];
    default:
      return [];
  }
}

/** Feedback evidence rendered as one optional reason line. */
export function describeUtility(utility: MemoryUtility): string[] {
  if (utility.observations <= 0) return [];
  const reasons = [
    `outcome feedback: utility ${round(utility.utility).toFixed(2)} over ${round(
      utility.observations,
    )} weighted observation${utility.observations === 1 ? "" : "s"}`,
  ];
  if (utility.uplift !== null) {
    const sign = utility.uplift >= 0 ? "+" : "";
    reasons.push(
      `observational uplift ${sign}${round(utility.uplift).toFixed(2)} (used in ${utility.usedBatches}, not used in ${utility.unusedBatches} batches)`,
    );
  }
  return reasons;
}

/** Health grade thresholds. */
export function healthGrade(score: number): "A" | "B" | "C" | "D" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  return "D";
}

/** Sort findings by severity, then id, for deterministic output. */
export function sortFindings(
  findings: MemoryHealthFinding[],
): MemoryHealthFinding[] {
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  return [...findings].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || a.id.localeCompare(b.id),
  );
}
