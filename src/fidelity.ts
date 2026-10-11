/**
 * Fidelity-level compaction (L0–L3) + query-adaptive level-aware retrieval.
 *
 * Every memory exists at four fidelity levels:
 *   - L0: tags + entities only (~tens of tokens). Derived free from the
 *         existing entity index/tags — nothing is stored.
 *   - L1: typed facts — short structured statements extracted at write /
 *         consolidation time. Deterministic and template-based (no LLM):
 *         entity-bearing sentences from the existing extraction pipeline
 *         (`extractQueryEntities` + `canonicalizeEntities`), prefixed with
 *         the memory's type.
 *   - L2: extractive summary — sentence selection by centrality
 *         (TextRank-lite over sentence word-overlap, no LLM). A future
 *         sleep-time LLM pass may upgrade it to abstractive; the
 *         extractive path always works with zero LLM.
 *   - L3: verbatim full text (the existing `content`).
 *
 * The retriever picks the CHEAPEST level that satisfies the query instead
 * of always returning verbatim: `routeFidelity()` chooses a starting level
 * from cheap local signals (entity density, query shape, length), and
 * `MemOS.recall()` escalates L0→L1→L2→L3 within the same call when the
 * result set looks insufficient — up to a caller-specified `maxFidelity`.
 *
 * Why this is novel: OpenViking ships fixed tiered loading (L0→L1→L2
 * ladder) but requires LLM/VLM + embeddings and is filesystem-based with
 * a static ladder; MemPalace's L0–L3 is a fixed wake-up loader. This is
 * zero-LLM, SQLite, per-query adaptive fidelity selection with in-call
 * escalation.
 *
 * Level persistence: L1/L2 are generated at write time (`MemOS.store`)
 * and cached in the reserved `metadata.fidelity` slot (`{ v, l1, l2 }`)
 * so they travel with the node on every storage adapter with zero schema
 * migration. `MemOS.compact()` backfills pre-existing memories eagerly;
 * reads also generate lazily when the cache is missing (fail-soft, no
 * writes on the hot path).
 *
 * Default-behavior contract: every public API defaults to L3-equivalent
 * output (verbatim), so existing tests and consumers see byte-identical
 * behavior unless they opt into `fidelity: "adaptive"` or a fixed lower
 * level. Adaptive is opt-in because level selection changes *which text*
 * is returned, and that must be a deliberate caller choice.
 *
 * @module @memos/fidelity
 */

import type { MemoryNode, MemoryType, SearchFilter } from "./types.js";
import {
  BUILTIN_ENTITY_ALIASES,
  canonicalizeEntities,
  extractQueryEntities,
} from "./entity-extraction.js";

// ---------------------------------------------------------------------------
// Level definitions
// ---------------------------------------------------------------------------

/** Fidelity levels, cheapest first. */
export type FidelityLevel = "L0" | "L1" | "L2" | "L3";

/** Ordered levels for escalation loops. */
export const FIDELITY_LEVELS: readonly FidelityLevel[] = [
  "L0",
  "L1",
  "L2",
  "L3",
];

/** Human-readable label per level (CLI/docs). */
export const FIDELITY_LEVEL_LABELS: Record<FidelityLevel, string> = {
  L0: "tags + entities",
  L1: "typed facts",
  L2: "extractive summary",
  L3: "verbatim",
};

/** One-line description per level (CLI/docs). */
export const FIDELITY_LEVEL_DESCRIPTIONS: Record<FidelityLevel, string> = {
  L0: "Tags and extracted entities only — free, derived from the entity index.",
  L1: "Short typed fact statements ([type] sentence), template-extracted at write time.",
  L2: "Extractive summary: top sentences by TextRank-lite centrality.",
  L3: "Full verbatim content — the pre-fidelity default.",
};

/** Numeric rank for ordering/clamping. */
const LEVEL_RANK: Record<FidelityLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
};

/** Next level up, or null at the top. */
export function nextFidelityLevel(level: FidelityLevel): FidelityLevel | null {
  const idx = LEVEL_RANK[level];
  return idx < FIDELITY_LEVELS.length - 1 ? FIDELITY_LEVELS[idx + 1]! : null;
}

/** Clamp a level to at most `max` (escalation ceiling). */
export function clampFidelityLevel(
  level: FidelityLevel,
  max: FidelityLevel,
): FidelityLevel {
  return LEVEL_RANK[level] <= LEVEL_RANK[max] ? level : max;
}

/** Parse a user-supplied level string; null when invalid. */
export function parseFidelityLevel(value: string): FidelityLevel | null {
  const upper = value.trim().toUpperCase();
  return (FIDELITY_LEVELS as readonly string[]).includes(upper)
    ? (upper as FidelityLevel)
    : null;
}

