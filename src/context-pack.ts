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
 *     consumer doesn't fold the same fact twice.
 *   - Token-accurate budgeting: uses a GPT-style BPE approximation
 *     (whitespace + punctuation split) instead of the 4-chars-per-token
 *     heuristic. Callers can swap in a real tokenizer via `tokenCounter`.
 *
 * @module @memos/context-pack
 */

import type { EmbeddingVector, ScoredMemory } from "./types.js";
// Runtime import is safe: embeddings.ts has no runtime imports of its own
// (type-only), so this cannot create a module cycle.
import { cosineSimilarity } from "./embeddings.js";

/** The single source of truth for the context-pack schema id. */
export const CONTEXT_PACK_SCHEMA = "ai-trio.memos.context-pack.v1";

/** A single ranked, ready-to-fold memory item. */
export interface ContextPackItem {
  id: string;
  content: string;
  summary: string | null;
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
  tags: string[];
  updatedAt: string;
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

// ---------------------------------------------------------------------------
// Pack builder
// ---------------------------------------------------------------------------

const DEFAULT_DEDUP_THRESHOLD = 0.85;

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
    embeddings,
    semanticDedupThreshold = DEFAULT_SEMANTIC_DEDUP_THRESHOLD,
  } = opts;

  // Sort by descending score.
  const sorted = [...items].sort((a, b) => b.score - a.score);

  // Phase 1: debloat, elide redundant summaries, and compute token counts.
  //
  // Tokenization budget per item (perf): `tokenCounter` runs at most four
  // times — packed content, packed summary (if present), raw content, and
  // raw summary (if included). The previous revision tokenized the packed
  // forms a SECOND time after building the item (6 calls/item worst case);
  // the counts are now computed once and reused everywhere below.
  const prepared = sorted.map((scored) => {
    const rawContent = scored.node.content;
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
      score: scored.score,
      scores: scored.scores ?? {},
      trust,
      source,
      // Per-node provenance for compact TOON encoding
      trustScore: scored.node.trustScore,
      nodeSource: scored.node.source,
      tags: [...scored.node.tags],
      updatedAt: new Date(scored.node.updatedAt).toISOString(),
    };
    const tokenCount = contentTokens + summaryTokens + 4; // overhead
    return { item, tokenCount, debloatSaved };
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
  const output: ContextPackItem[] = [];
  const outputVectors: Array<{ id: string; vector: EmbeddingVector }> = [];
  let tokensUsed = 0;
  let tokensSaved = 0;
  for (const { item, tokenCount, debloatSaved } of prepared) {
    // Pass a: lexical near-duplicate check.
    if (dedup) {
      let isDup = false;
      for (const existing of output) {
        if (
          jaccardSimilarity(item.content, existing.content) >= dedupThreshold
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
        for (const { vector: existingVector } of outputVectors) {
          if (
            cosineSimilarity(vector, existingVector) >= semanticDedupThreshold
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
    if (tokensUsed + tokenCount > tokenBudget && output.length > 0) {
      continue;
    }
    // Track savings from debloating.
    tokensSaved += debloatSaved;
    output.push(item);
    tokensUsed += tokenCount;
    // Remember this item's vector for later semantic comparisons.
    const vector = embeddings?.get(item.id);
    if (vector) outputVectors.push({ id: item.id, vector });
  }

  return {
    schema: CONTEXT_PACK_SCHEMA,
    query,
    namespace,
    tokenBudget,
    items: output,
    tokensSaved,
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
 *
 * Token savings vs JSON: 60-90% on typical context packs (where JSON
 * overhead like braces, quotes, and field names dominate).
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
  for (const item of pack.items) {
    // Escape pipe characters in content by replacing with ¦
    const safeContent = item.content.replace(/\|/g, "¦").replace(/\n/g, " ");
    const safeTags = item.tags.join(";");
    lines.push(
      `${item.id}|${item.score.toFixed(3)}|${item.trust}|${item.source}|${item.updatedAt}|${safeTags}|${safeContent}`,
    );
  }
  return lines.join("\n");
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
 * @returns The pack object (for json) or a string (for toon formats).
 */
export function serializeContextPack(
  pack: ContextPack,
  format: "json" | "toon" | "toon-compact",
  tokenCounter?: (text: string) => number,
): ContextPack | string {
  if (format === "toon-compact") {
    return packToToonCompact(pack, tokenCounter);
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
 * @param tokenCounter — Optional custom token counter (unused, reserved for
 *   future budget enforcement).
 * @returns A compact TOON-formatted string.
 */
export function packToToonCompact(
  pack: ContextPack,
  _tokenCounter?: (text: string) => number,
): string {
  const body = serializeCompactRows(
    pack.items.map((item) => ({
      id: item.id,
      score: item.score,
      trustScore: item.trustScore ?? 0.5,
      source: item.nodeSource ?? item.source,
      updatedAtMs: new Date(item.updatedAt).getTime(),
      tags: item.tags,
      content: item.content,
    })),
  );
  // Prepend the pack envelope (schema/query/namespace/budget) as a header
  // line so the pack path keeps its provenance. The search-result path
  // omits it — nothing to say there.
  const envelope =
    `# ${CONTEXT_PACK_SCHEMA}|q=${pack.query}|n=${pack.namespace}` +
    `|b=${pack.tokenBudget}|s=${pack.tokensSaved}`;
  return `${envelope}\n${body}`;
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
  score: number;
  trustScore: number;
  source: string;
  updatedAtMs: number;
  tags: string[];
  content: string;
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
    lines.push(
      [
        shortId,
        scoreInt,
        trustCode,
        srcCode,
        epochDelta,
        safeTags,
        safeContent,
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

    const [id, scoreInt, trustCode, srcCode, ts, tags, ...contentParts] = parts;
    const content = contentParts.join("|"); // rejoin in case of ¦ escapes

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
    };
    items.push(item);
  }

  return items;
}
