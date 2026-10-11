/**
 * AI Trio context pack builder.
 *
 * Implements the `ai-trio.memos.context-pack.v1` contract from
 * `docs/ai-trio-contracts.md`. This is the canonical envelope LLM Guardian
 * and any other AI Trio consumer reads.
 *
 * Token-saving features:
 *   - Content debloating: strips redundant whitespace, collapses repeated
 *     phrases, trims trailing punctuation noise.
 *   - Smart dedup: drops near-duplicate items from the pack so the
 *     consumer doesn't fold the same fact twice — but only genuine
 *     duplicates. Similarity scores are order-blind and value-blind, so
 *     every drop is gated by a discriminating-token guard: an inverted
 *     fact (source/destination swapped) or a changed number survives.
 *   - Token-accurate budgeting: uses a GPT-style BPE approximation
 *     (whitespace + punctuation split) instead of the 4-chars-per-token
 *     heuristic. Callers can swap in a real tokenizer via `tokenCounter`.
 *   - Prompt-cache stability: scores are rounded to 3 decimals, items
 *     sort deterministically (score desc, id asc), and serialization
 *     layouts are fixed — so rebuilding a pack from the same memories
 *     yields byte-identical output. Providers that discount repeated
 *     prompt prefixes (Anthropic prompt caching, OpenAI) then cache the
 *     evidence block instead of re-billing it every turn.
 *
 * @module @memos/context-pack
 */

import type {
  ContextPackCompressionOptions,
  ContextPackWireFormat,
  EmbeddingVector,
  ImageAttachment,
  ImageMemoryMeta,
  ScoredMemory,
} from "./types.js";
import type { ProceduralLesson } from "./types.js";
// Runtime import is safe: embeddings.ts has no runtime imports of its own
// (type-only), so this cannot create a module cycle.
import { cosineSimilarity } from "./embeddings.js";
// Stable score-desc/id-asc ordering shared with retrieval fusion.
// retrieval.ts does not import this module, so no cycle is introduced.
import { compareScoredMemories } from "./retrieval.js";
// Citation tokens are pure string functions; procedural.ts is type-only
// plus pure math — neither imports this module, so no cycle.
import { assignCitationTokens, citationToken } from "./citations.js";
import { lessonCitationToken } from "./procedural.js";
// Fidelity levels are pure functions over nodes (fidelity.ts imports
// nothing from this module), so no cycle is introduced.
import {
  levelText,
  routeFidelity,
  shouldCompressFidelityItem,
} from "./fidelity.js";
import type { FidelityLevel } from "./fidelity.js";
import { isUntrustedForAgent } from "./provenance.js";
import { compressText, type CompressionLevel } from "./compression.js";

/**
 * The image payload carried by a node, or null when it is not an image
 * memory.
 *
 * `metadata.image` — not `type`, not a new MemoryType member — is the
 * discriminator (the same pattern `metadata.context` uses), so
 * MemoryType exhaustiveness stays intact everywhere: the sync
 * allowlist, fidelity labels, adapters, and the MCP zod schema all keep
 * working without knowing images exist.
 *
 * A malformed payload returns null rather than throwing: a pack is a
 * read path, and a partially-written metadata key must degrade to
 * "not an image" instead of failing the whole pack.
 */
export function imageAttachmentOf(node: {
  metadata?: Record<string, unknown>;
}): ImageMemoryMeta | null {
  const raw = node.metadata?.image;
  if (!raw || typeof raw !== "object") return null;
  const image = raw as Partial<ImageMemoryMeta>;
  if (typeof image.ref !== "string" || typeof image.sha256 !== "string") {
    return null;
  }
  return image as ImageMemoryMeta;
}

/** The single source of truth for the context-pack schema id. */
export const CONTEXT_PACK_SCHEMA = "ai-trio.memos.context-pack.v1";

/** A single ranked, ready-to-fold memory item. */
export interface ContextPackItem {
  id: string;
  /**
   * Citable token like `[mem:a3f9]`, unique within the pack. Present
   * only when the pack was built with `citations: true`.
   */
  citation?: string;
  content: string;
  summary: string | null;
  /**
   * Fidelity level this item's content was rendered at. Present only
   * when the pack was built with the `fidelity` option; `undefined`
   * means L3 verbatim (the default).
   */
  fidelity?: FidelityLevel;
  score: number;
  scores: {
    keyword?: number;
    semantic?: number;
    hybrid?: number;
  };
  /** Pack-level trust label (e.g. "local"). Use trustScore for the numeric value. */
  trust: string;
  /** Pack-level source label (e.g. "session"). Use nodeSource for the per-node provenance. */
  source: string;
  /** Per-node numeric trust score [0, 1]. Used by compact TOON for 0-9 encoding. */
  trustScore?: number;
  /** Per-node provenance source. Used by compact TOON for 2-char code. */
  nodeSource?: string;
  /**
   * Provenance tier of the item's channel (`user-verified` > `user` >
   * `tool-output` > `chat` > `imported`). Lets pack consumers apply the
   * read-time trust policy.
   */
  provenance?: string;
  /**
   * True when the item comes from a low-trust channel (`imported` /
   * `tool-output` tier, or quarantined-then-released): the host agent
   * should confirm it instead of silently injecting it as context.
   */
  untrustedSource?: boolean;
  tags: string[];
  updatedAt: string;
  /**
   * Image attachments carried by this item. Present only when the item
   * is an image memory AND the pack was built with images enabled
   * (the default when any candidate is an image memory).
   *
   * A REFERENCE, never the bytes: `ref` resolves through
   * `memos.imageMemory(ref)`. One item can carry several (a node whose
   * caption describes a multi-image memory), so this stays an array.
   */
  images?: ImageAttachment[];
}

/** Top-level envelope returned to the AI Trio. */
export interface ContextPack {
  schema: typeof CONTEXT_PACK_SCHEMA;
  query: string;
  namespace: string;
  tokenBudget: number;
  items: ContextPackItem[];
  /** Number of tokens saved by debloating + dedup. 0 when neither ran. */
  tokensSaved: number;
  /**
   * Fidelity metadata: which level the pack was rendered at and what it
   * cost vs verbatim, so token savings are visible. Present only when
   * the pack was built with the `fidelity` option.
   */
  fidelity?: ContextPackFidelityMeta;
  /**
   * Procedural lessons injected as an "operating instructions" section.
   * Present only when the pack was built with lessons requested
   * (`MemOS.contextPack({ lessons })`).
   */
  lessons?: ProceduralLesson[];
}

/**
 * Pack-level fidelity metadata. `contentTokens` is what the packed item
 * contents cost at the chosen level; `verbatimTokens` is what the SAME
 * items would have cost at L3 — the difference is the fidelity saving.
 */
export interface ContextPackFidelityMeta {
  level: FidelityLevel;
  /** True when the level came from the query-adaptive router. */
  adaptive: boolean;
  contentTokens: number;
  verbatimTokens: number;
}

