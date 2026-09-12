/**
 * Entity extraction for fused retrieval scoring.
 *
 * The third retrieval signal alongside keyword (FTS5) and semantic
 * (embedding) legs: memories whose stored entities overlap the query's
 * entities get a post-fusion boost. This mirrors the 2026 fused
 * multi-signal retrieval consensus (semantic + BM25 + entity match).
 *
 * The extractor is deliberately lightweight and dependency-free —
 * capitalized multi-word sequences, acronyms, quoted strings, and
 * code-identifier shapes. It runs on every hybrid search, so it must
 * stay in the sub-millisecond class. Entities for a memory are captured
 * at write time into `metadata.entities` (see `MemOS.store`), so the
 * per-candidate overlap check is a set intersection, not a rescan.
 *
 * @module @mem-os/entity-extraction
 */

/** Minimum length for a single-word entity (filters noise like "I", "A"). */
const MIN_WORD_LENGTH = 3;

/** Words that are capitalized mid-sentence but are not entities. */
const STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "there",
  "then",
  "than",
  "when",
  "while",
  "where",
  "which",
  "who",
  "how",
  "why",
  "what",
  "and",
  "but",
  "for",
  "not",
  "with",
  "from",
  "into",
  "onto",
  "over",
  "after",
  "before",
  "because",
  "if",
  "it",
  "its",
  "we",
  "our",
  "you",
  "your",
  "they",
  "their",
  "she",
  "his",
  "her",
  "him",
  "us",
  "them",
  "please",
  "also",
  "just",
  "very",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "done",
  "have",
  "has",
  "had",
  "was",
  "were",
  "are",
  "is",
  "am",
  "be",
  "been",
  "being",
  "add",
  "use",
  "using",
  "used",
  "make",
  "made",
  "run",
  "runs",
  "new",
  "old",
  "get",
  "got",
  "set",
  "let",
  "put",
  "try",
  "tried",
  "i'd",
  "i'm",
  "i've",
  "don't",
  "doesn't",
  "didn't",
  "won't",
  "can't",
]);

/** Terms that never count as entities regardless of casing. */
const NON_ENTITY_TOKEN = /^[0-9_]+$/;

function isCodeIdentifier(token: string): boolean {
  // snake_case, kebab-case, dotted paths, or CamelCase with an internal
  // uppercase — the shapes that show up when agents store technical memory.
  return /[_\-.]/.test(token) || /^[a-z]+[A-Z]/.test(token);
}

function isAcronym(token: string): boolean {
  return (
    token.length >= 2 && token === token.toUpperCase() && /[A-Z]/.test(token)
  );
}

/**
 * Extract candidate entities from free text.
 *
 * Returns lowercase-normalized entities so overlap checks are
 * case-insensitive. Order is stable (first appearance), duplicates are
 * removed. Sentence-initial capitalization is ignored (it's grammatical,
 * not a name), which keeps "Fix the parser" from yielding "fix".
 */
