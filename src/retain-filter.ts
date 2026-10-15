/**
 * Retain pre-filter for MemOS memory writes (v1.6.26).
 *
 * Hermes-style signal gate (cf. NousResearch/hermes-agent #16834): a cheap
 * local classifier that decides whether a piece of content is worth storing in
 * long-term memory before the write happens. Without this, every turn —
 * including low-signal acknowledgements, chit-chat, and retries — enters
 * memory and later bloats context-packs, costing retrieval tokens and diluting
 * relevance ranking.
 *
 * Default mode is a ZERO-LLM-CALL local classifier (keeps MemOS fast and
 * local). The *decision* is conservative-first: a write is skipped only
 * on positive evidence of noise (empty content, pure acknowledgements,
 * fragments, near-duplicates of existing same-scope memories) — when in
 * doubt the memory is kept, because a false skip silently loses user
 * data. The *score* (0–1) separately estimates signal density from
 * length, entity/code presence, action verbs, and novelty, and is
 * reported for debugging/telemetry. An optional custom classifier can
 * be injected via `setRetainClassifier()`.
 *
 * The near-duplicate test is where a salience gate most easily destroys
 * accuracy, so it is deliberately narrow: a restatement may only be
 * collapsed into an existing memory when the new text adds no salient
 * content the stored one lacks AND does not flip its negation polarity
 * (see {@link isRestatement}). Token overlap alone is not enough —
 * "…listens on port 5432 with a connection pool of 20" and "…listens on
 * port 6543 with a connection pool of 20" share 92% of their tokens and
 * are two different facts. Collapsing those silently deletes the update,
 * which is the one failure mode a memory write gate must never have.
 *
 * @module @mem-os/sdk/retain-filter
 */

import {
  classifyContentChange,
  contentTokens,
  hasNegationMarker,
} from "./confidence-machine.js";

/** Inputs the retain gate uses to make its decision. */
export interface RetainInput {
  /** The content proposed for storage. */
  content: string;
  /**
   * Existing memory content in the same namespace (for novelty detection).
   * Optional; when absent, novelty is assumed maximal.
   */
  existingContent?: string[];
}

/** The gate's verdict plus the score that drove it. */
export interface RetainDecision {
  /** True = store the content. */
  retain: boolean;
  /** Signal-density score in [0, 1]. Higher = more worth storing. */
  score: number;
  /** Human-readable reason for the decision (for debugging). */
  reason: string;
}

/** Minimum content length (in chars) to consider storing. */
const MIN_LENGTH = 15;
/** Score at or above which content is retained. */
const RETAIN_THRESHOLD = 0.3;

// Action / signal verbs — presence pushes the score up.
const ACTION_VERBS =
  /\b(?:prefers?|wants?|needs?|likes?|dislikes?|uses?|chose|chooses|set|configured?|created?|added?|removed?|updated?|installed?|deployed?|named|called|works?|lives?|located?|built|built with|wrote|fixed|decided|chose|switched|migrated|adopted|disabled|enabled|changed|replaced)\b/gi;

