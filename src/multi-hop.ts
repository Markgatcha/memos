/**
 * Second-hop entity-bridge retrieval (`multiHop`).
 *
 * Multi-hop ("bridge") questions ask about an entity B that is not named in
 * the question itself, but is reachable through a first-hop document A that
 * the question *does* name (e.g. "What government position was held by the
 * woman who portrayed Corliss Archer in the film Kiss and Tell?" -> first hop
 * retrieves "Kiss and Tell (1945 film)", which names "Shirley Temple", whose
 * biography holds the answer).
 *
 * Architecture:
 *   1. First hop: standard hybrid retrieval returns its ranked candidate pool.
 *   2. Bridge extraction: from the top first-hop seeds (and the query), extract
 *      bounded candidate bridging entities (quoted titles, capitalized proper
 *      noun phrases, and stored entity mentions), weighted by sentence-level
 *      overlap with the query.
 *   3. Second-hop candidate resolution & verification: resolve candidate
 *      memories via the namespace subject index and entity inverted index, and
 *      score them on three complementary verification signals:
 *        - Forward bridge: a top seed's body explicitly mentions the
 *          candidate's lead subject (especially in a sentence that overlaps
 *          query terms), and the candidate's body contains non-seed query
 *          context words.
 *        - Backward bridge: the candidate's body explicitly mentions a top
 *          seed's lead subject AND supplies the missing query context words.
 *        - Missing query-entity resolution: for comparison / dual-entity
 *          questions where one named query entity is completely absent from
 *          the top-K subjects, promote the memory whose lead subject matches
 *          that missing entity.
 *   4. Bounded, non-displacing fusion:
 *        - Never touch the top `minSlot` (`Math.max(1, Math.floor(limit / 2))`)
 *          results.
 *        - Protect any tail slot (`minSlot .. limit - 1`) that already covers
 *          a distinct query entity or already bridges to the top seeds.
 *        - Only replace an unprotected tail slot when the candidate's scaled
 *          second-hop score (`seed0Score * confidenceFactor`) is at least the
 *          victim slot's first-hop score (`victimScore <= pickScaledScore`).
 *        - Never return more than `limit` items.
 */

import type { MemoryNode, MultiHopOptions, ScoredMemory } from "./types.js";

export const DEFAULT_MULTIHOP_MAX_ENTITIES = 10;
export const DEFAULT_MULTIHOP_MAX_SEEDS = 5;
export const DEFAULT_MULTIHOP_MAX_INJECTED = 2;
export const DEFAULT_MULTIHOP_MIN_BRIDGE_SCORE = 2.2;

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "is",
  "was",
  "are",
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
  "by",
  "with",
  "from",
  "as",
  "into",
  "that",
  "which",
  "who",
  "whom",
  "whose",
  "what",
  "where",
  "when",
  "why",
  "how",
  "this",
  "these",
  "those",
  "it",
  "its",
  "he",
  "his",
  "him",
  "she",
  "her",
  "hers",
  "they",
  "their",
  "them",
  "we",
  "our",
  "you",
  "your",
  "not",
  "no",
  "nor",
  "so",
  "too",
  "very",
  "can",
  "will",
  "just",
  "should",
  "now",
  "also",
  "than",
  "then",
  "both",
  "either",
  "neither",
  "each",
  "every",
  "any",
  "some",
  "such",
  "same",
  "other",
  "more",
  "most",
  "between",
  "after",
  "before",
  "during",
  "under",
  "over",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "about",
  "against",
  "through",
  "into",
  "onto",
  "upon",
  "within",
  "without",
  "along",
  "following",
  "across",
  "behind",
  "beyond",
  "plus",
  "except",
  "around",
  "near",
  "many",
  "much",
  "few",
  "several",
  "own",
]);

const SENTENCE_STARTERS = new Set([
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "but",
  "as",
  "by",
  "with",
  "from",
  "he",
  "she",
  "it",
  "they",
  "his",
  "her",
  "its",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "after",
  "before",
  "during",
  "while",
  "when",
  "where",
  "although",
  "though",
  "since",
  "because",
  "however",
  "moreover",
  "furthermore",
  "later",
  "subsequently",
  "initially",
  "originally",
  "born",
  "known",
  "located",
  "founded",
  "created",
  "built",
  "established",
  "released",
  "published",
  "directed",
  "written",
  "starring",
  "featuring",
  "also",
  "some",
  "many",
  "most",
  "several",
  "both",
  "each",
  "one",
  "two",
]);

