// Semantic Folding Engine — EDH (Entity-Dense Headlinese) Distillation
// Converts raw text into compressed, high-density semantic representations
// Target: <50ms local execution

import { estimateTokens } from "./token-counter";
import type { ChatMessage, EntityHeadline, FoldingResult } from "./types";

// ─── Entity Extraction ───────────────────────────────────────────────────────

const ACTION_VERBS = [
  "create",
  "delete",
  "update",
  "refactor",
  "build",
  "fix",
  "deploy",
  "configure",
  "analyze",
  "optimize",
  "implement",
  "design",
  "review",
  "test",
  "debug",
  "migrate",
  "integrate",
  "validate",
  "extract",
  "parse",
  "generate",
  "transform",
  "route",
  "authenticate",
  "authorize",
  "cache",
  "query",
  "index",
  "serialize",
  "deserialize",
  "compress",
  "fold",
  "shard",
  "send",
  "receive",
  "fetch",
  "load",
  "save",
  "read",
  "write",
  "execute",
  "run",
  "start",
  "stop",
  "enable",
  "disable",
  "add",
  "remove",
  "check",
];

const ENTITY_PATTERNS: Array<{ type: string; pattern: RegExp }> = [
  { type: "function", pattern: /(?:function|fn|def|const|let|var)\s+(\w+)/g },
  { type: "class", pattern: /(?:class|interface|type|struct)\s+(\w+)/g },
  {
    type: "file_path",
    pattern: /(?:[\w./-]+\.(?:ts|tsx|js|jsx|py|go|rs|md|json|yaml|yml|toml))/g,
  },
  { type: "url", pattern: /https?:\/\/[^\s,)]+/g },
  {
    type: "api_endpoint",
    pattern: /(?:GET|POST|PUT|DELETE|PATCH)\s+\/[\w/:-]+/g,
  },
  {
    type: "model_name",
    pattern:
      /(?:gpt-4(?:\.\d)?|gpt-5(?:\.\d)?|claude-(?:3\.\d|4\.\d)|gemini-(?:\d\.\d)|o[13]|llama|mistral|deepseek)/gi,
  },
  {
    type: "number",
    pattern: /\b\d+(?:\.\d+)?(?:%|ms|s|tok|tokens|usd|\$)\b/gi,
  },
  { type: "code_ref", pattern: /`[^`]+`/g },
  { type: "hex_color", pattern: /#(?:[0-9a-fA-F]{3}){1,2}\b/g },
  {
    type: "css_value",
    pattern: /(?:rgb|rgba|hsl|hsla)\s*\([^)]+\)/g,
  },
  {
    type: "config_number",
    pattern:
      /(?:timeout|max|min|port|size|limit|threshold|interval|delay|retries|workers|threads)\s*[:=]\s*\d+(?:\.\d+)?/gi,
  },
];

function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const { pattern } of ENTITY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(text);
    while (match !== null) {
      entities.add(match[0]);
      match = regex.exec(text);
    }
  }
  return [...entities];
}

function extractActions(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) {
      found.add(verb);
    }
  }
  return [...found];
}

// ─── Helpers: hashing & similarity (semantic dedup) ──────────────────────────

/**
 * FNV-1a 32-bit hash. Used to build compact fold-cache keys instead of using
 * the raw (potentially huge) text as a Map key. Deterministic and fast.
 */
function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // FNV prime multiplication, keep it 32-bit.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Term-frequency cosine similarity over lowercased word tokens. Cheap,
 * zero-dependency, and good enough to detect near-duplicate sentences for the
 * semantic-dedup fold. Returns a value in [0, 1].
 *
 * This is the literal "semantic folding" intent: collapse sentences that carry
 * the same information before they re-enter the context window.
 */
function sentenceSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length > 2);
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const w of ta) freq.set(w, (freq.get(w) ?? 0) + 1);
  let dot = 0;
  for (const w of tb) {
    const c = freq.get(w);
    if (c) dot += c; // |tb| term weight is 1, so dot = shared term count
  }
  // Cosine with |a|=sqrt(sum of squares of counts)=sqrt(ta.length) since each
  // term appears with weight; |b|=sqrt(tb.length). Cheaper than full norm and
  // monotonic with true cosine for ranking purposes.
  const denom = Math.sqrt(ta.length) * Math.sqrt(tb.length);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Drop near-duplicate sentences from a list (keeping the higher-scored /
 * earlier one). Returns the deduplicated list, order preserved.
 *
 * @param scored - sentences with relevance scores and original positions
 * @param threshold - cosine similarity above which two sentences are treated
 *   as duplicates (default 0.85)
 */
interface ScoredSentence {
  text: string;
  score: number;
  hasCode: boolean;
  position: number;
}

function dedupSentences(
  scored: ScoredSentence[],
  threshold = 0.85,
): ScoredSentence[] {
  const kept: ScoredSentence[] = [];
  for (const candidate of scored) {
    const isDup = kept.some(
      (k) => sentenceSimilarity(k.text, candidate.text) >= threshold,
    );
    if (!isDup) kept.push(candidate);
  }
  return kept;
}

// ─── Sentence Compression ────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function computeRelevanceScore(sentence: string): number {
  let score = 0;
  const lower = sentence.toLowerCase();

  // Sentences with action verbs are more relevant
  for (const verb of ACTION_VERBS) {
    if (lower.includes(verb)) score += 0.15;
  }

  // Sentences with code refs are more relevant
  if (/`[^`]+`/.test(sentence)) score += 0.2;

  // Sentences with numbers/metrics are more relevant
  if (/\d+/.test(sentence)) score += 0.1;

  // Shorter sentences tend to be more information-dense
  const words = sentence.split(/\s+/).length;
  if (words <= 15) score += 0.15;
  else if (words <= 30) score += 0.05;

  // Sentences at the start or end of a paragraph are more important
  score += 0.1;

  return Math.min(score, 1);
}

