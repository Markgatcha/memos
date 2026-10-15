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
 * Similarity at or above which two memories state the SAME fact — a
 * paraphrase rather than a contradiction. Deliberately the same number
 * as `CONTRADICTION_SIM_MAX` in src/contradictions.ts (>= 0.85 is a
 * duplicate for the write-time scan too). It is duplicated here rather
 * than imported because that module imports this one (`sharesSubject`),
 * and pulling a `const` across a cycle makes it a temporal-dead-zone
 * hazard at module-eval time.
 */
export const CONFIRMED_SIM_MIN = 0.85;

/**
 * Similarity at or above which two memories are about the same thing —
 * where the nirdiamant recipe's contradiction band starts. Mirrors
 * `CONTRADICTION_SIM_MIN` in src/contradictions.ts.
 */
export const RELATED_SIM_MIN = 0.5;

/**
 * Polarity markers: words that flip the truth value of an assertion.
 *
 * A marker present on one side of a pair and absent on the other means
 * the two texts assert OPPOSITE things — the most common shape of a
 * knowledge update ("user likes coffee" → "user no longer likes
 * coffee").
 *
 * Deliberately blind to {@link REVISION_VERBS}: those replace a *value*
 * without flipping a truth, and they are handled by
 * {@link displacedTokens}/{@link classifyContentChange}'s revision rule
 * instead, because the polarity test cannot see them.
 */
export const NEGATION_MARKERS = [
  "not",
  "never",
  "no longer",
  "instead of",
  "rather than",
  "no more",
  "stopped",
  "cannot",
  "can't",
  "don't",
  "doesn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
] as const;

/**
 * Salient-token containment at or above which a same-shape pair counts
 * as a value replacement rather than as two different facts: the shared
 * words of the stored text over the smaller of the two sets.
 *
 * A value update keeps the sentence and swaps one slot ("port 5432" →
 * "port 6543", "dark mode" → "light mode"), so the stored text's
 * content survives almost intact. Two genuinely different facts that
 * merely share a subject ("Alice owns the PostgreSQL schema" vs "Alice
 * owns the Kubernetes cluster") land at 0.5, which is what keeps this
 * from superseding unrelated memories.
 */
export const REPLACEMENT_CONTAINMENT_MIN = 0.6;

/**
 * Verbs that mark a *displacement* update: the new text names a value the
 * stored text still asserts and says it has been replaced ("moved from
 * AWS to Fly", "switched from pnpm to npm", "replaced the pool with…").
 *
 * This is the other half of the knowledge-update grammar, the half the
 * polarity list must ignore. A displacement carries no negation word, so
 * {@link hasNegationMarker} stays false on both sides of
 * "Our production deploy runs on AWS Elastic Beanstalk." vs "Our
 * production deploy moved from AWS to Fly.io machines." — which is how a
 * pure-token comparison reads them as "distinct" and lets the stale
 * version keep full confidence.
 */
export const REVISION_VERBS = [
  "moved",
  "switched",
  "changed",
  "migrated",
  "transitioned",
  "shifted",
  "replaced",
] as const;

/**
 * Prepositions that introduce the value a displacement replaces:
 * "moved FROM X to Y", "moved OFF X", "replaced X WITH Y". The span they
 * introduce is what {@link displacedTokens} reads.
 */
const DISPLACEMENT_PREPOSITIONS = new Set(["from", "off", "with"]);

/** Words that end a displaced-value span ("from X TO Y"). */
const DISPLACEMENT_TERMINATORS = new Set([
  "to",
  "into",
  "onto",
  "and",
  "but",
  "because",
  "so",
  "which",
  "that",
  "with",
  "for",
  "after",
  "before",
  "while",
  "than",
  "instead",
]);

/** Membership form of {@link REVISION_VERBS} for the hot scan loop. */
const REVISION_VERB_SET = new Set<string>(REVISION_VERBS);

/**
 * Function words dropped by {@link contentTokens} before the salient
 * token sets are compared. Articles, conjunctions, prepositions and
 * auxiliaries carry no fact value, so counting them only dilutes the
 * Jaccard overlap that separates a value swap ("dark" → "light") from
 * two unrelated facts.
 *
 * Domain words such as "user", "prefers" or "likes" are deliberately
 * NOT here: they are the predicate of the memories this module scores.
 * Numbers are never dropped either — see {@link contentWords}.
 */
const FUNCTION_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "was",
  "were",
  "are",
  "has",
  "had",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "may",
  "might",
  "must",
  "shall",
  "been",
  "being",
  "have",
  "you",
  "your",
  "its",
  "their",
  "our",
  "out",
  "off",
  "but",
  "all",
  "any",
  "one",
  "two",
  "get",
  "got",
  "let",
  "put",
  "via",
  "per",
  "than",
  "then",
  "them",
  "they",
  "this",
  "that",
  "these",
  "those",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "when",
  "while",
  "where",
  "which",
  "who",
  "what",
  "how",
  "why",
]);

