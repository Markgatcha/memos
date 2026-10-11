/**
 * Statistical hard compression for context-pack items — a zero-dependency
 * variant of LLMLingua's token-selection idea: drop low-information
 * tokens (function words, filler adverbs) before injection instead of
 * calling a small LM to score perplexity.
 *
 * Honest framing: this is a conservative stopword-class filter, not a
 * learned compressor. It removes ~20–40% of tokens from typical prose at
 * zero cost and zero risk of a model dependency; the text remains
 * readable ("the deploy pipeline" → "deploy pipeline" — the separator of
 * a dropped word collapses, it never glues its neighbours into
 * "deploypipeline"). Code-like lines are never touched, and quoted spans
 * are preserved verbatim.
 *
 * @module @mem-os/compression
 */

export type CompressionLevel = "light" | "aggressive";

/** Function words dropped at `light` level. */
const LIGHT_DROPS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "that",
  "which",
  "and",
  "or",
  "in",
  "on",
  "at",
  "for",
  "with",
  "as",
  "by",
  "it",
  "its",
  "this",
  "these",
  "those",
]);

/** Additional tokens dropped at `aggressive` level.
 *
 * SAFETY (audit finding 1 — polarity-blind compression): every token that
 * carries logical polarity, quantity or epistemic strength is deliberately
 * ABSENT from this set. Dropping them flips the meaning of a fact:
 * "the only migration that has not failed" used to compress to
 * "migration not failed" — an unqualified failure claim — and
 * "Do not log tokens" to "not log tokens". Never re-add `not, never, no,
 * none, neither, nor, without, except, only, all, any, both, each, some,
 * few, many, most, same, too, enough, must, may, might, can, could,
 * should, would, will, do, does, did, have, has, had` to any drop set;
 * `__tests__/compression-semantics.test.ts` guards this invariant.
 */
const AGGRESSIVE_DROPS = new Set([
  "very",
  "really",
  "just",
  "actually",
  "basically",
  "literally",
  "quite",
  "rather",
  "somewhat",
  "also",
  "even",
  "still",
  "already",
  "however",
  "therefore",
  "then",
  "so",
  "such",
  "via",
  "per",
  "about",
  "into",
  "over",
  "under",
  "again",
  "here",
  "when",
  "where",
  "how",
  "who",
  "what",
  "why",
  "own",
  "there",
  "their",
  "they",
  "them",
  "we",
  "our",
  "you",
  "your",
  "i",
  "me",
  "my",
  "he",
  "she",
  "his",
  "her",
  "him",
  "us",
]);

/** Negation cues. A token adjacent to one of these is never dropped —
 * the neighbours of a negation are what the negation scopes over, and
 * losing them turns a precise exception into a blanket claim. */
const NEGATION_CUES =
  /\b(not|never|no|none|neither|nor|without|except)\b|cannot|n't$/i;

/**
 * Strip leading/trailing punctuation so "failed." matches "failed".
 *
 * Hand-rolled rather than `/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g`: with a
 * leading `^`-anchored and a trailing `$`-anchored alternative in one
 * alternation, the engine re-anchors at every offset of a long
 * non-alphanumeric run — quadratic on input like `"////…/x"`
 * (CodeQL js/polynomial-redos). A single scan each way is linear and
 * behaves identically.
 */
function bareWord(part: string): string {
  let start = 0;
  let end = part.length;
  const isAlnum = (c: number) =>
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122); // a-z
  while (start < end && !isAlnum(part.charCodeAt(start))) start++;
  while (end > start && !isAlnum(part.charCodeAt(end - 1))) end--;
  return start === 0 && end === part.length
    ? part.toLowerCase()
    : part.slice(start, end).toLowerCase();
}

/** Whether `part` is a word token (as opposed to whitespace or empty). */
function isWordPart(part: string): boolean {
  return part !== "" && !/^\s+$/.test(part);
}

/** Negation-adjacency guard (~15 lines).
 *
 * A token is protected — dropped by nothing, at any level — when it sits
 * immediately before or after a negation cue, immediately before or
 * after a number/unit, or inside a `not X but Y` contrast span. Those
 * neighbours are exactly what the negation or the number scopes over:
 * dropping them turns "the migration has not failed" into a bare
 * "failed" claim and "250ms, not 250s" into "250ms 250s".
 */
function protectedIndexes(parts: string[]): Set<number> {
  const words: Array<{ i: number; bare: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    if (isWordPart(parts[i])) words.push({ i, bare: bareWord(parts[i]) });
  }

  const keep = new Set<number>();
  const negated: number[] = [];

  for (let w = 0; w < words.length; w++) {
    const { i, bare } = words[w];
    // Number/unit tokens: the value itself and its immediate scope.
    if (/\d/.test(bare) || /^[%$]+$/.test(bare)) {
      keep.add(i);
      if (words[w - 1]) keep.add(words[w - 1].i);
      if (words[w + 1]) keep.add(words[w + 1].i);
    }
    // Negation cues and the words they scope over.
    if (NEGATION_CUES.test(bare)) {
      keep.add(i);
      negated.push(w);
      if (words[w - 1]) keep.add(words[w - 1].i);
      if (words[w + 1]) keep.add(words[w + 1].i);
    }
  }

  // `not X but Y` / `not X, Y`: the contrastive tail of the clause is
  // the corrected reading and must survive intact.
  for (let w = 0; w < words.length; w++) {
    const afterNegation = negated.some((n) => w > n);
    if (!afterNegation) continue;
    if (negated.some((n) => Math.abs(w - n) <= 1)) continue;
    if (/(^|,)\s*but\b|^\bbut\b/i.test(bareWord(words[w].bare))) {
      for (let k = w; k < words.length; k++) keep.add(words[k].i);
      break;
    }
  }

  return keep;
}