/**
 * Dialogue/transcript speaker prefixes (e.g. "user:", "assistant:") are not
 * encyclopedic or entity subject headers. Excluding them ensures chat-turn
 * corpora (such as LongMemEval or LoCoMo) do not index "user" as an entity
 * subject and short-circuit with zero overhead.
 */
const DIALOGUE_PREFIX_RE =
  /^(?:user|assistant|system|human|ai|agent|speaker|question|answer|note|context|date|time|session|turn)\s*:/i;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).filter(
    (w) => !STOPWORDS.has(w),
  );
}

/**
 * Strip single-letter middle initials ("William H. Seward" -> "William Seward")
 * so mentions with or without middle initials match cleanly.
 */
export function normalizeMiddleInitials(text: string): string {
  return text.replace(/\b([a-z]{2,})\s+[a-z]\.\s+([a-z]{2,})\b/gi, "$1 $2");
}

/**
 * Whole-word / whole-phrase case-insensitive containment check on lowercased
 * strings.
 */
export function containsPhrase(
  haystackLower: string,
  phraseLower: string,
): boolean {
  if (!phraseLower || phraseLower.length < 2) return false;
  let startPos = 0;
  const isWordChar = (c: string): boolean => /[a-z0-9]/.test(c);
  while (startPos < haystackLower.length) {
    const idx = haystackLower.indexOf(phraseLower, startPos);
    if (idx < 0) return false;
    const before = idx === 0 ? " " : haystackLower[idx - 1]!;
    const afterIdx = idx + phraseLower.length;
    const after =
      afterIdx >= haystackLower.length ? " " : haystackLower[afterIdx]!;
    const okBefore = !isWordChar(phraseLower[0]!) || !isWordChar(before);
    const okAfter =
      !isWordChar(phraseLower[phraseLower.length - 1]!) || !isWordChar(after);
    if (okBefore && okAfter) return true;
    startPos = idx + 1;
  }
  return false;
}

/**
 * Phrase containment that also accepts regular English plural inflections
 * ("platypus" -> "platypuses", "company" -> "companies").
 */
export function containsPhraseOrPlural(
  haystackLower: string,
  phraseLower: string,
): boolean {
  if (containsPhrase(haystackLower, phraseLower)) return true;
  if (phraseLower.length < 4) return false;
  if (phraseLower.endsWith("y") && !/[aeiou]y$/.test(phraseLower)) {
    if (containsPhrase(haystackLower, `${phraseLower.slice(0, -1)}ies`)) {
      return true;
    }
  }
  if (containsPhrase(haystackLower, `${phraseLower}s`)) return true;
  if (containsPhrase(haystackLower, `${phraseLower}es`)) return true;
  return false;
}

/**
 * Parsed lead subject of an entity-centric memory node (e.g.
 * `"Kiss and Tell (1945 film): Kiss and Tell is a 1945..."` or
 * `"Shirley Temple was an American actress..."`).
 */
export interface LeadSubject {
  /** Full subject including parenthetical qualifier, e.g. `"Kiss and Tell (1945 film)"`. */
  full: string;
  /** Subject without parenthetical qualifier, e.g. `"Kiss and Tell"`. */
  clean: string;
  /** Lowercased `clean` subject. Empty string when no lead subject exists. */
  cleanLower: string;
  /** Content words of `cleanLower`. */
  cleanWords: string[];
  /** Parenthetical disambiguator if present, e.g. `"1945 film"`. */
  qualifier: string;
  /** Character offset where the body starts after a `"Subject: "` header. */
  bodyOffset: number;
  /** Lazily cached lowercased body text. */
  _bodyLower?: string;
  /** Lazily cached middle-initial-normalized lowercased body text. */
  _bodyNormLower?: string;
  /** Lazily cached content word set of the body. */
  _bodyWords?: Set<string>;
}

const leadCache = new WeakMap<MemoryNode, LeadSubject>();