// ---------------------------------------------------------------------------
// Sentence utilities
// ---------------------------------------------------------------------------

/** Small stopword set for sentence scoring (independent of other modules). */
const FIDELITY_STOPWORDS = new Set([
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
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "and",
  "but",
  "or",
  "not",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
]);

/**
 * Split text into sentences. Newlines become spaces; splits on `.`/`!`/`?`
 * followed by whitespace (lookbehind keeps the terminator). Deterministic.
 */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Lowercase word tokens for scoring (len >= 2, stopwords removed). */
function contentWords(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !FIDELITY_STOPWORDS.has(w));
}

// ---------------------------------------------------------------------------
// L0 — tags + entities (free derivation)
// ---------------------------------------------------------------------------

/** Stored entities on a node (`metadata.entities`), lowercased + deduped. */
export function nodeEntities(node: MemoryNode): string[] {
  const raw = node.metadata?.entities;
  const out: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const s = String(e).toLowerCase().trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * L0 text: tags and entities only. Derived free from the existing entity
 * index/tags — nothing is generated or stored. Returns "" when the memory
 * has neither (such memories can only be reached at L1+).
 */
export function fidelityL0(node: MemoryNode): string {
  const parts: string[] = [];
  const tags = (node.tags ?? []).map((t) => String(t).trim()).filter(Boolean);
  if (tags.length > 0) parts.push(`tags: ${tags.join(", ")}`);
  const entities = nodeEntities(node);
  if (entities.length > 0) parts.push(`entities: ${entities.join(", ")}`);
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// L1 — typed facts (deterministic, template-based, no LLM)
// ---------------------------------------------------------------------------

/** Max facts per memory at L1. */
const L1_MAX_FACTS = 3;
/** Max chars per fact (hard truncate with ellipsis). */
const L1_MAX_FACT_CHARS = 220;

/** Short type label used as the `[type]` prefix on each fact. */
function typeLabel(type: MemoryType): string {
  return type === "custom" ? "note" : type;
}

function truncateFact(s: string): string {
  const t = s.trim();
  return t.length > L1_MAX_FACT_CHARS
    ? `${t.slice(0, L1_MAX_FACT_CHARS - 1).trimEnd()}…`
    : t;
}

/**
 * L1 text: typed fact statements. Entity-bearing sentences (matched
 * against the memory's own tags + stored entities via the existing
 * extraction pipeline) become `[type] sentence` facts; when no sentence
 * carries an entity, the lead sentence stands in. Deterministic,
 * template-based — no LLM.
 *
 * Falls back to the verbatim content when the facts would cost as much
 * as the content itself, keeping token counts non-increasing L1 ≤ L3.
 */
export function fidelityL1(node: MemoryNode): string {
  const sentences = splitSentences(node.content).filter((s) => s.length > 10);
  if (sentences.length === 0) return node.content;

  // Lookup vocabulary: the memory's own tags + stored entities
  // (extracted at write time by the existing pipeline). Legacy nodes
  // without stored entities get them extracted on the fly.
  const vocab = new Set<string>();
  for (const t of node.tags ?? []) vocab.add(String(t).toLowerCase());
  let entities = nodeEntities(node);
  if (entities.length === 0 && node.tags.length === 0) {
    entities = canonicalizeEntities(extractQueryEntities(node.content));
  }
  for (const e of entities) vocab.add(e);

  const label = typeLabel(node.type);
  const facts: string[] = [];
  for (const sentence of sentences) {
    if (facts.length >= L1_MAX_FACTS) break;
    const sentenceEntities = canonicalizeEntities(
      extractQueryEntities(sentence),
    );
    let matched = sentenceEntities.some((e) => vocab.has(e));
    if (!matched) {
      const lower = sentence.toLowerCase();
      for (const v of vocab) {
        if (v.length >= 3 && lower.includes(v)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) facts.push(`[${label}] ${truncateFact(sentence)}`);
  }
  if (facts.length === 0) {
    facts.push(`[${label}] ${truncateFact(sentences[0]!)}`);
  }
  const text = facts.join(" ");
  // Never let the "compressed" level cost more than verbatim.
  return text.length >= node.content.length ? node.content : text;
}

// ---------------------------------------------------------------------------
// L2 — extractive summary by sentence centrality (TextRank-lite, no LLM)
// ---------------------------------------------------------------------------

/** PageRank damping factor (TextRank default). */
const TEXTRANK_DAMPING = 0.85;
/** PageRank iterations — converges for summary-sized graphs. */
const TEXTRANK_ITERATIONS = 25;
/** Max chars for the L2 summary (sentence-boundary respected). */
const L2_MAX_CHARS = 600;
/** Content at or below this length is already summary-sized: L2 = L3. */
const L2_PASSTHROUGH_CHARS = 280;

/**
 * Information-dense predicates: a sentence carrying one of these
 * holds a value, a date, or a polarity constraint — the token the
 * user actually asked about. Centrality (word overlap with *other*
 * sentences) is structurally blind to them: a sentence that shares
 * vocabulary with nothing scores LOW on centrality precisely
 * BECAUSE it is unique, so TextRank-lite deletes the one sentence
 * that carries the number. `fidelityL2` reserves take-slots for
 * these sentences before backfilling by centrality.
 */
const DENSE_PATTERNS: ReadonlyArray<RegExp> = [
  /\d/, // any digit: "120 connections", "March 3rd", "v2.1"
  /\b(not|never|no|none|neither|nor|without|except)\b/i, // negation
  /\b(only|must|required)\b/i, // necessity constraints
];

/** True when the sentence carries a number, date, or negation. */
export function isInformationDense(sentence: string): boolean {
  return DENSE_PATTERNS.some((re) => re.test(sentence));
}

/**
 * TextRank-lite sentence centrality: similarity(i, j) =
 * |words_i ∩ words_j| / (log|words_i| + log|words_j|) (Mihalcea & Tarau
 * 2004), then PageRank over the similarity graph. Pure function, zero
 * LLM. Returns sentences ranked best-first (ties: original order).
 */
export function rankSentencesByCentrality(sentences: string[]): string[] {
  const n = sentences.length;
  if (n <= 2) return [...sentences];
  const wordSets = sentences.map((s) => new Set(contentWords(s)));

  // Similarity matrix (symmetric).
  const sim: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = wordSets[i]!;
      const b = wordSets[j]!;
      if (a.size === 0 || b.size === 0) continue;
      let inter = 0;
      for (const w of a) if (b.has(w)) inter += 1;
      const denom = Math.log(a.size) + Math.log(b.size);
      const s = denom > 0 ? inter / denom : 0;
      sim[i]![j] = s;
      sim[j]![i] = s;
    }
  }

  const outWeight = sim.map((row) => row.reduce((x, y) => x + y, 0));
  let scores = new Array<number>(n).fill(1 / n);
  for (let iter = 0; iter < TEXTRANK_ITERATIONS; iter += 1) {
    const next = new Array<number>(n).fill(1 - TEXTRANK_DAMPING);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j || outWeight[j] === 0) continue;
        next[i]! +=
          TEXTRANK_DAMPING * (sim[j]![i]! / outWeight[j]!) * scores[j]!;
      }
    }
    scores = next;
  }

  return sentences
    .map((s, i) => ({ s, i, score: scores[i]! }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((e) => e.s);
}

/**
 * L2 text: extractive summary — the top central sentences in original
 * order, capped at ~600 chars. Short content passes through unchanged
 * (nothing to compress). Never longer than verbatim, so L2 ≤ L3.
 *
 * A sleep-time LLM pass may later UPGRADE this slot to an abstractive
 * summary; the extractive path here is the guaranteed zero-LLM floor.
 */
export function fidelityL2(node: MemoryNode): string {
  const content = node.content;
  if (content.length <= L2_PASSTHROUGH_CHARS) return content;
  const sentences = splitSentences(content).filter((s) => s.length > 10);
  if (sentences.length <= 2) return content;

  const ranked = rankSentencesByCentrality(sentences);
  const take = content.length > 1500 ? 3 : 2;

  // Reserve slots for sentences centrality is blind to.
  //
  // Centrality ranks a sentence by how much vocabulary it SHARES
  // with the rest, so the sentence holding the number/date/negation —
  // unique by construction — is structurally LAST on centrality and
  // gets dropped by the take. Same for the note's final sentence,
  // which usually carries the conclusion ("so what") and is the one
  // the char-cap trim below drops first.
  //
  // So: fill reserved slots first (highest-ranked dense sentence,
  // then the final sentence), then backfill by centrality.
  const last = sentences[sentences.length - 1]!;
  const dense = ranked.filter(isInformationDense);
  const picked = new Set<string>();
  for (const d of dense) {
    if (picked.size >= take) break;
    picked.add(d);
  }
  if (!picked.has(last) && picked.size < take) {
    picked.add(last);
  }
  for (const s of ranked) {
    if (picked.size >= take) break;
    picked.add(s);
  }

  // Emit in ORIGINAL order (narrative coherence beats rank order).
  const ordered = sentences.filter((s) => picked.has(s));
  let text = ordered.join(" ");
  if (text.length > L2_MAX_CHARS) {
    // Trim at a sentence boundary: drop the last-picked sentence
    // first — but never a dense one, which carries the value the
    // caller asked about.
    const kept = ordered.slice(0, -1).filter((s) => !isInformationDense(s));
    text =
      kept.length > 0 && kept.length <= L2_MAX_CHARS
        ? kept.join(" ")
        : `${text.slice(0, L2_MAX_CHARS - 1).trimEnd()}…`;
  }
  return text.length >= content.length ? content : text;
}

// ---------------------------------------------------------------------------
// Level cache (metadata.fidelity) + accessor
// ---------------------------------------------------------------------------

/**
 * Reserved metadata slot for cached L1/L2 text: `{ v: 1, l1, l2 }`.
 * L0 is always derived free; L3 is the content column.
 */
const FIDELITY_META_KEY = "fidelity";
const FIDELITY_CACHE_VERSION = 1;

interface FidelityCache {
  v: number;
  l1?: string;
  l2?: string;
}

function readFidelityCache(node: MemoryNode): FidelityCache | null {
  const raw = node.metadata?.[FIDELITY_META_KEY];
  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as FidelityCache).v === FIDELITY_CACHE_VERSION
  ) {
    return raw as FidelityCache;
  }
  return null;
}