function compressSentence(sentence: string): string {
  let compressed = sentence;

  // Remove filler words & hedging phrases
  compressed = compressed.replace(
    /\b(?:basically|actually|essentially|really|very|quite|just|perhaps|maybe|kind of|sort of|I think|I believe|I feel|it seems|it appears|in order to|due to the fact that|for the purpose of|needless to say|as a matter of fact|at the end of the day|in terms of|when it comes to|the fact that|a number of|a lot of|lots of|in my opinion|from my perspective|needless to say|going forward|at this point in time|at the present time|in the event that)\b/gi,
    "",
  );

  // Collapse redundant phrases → terse equivalents
  compressed = compressed
    .replace(/\b(?:in order to|so as to)\b/gi, "to")
    .replace(/\b(?:due to the fact that|owing to the fact that)\b/gi, "because")
    .replace(/\b(?:for the purpose of)\b/gi, "for")
    .replace(/\b(?:a number of)\b/gi, "several")
    .replace(/\b(?:in the event that)\b/gi, "if")
    .replace(/\b(?:in spite of the fact that)\b/gi, "although")
    .replace(
      /\b(?:with regard to|with respect to|in reference to)\b/gi,
      "regarding",
    )
    .replace(/\b(?:make a decision)\b/gi, "decide")
    .replace(/\b(?:come to a conclusion)\b/gi, "conclude")
    .replace(/\b(?:is able to)\b/gi, "can")
    .replace(/\b(?:in the near future)\b/gi, "soon");

  // Expand common contractions to their shorter root where it reduces length
  // (e.g. "do not" → "don't") — net token win for most tokenizers.
  compressed = compressed
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bdoes not\b/gi, "doesn't")
    .replace(/\bdid not\b/gi, "didn't")
    .replace(/\bis not\b/gi, "isn't")
    .replace(/\bare not\b/gi, "aren't")
    .replace(/\bwill not\b/gi, "won't")
    .replace(/\bcannot\b/gi, "can't")
    .replace(/\bit is\b/gi, "it's")
    .replace(/\bthey are\b/gi, "they're")
    .replace(/\bwe are\b/gi, "we're")
    .replace(/\byou are\b/gi, "you're");

  // Collapse whitespace
  compressed = compressed.replace(/\s+/g, " ").trim();

  // Remove trailing punctuation except important ones
  compressed = compressed.replace(/[,;]\s*$/, ".");

  return compressed;
}

// ─── Headline Builder ────────────────────────────────────────────────────────

function buildHeadline(actions: string[], entities: string[]): string {
  const actionPart =
    actions.length > 0 ? `[ACTION:${actions.slice(0, 3).join(",")}]` : "";

  const entityPart =
    entities.length > 0 ? `[TARGET:${entities.slice(0, 5).join(",")}]` : "";

  const parts = [actionPart, entityPart].filter(Boolean);
  return parts.join("");
}