/**
 * Stop words for the shared-subject guard: {@link FUNCTION_WORDS} plus
 * the generic memory-about-the-user vocabulary. Two texts that share
 * only "user" or "prefers" are not about the same subject, which is
 * what stops "User no longer drinks coffee" from superseding an
 * unrelated memory that merely happens to mention the user.
 *
 * Kept separate from {@link contentTokens} on purpose: the guard wants
 * to ignore who the sentence is about, the change classifier needs the
 * predicate to survive.
 */
const SUBJECT_STOP_WORDS = new Set([
  ...FUNCTION_WORDS,
  "user",
  "prefers",
  "likes",
  "not",
  "no",
  "longer",
]);

/**
 * The outcome of comparing a new observation against an existing memory.
 */
export type EvidenceOutcome = "confirmed" | "partial_conflict" | "contradicted";

/**
 * How the salient content of two texts relates:
 *
 *  - `reaffirm`  — the new text adds nothing the stored one lacks (an
 *    exact restatement, a rephrase, or an abbreviation). Safe to fold
 *    into the stored memory; nothing is lost.
 *  - `augment`   — the new text keeps every stored token and adds more
 *    ("…validated by zod at boot" → "…at boot and fails fast"): the same
 *    fact with extra detail.
 *  - `replace`   — the sentence shape survives but at least one slot
 *    changed value ("port 5432" → "port 6543"): a knowledge update.
 *  - `flip`      — the two texts carry opposite negation polarity:
 *    they assert opposite things.
 *  - `distinct`  — too little overlap to be the same fact.
 */
export type ContentChange =
  "reaffirm" | "augment" | "replace" | "flip" | "distinct";

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
 * Meaningful content words of a text, in order: lowercase tokens that
 * are either a number of any length ("20", "50", "5432") or an
 * alphabetic token longer than two characters, minus common function
 * words.
 *
 * The numeric carve-out is load-bearing, not cosmetic. The length>2
 * filter alone silently deletes every 1-2 character count from a
 * salient-token comparison, so "the pool is capped at 20 connections"
 * and "the pool is capped at 50 connections" reduced to an identical
 * token set and were classified `reaffirm` — the update was folded into
 * the stale memory and the new value vanished. Ports, versions, pool
 * sizes, replica counts and schedules are all 1-2 character facts in this
 * domain, so numbers must survive tokenization.
 *
 * Shared by {@link classifyContentChange} and the retain gate
 * (src/retain-filter.ts) so every lexical comparison in the write path
 * uses one tokenizer and one stop-word list.
 *
 * @param text — Free text (memory content, query, observation).
 * @returns The ordered content words.
 */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => isSalientToken(w) && !FUNCTION_WORDS.has(w));
}

/** Does a token carry fact value? Numbers always do; words must be >2 chars. */
function isSalientToken(token: string): boolean {
  return /^[0-9]+$/.test(token) || token.length > 2;
}

/**
 * The de-duplicated set form of {@link contentWords}, for membership
 * checks. Retained as the public spelling because callers that only ask
 * "do these texts share a token" should not have to think about order.
 */
export function contentTokens(text: string): Set<string> {
  return new Set(contentWords(text));
}

/**
 * Does the text flip a truth value? Whole-word match against
 * {@link NEGATION_MARKERS}, so "not npm" counts while "nothing" or
 * "notable" does not.
 *
 * @param text — Free text.
 * @returns True when at least one polarity marker is present.
 */
export function hasNegationMarker(text: string): boolean {
  // Normalise punctuation to spaces so "never," / "no longer." match.
  const padded = ` ${text.toLowerCase().replace(/[^a-z0-9'\s]+/g, " ")} `;
  return NEGATION_MARKERS.some((marker) => padded.includes(` ${marker} `));
}

/**
 * The salient values a displacement update replaces.
 *
 * Scans for a {@link REVISION_VERBS} occurrence and reads the span that
 * follows it up to the first terminator, so "migrated the deploy
 * pipeline from jenkins to github actions" yields ["jenkins"] and
 * "replaced aws with fly" yields ["aws"]. Returns [] when the verb has no
 * explicit displaced object ("moved to Berlin") — a verb alone is not
 * enough to invalidate a stored fact, only a named replacement is.
 *
 * The old text has to contain one of these for the pair to count as a
 * revision (see {@link classifyContentChange}); that is what stops
 * "migrated from Jenkins to GitHub Actions" from superseding the stored
 * "pipeline runs on GitHub Actions", where both statements are true.
 *
 * @param text — Free text.
 * @returns The displaced salient values, in order, deduplicated.
 */