/**
 * Stamp generated L1/L2 text into the node's reserved metadata slot
 * (mutates the passed node object). Called at write time and by
 * `MemOS.compact()` backfill.
 */
export function stampFidelityCache(node: MemoryNode): {
  l1: string;
  l2: string;
} {
  const l1 = fidelityL1(node);
  const l2 = fidelityL2(node);
  const metadata = (node.metadata ?? {}) as Record<string, unknown>;
  metadata[FIDELITY_META_KEY] = {
    v: FIDELITY_CACHE_VERSION,
    l1,
    l2,
  } satisfies FidelityCache;
  node.metadata = metadata;
  return { l1, l2 };
}

/** True when the node already carries cached L1/L2 text. */
export function hasFidelityCache(node: MemoryNode): boolean {
  const cache = readFidelityCache(node);
  return (
    !!cache && typeof cache.l1 === "string" && typeof cache.l2 === "string"
  );
}

/**
 * Text of a memory at a fidelity level. L1/L2 prefer the write-time
 * cache and generate lazily (pure, no writes) when missing.
 *
 * Image memories append their `[img:<ref>]` token at EVERY level. The
 * lower levels exist to save tokens (L0 is a tag/entity soup, L1 is
 * typed facts), and none of them carries `node.content` — so without
 * this append a memory findable at L0 would return prose with no way
 * to reach the image it describes. A memory that can be found but whose
 * image cannot be shown is a broken memory, so the token rides at every
 * level. Text nodes are untouched: no token is appended and their
 * rendered bytes are identical to before.
 */
