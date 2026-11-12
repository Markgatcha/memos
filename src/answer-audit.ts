/**
 * Answer audit: check a generated answer against the memories behind it.
 *
 * Retrieval quality is necessary but not sufficient — an answer can cite
 * nothing, cite the wrong memory, or assert something the store never said.
 * This module splits an answer into claims, scores each claim against the
 * candidate memories, and reports coverage.
 *
 * The default scorer is lexical (containment + Jaccard over content tokens)
 * with an explicit negation check, so it stays deterministic and offline.
 * Citations written as `[mem:abcd]` are resolved and treated as evidence.
 *
 * @module @mem-os/sdk/answer-audit
 */

import { parseCitationToken } from "./citations.js";

/** Verdict for one claim. */
export type ClaimStatus =
  "supported" | "partial" | "unsupported" | "contradicted";

/** One sentence-level verdict. */
export interface AnswerClaimAudit {
  claim: string;
  status: ClaimStatus;
  /** 0-1 lexical support from the best matching memory. */
  score: number;
  /** Memory ids resolved from `[mem:...]` tokens in this claim. */
  citations: string[];
  /** Memories that supplied the best evidence (or the contradiction). */
  matchedMemoryIds: string[];
  /** Truncated content of the best matching memory. */
  evidence?: string;
  /** Why the verdict landed where it did. */
  reason?: string;
}

/** Aggregate report for one answer. */
export interface AnswerAuditReport {
  answer: string;
  claims: AnswerClaimAudit[];
  counts: {
    supported: number;
    partial: number;
    unsupported: number;
    contradicted: number;
  };
  /** (supported + 0.5 × partial) / claims, 0-1. */
  coverage: number;
  citationsResolved: number;
  citationsUnresolved: number;
  threshold: number;
}

/** Minimal memory shape the auditor needs. */
export interface AuditMemory {
  id: string;
  content: string;
}

/** Options for {@link auditAnswerText}. */
export interface AnswerAuditOptions {
  /** Similarity at or above this is `supported`. Default 0.55. */
  threshold?: number;
  /** Include at most this many evidence memories. Default 1. */
  maxEvidence?: number;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "with",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "as",
  "by",
  "from",
  "we",
  "i",
  "you",
  "they",
  "he",
  "she",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "may",
  "might",
  "must",
  "about",
  "into",
  "over",
  "under",
  "also",
  "just",
  "very",
  "more",
  "most",
  "some",
  "any",
  "all",
  "each",
  "there",
  "here",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "what",
  "how",
  "why",
]);

const NEGATION =
  /\b(not|no|never|without|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|wouldn't|shouldn't|couldn't)\b/i;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentTokens(text: string): Set<string> {
  const tokens = normalize(text)
    .split(" ")
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token));
  return new Set(tokens);
}

/** True when the text contains an explicit negation. */
export function hasNegation(text: string): boolean {
  return NEGATION.test(text);
}

/**
 * Split an answer into claim-sized units.
 *
 * Bullets, numbered list items, and sentences become claims. Questions and
 * fragments under three words are dropped — they are not assertions.
 */