export function extractQueryEntities(text: string): string[] {
  if (!text) return [];
  const entities: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string, minLen = MIN_WORD_LENGTH): void => {
    const normalized = raw.toLowerCase().trim();
    if (normalized.length < minLen) return;
    if (NON_ENTITY_TOKEN.test(normalized)) return;
    if (STOPWORDS.has(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    entities.push(normalized);
  };

  // 1. Quoted strings and backticked code spans are always entities.
  // Single-character delimiters with lazy content (no `+` quantifiers
  // adjacent to the negated class): nothing can be matched two ways, so
  // the scan stays linear on adversarial, quote-heavy input — a
  // polynomial-backtracking hazard with the previous `["'`]+` form.
  for (const match of text.matchAll(/["'`]([^"'`\n]{3,60}?)["'`]/g)) {
    push(match[1]!);
  }

  // 2. Code identifiers (snake_case / kebab-case / dotted / camelCase).
  for (const token of text.split(/[^A-Za-z0-9_\-.]+/)) {
    if (
      token.length >= MIN_WORD_LENGTH &&
      isCodeIdentifier(token) &&
      !STOPWORDS.has(token.toLowerCase())
    ) {
      push(token);
    }
  }

  // 3. Capitalized sequences (proper nouns), skipping sentence starts.
  // A token is "sentence-initial" when the previous non-space char is
  // nothing, `.`, `!`, `?`, or a newline.
  const tokens = [...text.matchAll(/[A-Za-z][A-Za-z0-9'_-]*/g)];
  for (let i = 0; i < tokens.length; i += 1) {
    const match = tokens[i]!;
    const token = match[0];
    const prevChar =
      match.index && match.index > 0 ? text[match.index - 1]! : "";
    const sentenceInitial =
      match.index === 0 || /[.!?\n]/.test(prevChar) || prevChar === "\n";

    if (isAcronym(token)) {
      // Acronyms are high-signal at any length (CI, KV, DB) — the
      // general minimum length only guards prose words.
      push(token, 2);
      continue;
    }
    if (sentenceInitial) continue;
    if (!/^[A-Z]/.test(token)) continue;
    if (STOPWORDS.has(token.toLowerCase())) continue;

    // Extend across adjacent capitalized words ("Postgres Connection
    // Pool") into one entity.
    let phrase = token;
    let lastIndex = match.index! + token.length;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const next = tokens[j]!;
      const between = text.slice(lastIndex, next.index);
      if (between !== " ") break;
      if (!/^[A-Z]/.test(next[0]) || STOPWORDS.has(next[0].toLowerCase()))
        break;
      phrase += ` ${next[0]}`;
      lastIndex = next.index! + next[0].length;
    }
    push(phrase);
  }

  return entities;
}

/**
 * Overlap between query entities and a memory's stored entities
 * (`metadata.entities`) and tags, in [0, 1]. Jaccard-style: shared
 * count over the smaller set, so a single match on a 1-entity query
 * counts fully.
 */
export function entityOverlap(
  queryEntities: readonly string[],
  node: { tags?: readonly string[]; metadata?: { entities?: unknown } },
): number {
  if (queryEntities.length === 0) return 0;

  const stored = new Set<string>();
  for (const tag of node.tags ?? []) {
    stored.add(String(tag).toLowerCase());
  }
  const metaEntities = node.metadata?.entities;
  if (Array.isArray(metaEntities)) {
    for (const entity of metaEntities) {
      stored.add(String(entity).toLowerCase());
    }
  }
  if (stored.size === 0) return 0;

  let shared = 0;
  for (const entity of queryEntities) {
    // Substring match both ways so "postgres connection pool" matches a
    // memory tagged "postgres" and vice versa.
    for (const candidate of stored) {
      if (
        candidate === entity ||
        candidate.includes(entity) ||
        entity.includes(candidate)
      ) {
        shared += 1;
        break;
      }
    }
  }
  return shared / Math.min(queryEntities.length, stored.size);
}

// ---------------------------------------------------------------------------
// Entity resolution (aliasing)
// ---------------------------------------------------------------------------

/**
 * Built-in alias table mapping surface forms to a canonical entity.
 * Lexical extraction alone yields "Postgres", "PostgreSQL", and "pg" as
 * three different entities; canonicalizing through this map (plus any
 * deployment-specific `MemOSConfig.entityAliases`) collapses them so the
 * overlap signal fires across phrasings.
 */
export const BUILTIN_ENTITY_ALIASES: Readonly<Record<string, string>> = {
  pg: "postgres",
  postgres: "postgres",
  postgresql: "postgres",
  pgsql: "postgres",
  js: "javascript",
  nodejs: "node",
  "node.js": "node",
  ts: "typescript",
  k8s: "kubernetes",
  ks: "kubernetes",
  py: "python",
  pip: "python",
  yarn: "npm",
  npm: "npm",
  docker: "docker",
  containerd: "docker",
  rust: "rust",
  go: "golang",
  golang: "golang",
  rails: "rails",
  react: "react",
  nextjs: "next",
  "next.js": "next",
  vue: "vue",
  s3: "aws",
  aws: "aws",
  gcp: "gcp",
  gh: "github",
  github: "github",
  gha: "github-actions",
  llm: "llm",
  agent: "agent",
  agents: "agent",
  db: "database",
  database: "database",
  redis: "redis",
  sqlite: "sqlite",
  graphql: "graphql",
};

/**
 * Canonicalize extracted entities through the built-in alias table plus
 * any deployment-specific aliases (from `MemOSConfig.entityAliases`,
 * which wins over built-ins). Deduplicates after mapping, preserving
 * first-appearance order.
 */
export function canonicalizeEntities(
  entities: readonly string[],
  extraAliases?: Readonly<Record<string, string>>,
): string[] {
  const aliases = extraAliases
    ? { ...BUILTIN_ENTITY_ALIASES, ...lowerKeys(extraAliases) }
    : BUILTIN_ENTITY_ALIASES;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entity of entities) {
    const key = entity.toLowerCase();
    const canonical = (aliases[key] ?? key).toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function lowerKeys(
  record: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key.toLowerCase()] = value.toLowerCase();
  }
  return out;
}