/** Lines that look like code are never compressed. */
function isCodeLike(line: string): boolean {
  return /^(\s{4,}|	)/.test(line) || /[{};=]|=>|^\s*\/\//.test(line);
}

/**
 * Image reference tokens that must survive compression intact.
 *
 * A `[img:…]` token is the ONLY way a consumer can resolve an image
 * memory's bytes. It is short and token-cheap, so it survives budget
 * pressure by accident — but nothing GUARANTEED that, and a future
 * compression variant that trims differently would silently strand the
 * image: the caption would compress to prose the model can't act on and
 * the reference that makes the image reachable would be gone. So the
 * token is pinned here, the same way negation and number-adjacent
 * tokens are pinned: it is split out before token-dropping and never
 * dropped. This is the single most important invariant of image memory.
 *
 * The outer group is a CAPTURING group on purpose: `String.split` only
 * preserves a matched delimiter when the regex captures it, and without
 * it the token would be discarded rather than re-joined. `(?:img|image)`
 * stays non-capturing so the token itself remains capture #1.
 */
const IMAGE_TOKEN_RE = /(\[(?:img|image):[A-Za-z0-9_-]{4,}\])/g;

/**
 * Compress one text block by dropping low-information tokens.
 *
 * @returns The compressed text. Structure (newlines) is preserved;
 * code-like lines pass through untouched.
 */
export function compressText(
  text: string,
  level: CompressionLevel = "light",
): string {
  if (!text) return text;
  const drops =
    level === "aggressive"
      ? new Set([...LIGHT_DROPS, ...AGGRESSIVE_DROPS])
      : LIGHT_DROPS;

  return text
    .split("\n")
    .map((line) => compressLine(line, drops))
    .join("\n");
}

/**
 * Compress one line, with image reference tokens pinned.
 *
 * The line is split into alternating prose / `[img:…]` segments; only
 * the prose segments go through token-dropping, and the tokens are
 * re-joined in place afterwards. So "the deploy failed [img:3f9a2b8c]
 * again" compresses its filler while the token survives verbatim at
 * `aggressive` level — which is exactly the invariant the image-memory
 * accuracy suite asserts.
 *
 * A line with no token takes the original path unchanged, so
 * text-only content is byte-identical to before.
 */
function compressLine(line: string, drops: Set<string>): string {
  if (!line.trim() || isCodeLike(line)) return line;
  // Reset the regex's lastIndex FIRST: `test` with a /g regex is
  // stateful, so a stale lastIndex from the previous line would skip
  // the first token — or miss it entirely.
  IMAGE_TOKEN_RE.lastIndex = 0;
  // No image token: the fast path, identical to the pre-image
  // implementation.
  if (!IMAGE_TOKEN_RE.test(line)) {
    return compressProse(line, drops);
  }
  IMAGE_TOKEN_RE.lastIndex = 0;
  const segments = line.split(IMAGE_TOKEN_RE);
  return segments
    .map((segment, index) =>
      // Even indexes are prose; odd indexes are the captured tokens.
      index % 2 === 1 ? segment : compressProse(segment, drops),
    )
    .join("");
}

/** Drop low-information tokens from one prose line (no image tokens). */
function compressProse(line: string, drops: Set<string>): string {
  if (!line.trim() || isCodeLike(line)) return line;
  const parts = line.split(/(\s+)/);
  const kept: string[] = [];
  // Whitespace whose LEFT neighbour was dropped is held back and
  // only emitted when a kept word actually follows. That collapses
  // the separator of a removed word instead of gluing its
  // neighbours together ("the deploy pipeline" → "deploy
  // pipeline", never "deploypipeline").
  let pendingSeparator: string | null = null;
  // An indented line keeps its indentation; a flush-left line must
  // not gain one when its first word is dropped.
  const indented = /^\s/.test(line);
  // Indices in `parts` that the negation/number adjacency guard
  // protects from any drop (see `protectedIndexes`). Iterating by
  // index (not `for..of`) matters: `parts.indexOf(part)` would
  // resolve a repeated word to its first occurrence.
  const guarded = protectedIndexes(parts);
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    if (part === "") continue;
    if (/^\s+$/.test(part)) {
      // Leading indentation is preserved verbatim; the rest is
      // provisional until the next kept word confirms it.
      if (kept.length === 0) kept.push(part);
      else if (pendingSeparator === null) pendingSeparator = part;
      continue;
    }
    const bare = bareWord(part);
    if (bare.length > 1 && drops.has(bare) && !guarded.has(idx)) continue;
    if (pendingSeparator !== null) {
      kept.push(pendingSeparator);
      pendingSeparator = null;
    }
    kept.push(part);
  }
  const joined = kept
    .join("")
    .replace(/\s{2,}/g, " ")
    .trimEnd();
  return indented ? joined : joined.replace(/^\s+/, "");
}