function parseLeadSubjectFromContent(content: string): LeadSubject {
  if (!content || DIALOGUE_PREFIX_RE.test(content)) {
    return {
      full: "",
      clean: "",
      cleanLower: "",
      cleanWords: [],
      qualifier: "",
      bodyOffset: 0,
    };
  }

  const headSlice = content.slice(0, 120);
  const firstNewline = headSlice.indexOf("\n");
  const colonIdx = headSlice.indexOf(":");
  if (
    colonIdx >= 2 &&
    colonIdx < 110 &&
    (firstNewline < 0 || colonIdx < firstNewline)
  ) {
    const candidate = headSlice.slice(0, colonIdx).trim();
    if (/^[A-Z0-9"'\u00C0-\u024F]/.test(candidate) && !/[?!]/.test(candidate)) {
      const parenMatch = candidate.match(/\(([^)]+)\)/);
      const qualifier = parenMatch ? parenMatch[1]!.trim() : "";
      const clean = candidate.replace(/\s*\([^)]*\)\s*/g, "").trim();
      const cleanLower = clean.toLowerCase();
      return {
        full: candidate,
        clean,
        cleanLower,
        cleanWords: tokenize(cleanLower),
        qualifier,
        bodyOffset: colonIdx + 1,
      };
    }
  }

  const plainMatch = headSlice.match(
    /^([A-Z][A-Za-z0-9'.-]*(?:\s+(?:(?:of|and|the|de|van|von|in|on|for)\s+)?[A-Z][A-Za-z0-9'.-]*){0,5})\s+(?:(\([^)]{2,60}\))\s+)?(?:is|was|are|were|has|had|became|served|worked|played|starred|portrayed|directed|wrote|founded|created|built|established|released|published|born|died|located|stands|refers)\b/,
  );
  if (plainMatch) {
    let rawSubj = plainMatch[1]!.trim();
    const parts = rawSubj.split(/\s+/);
    if (parts.length >= 2 && SENTENCE_STARTERS.has(parts[0]!.toLowerCase())) {
      rawSubj = parts.slice(1).join(" ");
    }
    const cleanLower = rawSubj.toLowerCase();
    if (!SENTENCE_STARTERS.has(cleanLower) && !STOPWORDS.has(cleanLower)) {
      const qualifier = plainMatch[2] ? plainMatch[2].slice(1, -1).trim() : "";
      return {
        full: qualifier ? `${rawSubj} (${qualifier})` : rawSubj,
        clean: rawSubj,
        cleanLower,
        cleanWords: tokenize(cleanLower),
        qualifier,
        bodyOffset: 0,
      };
    }
  }

  return {
    full: "",
    clean: "",
    cleanLower: "",
    cleanWords: [],
    qualifier: "",
    bodyOffset: 0,
  };
}

/**
 * Extract (and memoize per `MemoryNode`) the lead subject of a memory or raw
 * content string solely from its text. Never reads benchmark metadata.
 */
export function extractLeadSubject(
  nodeOrContent: MemoryNode | string,
): LeadSubject {
  if (typeof nodeOrContent === "string") {
    return parseLeadSubjectFromContent(nodeOrContent);
  }
  const cached = leadCache.get(nodeOrContent);
  if (cached) return cached;
  const parsed = parseLeadSubjectFromContent(nodeOrContent.content);
  leadCache.set(nodeOrContent, parsed);
  return parsed;
}

function getBodyLower(node: MemoryNode, lead: LeadSubject): string {
  if (lead._bodyLower === undefined) {
    const rawBody =
      lead.bodyOffset > 0
        ? node.content.slice(lead.bodyOffset).trim()
        : node.content;
    lead._bodyLower = rawBody.toLowerCase();
  }
  return lead._bodyLower;
}

function getBodyNormLower(node: MemoryNode, lead: LeadSubject): string {
  if (lead._bodyNormLower === undefined) {
    lead._bodyNormLower = normalizeMiddleInitials(getBodyLower(node, lead));
  }
  return lead._bodyNormLower;
}

function getBodyWords(node: MemoryNode, lead: LeadSubject): Set<string> {
  if (lead._bodyWords === undefined) {
    lead._bodyWords = new Set(tokenize(getBodyLower(node, lead)));
  }
  return lead._bodyWords;
}

/**
 * Lightweight per-namespace index mapping lead subject phrases and rare subject
 * tokens to their `MemoryNode`s.
 */
export interface NamespaceSubjectIndex {
  byCleanSubject: Map<string, MemoryNode[]>;
  bySubjectWord: Map<string, MemoryNode[]>;
  subjectWordDf: Map<string, number>;
}

/**
 * Build an in-memory subject lookup index over a set of nodes.
 */