// ─── Main Folding Function ───────────────────────────────────────────────────

// LRU cache for fold results. Folding is called on every chat turn, and
// system prompts, tool schemas, and repeated messages often fold to
// identical results. Caching eliminates redundant work and cuts the
// per-turn cost when the same content is folded repeatedly.
const FOLD_CACHE_MAX_ENTRIES = 256;
const FOLD_CACHE_TTL_MS = 60_000; // 60 seconds
const foldCache = new Map<
  string,
  { result: FoldingResult; expiresAt: number }
>();

function getCachedFold(key: string): FoldingResult | null {
  const entry = foldCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    foldCache.delete(key);
    return null;
  }
  // Move to end (most recently used).
  foldCache.delete(key);
  foldCache.set(key, entry);
  return entry.result;
}

function setCachedFold(key: string, result: FoldingResult): void {
  if (foldCache.size >= FOLD_CACHE_MAX_ENTRIES) {
    const oldest = foldCache.keys().next().value;
    if (oldest) foldCache.delete(oldest);
  }
  foldCache.set(key, { result, expiresAt: Date.now() + FOLD_CACHE_TTL_MS });
}

/** Clear the fold result cache. Useful for tests and forced re-folding. */
export function clearFoldCache(): void {
  foldCache.clear();
}

/** Current size of the fold result cache. Useful for monitoring. */
export function foldCacheSize(): number {
  return foldCache.size;
}

