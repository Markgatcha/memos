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
 * local): it scores content on signal density — length floor, entity/code
 * presence, action verbs, and a low-signal acknowledgement penalty. An
 * optional custom classifier can be injected via `setRetainClassifier()`.
 *
 * @module @mem-os/sdk/retain-filter
 */

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

// Low-signal acknowledgement patterns — pure noise, not worth storing.
const LOW_SIGNAL_PATTERNS =
  /^(?:ok|okay|sure|got it|understood|done|will do|sure thing|sounds good|great|perfect|thanks|thank you|yep|yup|no problem|of course|absolutely|right|correct|exactly|yes|no|maybe|sure|hi|hello|hey|lol|haha|k|kk|cool|nice|wow)[.!?]?$/i;

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
    const tokens = new Set(
      content
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((w) => w.length > 2),
    );
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
      maxOverlap = Math.max(maxOverlap, overlap / Math.max(tokens.size, 1));
    }
    score += (1 - maxOverlap) * 0.1;
  } else {
    score += 0.1;
  }

  return Math.min(1, score);
}

/**
 * Decide whether to retain (store) content. Default uses the local classifier;
 * callers can inject a custom classifier via `setRetainClassifier()`.
 */
export function shouldRetain(input: RetainInput): RetainDecision {
  const score = scoreRetain(input);
  const retain = score >= RETAIN_THRESHOLD;
  let reason: string;
  if (input.content.trim().length < MIN_LENGTH) reason = "too short";
  else if (score < 0.1) reason = "low-signal acknowledgement";
  else if (retain) reason = "signal density above threshold";
  else reason = "below retain threshold";
  return { retain, score, reason };
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