export function buildNamespaceSubjectIndex(
  nodes: readonly MemoryNode[],
): NamespaceSubjectIndex {
  const byCleanSubject = new Map<string, MemoryNode[]>();
  const bySubjectWord = new Map<string, MemoryNode[]>();
  const subjectWordDf = new Map<string, number>();

  for (const node of nodes) {
    const lead = extractLeadSubject(node);
    if (!lead.cleanLower) continue;
    const cleanKey = lead.cleanLower;
    let list = byCleanSubject.get(cleanKey);
    if (!list) {
      list = [];
      byCleanSubject.set(cleanKey, list);
    }
    list.push(node);

    const noMidKey = normalizeMiddleInitials(cleanKey);
    if (noMidKey !== cleanKey) {
      let nmList = byCleanSubject.get(noMidKey);
      if (!nmList) {
        nmList = [];
        byCleanSubject.set(noMidKey, nmList);
      }
      nmList.push(node);
    }

    const words = new Set(lead.cleanWords);
    for (const w of words) {
      if (w.length < 3) continue;
      subjectWordDf.set(w, (subjectWordDf.get(w) ?? 0) + 1);
      let wList = bySubjectWord.get(w);
      if (!wList) {
        wList = [];
        bySubjectWord.set(w, wList);
      }
      wList.push(node);
    }
  }

  return { byCleanSubject, bySubjectWord, subjectWordDf };
}

/**
 * Extract up to `maxEntities` candidate bridging entities from a seed memory
 * (or raw text) relative to `query`.
 *
 * Candidates are ranked by sentence-level query overlap and structural cues
 * (quoted titles, multi-word proper-noun phrases, single capitalized proper
 * nouns, and MemOS's own `metadata.entities` index). Never reads benchmark
 * metadata such as `hotpot_title`, `supporting_facts`, or `answer`.
 */