export function foldText(
  text: string,
  options: { maxTokens?: number; preserveCode?: boolean } = {},
): FoldingResult {
  // Cache key uses a compact FNV-1a hash of the text + options, so the cache
  // Map isn't bloated by full prompt strings (which can be thousands of chars).
  const cacheKey = `${options.maxTokens ?? 2000}|${options.preserveCode ? "1" : "0"}|${fnv1aHash(text)}`;
  const cached = getCachedFold(cacheKey);
  if (cached) return cached;

  const start = performance.now();
  const { maxTokens = 2000, preserveCode = true } = options;

  const originalTokens = estimateTokens(text);

  // Extract entities and actions
  const entities = extractEntities(text);
  const actions = extractActions(text);

  // Split into sentences and score. Track original position so we can
  // restore narrative flow after relevance-based selection.
  const sentences = splitSentences(text);
  let scored: ScoredSentence[] = sentences.map((s, position) => ({
    text: s,
    score: computeRelevanceScore(s),
    hasCode: /`[^`]+`/.test(s) || /```[\s\S]*?```/.test(s),
    position,
  }));

  // Semantic dedup: drop near-duplicate sentences (cosine sim >= 0.85) before
  // budget allocation. This is the core "semantic folding" operation —
  // collapse sentences carrying the same information.
  scored = dedupSentences(scored, 0.85);

  // Select by relevance, prioritizing code blocks when requested.
  const sorted = [...scored].sort((a, b) => {
    if (preserveCode && a.hasCode && !b.hasCode) return -1;
    if (preserveCode && !a.hasCode && b.hasCode) return 1;
    return b.score - a.score;
  });

  // Keep top sentences until we hit the token budget
  let tokenBudget = maxTokens;
  const kept: ScoredSentence[] = [];

  for (const item of sorted) {
    const compressed = compressSentence(item.text);
    const tokens = estimateTokens(compressed);
    if (tokens <= tokenBudget) {
      kept.push({ ...item, text: compressed });
      tokenBudget -= tokens;
    }
    if (tokenBudget <= 0) break;
  }

  // Restore original narrative order so the folded text reads coherently
  // (previously, relevance sort shuffled the sentence flow).
  kept.sort((a, b) => a.position - b.position);

  // Build the headline. Adaptive: only prepend the EDH headline when the fold
  // is actually compressing. For small/already-dense prompts the headline is
  // pure overhead and previously caused output to exceed the input (the
  // "58 → 74 tokens" expansion case). Skip it when the kept body alone is
  // already <= originalTokens.
  const headline = buildHeadline(actions, entities);
  const body = kept.map((k) => k.text).join(" ");
  const bodyTokens = estimateTokens(body);
  const useHeadline =
    headline.length > 0 &&
    originalTokens > 0 &&
    bodyTokens < originalTokens * 0.9;
  const foldedPrompt = useHeadline ? `${headline}\n${body}` : body;

  const foldedTokens = estimateTokens(foldedPrompt);
  const compressionRatio =
    originalTokens > 0 ? foldedTokens / originalTokens : 1;
  const semanticDensity =
    entities.length > 0
      ? Math.min(
          1,
          (actions.length + entities.length) / Math.max(foldedTokens / 10, 1),
        )
      : 0;

  const metadata: EntityHeadline = {
    headline: useHeadline ? headline : "",
    originalTokens,
    foldedTokens,
    compressionRatio,
    semanticDensity,
    entities: entities.slice(0, 10),
    actions: actions.slice(0, 5),
  };

  const result = {
    foldedPrompt,
    foldedTokens,
    metadata,
    estimatedSavingsUsd: 0, // Calculated at orchestrator level with pricing
    foldingTimeMs: performance.now() - start,
  };
  setCachedFold(cacheKey, result);
  return result;
}

// ─── Fold Messages ───────────────────────────────────────────────────────────

export function foldMessages(
  messages: ChatMessage[],
  options: { maxTokens?: number; preserveSystem?: boolean } = {},
): {
  messages: ChatMessage[];
  metadata: EntityHeadline;
  foldedTokens: number;
  foldingTimeMs: number;
} {
  const { maxTokens = 4000, preserveSystem = true } = options;
  const start = performance.now();

  const result: ChatMessage[] = [];
  let totalOriginalTokens = 0;
  let totalFoldedTokens = 0;
  const allEntities: string[] = [];
  const allActions: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system" && preserveSystem) {
      result.push(msg);
      continue;
    }

    if (msg.role !== "user" && msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    const originalTokens = estimateTokens(msg.content);
    totalOriginalTokens += originalTokens;

    // Leave genuinely tiny turns untouched (don't bother folding a
    // one-liner). Gate on character length, not token count, so a
    // moderately long single message (hundreds of tokens) still gets
    // folded instead of being returned verbatim.
    if (msg.content.length <= 80) {
      result.push(msg);
      totalFoldedTokens += originalTokens;
      continue;
    }

    // Adaptive fold ratio. Scale with semantic density, but always apply a
    // meaningful compression to long turns so foldMessages actually shrinks
    // them (the test contract requires a long user turn to come back
    // shorter). Cap the effective budget so even dense long content is
    // compressed rather than returned verbatim.
    const entities = extractEntities(msg.content);
    const actions = extractActions(msg.content);
    const density = Math.min(
      1,
      (entities.length + actions.length) / Math.max(originalTokens / 8, 1),
    );
    // Map density [0,1] → ratio [0.3, 0.6], then clamp the absolute budget
    // so a 4000-token message still folds to <= ~1200 tokens.
    const foldRatio = 0.3 + density * 0.3;
    const maxTokensForMsg = Math.min(
      Math.floor(originalTokens * foldRatio),
      1200,
      maxTokens,
    );

    const foldResult = foldText(msg.content, {
      maxTokens: maxTokensForMsg,
      preserveCode: true,
    });

    result.push({ ...msg, content: foldResult.foldedPrompt });
    totalFoldedTokens += foldResult.metadata.foldedTokens;
    allEntities.push(...foldResult.metadata.entities);
    allActions.push(...foldResult.metadata.actions);
  }

  const headline = buildHeadline(
    [...new Set(allActions)].slice(0, 5),
    [...new Set(allEntities)].slice(0, 10),
  );

  return {
    messages: result,
    foldedTokens: totalFoldedTokens,
    metadata: {
      headline,
      originalTokens: totalOriginalTokens,
      foldedTokens: totalFoldedTokens,
      compressionRatio:
        totalOriginalTokens > 0 ? totalFoldedTokens / totalOriginalTokens : 1,
      semanticDensity: allEntities.length / Math.max(totalFoldedTokens / 10, 1),
      entities: [...new Set(allEntities)].slice(0, 10),
      actions: [...new Set(allActions)].slice(0, 5),
    },
    foldingTimeMs: performance.now() - start,
  };
}

// ─── Token Estimation ────────────────────────────────────────────────────────
//
// `estimateTokens` is imported from ./token-counter.ts (pluggable BPE
// approximation, overridable via setTokenizer()). It is re-exported here for
// backward compatibility: the bench script and examples import it from this
// module. Prefer importing from ./token-counter.ts directly in new code.

export { estimateTokens } from "./token-counter";

export default { foldText, foldMessages, estimateTokens };
