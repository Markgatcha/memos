/**
 * Confidence score state machine for MemOS memory nodes.
 *
 * Implements the reinforce/revise/supersede pattern described in
 * Mem0's "AI Memory Confidence Score" blog post, adapted for MemOS's
 * local-first architecture.
 *
 * Every memory node carries a `confidence` [0,1] and `evidenceCount`
 * in its metadata. When a new observation touches an existing memory,
 * the confidence score is adjusted:
 *
 * - CONFIRMED (new evidence agrees) → confidence increases (diminishing returns)
 * - PARTIAL_CONFLICT (new evidence partially conflicts) → confidence decreases
 * - CONTRADICTED (new evidence clearly replaces) → supersede old memory
 *
 * The confidence score feeds into the trust-weighted hybrid search,
 * so lower-confidence memories rank lower in retrieval results.
 */

/** Default confidence floor — memories below this get flagged for review. */
export const CONFIDENCE_FLOOR = 0.3;

/** Initial confidence for a new memory before any evidence. */
export const INITIAL_CONFIDENCE = 0.5;

/** Maximum confidence cap. */
export const CONFIDENCE_CAP = 1.0;

/**
 * Keyword signals that mark new content as a negation/update of an
 * existing fact ("no longer", "moved", …). Exported so the store-path
 * evidence wiring (src/memory.ts) uses the SAME word list as
 * {@link classifyEvidence} instead of duplicating it.
 */
export const CONTRADICTION_SIGNALS = [
  "not",
  "never",
  "no longer",
  "changed",
  "moved",
  "left",
  "different",
] as const;

/**
 * The outcome of comparing a new observation against an existing memory.
 */
export type EvidenceOutcome = "confirmed" | "partial_conflict" | "contradicted";

/**
 * The result of applying evidence to a memory's confidence score.
 */
export interface ConfidenceUpdate {
  /** New confidence score in [0, 1]. */
  confidence: number;
  /** New evidence count (total reinforce + revise events). */
  evidenceCount: number;
  /** Whether the memory was superseded (i.e. should be marked historical). */
  superseded: boolean;
  /** Whether the memory is now below the confidence floor (flagged for review). */
  flaggedForReview: boolean;
}

/**
 * Apply a single evidence event to a memory's confidence score.
 *
 * Uses a diminishing-returns formula for reinforcement:
 *   confidence += (CAP - confidence) * REINFORCE_RATE
 *
 * For partial conflicts (down-adjust):
 *   confidence -= confidence * REVISE_RATE
 *
 * @param currentConfidence — Current confidence score [0, 1].
 * @param currentEvidence — Current evidence count.
 * @param outcome — The evidence outcome from comparing new observation.
 * @returns Updated ConfidenceUpdate.
 */
export function applyEvidence(
  currentConfidence: number,
  currentEvidence: number,
  outcome: EvidenceOutcome,
): ConfidenceUpdate {
  if (outcome === "contradicted") {
    // Superseded — mark as historical, don't delete
    return {
      confidence: 0,
      evidenceCount: currentEvidence + 1,
      superseded: true,
      flaggedForReview: false, // superseded is a stronger signal
    };
  }

  if (outcome === "confirmed") {
    // Reinforce: confidence increases with diminishing returns
    // New = old + (CAP - old) * rate
    const newConfidence = Math.min(
      CONFIDENCE_CAP,
      currentConfidence + (CONFIDENCE_CAP - currentConfidence) * 0.15,
    );
    return {
      confidence: newConfidence,
      evidenceCount: currentEvidence + 1,
      superseded: false,
      flaggedForReview: newConfidence < CONFIDENCE_FLOOR,
    };
  }

  // partial_conflict — confidence decreases
  const newConfidence = Math.max(
    0,
    currentConfidence - currentConfidence * 0.25,
  );
  return {
    confidence: newConfidence,
    evidenceCount: currentEvidence + 1,
    superseded: false,
    flaggedForReview: newConfidence < CONFIDENCE_FLOOR,
  };
}

/**
 * Compare a new observation against an existing memory to determine
 * the evidence outcome.
 *
 * This is a simple heuristic-based classifier. For production use,
 * you may want to replace this with an LLM-based classifier.
 *
 * @param existingContent — The existing memory's content.
 * @param newContent — The new observation's content.
 * @param similarity — Semantic similarity between the two (0-1).
 * @returns The EvidenceOutcome.
 */
export function classifyEvidence(
  existingContent: string,
  newContent: string,
  similarity: number,
): EvidenceOutcome {
  // High similarity (>= 0.85) → confirmed (reinforced)
  if (similarity >= 0.85) {
    return "confirmed";
  }

  // Medium similarity (0.5 - 0.85) → partial conflict
  if (similarity >= 0.5) {
    return "partial_conflict";
  }

  // Low similarity (< 0.5) → check if they contradict
  // Simple keyword-based contradiction detection
  const newLower = newContent.toLowerCase();

  // If the NEW content carries a contradiction signal and similarity is
  // low, treat as contradicted (e.g. "user likes coffee" vs "user no
  // longer likes coffee").
  if (
    CONTRADICTION_SIGNALS.some((w) => newLower.includes(w)) &&
    similarity < 0.3
  ) {
    return "contradicted";
  }

  // Very low similarity and no contradiction → unrelated (no change).
  // NOTE for callers: this is the NEUTRAL fallthrough, not a positive
  // confirmation — unrelated content must NOT reinforce a memory. The
  // store-path wiring (src/memory.ts) distinguishes the two by requiring
  // pair similarity >= 0.85 before treating "confirmed" as a reinforce.
  return "confirmed";
}

/**
 * Do two texts talk about the same SUBJECT?
 *
 * Guard used by the store-path evidence wiring before a contradiction is
 * allowed to supersede a memory: the texts must share at least one
 * meaningful content word (length > 2, not a stop word). This prevents
 * "User no longer drinks coffee" from nuking an unrelated memory that
 * merely happens to contain a signal word.
 */
export function sharesSubject(a: string, b: string): boolean {
  const STOP = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "if",
    "then",
    "else",
    "when",
    "at",
    "by",
    "for",
    "with",
    "about",
    "into",
    "through",
    "during",
    "to",
    "from",
    "in",
    "on",
    "of",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
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
    "shall",
    "user",
    "prefers",
    "likes",
    "not",
    "no",
    "longer",
  ]);
  const words = (t: string) =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    );
  const setA = words(a);
  const setB = words(b);
  for (const w of setA) {
    if (setB.has(w)) return true;
  }
  return false;
}

/**
 * Get the effective retrieval weight for a memory, combining
 * trust and confidence scores.
 *
 * Higher trust (source) + higher confidence → higher weight.
 * Memories below the confidence floor get suppressed.
 *
 * @param trustScore — The static trust score [0, 1] from provenance.
 * @param confidence — The dynamic confidence score [0, 1].
 * @returns Combined weight multiplier in [0, 1].
 */
export function confidenceWeight(
  trustScore: number,
  confidence?: number,
): number {
  if (confidence === undefined || confidence === null) {
    // No confidence tracking yet — use trust score only
    return trustScore;
  }
  if (confidence < CONFIDENCE_FLOOR) {
    // Below floor: heavily suppress
    return trustScore * 0.1;
  }
  // Combine trust and confidence with a geometric mean
  // This penalizes memories that are low on either dimension
  return Math.sqrt(trustScore * confidence);
}