export function levelText(node: MemoryNode, level: FidelityLevel): string {
  const rendered = renderLevel(node, level);
  const imageRef = imageRefToken(node);
  return imageRef ? `${rendered} ${imageRef}` : rendered;
}

/** The `[img:<ref>]` token for an image node, or "" for any other node. */
function imageRefToken(node: MemoryNode): string {
  const raw = node.metadata?.image;
  if (!raw || typeof raw !== "object") return "";
  const ref = (raw as { ref?: unknown }).ref;
  return typeof ref === "string" && ref.length > 0 ? `[img:${ref}]` : "";
}

/** The level renderer itself, before the image token is appended. */
function renderLevel(node: MemoryNode, level: FidelityLevel): string {
  switch (level) {
    case "L0":
      return fidelityL0(node);
    case "L1": {
      const cached = readFidelityCache(node)?.l1;
      return typeof cached === "string" ? cached : fidelityL1(node);
    }
    case "L2": {
      const cached = readFidelityCache(node)?.l2;
      return typeof cached === "string" ? cached : fidelityL2(node);
    }
    case "L3":
      return node.content;
  }
}

// ---------------------------------------------------------------------------
// Level-corpus scorer (local BM25-lite, [0,1] coverage)
// ---------------------------------------------------------------------------

/**
 * Tokenize for the coverage scorer: lowercase, len ≥ 2, stopwords out,
 * canonicalized through the entity alias table so "postgres" matches
 * "postgresql" ("db" matches "database", …). Deterministic.
 */
function scorerTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || FIDELITY_STOPWORDS.has(raw)) continue;
    const canonical = BUILTIN_ENTITY_ALIASES[raw] ?? raw;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    terms.push(canonical);
  }
  return terms;
}

/**
 * Score each doc against the query as IDF-weighted term coverage in
 * [0, 1]: the fraction of the query's IDF mass present in the doc.
 * 1.0 = every query term appears; 0.0 = none do. Local, zero-dependency,
 * deterministic — the hot-path scorer for level corpora.
 */