export function displacedTokens(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let v = 0; v < words.length; v += 1) {
    if (!REVISION_VERB_SET.has(words[v]!)) continue;
    // The verb's own span: everything up to the first terminator.
    let end = v + 1;
    while (end < words.length && !DISPLACEMENT_TERMINATORS.has(words[end]!)) {
      end += 1;
    }
    const span = words.slice(v + 1, end);
    // "from X" / "off X" name the displaced value AFTER the preposition;
    // "replaced X with Y" names it BEFORE it.
    const preposition = span.findIndex((w) => DISPLACEMENT_PREPOSITIONS.has(w));
    const named =
      preposition < 0
        ? span
        : span[preposition] === "with"
          ? span.slice(0, preposition)
          : span.slice(preposition + 1);
    for (const raw of named) {
      if (!isSalientToken(raw) || FUNCTION_WORDS.has(raw)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push(raw);
    }
    v = end;
  }
  return out;
}

/**
 * Does the new text displace a value the stored text still asserts?
 * True when it carries a {@link REVISION_VERBS} with an explicit
 * displaced object that appears verbatim in `existingContent`.
 */
function revisesStoredValue(
  existingContent: string,
  newContent: string,
): boolean {
  const displaced = displacedTokens(newContent);
  if (displaced.length === 0) return false;
  const stored = new Set(contentWords(existingContent));
  return displaced.some((v) => stored.has(v));
}

/**
 * Classify how the salient content of two texts relates.
 *
 * Pure lexical comparison — no embeddings, no LLM — of the two ordered
 * content words plus negation polarity. This is what lets the evidence
 * state machine tell a *restatement* (fold into the stored memory) apart
 * from a *value update* (supersede the stored version): embedding
 * similarity alone cannot, because both land in the same 0.78–0.94
 * cosine band.
 *
 * A value replacement has to look like a slot swap inside an unchanged
 * sentence, so it is gated on three things at once:
 *   1. every content word of the stored text still appears in the new
 *      one, plus at least one that does not (something was swapped in);
 *   2. the overlap dominates the pair (containment ≥
 *      {@link REPLACEMENT_CONTAINMENT_MIN}) — this is what keeps "Alice
 *      owns the PostgreSQL schema" / "Alice owns the Kubernetes cluster"
 *      at 0.5 as two facts instead of an update;
 *   3. the sentences share a leading subject (see
 *      {@link sharesLeadingSubject}) — this is what keeps "The staging
 *      database is a Postgres 16 instance" / "The production database is
 *      a Postgres 16 instance" (differing at word zero) as two facts,
 *      while "Alice lives in Berlin" → "Alice lives in Tokyo" is one.
 *
 * A slot swap is not the only shape a value update takes. The other is a
 * *displacement* — "our deploy moved FROM aws TO fly" reuses so little of
 * the stored sentence that containment lands at 0.5, but it names the
 * value it replaces. Those are caught by the last rule: a
 * {@link REVISION_VERBS} with an explicit displaced object that the
 * stored text still asserts is the same kind of knowledge update, and it
 * is gated on the displaced value appearing in the stored text so a
 * migration whose old value the stored text does not mention ("runs on
 * GitHub Actions" alongside "migrated from Jenkins") is not invalidated.
 *
 * @param existingContent — The stored memory's content.
 * @param newContent — The new observation's content.
 * @returns The {@link ContentChange} verdict.
 */
export function classifyContentChange(
  existingContent: string,
  newContent: string,
): ContentChange {
  const existing = contentWords(existingContent);
  const incoming = contentWords(newContent);
  const flipped =
    hasNegationMarker(existingContent) !== hasNegationMarker(newContent);
  // A polarity flip is decisive even when the rest of the sentence is
  // unchanged ("prefers dark mode" vs "no longer prefers dark mode"):
  // identical tokens, opposite assertion.
  if (flipped && existing.length + incoming.length > 0) return "flip";

  const existingSet = new Set(existing);
  const incomingSet = new Set(incoming);

  let shared = 0;
  let onlyExisting = 0;
  for (const token of existingSet) {
    if (incomingSet.has(token)) shared += 1;
    else onlyExisting += 1;
  }
  let onlyIncoming = 0;
  for (const token of incomingSet)
    if (!existingSet.has(token)) onlyIncoming += 1;

  if (onlyExisting === 0 && onlyIncoming === 0) return "reaffirm";
  if (onlyExisting === 0) return "augment";
  if (onlyIncoming === 0) {
    // The new text asserts nothing the stored one lacks — an
    // abbreviation of the same fact. Folding it in loses nothing.
    return "reaffirm";
  }
  const containment = shared / Math.min(existingSet.size, incomingSet.size);
  if (
    containment >= REPLACEMENT_CONTAINMENT_MIN &&
    sharesLeadingSubject(existing, incoming)
  ) {
    return "replace";
  }
  // Low lexical overlap, but an explicit displacement of a value the
  // stored text still asserts ("moved from X to Y") is the same failure
  // mode as a slot swap: keeping the stored version would reinforce a
  // stale fact and silently drop the new one.
  if (revisesStoredValue(existingContent, newContent)) return "replace";
  return "distinct";
}