export function splitAnswerClaims(answer: string): string[] {
  const rough = answer
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
        .replace(/^#+\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0);

  const claims: string[] = [];
  const seen = new Set<string>();
  for (const line of rough) {
    if (line.endsWith("?")) continue;
    const words = line.split(/\s+/).filter((word) => word.length > 0);
    if (words.length < 3) continue;
    const key = normalize(line);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    claims.push(line.replace(/[.]+$/, ""));
  }
  return claims;
}

/**
 * Lexical support score in [0, 1].
 *
 * 70% of the score is how much of the claim's content vocabulary appears in
 * the memory (containment); 30% is Jaccard, which penalises memories that
 * are much larger than the claim. An exact phrase match scores 1.
 */
export function claimSupportScore(claim: string, memory: string): number {
  const normalizedClaim = normalize(claim);
  const normalizedMemory = normalize(memory);
  if (!normalizedClaim || !normalizedMemory) return 0;
  if (
    normalizedMemory.includes(normalizedClaim) ||
    normalizedClaim.includes(normalizedMemory)
  ) {
    return 1;
  }

  const claimTokens = contentTokens(claim);
  const memoryTokens = contentTokens(memory);
  if (claimTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of claimTokens) {
    if (memoryTokens.has(token)) intersection += 1;
  }
  const containment = intersection / claimTokens.size;
  const union = claimTokens.size + memoryTokens.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return Math.min(1, containment * 0.7 + jaccard * 0.3);
}

/** Extract and resolve `[mem:...]` citations in one claim. */
export function resolveClaimCitations(
  claim: string,
  memories: AuditMemory[],
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const matches = claim.match(/\[mem:[0-9a-z]+\]/gi) ?? [];
  for (const match of matches) {
    const hex = parseCitationToken(match);
    if (!hex) {
      unresolved.push(match);
      continue;
    }
    const candidates = memories.filter((memory) =>
      memory.id.replace(/-/g, "").toLowerCase().startsWith(hex),
    );
    if (candidates.length === 1 && candidates[0]) {
      resolved.push(candidates[0].id);
    } else {
      unresolved.push(match);
    }
  }
  return { resolved: [...new Set(resolved)], unresolved };
}

function truncate(text: string, max = 240): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Audit an answer against a candidate memory set. */
export function auditAnswerText(
  answer: string,
  memories: AuditMemory[],
  opts: AnswerAuditOptions = {},
): AnswerAuditReport {
  const threshold = opts.threshold ?? 0.55;
  const partialThreshold = threshold * 0.55;
  const claims = splitAnswerClaims(answer);
  const audits: AnswerClaimAudit[] = [];
  let citationsResolved = 0;
  let citationsUnresolved = 0;

  for (const claim of claims) {
    let bestScore = 0;
    let bestMemory: AuditMemory | null = null;
    for (const memory of memories) {
      const score = claimSupportScore(claim, memory.content);
      if (score > bestScore) {
        bestScore = score;
        bestMemory = memory;
      }
    }

    const citations = resolveClaimCitations(claim, memories);
    citationsResolved += citations.resolved.length;
    citationsUnresolved += citations.unresolved.length;

    let status: ClaimStatus;
    let reason: string;

    if (citations.resolved.length > 0) {
      if (bestScore >= partialThreshold) {
        status = "supported";
        reason = `cited ${citations.resolved.length} memory(s) with lexical overlap`;
      } else {
        status = "partial";
        reason =
          "citation resolved, but shares little vocabulary with the claim";
      }
    } else if (citations.unresolved.length > 0) {
      status = bestScore >= threshold ? "supported" : "unsupported";
      reason = "citation did not resolve; scored lexically";
    } else if (
      bestMemory &&
      hasNegation(claim) !== hasNegation(bestMemory.content)
    ) {
      if (bestScore >= 0.45) {
        status = "contradicted";
        reason = "high lexical overlap but opposite negation";
      } else if (bestScore >= partialThreshold) {
        status = "partial";
        reason = "weak overlap with a negation difference";
      } else {
        status = "unsupported";
        reason = "no memory covers this claim";
      }
    } else if (bestScore >= threshold) {
      status = "supported";
      reason = "lexical overlap above threshold";
    } else if (bestScore >= partialThreshold) {
      status = "partial";
      reason = "some overlap, below the support threshold";
    } else {
      status = "unsupported";
      reason = "no memory covers this claim";
    }

    audits.push({
      claim,
      status,
      score: Number(bestScore.toFixed(4)),
      citations: citations.resolved,
      matchedMemoryIds: bestMemory ? [bestMemory.id] : [],
      ...(bestMemory ? { evidence: truncate(bestMemory.content) } : {}),
      reason,
    });
  }

  const counts = {
    supported: audits.filter((audit) => audit.status === "supported").length,
    partial: audits.filter((audit) => audit.status === "partial").length,
    unsupported: audits.filter((audit) => audit.status === "unsupported")
      .length,
    contradicted: audits.filter((audit) => audit.status === "contradicted")
      .length,
  };
  const coverage =
    audits.length > 0
      ? (counts.supported + counts.partial * 0.5) / audits.length
      : 0;

  return {
    answer,
    claims: audits,
    counts,
    coverage: Number(coverage.toFixed(4)),
    citationsResolved,
    citationsUnresolved,
    threshold,
  };
}

/** Text rendering for the CLI. */
export function formatAnswerAudit(report: AnswerAuditReport): string {
  const lines = [
    `Answer audit: ${report.claims.length} claim(s) — ${report.counts.supported} supported, ${report.counts.partial} partial, ${report.counts.unsupported} unsupported, ${report.counts.contradicted} contradicted`,
    `Coverage: ${(report.coverage * 100).toFixed(1)}%  Citations: ${report.citationsResolved} resolved, ${report.citationsUnresolved} unresolved`,
  ];
  for (const claim of report.claims) {
    lines.push(`  [${claim.status} ${claim.score.toFixed(2)}] ${claim.claim}`);
    if (claim.reason) lines.push(`      ${claim.reason}`);
    if (claim.evidence) lines.push(`      evidence: ${claim.evidence}`);
  }
  return lines.join("\n");
}