export function scoreLevelCorpus(query: string, docs: string[]): number[] {
  const qTerms = scorerTerms(query);
  if (qTerms.length === 0) return docs.map(() => 0);
  const docSets = docs.map((d) => new Set(scorerTerms(d)));
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const t of qTerms) {
    let df = 0;
    for (const s of docSets) if (s.has(t)) df += 1;
    idf.set(t, Math.log(1 + n / (1 + df)));
  }
  const denom = qTerms.reduce((sum, t) => sum + idf.get(t)!, 0);
  if (denom === 0) return docs.map(() => 0);
  return docSets.map((set) => {
    let num = 0;
    for (const t of qTerms) if (set.has(t)) num += idf.get(t)!;
    return num / denom;
  });
}

// ---------------------------------------------------------------------------
// Query-adaptive router (local, no LLM)
// ---------------------------------------------------------------------------

/** Query words that mark a question (vs. a lookup). */
const QUESTION_WORDS = new Set([
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "tell",
]);

/** Words marking an explanatory/conceptual query — needs full nuance. */
const EXPLAIN_WORDS = new Set([
  "why",
  "how",
  "explain",
  "describe",
  "comparison",
  "compare",
  "philosophy",
  "implications",
  "meaning",
  "reasoning",
  "evolved",
  "evolution",
]);

/** Words marking a summarization-style query — summary level suffices. */
const SUMMARY_WORDS = new Set([
  "summarize",
  "summarise",
  "summary",
  "overview",
  "recap",
  "digest",
  "tldr",
]);

/** Cheap signals the router used for one query. */
export interface FidelitySignals {
  /** Canonicalized entities found in the query. */
  entities: string[];
  /** Query word count. */
  words: number;
  /** Question words present. */
  questionWords: string[];
  /** Explanatory/conceptual markers present. */
  explainWords: string[];
  /** Summarization markers present. */
  summaryWords: string[];
  /** Quoted spans or code identifiers present (high specificity). */
  quoted: boolean;
  /**
   * Decisive tokens the query carries — numbers, units, or negation.
   * When present, the served text must contain them too: a query
   * asking "why not 20" gets "pool = 40" as an answer otherwise.
   * `recall()` uses this to force escalation past a level that
   * merely has high term coverage.
   */
  decisiveTokens: string[];
}

/** Router output: starting level + why. */
export interface FidelityRoute {
  level: FidelityLevel;
  /** Human-readable reason (logged / surfaced in results). */
  reason: string;
  signals: FidelitySignals;
}

/**
 * Extract router entities: the standard pipeline
 * (`extractQueryEntities` + canonicalization) PLUS lowercase alias-table
 * vocabulary — "postgres" never surfaces as a capitalized entity but is
 * an unambiguous entity reference through the alias table.
 */