export function extractBridgeEntities(
  seed: MemoryNode | string,
  query: string,
  options: { maxEntities?: number } = {},
): string[] {
  const maxEntities = Math.max(
    0,
    Math.floor(options.maxEntities ?? DEFAULT_MULTIHOP_MAX_ENTITIES),
  );
  if (maxEntities <= 0) return [];

  const qTokens = new Set(tokenize(query));
  const lead = extractLeadSubject(seed);
  const content = typeof seed === "string" ? seed : seed.content;
  const body =
    lead.bodyOffset > 0 ? content.slice(lead.bodyOffset).trim() : content;

  const candidates = new Map<string, number>();

  if (lead.qualifier && lead.clean.length >= 3) {
    candidates.set(lead.cleanLower, 4.5);
  }

  const addCandidate = (phrase: string, weight: number): void => {
    const norm = phrase
      .trim()
      .replace(/^[.,"'()[\]]+|[.,"'()[\]]+$/g, "")
      .trim();
    if (norm.length < 3) return;
    const lower = norm.toLowerCase();
    if (STOPWORDS.has(lower) || SENTENCE_STARTERS.has(lower)) return;
    if (lower === lead.cleanLower && !lead.qualifier) return;
    const words = tokenize(lower);
    if (words.length === 0) return;

    candidates.set(lower, Math.max(candidates.get(lower) ?? 0, weight));
    const noMid = normalizeMiddleInitials(lower);
    if (noMid !== lower && noMid.length >= 5) {
      candidates.set(noMid, Math.max(candidates.get(noMid) ?? 0, weight));
    }
  };

  const sentences = body.split(/(?<=[.!?])\s+/);
  for (let sIdx = 0; sIdx < sentences.length; sIdx++) {
    const sent = sentences[sIdx]!;
    const sentWords = tokenize(sent);
    const qOverlap = sentWords.filter((w) => qTokens.has(w)).length;
    const sentBoost = (sIdx === 0 ? 1.4 : 1.0) + qOverlap * 0.6;

    const quoteRe = /"([^"]{3,60})"/g;
    let qm: RegExpExecArray | null;
    while ((qm = quoteRe.exec(sent)) !== null) {
      addCandidate(qm[1]!, 3.2 * sentBoost);
    }

    const capPhraseRe =
      /\b([A-Z][A-Za-z0-9'.-]*(?:\s+(?:(?:of|and|the|de|van|von|in|on|for|at|to|by)\s+)?[A-Z][A-Za-z0-9'.-]*)+)\b/g;
    let cm: RegExpExecArray | null;
    while ((cm = capPhraseRe.exec(sent)) !== null) {
      const phrase = cm[1]!;
      const parts = phrase.split(/\s+/);
      if (parts.length >= 2 && SENTENCE_STARTERS.has(parts[0]!.toLowerCase())) {
        addCandidate(parts.slice(1).join(" "), 3.4 * sentBoost);
      }
      addCandidate(phrase, 3.0 * sentBoost);
    }

    const singleCapRe = /\b([A-Z][a-zA-Z0-9'-]{2,})\b/g;
    let sm: RegExpExecArray | null;
    while ((sm = singleCapRe.exec(sent)) !== null) {
      if (sm.index === 0 && SENTENCE_STARTERS.has(sm[1]!.toLowerCase())) {
        continue;
      }
      addCandidate(sm[1]!, 1.6 * sentBoost);
    }
  }

  if (typeof seed !== "string" && Array.isArray(seed.metadata?.entities)) {
    for (const rawEnt of seed.metadata.entities as unknown[]) {
      const clean = String(rawEnt).replace(/\.$/, "");
      addCandidate(clean, 1.4);
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxEntities)
    .map(([phrase]) => phrase);
}

export interface ExpandMultiHopInput {
  /** User search query. */
  query: string;
  /** Caller's top-K result limit. */
  limit: number;
  /** Pre-built subject index for the active namespace/scope. */
  subjectIndex: NamespaceSubjectIndex;
  /** Optional additional candidates from `storage.searchByEntities`. */
  entityMatches?: readonly MemoryNode[];
  /** Optional filter guard ensuring injected nodes obey query constraints. */
  nodePassesFilter?: (node: MemoryNode) => boolean;
  /** Multi-hop configuration options. */
  options?: MultiHopOptions;
}

export interface MultiHopExpansionResult {
  /** Final ranked results (capped at `limit`). */
  results: ScoredMemory[];
  /** Number of second-hop memories promoted into the window. */
  injected: number;
  /** Extracted bridging entities used during the hop. */
  bridgeEntities: string[];
}

interface PreparedSeed {
  node: MemoryNode;
  score: number;
  seedWeight: number;
  lead: LeadSubject;
  bodyLower: string;
  bodyNormLower: string;
  bodyWordSet: Set<string>;
  nonSeedQWords: string[];
  sentences: Array<{ normLower: string; words: string[] }>;
}

/**
 * Execute second-hop entity-bridge retrieval and merge verified second-hop
 * evidence into weak tail slots of `firstHopPool` without displacing stronger
 * first-hop results or exceeding `limit`.
 */
export function expandMultiHop(
  firstHopPool: readonly ScoredMemory[],
  input: ExpandMultiHopInput,
): MultiHopExpansionResult {
  const {
    query,
    limit,
    subjectIndex,
    entityMatches = [],
    nodePassesFilter,
    options = {},
  } = input;

  const firstHop10 = firstHopPool.slice(0, limit);
  if (
    options.enabled === false ||
    !query ||
    limit < 4 ||
    firstHop10.length < 4 ||
    subjectIndex.byCleanSubject.size === 0
  ) {
    return { results: [...firstHop10], injected: 0, bridgeEntities: [] };
  }

  const maxEntities = Math.max(
    0,
    Math.floor(options.maxEntities ?? DEFAULT_MULTIHOP_MAX_ENTITIES),
  );
  const maxSeeds = Math.max(
    1,
    Math.floor(options.maxSeeds ?? DEFAULT_MULTIHOP_MAX_SEEDS),
  );
  const maxInjected = Math.max(
    0,
    Math.floor(options.maxInjected ?? DEFAULT_MULTIHOP_MAX_INJECTED),
  );
  const minSlot = Math.max(1, Math.min(5, Math.floor(limit / 2)));

  if (maxEntities <= 0 || maxInjected <= 0) {
    return { results: [...firstHop10], injected: 0, bridgeEntities: [] };
  }

  const firstHopScoreMap = new Map<string, number>();
  const firstHopRankMap = new Map<string, number>();
  firstHopPool.forEach((r, idx) => {
    firstHopScoreMap.set(r.node.id, r.score);
    firstHopRankMap.set(r.node.id, idx);
  });

  const qLower = query.toLowerCase();
  const qNormLower = normalizeMiddleInitials(qLower);
  const qWords = tokenize(query);
  const qWordSet = new Set(qWords);

  const seeds: PreparedSeed[] = [];
  const baseWeights = [1.0, 0.6, 0.35, 0.25, 0.2];
  const seedScanCap = Math.min(Math.max(maxSeeds + 2, 7), firstHop10.length);
  for (let idx = 0; idx < seedScanCap; idx++) {
    if (seeds.length >= maxSeeds) break;
    const r = firstHop10[idx]!;
    const lead = extractLeadSubject(r.node);
    const inQ =
      lead.cleanLower.length >= 4 && containsPhrase(qLower, lead.cleanLower);
    if (idx < Math.min(3, maxSeeds) || inQ) {
      const baseW = baseWeights[idx] ?? 0.25;
      const seedWeight = idx < 3 ? (inQ ? Math.max(baseW, 0.85) : baseW) : 0.75;
      const sLeadWords = new Set(lead.cleanWords);
      const nonSeedQWords = qWords.filter((w) => !sLeadWords.has(w));
      const rawBody =
        lead.bodyOffset > 0
          ? r.node.content.slice(lead.bodyOffset).trim()
          : r.node.content;
      const rawSents = rawBody.split(/(?<=[.!?])\s+/);
      const sentences = rawSents.map((s) => {
        const nl = normalizeMiddleInitials(s.toLowerCase());
        return { normLower: nl, words: tokenize(nl) };
      });
      seeds.push({
        node: r.node,
        score: r.score,
        seedWeight,
        lead,
        bodyLower: getBodyLower(r.node, lead),
        bodyNormLower: getBodyNormLower(r.node, lead),
        bodyWordSet: getBodyWords(r.node, lead),
        nonSeedQWords,
        sentences,
      });
    }
  }

  if (seeds.length === 0) {
    return { results: [...firstHop10], injected: 0, bridgeEntities: [] };
  }

  const coveredCleanSubjects = new Set<string>();
  for (const r of firstHop10) {
    const l = extractLeadSubject(r.node);
    if (l.cleanLower) coveredCleanSubjects.add(l.cleanLower);
  }

  const candMap = new Map<string, MemoryNode>();
  for (const r of firstHopPool.slice(0, 30)) {
    candMap.set(r.node.id, r.node);
  }

  const queryBridgeEnts = extractBridgeEntities(query, "", { maxEntities });
  const allBridgeEnts = new Set<string>(queryBridgeEnts);

  for (const seed of seeds) {
    const ents = extractBridgeEntities(seed.node, query, { maxEntities });
    for (const e of ents) allBridgeEnts.add(e);
  }

  for (const phrase of allBridgeEnts) {
    for (const n of subjectIndex.byCleanSubject.get(phrase) ?? []) {
      candMap.set(n.id, n);
    }
    for (const w of tokenize(phrase)) {
      if ((subjectIndex.subjectWordDf.get(w) ?? 999) <= 25) {
        for (const n of subjectIndex.bySubjectWord.get(w) ?? []) {
          candMap.set(n.id, n);
        }
      }
    }
  }

  for (const n of entityMatches) {
    candMap.set(n.id, n);
  }

  const scoreCandidate = (cand: MemoryNode): number => {
    const cLead = extractLeadSubject(cand);
    if (!cLead.cleanLower) return 0;
    const cLeadCleanLower = cLead.cleanLower;
    const cLeadWords = cLead.cleanWords;

    const subjectAlreadyCovered = coveredCleanSubjects.has(cLeadCleanLower);
    const cNamedInQuery =
      cLeadCleanLower.length >= 3 &&
      (containsPhrase(qLower, cLeadCleanLower) ||
        containsPhrase(qNormLower, cLeadCleanLower));

    let bestSeedBridgeScore = 0;

    if (cNamedInQuery && !subjectAlreadyCovered) {
      const esc = cLead.clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const isCapInQuery = new RegExp(`\\b${esc}\\b`).test(query);
      if (isCapInQuery && !/^(ad|bc)?\s*\d+$/i.test(cLead.clean)) {
        let directQueryEntityScore = 2.6 + (cLeadWords.length >= 2 ? 0.8 : 0.2);
        if (cLead.qualifier) {
          const qualWords = tokenize(cLead.qualifier);
          const s0BodyLower = seeds[0] ? seeds[0].bodyLower : "";
          const qualMatches = qualWords.filter(
            (w) => qWordSet.has(w) || containsPhrase(s0BodyLower, w),
          ).length;
          if (qualMatches > 0) {
            directQueryEntityScore += 0.7 * (qualMatches / qualWords.length);
          } else {
            directQueryEntityScore -= cLeadWords.length === 1 ? 1.5 : 0.6;
          }
        }
        bestSeedBridgeScore = Math.max(
          bestSeedBridgeScore,
          directQueryEntityScore,
        );
      }
    }

    for (const seed of seeds) {
      if (seed.node.id === cand.id) continue;
      const sWeight = seed.seedWeight;
      const sLead = seed.lead;
      const sLeadCleanLower = sLead.cleanLower;
      const sBodyLower = seed.bodyLower;
      const sBodyNormLower = seed.bodyNormLower;

      let forwardScore = 0;
      const allowForward = !cNamedInQuery || !subjectAlreadyCovered;

      const isSameCleanSubjectSibling =
        cLeadCleanLower === sLeadCleanLower &&
        cLead.full.toLowerCase() !== sLead.full.toLowerCase() &&
        Boolean(sLead.qualifier);

      const hasFirstLeadWord =
        cLeadWords.length > 0 &&
        (seed.bodyWordSet.has(cLeadWords[0]!) ||
          sBodyLower.includes(
            cLeadWords[0]!.slice(0, Math.max(3, cLeadWords[0]!.length - 1)),
          ));

      if (
        cLeadCleanLower.length >= 3 &&
        allowForward &&
        (isSameCleanSubjectSibling ||
          (hasFirstLeadWord &&
            (containsPhraseOrPlural(sBodyLower, cLeadCleanLower) ||
              containsPhraseOrPlural(sBodyNormLower, cLeadCleanLower))))
      ) {
        forwardScore = 2.5;
        if (cLeadWords.length >= 2) forwardScore += 1.2;
        else {
          const df = subjectIndex.subjectWordDf.get(cLeadCleanLower) ?? 10;
          if (df <= 3) forwardScore += 1.0;
          else if (df >= 25) forwardScore -= 0.8;
        }

        let bestSentOverlap = 0;
        let mentionedInFirstSent = false;
        for (let sIdx = 0; sIdx < seed.sentences.length; sIdx++) {
          const sent = seed.sentences[sIdx]!;
          if (containsPhraseOrPlural(sent.normLower, cLeadCleanLower)) {
            if (sIdx === 0) mentionedInFirstSent = true;
            const ov = sent.words.filter(
              (w) => qWordSet.has(w) && !cLeadWords.includes(w),
            ).length;
            if (ov > bestSentOverlap) bestSentOverlap = ov;
          }
        }
        forwardScore += Math.min(1.5, bestSentOverlap * 0.45);
        if (mentionedInFirstSent) forwardScore += 0.35;

        if (cLead.qualifier) {
          const qualWords = tokenize(cLead.qualifier);
          const qualMatches = qualWords.filter(
            (w) => qWordSet.has(w) || seed.bodyWordSet.has(w),
          ).length;
          if (qualMatches > 0) {
            forwardScore += 0.6 * (qualMatches / qualWords.length);
          } else {
            forwardScore -= cLeadWords.length === 1 ? 1.8 : 0.6;
          }
        }
      } else if (cLeadWords.length >= 2 && allowForward) {
        const novelWordsInSeed = cLeadWords.filter(
          (w) =>
            !qWordSet.has(w) &&
            (seed.bodyWordSet.has(w) ||
              containsPhraseOrPlural(sBodyNormLower, w)),
        );
        const wordsInQuery = cLeadWords.filter((w) => qWordSet.has(w));
        const coverage =
          (novelWordsInSeed.length + wordsInQuery.length) / cLeadWords.length;
        if (novelWordsInSeed.length >= 1 && coverage >= 0.75) {
          const minDf = Math.min(
            ...novelWordsInSeed.map(
              (w) => subjectIndex.subjectWordDf.get(w) ?? 10,
            ),
          );
          if (novelWordsInSeed.length >= 2 || minDf <= 10) {
            forwardScore =
              1.8 * coverage + (novelWordsInSeed.length >= 2 ? 0.6 : 0.2);
          }
        }
      }

      let backwardScore = 0;
      if (sLeadCleanLower.length >= 4 && sLead.cleanWords.length > 0) {
        const cBodyLower = getBodyLower(cand, cLead);
        const firstWordStem = sLead.cleanWords[0]!.slice(
          0,
          Math.max(3, sLead.cleanWords[0]!.length - 1),
        );
        if (cBodyLower.includes(firstWordStem)) {
          if (
            containsPhraseOrPlural(cBodyLower, sLeadCleanLower) ||
            (sLead.cleanWords.length >= 2 &&
              cBodyLower.includes(
                sLead.cleanWords[sLead.cleanWords.length - 1]!,
              ) &&
              containsPhraseOrPlural(
                getBodyNormLower(cand, cLead),
                sLeadCleanLower,
              ))
          ) {
            const cBodyWords = getBodyWords(cand, cLead);
            const nonSeedQWords = seed.nonSeedQWords;
            const matchedNonSeedQWords = nonSeedQWords.filter(
              (w) => cBodyWords.has(w) || cLeadWords.includes(w),
            );
            const qContextRatio =
              nonSeedQWords.length > 0
                ? matchedNonSeedQWords.length / nonSeedQWords.length
                : 0;
            if (matchedNonSeedQWords.length >= 1) {
              backwardScore =
                1.5 +
                Math.min(1.5, matchedNonSeedQWords.length * 0.45) +
                qContextRatio * 0.8;
              if (sLead.cleanWords.length >= 2) backwardScore += 0.4;
            }
          }
        }
      }

      const seedBridge = Math.max(forwardScore, backwardScore);
      if (seedBridge > 0) {
        const cBodyWords = getBodyWords(cand, cLead);
        const nonSeedQWords = seed.nonSeedQWords;
        const matchedNonSeedQWords = nonSeedQWords.filter(
          (w) => cBodyWords.has(w) || cLeadWords.includes(w),
        );
        const qContextRatio =
          nonSeedQWords.length > 0
            ? matchedNonSeedQWords.length / nonSeedQWords.length
            : 0;
        const totalForSeed =
          sWeight *
          (seedBridge +
            matchedNonSeedQWords.length * 0.35 +
            qContextRatio * 0.6);
        if (totalForSeed > bestSeedBridgeScore) {
          bestSeedBridgeScore = totalForSeed;
        }
      }
    }

    if (bestSeedBridgeScore <= 0) return 0;

    const fhScore = firstHopScoreMap.get(cand.id) ?? 0;
    const fhRank = firstHopRankMap.get(cand.id) ?? 999;
    const fhBonus = fhRank < 99 ? 0.4 * fhScore : 0;

    return bestSeedBridgeScore + fhBonus;
  };

  const topKIdSet = new Set(firstHop10.map((r) => r.node.id));
  const scoredOutside: Array<{ node: MemoryNode; bridgeScore: number }> = [];
  for (const [cid, cNode] of candMap) {
    if (topKIdSet.has(cid)) continue;
    if (nodePassesFilter && !nodePassesFilter(cNode)) continue;
    const bScore = scoreCandidate(cNode);
    if (bScore >= DEFAULT_MULTIHOP_MIN_BRIDGE_SCORE) {
      scoredOutside.push({ node: cNode, bridgeScore: bScore });
    }
  }
  scoredOutside.sort((a, b) => b.bridgeScore - a.bridgeScore);

  const isSlotProtected = (idx: number): boolean => {
    if (idx < minSlot) return true;
    const n = firstHop10[idx]!.node;
    const nLead = extractLeadSubject(n);
    const nClean = nLead.cleanLower;

    if (
      nClean.length >= 3 &&
      !/^(ad|bc)?\s*\d+$/i.test(nLead.clean) &&
      containsPhrase(qLower, nClean)
    ) {
      const alreadyAbove = firstHop10
        .slice(0, idx)
        .some((above) => extractLeadSubject(above.node).cleanLower === nClean);
      if (!alreadyAbove) return true;
    }

    if (
      nLead.qualifier &&
      seeds[0] &&
      !containsPhrase(qLower, seeds[0].lead.cleanLower)
    ) {
      const qualWords = tokenize(nLead.qualifier);
      if (qualWords.length > 0 && qualWords.some((w) => qWordSet.has(w))) {
        const nBodyLower = getBodyLower(n, nLead);
        for (const qe of queryBridgeEnts) {
          if (qe.length >= 4 && containsPhrase(nBodyLower, qe)) return true;
        }
      }
    }

    if (scoreCandidate(n) >= 2.1) return true;

    const nBody = getBodyNormLower(n, nLead);
    for (let j = 0; j < Math.min(5, idx); j++) {
      const above = firstHop10[j]!.node;
      const aLead = extractLeadSubject(above);
      const aClean = aLead.cleanLower;
      const aBody = getBodyNormLower(above, aLead);
      if (nClean.length >= 4 && containsPhraseOrPlural(aBody, nClean)) {
        return true;
      }
      if (aClean.length >= 4 && containsPhraseOrPlural(nBody, aClean)) {
        return true;
      }
    }
    return false;
  };

  const finalResults = [...firstHop10];
  let injected = 0;
  let slot = finalResults.length - 1;

  for (const pick of scoredOutside) {
    if (injected >= maxInjected) break;
    while (slot >= minSlot && isSlotProtected(slot)) {
      slot--;
    }
    if (slot < minSlot) break;

    const victimScore = finalResults[slot]!.score;
    const seed0Score = firstHop10[0]?.score ?? 0.5;
    const confidenceFactor =
      Math.min(0.88, 0.72 + Math.min(0.16, (pick.bridgeScore - 2.2) * 0.06)) -
      injected * 0.03;
    const pickScaledScore = seed0Score * confidenceFactor;
    if (victimScore > pickScaledScore) break;

    finalResults[slot] = {
      node: pick.node,
      score: pickScaledScore,
      scores: {
        ...finalResults[slot]!.scores,
        multiHop: pick.bridgeScore,
      },
    };
    slot--;
    injected++;
  }

  return {
    results: finalResults.slice(0, limit),
    injected,
    bridgeEntities: [...allBridgeEnts],
  };
}