const ENTITY_SIGNALS = [
  /`[^`]+`/g, // code refs
  /(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|toml))/g, // file paths
  /https?:\/\/[^\s,)]+/g, // urls
  /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g, // proper nouns / concepts
  /\b\d+(?:\.\d+)?(?:%|ms|s|usd|\$|x)\b/gi, // numbers with units
];

// Low-signal acknowledgement phrases — pure noise, not worth storing.
// Anchored: the whole content must be an acknowledgement.
const LOW_SIGNAL_PATTERNS =
  /^(?:ok|okay|sure|got it|understood|done|will do|sure thing|sounds good|great|perfect|thanks|thank you|yep|yup|no problem|of course|absolutely|right|correct|exactly|yes|no|maybe|sure|hi|hello|hey|lol|haha|k|kk|cool|nice|wow)[.!?]?$/i;

// Individual acknowledgement words — used to catch repeated acks
// ("ok ok ok", "thanks thanks") that the anchored phrase pattern misses.
const ACK_WORDS =
  /^(?:ok|okay|sure|got|it|understood|done|will|do|thing|sounds|good|great|perfect|thanks|thank|you|yep|yup|no|problem|of|course|absolutely|right|correct|exactly|yes|maybe|hi|hello|hey|lol|haha|k|kk|cool|nice|wow)$/i;

/** Near-duplicate threshold: token overlap at/above this is a duplicate. */
const DUPLICATE_OVERLAP = 0.85;

/** Minimum alphanumeric characters for content to be storable at all. */
const MIN_SIGNAL_CHARS = 4;

/**
 * Max token overlap of `content` against any entry of `existingContent`
 * (0–1). Tokens are lowercase alphanumeric words longer than 2 chars.
 */
export function maxTokenOverlap(
  content: string,
  existingContent: string[],
): number {
  const tokens = new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length > 2),
  );
  if (tokens.size === 0) return 0;
  let maxOverlap = 0;
  for (const existing of existingContent.slice(0, 20)) {
    const exTokens = new Set(
      existing
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((w) => w.length > 2),
    );
    let overlap = 0;
    for (const t of tokens) if (exTokens.has(t)) overlap++;
    maxOverlap = Math.max(maxOverlap, overlap / tokens.size);
  }
  return maxOverlap;
}

/**
 * The existing memory a write would collapse into, if any.
 *
 * Restatements ("user prefers dark mode!" after "User prefers dark mode")
 * must collapse; value updates must not. Overlap alone cannot tell them
 * apart, so the overlap leader is re-checked with
 * {@link classifyContentChange} — the same salient-token comparison the
 * evidence state machine uses — and only counts when the new text is a
 * `reaffirm` or `augment` of it (it asserts nothing that is absent from
 * what is already stored) and the negation polarity has not flipped.
 *
 * @param content — The content proposed for storage.
 * @param existingContent — Existing memory content in the same scope.
 * @returns The matched existing content plus its overlap ratio, or null
 *   when nothing qualifies as a restatement.
 */
export function findRestatement(
  content: string,
  existingContent: string[],
): { existing: string; overlap: number } | null {
  const tokens = contentTokens(content);
  let best: { existing: string; overlap: number } | null = null;
  for (const existing of existingContent.slice(0, 20)) {
    const exTokens = contentTokens(existing);
    if (exTokens.size === 0) continue;
    let overlap = 0;
    for (const t of tokens) if (exTokens.has(t)) overlap += 1;
    const ratio = overlap / tokens.size;
    if (ratio < DUPLICATE_OVERLAP) continue;
    if (!best || ratio > best.overlap) best = { existing, overlap: ratio };
  }
  if (!best) return null;
  const change = classifyContentChange(best.existing, content);
  if (change !== "reaffirm" && change !== "augment") return null;
  // Belt and braces: `classifyContentChange` already reads polarity, but
  // a gate that can silently drop a write should never merge two texts
  // whose negation markers differ.
  if (hasNegationMarker(best.existing) !== hasNegationMarker(content)) {
    return null;
  }
  return best;
}

/**
 * Is `content` a restatement of something already stored, rather than
 * new information? True only for that narrow case — a genuine value
 * update ("moved from AWS to Fly", "port 5432" → "port 6543",
 * "prefers dark mode" → "no longer prefers dark mode") is never a
 * restatement, no matter how much of the sentence it reuses.
 *
 * @param content — The content proposed for storage.
 * @param existingContent — Existing memory content in the same scope.
 * @returns True when the write would add nothing to what is stored.
 */
export function isRestatement(
  content: string,
  existingContent: string[],
): boolean {
  return findRestatement(content, existingContent) !== null;
}

/**
 * Count distinct signal indicators in the content.
 */
function countSignals(content: string): number {
  let count = 0;
  for (const pattern of ENTITY_SIGNALS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    const matches = content.match(regex);
    if (matches) count += new Set(matches).size;
  }
  return count;
}

/**
 * Default local classifier: scores content on signal density (0-1).
 *
 * Components:
 *  - Length floor: tiny content scores ~0.
 *  - Signal density: entities / code refs / numbers per 100 chars.
 *  - Action / preference verbs: factual statements score higher.
 *  - Low-signal penalty: pure acknowledgements score ~0.
 *  - Novelty: down-weight content that duplicates existing memory.
 *
 * No LLM call, no I/O — runs in well under 1ms.
 */
export function scoreRetain(input: RetainInput): number {
  const { content, existingContent = [] } = input;

  if (!content || content.trim().length < MIN_LENGTH) return 0;

  // Hard penalty for pure acknowledgement turns.
  if (LOW_SIGNAL_PATTERNS.test(content.trim())) return 0.05;

  let score = 0;

  // Signal density.
  const signalCount = countSignals(content);
  const density = Math.min(1, signalCount / 3); // 3+ signals → max density
  score += density * 0.45;

  // Action / preference verbs (factual statements worth remembering).
  const verbMatches = content.match(ACTION_VERBS) ?? [];
  const verbDensity = Math.min(
    1,
    new Set(verbMatches.map((v) => v.toLowerCase())).size / 2,
  );
  score += verbDensity * 0.3;

  // Length appropriateness.
  const len = content.trim().length;
  score += len >= 25 && len <= 500 ? 0.15 : 0.05;

  // Novelty: down-weight near-duplicates of existing memory.
  if (existingContent.length > 0) {
    score += (1 - maxTokenOverlap(content, existingContent)) * 0.1;
  } else {
    score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * Decide whether to retain (store) content. Default uses the local
 * classifier; callers can inject a custom classifier via
 * `setRetainClassifier()`.
 *
 * Conservative-first contract (the accuracy gate): a write is skipped
 * ONLY on positive evidence of noise —
 *   1. empty content,
 *   2. a pure acknowledgement ("ok", "thanks", "ok ok ok", …),
 *   3. a fragment with almost no alphanumeric content ("...", "k"),
 *   4. a restatement of an existing same-scope memory — strictly
 *      {@link isRestatement}, so a value update that reuses most of the
 *      stored sentence ("port 5432" → "port 6543", "prefers dark mode" →
 *      "no longer prefers dark mode") is ALWAYS retained.
 * Everything else is retained. When in doubt, keep the memory — a
 * false skip silently loses user data, while a false keep only costs a
 * little storage. `score` still reports the signal-density estimate
 * from `scoreRetain` for debugging/telemetry.
 */
export function shouldRetain(input: RetainInput): RetainDecision {
  const score = scoreRetain(input);
  const content = input.content ?? "";
  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { retain: false, score, reason: "empty content" };
  }
  if (LOW_SIGNAL_PATTERNS.test(trimmed)) {
    return { retain: false, score, reason: "low-signal acknowledgement" };
  }
  // Repeated acks the anchored phrase pattern misses ("ok ok ok").
  const words = trimmed
    .replace(/[.!?]+$/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (
    words.length > 0 &&
    words.every((w) => ACK_WORDS.test(w.replace(/[.,!?]+$/g, "")))
  ) {
    return { retain: false, score, reason: "low-signal acknowledgement" };
  }
  const signalChars = trimmed.replace(/[^a-z0-9]/gi, "").length;
  if (signalChars < MIN_SIGNAL_CHARS) {
    return { retain: false, score, reason: "too short" };
  }
  const existing = input.existingContent ?? [];
  const restatement = findRestatement(content, existing);
  if (restatement) {
    return {
      retain: false,
      score,
      reason: `near-duplicate of existing memory (overlap ${restatement.overlap.toFixed(2)}, restatement)`,
    };
  }
  return { retain: true, score, reason: "no noise evidence — retained" };
}

/**
 * Optional pluggable classifier. When set, `shouldRetain` delegates to it.
 * Pass undefined to restore the default local classifier.
 */
let customClassifier: ((input: RetainInput) => RetainDecision) | null = null;

export function setRetainClassifier(
  classifier?: (input: RetainInput) => RetainDecision,
): void {
  customClassifier = classifier ?? null;
}

/** Decide whether to retain, using the custom classifier if installed. */
export function decideRetain(input: RetainInput): RetainDecision {
  if (customClassifier) return customClassifier(input);
  return shouldRetain(input);
}

export { RETAIN_THRESHOLD };