export function routerEntities(query: string): string[] {
  const out = canonicalizeEntities(extractQueryEntities(query));
  const seen = new Set(out);
  for (const token of query.toLowerCase().split(/[^a-z0-9]+/)) {
    const canonical = BUILTIN_ENTITY_ALIASES[token];
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

function wordList(query: string): string[] {
  return query.trim().split(/\s+/).filter(Boolean);
}

/** Negation words that must appear verbatim in the served text. */
const DECISIVE_NEGATIONS = new Set([
  "not",
  "never",
  "no",
  "none",
  "neither",
  "nor",
  "without",
  "except",
  "only",
]);

/**
 * Quantity words. A query asking for one of these is a factoid whose
 * answer is a VALUE, not a label — the same trap as a bare number.
 */
const DECISIVE_QUANTITY_WORDS = new Set([
  "size",
  "limit",
  "count",
  "number",
  "amount",
  "max",
  "maximum",
  "min",
  "minimum",
  "timeout",
  "rate",
  "budget",
  "threshold",
  "version",
  "ttl",
  "latency",
  "duration",
]);

/**
 * Decisive tokens in a query: numbers (with optional units) and
 * negations. These are the tokens a bag-of-words coverage score
 * cannot judge: "pool size = 20" and "pool size reduced from 40"
 * score identically on term presence, and "not" is invisible to
 * every set-membership scorer. When the query carries one and the
 * served text lacks it, `recall()` must escalate regardless of the
 * coverage score.
 */
export function queryDecisiveTokens(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (tok: string) => {
    const t = tok.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  // Numbers with optional unit: "20", "25 connections", "120ms",
  // "3am", "2.5", "42%", "$30". The unit tail is capped so a number
  // mid-sentence can't swallow the rest of the clause.
  //
  // Each numeric run is matched through an ATOMIC group — `(?=(…))\1` —
  // instead of `\d+(?:[.,]\d+)*` directly. In the plain form the engine
  // can split a long "0,0,0,…" run between the outer `\d+` and the inner
  // `(?:[.,]\d+)*` in polynomially many ways (CodeQL js/polynomial-redos).
  // The lookahead captures the maximal run and the backreference consumes
  // it without giving the unit tail a chance to backtrack into it, so the
  // scan is linear and the matched tokens are byte-identical.
  const numberRe =
    /(?=(\d+(?:[.,]\d+)*))\1(?:\s*[a-z]{0,12})?|[$%](?=(\d*(?:[.,]\d+)*))\2/gi;
  let m: RegExpExecArray | null;
  while ((m = numberRe.exec(query)) !== null) {
    push(m[0]!);
  }
  // Negations / exclusive quantifiers, and quantity words ("pool
  // size" is a factoid whose answer is a value, same trap as a bare
  // number).
  for (const raw of query.toLowerCase().split(/[^a-z]+/)) {
    if (DECISIVE_NEGATIONS.has(raw) || DECISIVE_QUANTITY_WORDS.has(raw)) {
      push(raw);
    }
  }
  return out;
}

/** Index of the first ".", "," or whitespace char, or -1. Linear scan. */
function searchFirstSeparator(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // "." (46), "," (44)
    if (c === 46 || c === 44) return i;
    // whitespace: space, \t, \n, \v, \f, \r
    if (c === 32 || (c >= 9 && c <= 13)) return i;
  }
  return -1;
}

/** True when `text` contains the decisive token (number or negation). */
export function textHasDecisiveToken(text: string, token: string): boolean {
  const t = token.trim().toLowerCase();
  if (!t) return true;
  if (/^\d/.test(t)) {
    // Number + optional unit: require the number; unit match is a
    // bonus, not a requirement (units are spelled inconsistently).
    // Cut at the first separator by INDEX rather than by
    // `/[.,\s].*$/`: `\s` and `.` overlap on tabs/newlines, so the
    // pattern can split such a run two ways and backtrack
    // quadratically (CodeQL js/polynomial-redos). `indexOf`-style
    // scanning is linear and yields the same prefix.
    const cut = searchFirstSeparator(t);
    const num = cut === -1 ? t : t.slice(0, cut);
    return text.toLowerCase().includes(num);
  }
  return new RegExp(`\\b${t}\\b`, "i").test(text);
}

/**
 * Pick the STARTING fidelity level for a query. Local heuristics, no
 * LLM. Rule: start low, escalate on demand (escalation happens in
 * `MemOS.recall()` when the result set looks insufficient).
 *
 * Rules (first match wins):
 *   1. Entity lookup (≥1 entity, ≤4 words, no question/explain
 *      words, NO decisive token) → L0. Tags+entities answer "which
 *      memory is about X" — a retrieval affordance, not an answer.
 *   2. Entity-anchored factoid, OR any query carrying a decisive
 *      token (number/unit/negation) → L1. Typed facts carry the
 *      answer; the decisive-token check in `recall()` escalates if
 *      the token is still absent at L1.
 *   3. Explanatory / conceptual (why/how/explain/…) → L3.
 *      Nuance and reasoning don't survive compression.
 *   4. Summarization request or long narrative query (≥30 words) → L2.
 *   5. Open question (what/which/who/when/where/tell, no entity) → L2.
 *      Summary first; escalate on miss.
 *   6. Fallback → L1 (cheap, structured, usually sufficient).
 *
 * L0 is never the terminal level for a content question: `recall()`
 * treats an L0-only hit as insufficient and escalates even when the
 * caller passed `fidelity: "adaptive"`.
 */
export function routeFidelity(query: string): FidelityRoute {
  const words = wordList(query);
  const lowered = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, ""));
  const entities = routerEntities(query);
  const questionWords = lowered.filter((w) => QUESTION_WORDS.has(w));
  const explainWords = lowered.filter((w) => EXPLAIN_WORDS.has(w));
  const summaryWords = lowered.filter((w) => SUMMARY_WORDS.has(w));
  const quoted = /["'`]/.test(query);
  const decisiveTokens = queryDecisiveTokens(query);
  const signals: FidelitySignals = {
    entities,
    words: words.length,
    questionWords,
    explainWords,
    summaryWords,
    quoted,
    decisiveTokens,
  };

  if (
    entities.length >= 1 &&
    words.length <= 4 &&
    questionWords.length === 0 &&
    explainWords.length === 0 &&
    decisiveTokens.length === 0
  ) {
    return {
      level: "L0",
      reason: `entity lookup (${entities.join(", ")}): tags+entities suffice`,
      signals,
    };
  }
  if (entities.length >= 1 && explainWords.length === 0) {
    return {
      level: "L1",
      reason:
        decisiveTokens.length > 0
          ? `decisive-token factoid (${decisiveTokens.join(", ")}): typed facts first, escalate if absent`
          : `entity-anchored factoid (${entities.join(", ")}): typed facts first`,
      signals,
    };
  }
  if (explainWords.length > 0) {
    return {
      level: "L3",
      reason: `explanatory query (${explainWords.join(", ")}): full nuance required`,
      signals,
    };
  }
  if (summaryWords.length > 0 || words.length >= 30) {
    return {
      level: "L2",
      reason:
        summaryWords.length > 0
          ? `summarization request (${summaryWords.join(", ")}): extractive summary first`
          : `long narrative query (${words.length} words): summary-level scan first`,
      signals,
    };
  }
  if (questionWords.length > 0) {
    return {
      level: "L2",
      reason: `open question (${questionWords.join(", ")}): summary first, escalate on miss`,
      signals,
    };
  }
  return {
    level: "L1",
    reason: "short keyword query: typed facts first",
    signals,
  };
}

// ---------------------------------------------------------------------------
// Recall result types
// ---------------------------------------------------------------------------

/** Options for `MemOS.recall()` — additive; nothing here changes search(). */
export interface FidelityRecallOptions {
  /**
   * Starting fidelity level, or `"adaptive"` to let `routeFidelity()`
   * choose from query signals. Default `"L3"` — verbatim output,
   * behavior-preserving for existing consumers.
   */
  fidelity?: FidelityLevel | "adaptive";
  /**
   * Escalation ceiling: recall never serves above this level, even when
   * the result set looks insufficient. Default `"L3"`.
   */
  maxFidelity?: FidelityLevel;
  /** Max results returned. Default 20. */
  limit?: number;
  /**
   * Minimum [0,1] coverage score for a hit. Results below it trigger
   * escalation (or are dropped at the ceiling). Default 0.15.
   */
  threshold?: number;
  /**
   * Escalate when fewer than this many hits clear the threshold.
   * Default 1.
   */
  minResults?: number;
  /**
   * Escalation floor: never serve a level below this, even via
   * `fidelity: "adaptive"`. Default `"L1"` — L0 (tags+entities) is a
   * retrieval affordance, not an answer, so an adaptive call never
   * stops there. Pass `"L0"` to opt back into tag soup (an explicit
   * contract: the caller wants "which memory is about X").
   */
  minLevel?: FidelityLevel;
  /**
   * Force escalation when the query carries a decisive token
   * (number/unit/negation) that the served text lacks. Default true:
   * IDF coverage scores "pool size = 20" and "pool size was reduced
   * from 40" identically, so this is the only signal that notices the
   * decisive token went missing during compaction. Set false to
   * restore pure coverage-gated escalation.
   */
  escalateOnMissingDecisiveToken?: boolean;
  /** Scope the candidate set (namespace/type/tags/pool). */
  filter?: SearchFilter;
  /**
   * Scope recall to one authoring harness (e.g. `"claude-code"`), or
   * `"all"` (default) for the behavior-preserving cross-harness
   * recall. `filter.harness` is honored too; this top-level option
   * wins when both are set.
   */
  harness?: string;
}

/** One recalled memory with its served fidelity level. */
export interface FidelityRecallResult {
  /** The full memory node (identity preserved; text served at `level`). */
  node: MemoryNode;
  /** Level the text was served at (after escalation). */
  level: FidelityLevel;
  /** `levelText(node, level)` — what the caller should inject. */
  text: string;
  /** [0,1] coverage score at the final level. */
  score: number;
  /** Levels attempted before the final one (empty when none). */
  escalations: FidelityLevel[];
  /** Router output — present only when `fidelity: "adaptive"`. */
  route?: FidelityRoute;
}

/** Default escalation floor: L0 is a retrieval affordance, not an answer. */
export const DEFAULT_MIN_FIDELITY_LEVEL: FidelityLevel = "L1";

/**
 * Composition guard for `fidelity` × `compression` (audit finding 7f).
 *
 * `compressText` is a stopword-class filter. Applied to an item that
 * is ALREADY a compressed fidelity level (L1 typed facts, L2
 * extractive summary), it strips the connective tissue that made the
 * summary readable — on top of the sentence-selection loss that
 * already happened. Two lossy passes composed: the result is
 * terser but materially less answerable than either pass alone.
 *
 * So when an item was rendered below L3, budget compression is
 * skipped (the item is admitted as-is, or dropped if it still
 * doesn't fit — exactly as it was before compression existed).
 * L3 verbatim text has its full prose structure to lose and is the
 * only level where the filter is a net win.
 */
export function shouldCompressFidelityItem(
  fidelity: FidelityLevel | undefined,
): boolean {
  return fidelity === undefined || fidelity === "L3";
}

/**
 * Resolve the effective start level + ceiling for a recall call.
 *
 * The start level is additionally clamped UP to the escalation floor
 * (`minLevel`, default L1) unless the caller explicitly requested L0:
 * an adaptive route may pick L0 for "postgres pool size", but serving
 * tag soup as the answer is a category error, so the floor lifts it
 * to L1.
 */
export function resolveRecallLevels(
  query: string,
  opts: FidelityRecallOptions = {},
): {
  start: FidelityLevel;
  max: FidelityLevel;
  floor: FidelityLevel;
  route?: FidelityRoute;
} {
  const max = opts.maxFidelity ?? "L3";
  const requested = opts.fidelity ?? "L3";
  // The floor lifts the start level UP (never serves below it); the
  // ceiling clamps it DOWN. Two independent clamps — applying the
  // floor as a downward clamp would silently downgrade every
  // explicit L2/L3 request and break the behavior-preserving default.
  const floor = opts.minLevel ?? DEFAULT_MIN_FIDELITY_LEVEL;
  const route = requested === "adaptive" ? routeFidelity(query) : undefined;
  const raw: FidelityLevel =
    requested === "adaptive" ? route!.level : requested;
  // An explicit `fidelity: "L0"` is a contract: the caller wants
  // "which memory is about X", so it may sit below the floor.
  const floored =
    requested === "L0"
      ? raw
      : LEVEL_RANK[raw] < LEVEL_RANK[floor]
        ? floor
        : raw;
  return {
    start: clampFidelityLevel(floored, max),
    max,
    floor,
    ...(route ? { route } : {}),
  };
}

/**
 * Whether the hits at the current level are sufficient, or the call
 * must escalate. Two conditions beyond raw coverage:
 *
 * 1. `floor` — never serve L0 unless the caller explicitly asked for
 *    it. Tags+entities answer "which memory", not "what is the value".
 * 2. Decisive tokens — when the query carries a number/unit/negation
 *    and the served text lacks it, escalate even at full coverage:
 *    "pool size = 20" and "pool size reduced from 40" both score 1.0
 *    on term presence, and only one of them answers the question.
 */
export function fidelityLevelSufficient(
  query: string,
  level: FidelityLevel,
  docs: string[],
  opts: { floor: FidelityLevel; checkDecisiveTokens: boolean },
): boolean {
  if (LEVEL_RANK[level] < LEVEL_RANK[opts.floor]) return false;
  if (!opts.checkDecisiveTokens) return true;
  const decisive = queryDecisiveTokens(query);
  if (decisive.length === 0) return true;
  const joined = docs.join("\n");
  return decisive.every((tok) => textHasDecisiveToken(joined, tok));
}

// ---------------------------------------------------------------------------
// Fidelity statistics
// ---------------------------------------------------------------------------

/** Per-level token stats over a set of memories. */
export interface FidelityLevelStats {
  level: FidelityLevel;
  label: string;
  description: string;
  /** Memories measured. */
  count: number;
  /** Mean tokens per memory at this level. */
  avgTokens: number;
  /** Total tokens across all measured memories. */
  totalTokens: number;
  /**
   * Fraction of tokens saved vs verbatim (L3): 0.9 = 90% fewer tokens.
   * 0 for L3 itself.
   */
  savingsVsVerbatim: number;
}

/**
 * Measure tokens per fidelity level over `nodes`. `tokenCounter` is
 * injected (callers pass the pack-grade `estimateTokens`) so this module
 * stays dependency-free.
 */
export function fidelityStats(
  nodes: MemoryNode[],
  tokenCounter: (text: string) => number,
): FidelityLevelStats[] {
  const totals = new Map<FidelityLevel, number>();
  for (const level of FIDELITY_LEVELS) totals.set(level, 0);
  for (const node of nodes) {
    for (const level of FIDELITY_LEVELS) {
      totals.set(
        level,
        totals.get(level)! + tokenCounter(levelText(node, level)),
      );
    }
  }
  const verbatim = Math.max(1, totals.get("L3")!);
  return FIDELITY_LEVELS.map((level) => {
    const totalTokens = totals.get(level)!;
    return {
      level,
      label: FIDELITY_LEVEL_LABELS[level],
      description: FIDELITY_LEVEL_DESCRIPTIONS[level],
      count: nodes.length,
      avgTokens: nodes.length > 0 ? totalTokens / nodes.length : 0,
      totalTokens,
      savingsVsVerbatim:
        level === "L3" ? 0 : Math.max(0, 1 - totalTokens / verbatim),
    };
  });
}

// ---------------------------------------------------------------------------
// Compact (backfill) types
// ---------------------------------------------------------------------------

/** Options for `MemOS.compact()`. */
export interface CompactOptions {
  /** Only backfill this namespace. */
  namespace?: string;
  /** Cap the number of memories scanned. */
  limit?: number;
  /** Include per-level token stats in the result. */
  stats?: boolean;
  /** Compute stats but don't write anything. */
  dryRun?: boolean;
}

/** Result of `MemOS.compact()`. */
export interface CompactResult {
  scanned: number;
  /** Memories that received newly generated L1/L2. */
  backfilled: number;
  /** Memories that already had cached levels. */
  skipped: number;
  stats?: FidelityLevelStats[];
}