/**
 * Do the two content-word sequences open with the same subject?
 *
 * A memory update keeps the thing being described and swaps a value
 * further along ("Alice lives in Berlin" → "Alice lives in Tokyo"), so
 * the first positional difference must not be at word zero. Differing at
 * word zero means the *subject* changed, which is just as often two
 * different things ("The staging database is a Postgres 16 instance" →
 * "The production database is a Postgres 16 instance") as it is an
 * update, and the conservative verdict there is to keep both.
 *
 * @param existing — Content words of the stored text, in order.
 * @param incoming — Content words of the new text, in order.
 * @returns True when both open with identical content.
 */
function sharesLeadingSubject(
  existing: readonly string[],
  incoming: readonly string[],
): boolean {
  let i = 0;
  while (
    i < existing.length &&
    i < incoming.length &&
    existing[i] === incoming[i]
  ) {
    i += 1;
  }
  return i > 0;
}

/**
 * Compare a new observation against an existing memory to determine
 * the evidence outcome.
 *
 * The bands mirror the write-time contradiction scan in
 * src/contradictions.ts (`CONTRADICTION_SIM_MIN` / `_MAX`), but the
 * verdict inside a band is decided by {@link classifyContentChange},
 * not by similarity alone:
 *
 *   sim >= 0.85 — same fact (paraphrase band)
 *     `flip` / `replace` → contradicted. A paraphrase that swaps a value
 *     ("port 5432" → "port 6543") or flips polarity is a knowledge
 *     UPDATE: folding it into the stored memory would reinforce the
 *     stale value and silently drop the new one, which is the worst
 *     possible write-time failure.
 *     `reaffirm` / `augment` → confirmed. No stored information is lost
 *     by keeping the stored version.
 *   0.5 <= sim < 0.85 — same subject, different value band
 *     `flip` / `replace` → contradicted (Zep-style invalidation of the
 *     version that is no longer true).
 *     `augment` → partial_conflict (keep both; the new detail deserves
 *     its own row).
 *     `reaffirm` / `distinct` → partial_conflict (keep both).
 *   sim < 0.5 — unrelated band: unchanged historical rule for everything
 *     EXCEPT a decisive verdict, which now also supersedes here.
 *
 * That last point is the fix for the displacement-update hole. A
 * displaced value is detected from the words of the two texts, so the
 * verdict must not depend on where the pair happens to land in
 * cosine-similarity space: a real-vector embedder scored "our production
 * deploy runs on AWS Elastic Beanstalk" vs "our production deploy moved
 * from AWS to Fly.io machines" at 0.408, which is below every band, and
 * the update silently fell through to the neutral "confirmed". A
 * decisive verdict is therefore band-independent, and the store path
 * still applies its own `sharesSubject` guard before superseding
 * (src/memory.ts) — two independent locks on a destructive action.
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
  const change = classifyContentChange(existingContent, newContent);
  const decisive = change === "flip" || change === "replace";

  // A value replacement or a polarity flip invalidates the stored
  // version at ANY similarity — the lexical verdict is stronger
  // evidence than the embedding distance, which is a noisy proxy for it.
  if (decisive) return "contradicted";

  // Duplicate/paraphrase band: the new text is the same fact restated,
  // possibly with a little more detail, so the stored version already
  // covers it and folding it in loses nothing.
  if (similarity >= CONFIRMED_SIM_MIN) {
    return "confirmed";
  }

  // Contradiction band (same subject, different value).
  if (similarity >= RELATED_SIM_MIN) {
    // `reaffirm` is the only folding case here: the texts are close but
    // not paraphrases, so an `augment` keeps its own row rather than
    // losing the extra detail to a confidence bump.
    return change === "reaffirm" ? "confirmed" : "partial_conflict";
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
 * meaningful content word (a number of any length, or a word longer than
 * two characters that is not a stop word). This prevents
 * "User no longer drinks coffee" from nuking an unrelated memory that
 * merely happens to contain a signal word.
 */
export function sharesSubject(a: string, b: string): boolean {
  const words = (t: string): Set<string> =>
    new Set(
      t
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => isSalientToken(w) && !SUBJECT_STOP_WORDS.has(w)),
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