/** Options for building a context pack. */
export interface BuildContextPackOptions {
  query: string;
  namespace: string;
  tokenBudget: number;
  items: ScoredMemory[];
  trust?: string;
  source?: string;
  includeSummary?: boolean;
  /**
   * Custom token counter. Receives a string, returns the token count.
   * Default: a GPT-style BPE approximation (split on whitespace +
   * punctuation, count fragments). Callers that have a real tokenizer
   * (e.g. `tiktoken` or an LM Studio endpoint) should pass it here for
   * exact budget enforcement.
   */
  tokenCounter?: (text: string) => number;
  /**
   * If true (default), strip redundant whitespace and collapse repeated
   * phrases from each item's content before packing.
   */
  debloat?: boolean;
  /**
   * If true (default), drop items whose content is >85% similar (by
   * token-set Jaccard) to an item already in the pack.
   */
  dedup?: boolean;
  /**
   * Jaccard similarity threshold above which two items are considered
   * duplicates. Default 0.85.
   */
  dedupThreshold?: number;
  /**
   * Keep items whose only difference is the one that matters (default
   * true). Before a lexical or semantic near-duplicate is dropped, the
   * two texts are compared on their DISCRIMINATING tokens: any
   * difference in the digit-bearing tokens (`pool size 20` vs
   * `pool size 40`), or — when the vocabulary overlap is high enough
   * for word order to be signal — a different content-word sequence
   * (source/destination inverted) keeps BOTH items.
   *
   * Set-membership similarity is order-blind and value-blind:
   * `moved the deploy script from the runner to the cluster` and
   * `moved the deploy script from the cluster to the runner` score
   * Jaccard 1.0 and cosine ≈ 0.99, so without this guard the pack
   * silently deletes one of two opposite facts. Genuine redundancy
   * (identical text, or a difference confined to function words) still
   * collapses — the token savings are the point of the feature. Set
   * `false` to restore pure similarity-threshold dedup.
   */
  dedupKeepIfDistinct?: boolean;
  /**
   * Opt-in semantic dedup: when provided, items whose stored embedding has
   * cosine similarity >= `semanticDedupThreshold` (default 0.90) with an
   * item already selected for the pack are dropped as paraphrased
   * duplicates. The higher-scored item always survives. Lexical dedup
   * (Jaccard) still runs independently; the two passes are complementary —
   * lexical catches shared-vocabulary copies, semantic catches paraphrases.
   *
   * Vectors come from the caller (typically MemOS, which already has them
   * in memory from hybrid search), so this pass adds no embedding compute.
   */
  embeddings?: Map<string, EmbeddingVector>;
  /**
   * Cosine similarity threshold for `embeddings`-based dedup.
   * Default 0.90 (near-certain paraphrase; lower values risk dropping
   * distinct-but-related facts).
   */
  semanticDedupThreshold?: number;
  /**
   * Memory-grounded citations (opt-in, default off). When true, every
   * pack item carries a `citation` token like `[mem:a3f9]` — unique
   * within the pack, lengthened git-style on collision — and the TOON
   * serializers render it ahead of the item's content so an agent can
   * quote it and a verifier can trace it via `resolveCitation`.
   * Opt-in because it changes the rendered bytes (cache-prefix rule:
   * never reshuffle a layout mid-session unasked).
   */
  citations?: boolean;
  /**
   * Procedural lessons to inject as an "operating instructions" section
   * (additive; does not consume the item token budget). Fetched via
   * `recallProcedural` by `MemOS.contextPack` — pass pre-fetched rows
   * here when calling `buildContextPack` directly.
   */
  lessons?: ProceduralLesson[];
  /**
   * Fidelity level for item contents: a fixed level or `"adaptive"`
   * (the query-adaptive router picks the starting level from query
   * signals). Default `undefined` = L3 verbatim — current behavior
   * preserved exactly. The resolved level is recorded per item
   * (`item.fidelity`) and in the pack metadata (`pack.fidelity`).
   */
  fidelity?: FidelityLevel | "adaptive";
  /**
   * Wire format the pack will be serialized to. When set, the budget
   * loop charges every item what it actually costs on the wire for that
   * format — the TOON row scaffolding (`id|score|trust|src|epochDelta|
   * tags|content`, base64url ids, citations) or the JSON serializer's
   * field names and quotes — instead of the legacy flat
   * `content + summary + 4` estimate. Letting a large budget buy fewer
   * items than it can really afford is the bug this closes.
   *
   * Default `undefined` = legacy accounting, which keeps the item
   * selection byte-identical for every existing caller.
   */
  wireFormat?: ContextPackWireFormat;
  /**
   * Compression for items that do not fit `tokenBudget`. Off by default
   * (see `ContextPackCompressionOptions`); when enabled, an oversized
   * item is re-rendered through `compressText` and admitted if the
   * compressed form fits. Items that are still too big after
   * compression are skipped exactly as before, so this can only add
   * items to a pack, never remove them.
   */
  compression?: ContextPackCompressionOptions;
  /**
   * Attach image references to pack items whose node is an image memory
   * (`metadata.image` present).
   *
   * Default `true` when any candidate item is an image memory: the
   * attachment is a REFERENCE (`img_<sha256[0:12]>` + dimensions +
   * caption), never the bytes, so there is no token-budget cost that
   * would justify an off-by-default. Pass `false` explicitly to omit
   * them (a pack with no images is byte-identical to before).
   *
   * The bytes are resolved separately via `memos.imageMemory(ref)` by a
   * vision-capable host model — inlining them would be both a token
   * bomb and a prompt-cache-prefix disaster.
   */
  images?: boolean;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate token count using a GPT-style BPE approximation.
 *
 * Splits on whitespace and punctuation boundaries, then counts the
 * fragments. This is within ~10% of real tiktoken counts for English
 * text and is zero-dependency. For exact counts, pass a `tokenCounter`
 * that calls tiktoken or an LM Studio token-count endpoint.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  // GPT tokenizes on whitespace + punctuation. Each punctuation mark
  // is typically its own token; words are 1-2 tokens depending on length.
  // A word of <=4 chars ≈ 1 token; longer words ≈ 1.3 tokens on average.
  const tokens = text
    .replace(/([.,;:!?"'(){}[\]])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let count = 0;
  for (const tok of tokens) {
    if (tok.length <= 4) count += 1;
    else if (tok.length <= 8) count += 1;
    else count += Math.ceil(tok.length / 4);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Per-item wire overhead (budget accounting)
// ---------------------------------------------------------------------------

/**
 * Legacy flat per-item overhead charged by the budget loop: the content
 * tokens, the summary tokens, plus this constant for "everything else".
 * Kept as the default so packs built without `wireFormat` select exactly
 * the same items they always did.
 */
const LEGACY_ITEM_OVERHEAD_TOKENS = 4;

/**
 * Tokens the *serialization scaffolding* of one pack item costs on the
 * wire — everything the item contributes except its own content and
 * summary text: the id, score, trust, source, timestamp and tags, the
 * pipe separators (TOON) or field names and quotes (JSON), the optional
 * citation token, and the optional fidelity field.
 *
 * The count is derived from the real serializers (`JSON.stringify`,
 * `packToToon`'s row layout, `serializeCompactRows`'s field order), so
 * the enforced budget tracks the bytes a consumer actually pays for
 * rather than the memory text alone.
 *
 * Two documented approximations, both in the conservative direction:
 *   - Compact TOON rows carry numeric placeholder fields (`0`), so the
 *     epoch-delta digits are undercounted by ~1 token.
 *   - Compact TOON references tags through the header dictionary when
 *     that is a net win; this charges the literal tags.
 *
 * @param item — The pack item (or a partial one) being costed.
 * @param wireFormat — Target format; `undefined` returns the legacy
 *   flat estimate.
 * @param tokenCounter — Token counter to measure the scaffolding with.
 * @param withCitation — True when the pack is built with `citations`, so
 *   the `[mem:xxxx]` token is charged too (it is assigned after budget
 *   selection, so the caller must say whether it will exist).
 */
export function itemWireOverheadTokens(
  item: ContextPackItem,
  wireFormat: ContextPackWireFormat | undefined,
  tokenCounter: (text: string) => number = estimateTokens,
  withCitation = false,
): number {
  if (wireFormat === undefined) return LEGACY_ITEM_OVERHEAD_TOKENS;
  // Citations are assigned after budget selection, so the token is
  // rendered on demand for the cost estimate.
  const citation = withCitation ? citationToken(item.id) : undefined;

  if (wireFormat === "json") {
    // Measure the real serializer directly: the same object with the
    // two variable-length text fields blanked out. Field names, quotes,
    // punctuation and the nested `scores` object all land in the count.
    return tokenCounter(
      JSON.stringify({
        ...item,
        content: "",
        summary: null,
        ...(citation ? { citation } : {}),
      }),
    );
  }

  // Both TOON layouts render the citation as a prefix inside the
  // content field, followed by one space.
  const citedPrefix = citation ? `${citation} ` : "";
  if (wireFormat === "toon") {
    const safeTags = item.tags.join(";");
    return tokenCounter(
      `${item.id}|${item.score.toFixed(3)}|${item.trust}|${item.source}|${item.updatedAt}|${safeTags}|${citedPrefix}`,
    );
  }
  // "toon-compact": ~id|s|t|c|e|g|ct, plus an optional 8th field.
  const fidelityField = item.fidelity ? `|${item.fidelity}` : "";
  return tokenCounter(
    `${encodeCompactId(item.id)}|0|0|ui|0|${item.tags.join(";")}|${citedPrefix}${fidelityField}`,
  );
}

// ---------------------------------------------------------------------------
// Content debloating
// ---------------------------------------------------------------------------

/**
 * Strip content bloat without losing meaning:
 *   - Collapse 3+ newlines to 2
 *   - Collapse 3+ spaces to 1
 *   - Strip trailing whitespace per line
 *   - Remove duplicate consecutive lines
 *   - Trim leading/trailing whitespace
 *
 * Returns the debloated text. If the text is short (<100 chars), returns
 * it unchanged — debloating overhead isn't worth it for one-liners.
 */
export function debloatContent(text: string): string {
  if (!text || text.length === 0) return text;
  let result = text;
  // Collapse excessive newlines.
  while (result.includes("\n\n\n")) {
    result = result.replace("\n\n\n", "\n\n");
  }
  // Strip trailing whitespace per line.
  result = result
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  // Collapse 3+ spaces to 1.
  result = result.replace(/ {3,}/g, " ");
  // Remove duplicate consecutive lines.
  const lines = result.split("\n");
  const deduped: string[] = [];
  let prev = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === prev && trimmed.length > 0) continue;
    deduped.push(line);
    prev = trimmed;
  }
  result = deduped.join("\n").trim();
  return result;
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------

/**
 * Compute the Jaccard similarity between two texts' token sets.
 * Returns a value in [0, 1]. 1 = identical token sets.
 *
 * Note what this CANNOT see: two sentences with the same vocabulary in
 * a different ORDER ("moved X from the runner to the cluster" vs
 * "moved X from the cluster to the runner") score a perfect 1.0. Token
 * sets are order-blind, so Jaccard alone can never tell an inverted
 * fact from a true duplicate — see {@link carriesDistinctFact}.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Function words stripped when building a text's content-word sequence.
 *
 * Deliberately EXCLUDES every polarity / quantity / modal token
 * (`not, never, no, only, all, both, must, can, will, …`) — those carry
 * the meaning, so they are content for this comparison and a difference
 * in them marks a distinct fact.
 */
const DEDUP_CONTENT_STOPWORDS = new Set([
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
  "from",
  "into",
  "about",
  "over",
  "under",
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

/**
 * Minimum Jaccard overlap at which word ORDER becomes a meaningful
 * discriminator. Below it the two texts share so little vocabulary that
 * "the sequences differ" is true of every paraphrase — the semantic
 * dedup pass exists precisely to catch those, so the guard stands down.
 */
const DISTINCT_FACT_OVERLAP_FLOOR = 0.6;

/**
 * Every token containing a digit (numbers, quantities, units glued to a
 * value: `3`, `250ms`, `40`, `v2`). Numbers are the single most
 * decision-relevant token class in technical memory, and set-based
 * similarity is blind to their VALUE.
 */
function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/\W+/)) {
    if (tok.length > 0 && /\d/.test(tok)) out.add(tok);
  }
  return out;
}

/**
 * The text's content words IN ORDER (function words removed, word order
 * preserved). Order is the point: `from the runner to the cluster` and
 * `from the cluster to the runner` produce different sequences while
 * producing identical token sets.
 */
function contentWordSequence(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((tok) => tok.length > 0 && !DEDUP_CONTENT_STOPWORDS.has(tok));
}

/** True when the two number-token sets are not equal. */
function numbersDiffer(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return true;
  for (const tok of a) {
    if (!b.has(tok)) return true;
  }
  return false;
}

/**
 * Guard applied BEFORE a near-duplicate is dropped: do these two texts
 * actually carry DISTINCT facts, or is the overlap genuine redundancy?
 *
 * Set-membership similarity cannot answer that question. Live-verified
 * failure this exists for (audit finding 4):
 *
 * ```
 * A: "moved the deploy script from the runner to the cluster and set retries to 3."
 * B: "moved the deploy script from the cluster to the runner and set retries to 3."
 * ```
 *
 * Jaccard(A, B) === 1.0 and cosine(A, B) ≈ 0.99 — both dedup passes used
 * to delete B and silently destroy an inverted fact. This guard
 * compares the parts of the texts that actually discriminate:
 *
 *  1. **Numbers.** Any difference in the digit-bearing token sets is a
 *     different fact. `pool size 20` vs `pool size 40` is a change, not
 *     a duplicate.
 *  2. **Content-word order.** When the vocabulary overlap is high enough
 *     for word order to be signal rather than paraphrase noise
 *     ({@link DISTINCT_FACT_OVERLAP_FLOOR}), a differing content-word
 *     sequence means the roles are swapped — source and destination
 *     inverted — which is the most dangerous near-duplicate shape there
 *     is.
 *
 * Returns `false` (collapse as before) for genuine redundancy: identical
 * text, or text differing only in function words. Disable with
 * `dedupKeepIfDistinct: false` to restore pure set-membership dedup.
 */
function carriesDistinctFact(a: string, b: string): boolean {
  if (numbersDiffer(numberTokens(a), numberTokens(b))) return true;
  if (jaccardSimilarity(a, b) < DISTINCT_FACT_OVERLAP_FLOOR) return false;
  const seqA = contentWordSequence(a);
  const seqB = contentWordSequence(b);
  if (seqA.length !== seqB.length) return true;
  for (let i = 0; i < seqA.length; i += 1) {
    if (seqA[i] !== seqB[i]) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pack builder
// ---------------------------------------------------------------------------

const DEFAULT_DEDUP_THRESHOLD = 0.85;

/**
 * Derived pack limits.
 *
 * `contextPack()` derives how many items to retrieve from the caller's
 * `tokenBudget`. The old rule clamped the derived value at 50, which made
 * a 200k-token context window buy exactly the same evidence volume as a
 * 4k one — the window scaled, the memory layer didn't. The ceiling now
 * grows with the budget up to {@link PACK_ITEM_LIMIT_MAX}, which is what
 * a large window is actually paying for.
 */

/** Budget assumed per packed item when deriving the item limit. */
export const PACK_TOKENS_PER_ITEM = 80;
/** Floor on the derived item limit (tiny budgets still get a real pack). */
export const PACK_ITEM_LIMIT_MIN = 8;
/**
 * Absolute ceiling on the derived item limit, and therefore on the
 * candidate pool (`limit * PACK_CANDIDATE_DEPTH_FACTOR` rows come back
 * from storage). Bounds memory use no matter how large a budget a caller
 * passes; 500 items of evidence is already more than fits in any
 * practical prompt once the token budget itself is enforced.
 */
export const PACK_ITEM_LIMIT_MAX = 500;
/**
 * How many candidates the pack path fetches per item slot. A larger
 * budget has to retrieve more candidates for budget trimming to have
 * material to work with.
 */
export const PACK_CANDIDATE_DEPTH_FACTOR = 4;

/**
 * Derive the pack item limit from a token budget.
 *
 * Scales linearly (`tokenBudget / PACK_TOKENS_PER_ITEM`) between
 * {@link PACK_ITEM_LIMIT_MIN} and {@link PACK_ITEM_LIMIT_MAX}. Budgets up
 * to 4,000 tokens derive the historical value of 50, so small-budget
 * packs are unchanged; larger windows now buy proportionally more
 * evidence.
 */
export function derivePackItemLimit(tokenBudget: number): number {
  const perItem = Math.floor(tokenBudget / PACK_TOKENS_PER_ITEM);
  return Math.min(PACK_ITEM_LIMIT_MAX, Math.max(PACK_ITEM_LIMIT_MIN, perItem));
}

/**
 * Derive the candidate depth (how many rows retrieval fetches) for a
 * derived pack item limit.
 */
export function derivePackCandidateDepth(limit: number): number {
  return limit * PACK_CANDIDATE_DEPTH_FACTOR;
}

/** One budgeted candidate, as produced by `buildContextPack` phase 1. */
interface PreparedPackItem {
  item: ContextPackItem;
  /** Tokens this item costs (content + summary + wire overhead). */
  tokenCount: number;
  /** Tokens debloating removed from this item. */
  debloatSaved: number;
  /** Content + summary tokens, i.e. `tokenCount` minus the overhead. */
  contentTokens: number;
  summaryTokens: number;
  overhead: number;
}

/**
 * Re-render an oversized item through {@link compressText} so it can be
 * admitted under the budget instead of dropped.
 *
 * Returns `null` — meaning "skip the item", exactly as the budget loop
 * did before compression existed — when compression is disabled, when
 * the compressed form is empty, when it did not actually save any tokens
 * (code-like content, or text made entirely of stop words), OR when the
 * compressed form still does not fit the remaining budget. Otherwise
 * returns the shrunken item, its new token count, and how many tokens
 * compression saved.
 */
function compressForBudget(
  prepared: PreparedPackItem,
  opts: {
    enabled: boolean;
    level: CompressionLevel;
    tokenCounter: (text: string) => number;
    tokensUsed: number;
    tokenBudget: number;
  },
): {
  item: ContextPackItem;
  tokenCount: number;
  compressionSaved: number;
} | null {
  if (!opts.enabled) return null;
  // Image-memory guard: compression must never strand an image. The
  // `[img:…]` token is pinned by `compressText` itself, so this is a
  // belt-and-braces check — but a future compression variant that
  // trims differently would silently break image recall, and the cost
  // of checking is one comparison. If the token is gone, the item keeps
  // its uncompressed form (the same "no win → skip compression" rule
  // the budget loop already applies).
  const beforeRefs = imageRefsIn(prepared.item.content);
  const compressedContent = compressText(prepared.item.content, opts.level);
  if (beforeRefs.length > 0 && !imageRefsIn(compressedContent).length) {
    return null;
  }
  // An empty (or all-stopword) result carries no information — skip the
  // item rather than inject a blank row.
  if (compressedContent.trim().length === 0) return null;
  const compressedSummary =
    prepared.item.summary !== null
      ? compressText(prepared.item.summary, opts.level) || null
      : null;
  const contentTokens = opts.tokenCounter(compressedContent);
  const summaryTokens = compressedSummary
    ? opts.tokenCounter(compressedSummary)
    : 0;
  const before = prepared.contentTokens + prepared.summaryTokens;
  const after = contentTokens + summaryTokens;
  // No win: keep the original text (and let the caller skip the item)
  // rather than pay for a lossy rewrite that bought nothing.
  if (after >= before) return null;
  const tokenCount = after + prepared.overhead;
  // The compressed form must actually fit. Compression buys headroom, it
  // does not grant an exception to the budget.
  if (opts.tokensUsed + tokenCount > opts.tokenBudget) return null;
  return {
    item: {
      ...prepared.item,
      content: compressedContent,
      summary: compressedSummary,
    },
    tokenCount,
    compressionSaved: before - after,
  };
}

/**
 * Cache-prefix stability contract.
 *
 * LLM providers discount cached input tokens (up to ~90%) only when the
 * prompt prefix is byte-identical across calls. Everything this module
 * emits is built to be byte-stable for identical inputs:
 *   - evidence items are U-shape ordered (lost-in-the-middle mitigation):
 *     the highest-scoring item comes FIRST, the second-best item is pinned
 *     LAST (the two most-attended positions), and the rest follow in
 *     descending score order. Deterministic: it reuses the score-desc /
 *     node-id-tiebreak sort below, so equal scores can never surface
 *     input-order noise;
 *   - the `scores` breakdown is re-emitted in a fixed key order
 *     (keyword, semantic, entity, hybrid) no matter which retrieval legs
 *     produced it — fusion builds that object in leg-dependent order;
 *   - serializers use a fixed section/field order and always emit every
 *     section (empty packs still emit their headers), so a missing section
 *     can never shift the bytes of a later one. TOON serializers append one
 *     fixed trailer line (`# q=<query>`) after the last evidence row so a
 *     reader scanning bottom-up re-anchors on the query.
 *
 * Rule of thumb for future edits: compress *contents* all you want, but
 * never reorder *layout* — layout churn breaks cache prefixes and raises
 * bills even while "saving" tokens.
 */

/** Fixed key order for the per-item score breakdown (see contract above). */
const SCORE_KEY_ORDER = ["keyword", "semantic", "entity", "hybrid"] as const;

/**
 * Re-emit a score breakdown in the fixed {@link SCORE_KEY_ORDER} order.
 * Unknown/future keys are appended afterwards in sorted order so nothing
 * is dropped and the layout stays deterministic.
 */
function normalizeScores(
  scores: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (scores) {
    for (const key of SCORE_KEY_ORDER) {
      if (scores[key] !== undefined) out[key] = roundScore(scores[key]);
    }
    for (const key of Object.keys(scores).sort()) {
      if (!(key in out)) out[key] = roundScore(scores[key] as number);
    }
  }
  return out;
}

/**
 * Round a score to 3 decimals.
 *
 * Cache-prefix stability: fusion scores are float64 math, so two runs
 * over the same memories can differ in the last bits
 * (0.9499999999999999 vs 0.95). Rounding at build time keeps JSON and
 * TOON output byte-identical across rebuilds, which is what lets
 * provider prompt caches hit on the evidence block.
 */
export function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

/**
 * Summary elision: drop the summary when it costs at least this fraction
 * of its own content's tokens. Below that, a summary is a genuinely
 * cheaper carrier of the fact; above it, the full content is the better
 * deal on its own.
 */
const SUMMARY_ELISION_RATIO = 0.5;

/**
 * Summary elision: drop the summary when its token-set Jaccard similarity
 * with its own content reaches this — i.e. it's a compressed copy, not an
 * independent viewpoint. 0.45 catches the classic extractive case (a
 * summary that is a prefix restatement of its own content sits at
 * ~0.4-0.5 because the content adds extra vocabulary); genuinely
 * condensed summaries land far below.
 */
const SUMMARY_ELISION_JACCARD = 0.45;

/**
 * Semantic dedup: cosine similarity at or above this counts as a
 * paraphrased duplicate. Deliberately high (near-identical vectors) so
 * distinct-but-related facts are never dropped.
 */
const DEFAULT_SEMANTIC_DEDUP_THRESHOLD = 0.9;

export function buildContextPack(opts: BuildContextPackOptions): ContextPack {
  const {
    query,
    namespace,
    tokenBudget,
    items,
    trust = "local",
    source = "session",
    includeSummary = true,
    tokenCounter = estimateTokens,
    debloat = true,
    dedup = true,
    dedupThreshold = DEFAULT_DEDUP_THRESHOLD,
    dedupKeepIfDistinct = true,
    embeddings,
    semanticDedupThreshold = DEFAULT_SEMANTIC_DEDUP_THRESHOLD,
    citations = false,
    lessons,
    fidelity,
    wireFormat,
    compression,
    images: imagesOption,
  } = opts;

  // Sort by descending score, node id as the final tiebreak (cache-prefix
  // stability: equal scores must not surface input-order noise).
  const sorted = [...items].sort(compareScoredMemories);

  // Fidelity level: "adaptive" routes per-query; a fixed level renders
  // every item at that level; undefined keeps the historical default of
  // L3 verbatim text.
  const resolvedLevel: FidelityLevel | undefined =
    fidelity === "adaptive" ? routeFidelity(query).level : fidelity;
  const fidelityAdaptive = fidelity === "adaptive";

  // Image attachments: default ON when any candidate is an image
  // memory. Explicit `false` opts out; a pack with no image nodes is
  // byte-identical to before either way (the field is simply absent).
  const imagesEnabled =
    imagesOption ??
    items.some((scored) => imageAttachmentOf(scored.node) !== null);

  // Phase 1: debloat, elide redundant summaries, and compute token counts.
  //
  // Tokenization budget per item (perf): `tokenCounter` runs at most four
  // times — packed content, packed summary (if present), raw content, and
  // raw summary (if included). The previous revision tokenized the packed
  // forms a SECOND time after building the item (6 calls/item worst case);
  // the counts are now computed once and reused everywhere below.
  const prepared = sorted.map((scored) => {
    // Fidelity rendering happens BEFORE debloat: a summary or entity
    // list has no filler worth stripping, and applying it first keeps
    // the token math consistent with the budget trimming below.
    const rawContent =
      resolvedLevel === undefined
        ? scored.node.content
        : levelText(scored.node, resolvedLevel);
    const content = debloat ? debloatContent(rawContent) : rawContent;
    const rawSummaryText = scored.node.summary || "";
    let summary = includeSummary
      ? (debloat ? debloatContent(rawSummaryText) : rawSummaryText) || null
      : null;

    // Token counts for the PACKED forms — computed once, reused.
    const contentTokens = tokenCounter(content);
    let summaryTokens = summary ? tokenCounter(summary) : 0;

    // Summary elision: a summary that restates its own content is paid
    // for twice on the wire while adding no new information. Drop it when
    // it costs half as many tokens as the full content OR lexically
    // overlaps the content enough to be a compressed copy. The full
    // content always stays, so no information is lost — only the lossy
    // duplicate is. Cost note: the Jaccard leg runs only when the ratio
    // leg misses, and both operands were just tokenized anyway, so this
    // adds one linear scan per item at most — negligible next to
    // `tokenCounter`.
    if (
      summary &&
      (summaryTokens >= SUMMARY_ELISION_RATIO * contentTokens ||
        jaccardSimilarity(summary, content) >= SUMMARY_ELISION_JACCARD)
    ) {
      summary = null;
      summaryTokens = 0;
    }

    // Token counts for the RAW forms — used only to measure how much
    // debloating saved on this item. The raw summary is only counted when
    // the summary SURVIVED elision: otherwise its tokens would be
    // double-counted (once via `summaryTokens = 0`, once via the raw
    // side), inflating `tokensSaved` with savings that came from
    // elision, not debloating.
    const rawContentTokens = tokenCounter(rawContent);
    const rawSummaryTokens =
      summary !== null ? tokenCounter(rawSummaryText) : 0;
    const debloatSaved = Math.max(
      0,
      rawContentTokens + rawSummaryTokens - (contentTokens + summaryTokens),
    );

    const item: ContextPackItem = {
      id: scored.node.id,
      content,
      summary,
      // Present only when the pack was built with `fidelity` — keeps the
      // default object shape byte-identical to before.
      ...(resolvedLevel !== undefined && { fidelity: resolvedLevel }),
      score: roundScore(scored.score),
      // Fixed key order — fusion builds this object in leg-dependent
      // order, which would otherwise shift JSON bytes between calls.
      scores: normalizeScores(scored.scores),
      trust,
      source,
      // Per-node provenance for compact TOON encoding
      trustScore: scored.node.trustScore,
      nodeSource: scored.node.source,
      // Provenance-trust layer: tier + read-time trust flag, so every
      // pack item handed to an agent is traceable to its channel and
      // low-trust items are explicitly marked.
      provenance: scored.node.provenance,
      untrustedSource: isUntrustedForAgent(scored.node),
      tags: [...scored.node.tags],
      updatedAt: new Date(scored.node.updatedAt).toISOString(),
      // Image reference(s), when this item is an image memory and the
      // pack carries images. The field is omitted entirely otherwise so
      // a text-only pack stays byte-identical.
      ...(imagesEnabled && imageAttachmentOf(scored.node)
        ? { images: [imageAttachmentOf(scored.node) as ImageAttachment] }
        : {}),
    };
    // Per-item wire overhead: the flat legacy estimate unless the caller
    // asked for wire-accurate accounting, in which case the id / score /
    // trust / source / timestamp / tags / separators / citation of the
    // target format are charged too.
    const overhead = itemWireOverheadTokens(
      item,
      wireFormat,
      tokenCounter,
      citations,
    );
    const tokenCount = contentTokens + summaryTokens + overhead;
    return {
      item,
      tokenCount,
      debloatSaved,
      contentTokens,
      summaryTokens,
      overhead,
    };
  });

  // Phase 2: dedup — skip items too similar to one already in the pack.
  //
  // Two complementary passes over the same candidate stream (sorted by
  // descending score, so the strongest item of any duplicate cluster is
  // always the survivor):
  //   a) Lexical (existing): token-set Jaccard >= dedupThreshold catches
  //      shared-vocabulary copies.
  //   b) Semantic (opt-in via `embeddings`): stored-vector cosine >=
  //      semanticDedupThreshold catches paraphrases with little lexical
  //      overlap. Vectors are passed in by the caller from data it already
  //      has in memory (hybrid search), so this adds zero embedding calls.
  //
  // Both passes are gated by `carriesDistinctFact`: a similarity score
  // alone is order-blind and value-blind, so it collapses an inverted
  // fact (source/destination swapped) or a changed number (pool size 20
  // vs 40) into its twin. The guard re-checks the discriminating tokens
  // before any drop, so the pack only ever discards genuine redundancy.
  const output: ContextPackItem[] = [];
  // Kept items' vectors plus their rendered text, so the semantic pass
  // can run the same discriminating-token guard the lexical pass uses
  // (a cosine score is as order-blind and value-blind as a Jaccard one).
  const outputVectors: Array<{
    id: string;
    vector: EmbeddingVector;
    content: string;
  }> = [];
  let tokensUsed = 0;
  let tokensSaved = 0;
  for (const preparedItem of prepared) {
    let { item, tokenCount, debloatSaved } = preparedItem; // eslint-disable-line prefer-const -- reassigned after compression
    // Pass a: lexical near-duplicate check.
    if (dedup) {
      let isDup = false;
      for (const existing of output) {
        if (
          jaccardSimilarity(item.content, existing.content) >= dedupThreshold &&
          !(
            dedupKeepIfDistinct &&
            carriesDistinctFact(item.content, existing.content)
          )
        ) {
          isDup = true;
          break;
        }
      }
      if (isDup) {
        // The entire item was dropped — count its tokens as saved.
        tokensSaved += tokenCount;
        continue;
      }
    }

    // Pass b: semantic paraphrase check (only when the caller supplied
    // vectors). Items without a vector can't be compared and stay in.
    if (embeddings) {
      const vector = embeddings.get(item.id);
      if (vector) {
        let isParaphrase = false;
        for (const kept of outputVectors) {
          if (
            cosineSimilarity(vector, kept.vector) >= semanticDedupThreshold &&
            !(
              dedupKeepIfDistinct &&
              carriesDistinctFact(item.content, kept.content)
            )
          ) {
            isParaphrase = true;
            break;
          }
        }
        if (isParaphrase) {
          tokensSaved += tokenCount;
          continue;
        }
      }
    }

    // Token budget check.
    //
    // An oversized item is not thrown away on the first miss: when
    // compression is enabled, the SAME item is re-rendered through
    // `compressText` and admitted if the compressed form fits. Only an
    // item that is still too big after compression is skipped — so a
    // tight budget loses a memory's filler, not the memory.
    let compressionSaved = 0;
    if (tokensUsed + tokenCount > tokenBudget && output.length > 0) {
      const shrunk = compressForBudget(preparedItem, {
        // Composition guard (audit finding 7f): an item already
        // rendered at a compressed fidelity level (L1 facts / L2
        // extractive summary) must not be stopword-filtered on top of
        // that loss — the connective tissue is what keeps the summary
        // answerable. L3 verbatim (or no fidelity at all) is the only
        // case where budget compression is a net win.
        enabled:
          compression?.enabled === true &&
          shouldCompressFidelityItem(item.fidelity),
        level: compression?.level ?? "light",
        tokenCounter,
        tokensUsed,
        tokenBudget,
      });
      if (!shrunk) continue;
      item = shrunk.item;
      tokenCount = shrunk.tokenCount;
      compressionSaved = shrunk.compressionSaved;
    }
    // Track savings from debloating (+ compression, when it ran).
    tokensSaved += debloatSaved + compressionSaved;
    output.push(item);
    tokensUsed += tokenCount;
    // Remember this item's vector for later semantic comparisons.
    const vector = embeddings?.get(item.id);
    if (vector)
      outputVectors.push({ id: item.id, vector, content: item.content });
  }

  // U-shape evidence ordering (lost-in-the-middle mitigation).
  //
  // Reader attention over long contexts is U-shaped: strongest at the
  // start and end, weakest in the middle (Liu et al. 2023). The most
  // useful position is first, the second-most is last — never a dumping
  // ground. `output` is a subsequence of `sorted` above (dedup and the
  // budget pass only ever REMOVE items), so it is still in score-desc /
  // node-id-tiebreak order: the first two entries are exactly best and
  // 2nd-best, no re-sort needed. With 0-2 items plain descending order
  // already satisfies best-first/2nd-last, so the list is left untouched.
  // Token counts are unaffected: this only permutes the final list.
  const ordered =
    output.length >= 3 ? [output[0], ...output.slice(2), output[1]] : output;

  // Memory-grounded citations: every rendered item gets a `[mem:xxxx]`
  // token, unique within the pack (git-style lengthening on collision).
  // Assigned AFTER ordering/trimming so tokens are unique among exactly
  // the items the consumer will see.
  if (citations) {
    const tokens = assignCitationTokens(ordered.map((item) => item.id));
    for (const item of ordered) {
      item.citation = tokens.get(item.id);
    }
  }

  // Item id -> source node, for fidelity verbatim-token accounting.
  const itemById = new Map(
    sorted.map((scored) => [scored.node.id, scored.node] as const),
  );

  return {
    schema: CONTEXT_PACK_SCHEMA,
    query,
    namespace,
    tokenBudget,
    items: ordered,
    tokensSaved,
    ...(lessons && lessons.length > 0 ? { lessons } : {}),
    // Fidelity metadata: contentTokens is what the packed contents cost
    // at the resolved level; verbatimTokens is what the same items would
    // have cost at L3. Absent unless the pack was built with `fidelity`.
    ...(resolvedLevel !== undefined
      ? {
          fidelity: {
            level: resolvedLevel,
            adaptive: fidelityAdaptive,
            contentTokens: ordered.reduce(
              (sum, item) => sum + tokenCounter(item.content),
              0,
            ),
            verbatimTokens: ordered.reduce((sum, item) => {
              const node = itemById.get(item.id);
              return (
                sum + tokenCounter(node ? levelText(node, "L3") : item.content)
              );
            }, 0),
          } satisfies ContextPackFidelityMeta,
        }
      : {}),
  };
}

/**
 * Serialize a ContextPack to TOON (Token-Optimized Object Notation).
 *
 * TOON is a compact, human-readable alternative to JSON for highly
 * structured data. Each line is a pipe-delimited record with a stable
 * field order: `id|score|trust|source|updatedAt|content|tags`.
 *
 * Format:
 *   # ai-trio.memos.context-pack.v1
 *   # toon:pipe-delimited|q=<query>|n=<namespace>|b=<tokenBudget>|s=<tokensSaved>
 *   # fields: id|score|trust|source|updatedAt|tags|content
 *   mem_abc123|0.95|local|user_input|2026-06-18T12:00:00Z|user;preference|User likes dark mode
 *   mem_def456|0.87|local|user_input|2026-06-18T11:30:00Z|work|User works at Google
 *   # q=<query>
 *
 * The trailer line repeats the query AFTER the evidence block (the header
 * already states it BEFORE) — a reader scanning bottom-up re-anchors on
 * the query. It is a `#` comment line, so line-based consumers skip it.
 *
 * Token savings vs JSON: 60-90% on typical context packs (where JSON
 * overhead like braces, quotes, and field names dominate).
 *
 * Fidelity: when the pack was built with the `fidelity` option, a
 * `# fidelity=<level>` header line is emitted so the rendered level is
 * visible (and cacheable) in the serialized form.
 *
 * @param pack — The ContextPack to serialize.
 * @returns A TOON-formatted string.
 */
export function packToToon(pack: ContextPack): string {
  const lines: string[] = [];
  // Header lines (start with # so consumers can skip them)
  lines.push(`# ${pack.schema}`);
  lines.push(
    `# toon:pipe-delimited|q=${pack.query}|n=${pack.namespace}|b=${pack.tokenBudget}|s=${pack.tokensSaved}`,
  );
  lines.push("# fields: id|score|trust|source|updatedAt|tags|content");
  // Fidelity header: records the level item contents were rendered at
  // (cache-prefix stability — the layout only ever grows this line when
  // the pack was actually built with `fidelity`).
  if (pack.fidelity) {
    lines.push(`# fidelity=${pack.fidelity.level}`);
  }
  for (const item of pack.items) {
    // Escape pipe characters in content by replacing with ¦
    const safeContent = item.content.replace(/\|/g, "¦").replace(/\n/g, " ");
    const safeTags = item.tags.join(";");
    // Citation tokens render ahead of the content (not as a new field —
    // the pipe layout stays fixed so existing line parsers keep working).
    const cited = item.citation
      ? `${item.citation} ${safeContent}`
      : safeContent;
    // Image references render TRAILING the content, for the same reason:
    // adding an 8th column would break every existing parser, and the
    // code documents that the fixed layout is what keeps provider prompt
    // caches warm. A consumer that cares parses the token out; one that
    // doesn't ignores it.
    const withImages = cited + imageRefSuffix(item);
    lines.push(
      `${item.id}|${item.score.toFixed(3)}|${item.trust}|${item.source}|${item.updatedAt}|${safeTags}|${withImages}`,
    );
  }
  // Query trailer: repeat the query after the evidence block (see the
  // docstring). Always emitted — fixed layout keeps cache prefixes stable.
  lines.push(`# q=${pack.query}`);
  // Operating-instructions section: procedural lessons ride after the
  // trailer as comment lines, so line-based TOON consumers skip them
  // unless they opt into lessons.
  appendLessonsSection(lines, pack.lessons);
  return lines.join("\n");
}

/**
 * The `[img:<ref>]` suffix appended to a TOON row for an image item.
 *
 * Deliberately NOT a new column: the pipe layout is documented as fixed
 * so provider prompt caches stay warm, and an 8th column would break
 * every existing parser. A consumer that cares parses the token out;
 * one that doesn't ignores it. Returns "" for text items, so a
 * text-only pack renders byte-identically to before.
 */
function imageRefSuffix(item: { images?: ImageAttachment[] }): string {
  if (!item.images || item.images.length === 0) return "";
  return item.images.map((image) => ` [img:${image.ref}]`).join("");
}

/** Compact-wire variant of {@link imageRefSuffix} (same token, same position). */
function compactImageRefSuffix(images: ImageAttachment[] | undefined): string {
  return imageRefSuffix({ images });
}

/**
 * Every `[img:<ref>]` / `[image:<ref>]` token in a text block.
 *
 * Used by the budget-compression guard to verify a compressed caption
 * still carries its image reference. Mirrors the pinning regex in
 * `compression.ts` — the two must stay in lockstep, since one pins the
 * tokens and the other proves they survived.
 */
function imageRefsIn(text: string): string[] {
  return text.match(/\[(?:img|image):[A-Za-z0-9_-]{4,}\]/g) ?? [];
}

/**
 * Append the procedural-lessons "operating instructions" section to a
 * verbose-TOON line buffer. Lessons render as `#`-comment lines so
 * existing parsers ignore them; each carries its own `[lesson:…]`
 * token for stable reference.
 */
function appendLessonsSection(
  lines: string[],
  lessons: ProceduralLesson[] | undefined,
): void {
  if (!lessons || lessons.length === 0) return;
  lines.push("# operating-instructions: learned lessons");
  for (const lesson of lessons) {
    const text = lesson.lesson.replace(/\|/g, "¦").replace(/\n/g, " ");
    const context = lesson.context
      ? ` (when: ${lesson.context.replace(/\|/g, "¦").replace(/\n/g, " ")})`
      : "";
    lines.push(
      `# - ${lessonCitationToken(lesson.id)} ${text}${context} [score ${lesson.score.toFixed(2)}, ${lesson.useCount} uses]`,
    );
  }
}

/**
 * Serialize an array of ScoredMemory to TOON (Token-Optimized Object Notation).
 *
 * @param results — Array of scored memories from a search.
 * @returns A TOON-formatted string.
 */
export function searchResultsToToon(results: ScoredMemory[]): string {
  const lines: string[] = [];
  lines.push("# memos.search.v1");
  lines.push("# toon:pipe-delimited");
  lines.push("# fields: id|score|trust|source|updatedAt|tags|content");
  for (const r of results) {
    const safeContent = r.node.content.replace(/\|/g, "¦").replace(/\n/g, " ");
    const safeTags = r.node.tags.join(";");
    lines.push(
      `${r.node.id}|${r.score.toFixed(3)}|${r.node.source}|${r.node.source}|${new Date(r.node.updatedAt).toISOString()}|${safeTags}|${safeContent}`,
    );
  }
  return lines.join("\n");
}

/**
 * Serialize a ContextPack in the requested format.
 *
 * @param pack — The ContextPack to serialize.
 * @param format — "json" returns the pack object as-is.
 *   "toon" returns verbose pipe-delimited.
 *   "toon-compact" returns ultra-compact pipe-delimited.
 * @param tokenCounter — Optional custom token counter for budget
 *   enforcement in compact mode.
 * @param maxTokens — Optional hard ceiling on the rendered token count,
 *   honoured by the compact TOON serializer (`packToToonCompact`). Ignored
 *   for "json" (an object has no length to trim) and "toon".
 * @returns The pack object (for json) or a string (for toon formats).
 */
export function serializeContextPack(
  pack: ContextPack,
  format: "json" | "toon" | "toon-compact",
  tokenCounter?: (text: string) => number,
  maxTokens?: number,
): ContextPack | string {
  if (format === "toon-compact") {
    return packToToonCompact(pack, tokenCounter, maxTokens);
  }
  if (format === "toon") {
    return packToToon(pack);
  }
  return pack;
}

// ---------------------------------------------------------------------------
// Compact TOON serialization (v2 wire format)
// ---------------------------------------------------------------------------

/**
 * Single-char codes for memory source (provenance).
 */
const SOURCE_CODE: Record<string, string> = {
  user_input: "ui",
  agent_inferred: "ai",
  external_data: "ex",
  system: "sy",
};

/** Reverse map: code -> source name. */
const CODE_SOURCE: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_CODE).map(([name, code]) => [code, name]),
);

/**
 * Alphabet for compact ID encoding: base64url characters. `~` is reserved
 * as the marker/escape character, so it never appears in encoded bodies.
 */
const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Losslessly shorten a memory ID for the wire.
 *
 * Canonical dashed UUIDs are re-packed as base64url under a `~` marker
 * (36 chars -> 24). Other pure-hex even-length IDs (except 32-hex, which
 * would be indistinguishable from UUID bodies on decode) are packed the
 * same way. Any other shape passes through unchanged; a literal leading
 * `~` is escaped as `~~` so the decoder can always tell encoded from raw.
 *
 * Decode rule: a decoded hex body of exactly 32 chars is re-dashed to the
 * canonical 8-4-4-4-12 UUID form; anything shorter stays plain hex. That
 * is why bare 32-hex IDs are excluded from encoding above.
 */
export function encodeCompactId(id: string): string {
  if (id.startsWith("~")) return `~${id}`;
  const dashedUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const plainHex =
    !dashedUuid &&
    /^[0-9a-f]+$/i.test(id) &&
    id.length % 2 === 0 &&
    id.length >= 2 &&
    id.length !== 32;
  if (!dashedUuid && !plainHex) return id;

  const hex = id.replace(/-/g, "").toLowerCase();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ID_ALPHABET[(acc >> bits) & 63];
    }
  }
  if (bits > 0) out += ID_ALPHABET[(acc << (6 - bits)) & 63];
  return `~${out}`;
}

/**
 * Inverse of {@link encodeCompactId}. Unknown shapes are returned as-is so
 * hand-written or foreign IDs survive untouched.
 */
export function decodeCompactId(wire: string): string {
  if (wire.startsWith("~~")) return wire.slice(1);
  if (!wire.startsWith("~")) return wire;
  const body = wire.slice(1);
  let bits = 0;
  let acc = 0;
  const bytes: number[] = [];
  for (const ch of body) {
    const val = ID_ALPHABET.indexOf(ch);
    if (val < 0) return wire; // not our encoding — treat as raw
    acc = (acc << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  // 32-hex bodies came from canonical dashed UUIDs — restore the dashes.
  if (hex.length === 32) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return hex;
}

/**
 * Parse a `k=v` header parameter, returning `fallback` when absent.
 * Values may not contain `|` (the header field separator).
 */
function headerParam(line: string, key: string, fallback: string): string {
  for (const part of line.split("|")) {
    if (part.startsWith(`${key}=`)) return part.slice(key.length + 1);
  }
  return fallback;
}

/**
 * Serialize a ContextPack to ultra-compact TOON format (v2).
 *
 * Layout:
 *   # memos.search.v2|e=<minEpoch>|t=<tagDict>
 *   # f=~id|s|t|c|e|g|ct
 *   ~Ab3xZ9|950|9|ui|-86400|0;2|User likes dark mode
 *   # q=<query>                <- pack path only: query trailer for
 *                                 bottom-up readers; skipped by the parser
 *
 * Optimizations vs the v1 compact format:
 *   1. IDs: pure-hex IDs (incl. dashed UUIDs) re-packed to base64url with a
 *      `~` prefix (36-char UUID -> 24 chars); other shapes pass through.
 *   2. Timestamps: delta-encoded from a header epoch anchor `e=` (rows with
 *      the smallest timestamp store 0).
 *   3. Tags: a per-call dictionary in the header (`t=a,b,c`), rows reference
 *      tags by index; falls back to literal tags when the dictionary is not
 *      a net win.
 *   4. Carried over from v1: integer scores (x1000), 0-9 trust digit,
 *      2-char source codes, single-char field legend.
 *
 * Round-trip: `parseToonCompact` restores the original IDs (dashed UUIDs
 * re-dashed), absolute timestamps, and tag names exactly.
 *
 * @param pack — The ContextPack to serialize.
 * @param tokenCounter — Optional custom token counter. Used only when
 *   `maxTokens` is set, to measure the rendered wire cost.
 * @param maxTokens — Optional hard ceiling on the rendered token count.
 *   When the full pack exceeds it, the items are first re-rendered through
 *   `compressText` and re-checked: if the compressed pack fits, it is
 *   returned whole — COMPRESS BEFORE DROP. Only when compression is not
 *   enough are items dropped lowest-score-first until the output fits, and
 *   those drops are taken from the ALREADY compressed set, so no fact is
 *   ever discarded before it has been given the chance to fit. Trimming is
 *   by SCORE, not by list position, so the U-shape pin (second-best item,
 *   pinned last) is never the first casualty. If even the single best item
 *   is over budget it is still emitted — an over-budget answer carrying
 *   the top fact beats an empty evidence block. Omitted (the default)
 *   serializes the whole pack, exactly as before.
 * @returns A compact TOON-formatted string.
 */
export function packToToonCompact(
  pack: ContextPack,
  tokenCounter?: (text: string) => number,
  maxTokens?: number,
): string {
  const render = (items: ContextPackItem[]): string => {
    const body = serializeCompactRows(
      items.map((item) => ({
        id: item.id,
        citation: item.citation,
        score: item.score,
        trustScore: item.trustScore ?? 0.5,
        source: item.nodeSource ?? item.source,
        updatedAtMs: new Date(item.updatedAt).getTime(),
        tags: item.tags,
        content: item.content,
        fidelity: item.fidelity,
        images: item.images,
      })),
    );
    // Prepend the pack envelope (schema/query/namespace/budget) as a header
    // line so the pack path keeps its provenance. The search-result path
    // omits it — nothing to say there.
    // The fidelity level rides in the envelope as `f=<level>` when the pack
    // was built with the `fidelity` option — so the wire form carries the
    // level without a schema bump.
    const fidelityParam = pack.fidelity ? `|f=${pack.fidelity.level}` : "";
    const envelope =
      `# ${CONTEXT_PACK_SCHEMA}|q=${pack.query}|n=${pack.namespace}` +
      `|b=${pack.tokenBudget}|s=${pack.tokensSaved}${fidelityParam}`;
    // Query trailer: repeat the query AFTER the evidence block (the envelope
    // already states it BEFORE) — a reader scanning bottom-up re-anchors on
    // the query. A `#` comment line, so `parseToonCompact` skips it.
    const trailer = `# q=${pack.query}`;
    // Lessons ride as `#` comment lines after the trailer — the compact
    // parser skips every `#` line, so the wire format stays parse-stable.
    const lessonLines: string[] = [];
    for (const lesson of pack.lessons ?? []) {
      const text = lesson.lesson.replace(/\|/g, "¦").replace(/\n/g, " ");
      lessonLines.push(
        `# L|${lessonCitationToken(lesson.id)}|${lesson.score.toFixed(2)}|${text}`,
      );
    }
    return [`${envelope}\n${body}\n${trailer}`, ...lessonLines].join("\n");
  };

  const full = render(pack.items);
  // No budget asked for (or nothing to trim): byte-identical to the
  // pre-budget serializer.
  if (maxTokens === undefined || !(maxTokens > 0)) return full;
  const counter = tokenCounter ?? estimateTokens;
  if (counter(full) <= maxTokens) return full;

  // COMPRESS BEFORE DROP (audit finding 7g).
  //
  // Trimming used to be score-only: the moment the full pack was over
  // budget, the lowest-scored items were discarded whole. Under budget
  // pressure the tail is exactly where the specific facts live, so the
  // pack lost whole memories when their filler alone was enough to
  // reclaim the space.
  //
  // First try shrinking every item through `compressText` and see whether
  // that alone brings the pack under budget. Only when it does not does
  // the score-based trim below run — and it then runs over the ALREADY
  // compressed items, so dropping an item means dropping a fact that
  // could not be made to fit, not a fact that was never compressed.
  //
  // `compressText` is a no-op on code-like and already-terse text, so
  // this is free (one render) whenever compression cannot help.
  const compressedItems = pack.items.map((item) => ({
    ...item,
    content: compressText(item.content, "light"),
  }));
  // `render` charges a row for its content, so a candidate is only
  // compared once it carries the bytes it will actually be measured at.
  const trimmedOperand =
    counter(render(compressedItems)) < counter(full)
      ? compressedItems
      : pack.items;
  const compressed = render(trimmedOperand);
  if (counter(compressed) <= maxTokens) return compressed;

  // Trim by score: keep the top-k items and drop the rest, then re-render
  // in the pack's own (U-shape) order. Trimming by score rather than by
  // position matters because `buildContextPack` pins the second-best item
  // LAST (lost-in-the-middle mitigation) — cutting from the tail would
  // throw away the runner-up before the mid-list filler.
  //
  // The operand is the compressed set: a compressed item is preferred
  // over a dropped one at every k. It is `pack.items` unchanged when
  // compression cannot shrink this pack's text at all, so a terse pack
  // trims exactly as it did before.
  const trimmable = trimmedOperand;
  const byScore = trimmable
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index);
  const keepCount = (k: number): Set<number> =>
    new Set(byScore.slice(0, k).map((entry) => entry.index));

  let best: string | null = null;
  for (let k = trimmable.length - 1; k >= 1; k -= 1) {
    const keep = keepCount(k);
    const candidate = render(trimmable.filter((_, i) => keep.has(i)));
    if (counter(candidate) <= maxTokens) return candidate;
    best = candidate;
  }
  // Even the top item is over budget. Emitting the best fact anyway beats
  // emitting an empty evidence block; the caller can tighten the pack
  // itself if it prefers silence.
  return best ?? compressed;
}

/**
 * Serialize search results to compact TOON format (v2). See
 * {@link packToToonCompact} for the wire layout.
 */
export function searchResultsToToonCompact(results: ScoredMemory[]): string {
  return serializeCompactRows(
    results.map((r) => ({
      id: r.node.id,
      score: r.score,
      trustScore: r.node.trustScore ?? 0.5,
      source: r.node.source,
      updatedAtMs: r.node.updatedAt,
      tags: r.node.tags,
      content: r.node.content,
    })),
  );
}

/** Field-normalized row shape shared by both compact serializers. */
interface CompactRow {
  id: string;
  /** Rendered ahead of the content when the pack was built with citations. */
  citation?: string;
  score: number;
  trustScore: number;
  source: string;
  updatedAtMs: number;
  tags: string[];
  content: string;
  /**
   * Fidelity level the content was rendered at. Only pack rows carry it
   * (search-result rows never do), and only when the pack was built
   * with the `fidelity` option — otherwise the row keeps its legacy
   * 7-field shape.
   */
  fidelity?: FidelityLevel;
  /**
   * Image attachments whose refs render trailing the content. Only pack
   * rows carry them, and only when the pack was built with images —
   * text-only rows keep their exact legacy shape.
   */
  images?: ImageAttachment[];
}

/**
 * Core v2 compact serializer shared by pack and search-result entry points.
 *
 * Two-pass: pass 1 collects the epoch anchor and tag dictionary, pass 2
 * emits rows. The tag dictionary is only used when the header cost is
 * smaller than the per-row savings (otherwise rows carry literal tags).
 */
function serializeCompactRows(rows: CompactRow[]): string {
  const lines: string[] = [];

  if (rows.length === 0) {
    lines.push("# memos.search.v2");
    lines.push("# f=~id|s|t|c|e|g|ct");
    return lines.join("\n");
  }

  // --- Pass 1: anchors -----------------------------------------------------
  const minEpoch = Math.min(
    ...rows.map((r) => Math.floor(r.updatedAtMs / 1000)),
  );
  const tagCounts = new Map<string, number>();
  let tagTotalChars = 0;
  for (const r of rows) {
    for (const tag of r.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      tagTotalChars += tag.length;
    }
  }
  const distinctTags = [...tagCounts.keys()];
  const dictChars = distinctTags.reduce((n, t) => n + t.length + 1, 0);
  // Honest cost comparison: the ";" separators between tags exist on BOTH
  // paths (rows join tags with ";" regardless), so they cancel out. What
  // differs is the payload per occurrence — a decimal index under the
  // dictionary vs the literal tag text — plus the one-time header cost of
  // the dictionary itself.
  // Never use the dictionary when a tag is all-digits: numeric row fields
  // would be ambiguous with dictionary indices on decode.
  const hasNumericTag = distinctTags.some((t) => /^[0-9]+$/.test(t));
  let withDictCost = dictChars;
  let withoutDictCost = 0;
  for (const [tag, count] of tagCounts) {
    withDictCost += count * String(distinctTags.indexOf(tag)).length;
    withoutDictCost += count * tag.length;
  }
  const dictWins =
    distinctTags.length > 0 && !hasNumericTag && withDictCost < withoutDictCost;

  // --- Header --------------------------------------------------------------
  const header = ["# memos.search.v2"];
  header.push(`e=${minEpoch}`);
  if (dictWins) header.push(`t=${distinctTags.join(",")}`);
  lines.push(header.join("|"));
  lines.push("# f=~id|s|t|c|e|g|ct");

  // --- Pass 2: rows --------------------------------------------------------
  const tagIndex = dictWins
    ? new Map(distinctTags.map((t, i) => [t, i]))
    : null;
  for (const r of rows) {
    const safeContent = r.content.replace(/\|/g, "¦").replace(/\n/g, " ");
    // Citation token renders inside the content field — the pipe layout
    // (and therefore the parser) is untouched.
    const cited = r.citation ? `${r.citation} ${safeContent}` : safeContent;
    // Image refs render TRAILING the content for the same reason: no new
    // column, so the fixed layout (and provider prompt caches) hold.
    const withImages = cited + compactImageRefSuffix(r.images);
    const scoreInt = Math.round(r.score * 1000);
    const srcCode = SOURCE_CODE[r.source] ?? r.source;
    const trustCode = Math.round(r.trustScore * 9);
    const epochDelta = Math.floor(r.updatedAtMs / 1000) - minEpoch;
    // IDs go on the wire verbatim (packed when hex/UUID-shaped). No prefix
    // is stripped or assumed — real storage IDs are bare dashed UUIDs.
    const shortId = encodeCompactId(r.id);
    const safeTags = tagIndex
      ? r.tags.map((t) => String(tagIndex.get(t) ?? t)).join(";")
      : r.tags.join(";");
    // Optional 8th field: the fidelity level the row's content was
    // rendered at. Only pack rows carry it (search-result rows never do),
    // and only when the pack was built with `fidelity`.
    const fidelityField = r.fidelity ? [r.fidelity] : [];
    lines.push(
      [
        shortId,
        scoreInt,
        trustCode,
        srcCode,
        epochDelta,
        safeTags,
        withImages,
        ...fidelityField,
      ].join("|"),
    );
  }

  return lines.join("\n");
}

/**
 * Decode a v2 (or v1) compact TOON string back into ContextPackItem objects.
 *
 * v2 headers carry an epoch anchor (`e=`) and optional tag dictionary
 * (`t=`); rows reference tags by index when the dictionary is present.
 * v1 strings (no `e=` in the header) keep their absolute-epoch semantics.
 *
 * All `#` comment lines are skipped — including the query trailer
 * (`# q=<query>`) that pack serializers append after the last evidence
 * row, so packs round-trip with the trailer intact-but-ignored.
 *
 * @param toon — The compact TOON string (header lines are skipped).
 * @returns Array of decoded ContextPackItem objects.
 */
export function parseToonCompact(toon: string): ContextPackItem[] {
  const items: ContextPackItem[] = [];
  const lines = toon.split("\n");
  const header = lines.find((l) => l.startsWith("# memos.search."));
  const isV2 = header?.includes(".v2") ?? false;
  const epochAnchor =
    isV2 && header ? parseInt(headerParam(header, "e", "0"), 10) : null;
  const tagDict =
    isV2 && header && header.includes("t=")
      ? headerParam(header, "t", "").split(",").filter(Boolean)
      : null;
  const dataLines = lines.filter((l) => l && !l.startsWith("#"));

  for (const line of dataLines) {
    const parts = line.split("|");
    if (parts.length < 7) continue;

    // Optional 8th field: fidelity level (pack rows built with the
    // `fidelity` option). Legacy 7-field rows parse unchanged. The last
    // field is only treated as fidelity when it exactly matches a known
    // level, so content containing raw pipes is never misread.
    const [id, scoreInt, trustCode, srcCode, ts, tags, ...rest] = parts;
    const fidelityLevels = new Set(["L0", "L1", "L2", "L3"]);
    const lastField = rest[rest.length - 1];
    const fidelity =
      rest.length > 1 && lastField && fidelityLevels.has(lastField)
        ? (lastField as FidelityLevel)
        : undefined;
    const content =
      fidelity !== undefined ? rest.slice(0, -1).join("|") : rest.join("|");

    // Reverse source code mapping.
    const source = CODE_SOURCE[srcCode] ?? srcCode;

    // Timestamps: v2 deltas are relative to the header anchor.
    const epoch =
      epochAnchor !== null ? epochAnchor + parseInt(ts, 10) : parseInt(ts, 10);

    // Tags: numeric fields resolve through the header dictionary.
    const resolvedTags = (tags ? tags.split(";") : []).map((t) => {
      if (tagDict && /^[0-9]+$/.test(t)) {
        return tagDict[parseInt(t, 10)] ?? t;
      }
      return t;
    });

    // v2 IDs are verbatim: decode and use as-is. The v1 format stripped a
    // "mem_" prefix on serialize, so the legacy decode path restores it.
    const rawId = decodeCompactId(id);
    const item: ContextPackItem = {
      id: isV2 ? rawId : rawId.startsWith("mem_") ? rawId : `mem_${rawId}`,
      content,
      summary: null,
      score: parseInt(scoreInt, 10) / 1000,
      scores: {},
      trust: String(Math.round((parseInt(trustCode, 10) / 9) * 100) / 100),
      source,
      // Populate per-node fields for compact encoding round-trip
      trustScore: parseInt(trustCode, 10) / 9,
      nodeSource: source,
      tags: resolvedTags,
      updatedAt: new Date(epoch * 1000).toISOString(),
      ...(fidelity !== undefined && { fidelity }),
    };
    items.push(item);
  }

  return items;
}
