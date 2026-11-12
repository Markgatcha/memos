/**
 * Retrieval Flight Recorder — opt-in retrieval tracing, human/MCP explain,
 * and deterministic counterfactual replay from stored candidate scores.
 *
 * Distinct from `src/time-travel.ts` (which replays stored node state at a
 * past timestamp) and `src/inspector.ts` (which runs a live query to inspect
 * node lifecycle/eligibility): this module records the exact retrieval
 * decisions made during a search and replays alternative fusion/gate/MMR/rerank
 * configurations offline — with zero re-embedding and zero database queries.
 *
 * Determinism contract: every Map and Set iteration in this module explicitly
 * sorts keys before iterating, and JSON serialization uses canonical sorted
 * keys so identical inputs + identical configs produce byte-identical output.
 *
 * @module @mem-os/flight-recorder
 */

import { createHash } from "node:crypto";
import { confidenceWeight } from "./confidence-machine.js";
import { entityOverlap } from "./entity-extraction.js";
import {
  DEFAULT_PROVENANCE_WEIGHT_STRENGTH,
  isProvenanceTier,
  provenanceMultiplier,
} from "./provenance.js";
import {
  DEFAULT_CONFIDENCE_WEIGHT,
  DEFAULT_ENTITY_LEG_WEIGHT,
  DEFAULT_ENTITY_WEIGHT,
  DEFAULT_FUSION_MODE,
  DEFAULT_IMAGE_LEG_WEIGHT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_MMR_LAMBDA,
  DEFAULT_RECENCY_HALF_LIFE_MS,
  DEFAULT_RELEVANCE_RATIO,
  DEFAULT_RRF_K,
  DEFAULT_SEMANTIC_WEIGHT,
  DEFAULT_TEMPORAL_RECENCY_STRENGTH,
  DEFAULT_TRUST_FLOOR,
  RECENCY_EPSILON,
  TEMPORAL_QUERY_RE,
} from "./retrieval.js";
import type {
  ExplainRecallReport,
  FusionOptions,
  MemoryNode,
  RecallTracePayload,
  RecallTraceRecord,
  ReplayConfigOverride,
  ReplayRecallReport,
  ScoredMemory,
  TraceCandidateBreakdown,
  TraceLegCandidate,
  TraceLegName,
  TraceLegRecord,
  TraceMmrDelta,
  TraceRerankDelta,
  TraceRetrievalConfig,
} from "./types.js";

/** Default retention cap for `recall_traces` rows. */
export const DEFAULT_MAX_RECALL_TRACES = 500;

/** Hard cap on tokens scanned per document for MMR token-Jaccard similarity. */
const MMR_MAX_TOKENS = 512;

/** Lexicographic string comparator (locale-independent, UTF-16 code units). */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Strict total-order comparator: descending score, ties broken by ascending ID. */
export function compareByScoreThenId<T extends { id: string; score: number }>(
  a: T,
  b: T,
): number {
  if (b.score !== a.score) return b.score - a.score;
  return compareIds(a.id, b.id);
}

/**
 * Deterministic canonical JSON serializer.
 *
 * Recursively sorts object keys lexicographically while omitting `undefined`
 * object fields (matching `JSON.stringify` round-trip semantics so
 * `JSON.parse(serializeCanonicalJson(x))` deeply equals `x`).
 */
export function serializeCanonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        item === undefined ? "null" : serializeCanonicalJson(item),
      )
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareIds);
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${serializeCanonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Compute a deterministic 16-hex-character SHA-256 fingerprint over a
 * canonicalized retrieval configuration snapshot.
 */
export function computeTraceConfigHash(config: TraceRetrievalConfig): string {
  return createHash("sha256")
    .update(serializeCanonicalJson(config), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function tokenizeAlphaNum(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function mmrTokenSet(text: string): Set<string> {
  return new Set(tokenizeAlphaNum(text).slice(0, MMR_MAX_TOKENS));
}

function jaccardSet(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const tok of [...small].sort(compareIds)) {
    if (large.has(tok)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Precompute sparse upper-triangle pairwise token-Jaccard similarities across
 * candidate nodes. Stores only `[idA, idB, similarity]` triples (`idA < idB`,
 * `similarity > 0`) — zero text and zero tokens — so counterfactual MMR replay
 * works even when `captureText` is `false`.
 */
export function computePairwiseMmrSimilarity(
  nodes: readonly MemoryNode[],
): Array<[string, string, number]> {
  const byId = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!byId.has(node.id)) {
      byId.set(
        node.id,
        mmrTokenSet(`${node.summary ?? ""} ${node.content ?? ""}`),
      );
    }
  }
  const sortedIds = [...byId.keys()].sort(compareIds);
  const pairs: Array<[string, string, number]> = [];
  for (let i = 0; i < sortedIds.length; i += 1) {
    const idA = sortedIds[i]!;
    const setA = byId.get(idA)!;
    if (setA.size === 0) continue;
    for (let j = i + 1; j < sortedIds.length; j += 1) {
      const idB = sortedIds[j]!;
      const setB = byId.get(idB)!;
      if (setB.size === 0) continue;
      const sim = jaccardSet(setA, setB);
      if (sim > 0) {
        pairs.push([idA, idB, sim]);
      }
    }
  }
  return pairs;
}

/**
 * Evaluate whether a single node contains an exact query term (>=3 chars),
 * matching `hasExactTermMatch` in `src/retrieval.ts`. Stored as a boolean per
 * candidate so offline relevance-gate replay needs no memory text.
 */
export function computeCandidateExactTermMatch(
  query: string,
  node: Pick<MemoryNode, "summary" | "content">,
): boolean {
  const terms = tokenizeAlphaNum(query).filter((term) => term.length >= 3);
  if (terms.length === 0) return false;
  const haystack = `${node.summary ?? ""} ${node.content ?? ""}`.toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term)) return true;
  }
  return false;
}

function minMaxNormalizeCandidates(
  candidates: readonly TraceLegCandidate[],
  higherIsBetter: boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  if (candidates.length === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const c of candidates) {
    if (c.rawScore < min) min = c.rawScore;
    if (c.rawScore > max) max = c.rawScore;
  }
  for (const c of candidates) {
    let norm: number;
    if (!(max > min)) {
      norm = 1;
    } else if (higherIsBetter) {
      norm = (c.rawScore - min) / (max - min);
    } else {
      norm = (max - c.rawScore) / (max - min);
    }
    const prev = out.get(c.id);
    if (prev === undefined || norm > prev) {
      out.set(c.id, norm);
    }
  }
  return out;
}

interface ComputedFusionEntry {
  id: string;
  fts: number;
  semantic: number;
  semanticRaw?: number;
  entityLeg: number;
  clip: number;
  clipRaw?: number;
  fusedBase: number;
  temporalRecencyMultiplier: number;
  entityOverlapMultiplier: number;
  trustMultiplier: number;
  provenanceMultiplier: number;
  confidenceMultiplier: number;
  recencyTieBreakDelta: number;
  fusedScore: number;
}

interface ComputedFusionOutput {
  effectiveWeights: RecallTracePayload["effectiveWeights"];
  entries: Map<string, ComputedFusionEntry>;
}

/**
 * Deterministic pure fusion math over stored leg candidates and numeric
 * attributes. Mirrors `fuseResults()` in `src/retrieval.ts` while recording
 * every per-candidate contribution term and sorting every map iteration.
 */
function computeDeterministicFusion(
  legs: {
    fts: readonly TraceLegCandidate[];
    semantic: readonly TraceLegCandidate[];
    entity: readonly TraceLegCandidate[];
    clip: readonly TraceLegCandidate[];
  },
  attributesById: ReadonlyMap<string, TraceCandidateBreakdown["attributes"]>,
  config: TraceRetrievalConfig,
  hasQueryText: boolean,
  nowMs: number,
): ComputedFusionOutput {
  const clipActive = legs.clip.length > 0 && config.imageLegWeight > 0;
  const entries = new Map<string, ComputedFusionEntry>();

  const ensureEntry = (id: string): ComputedFusionEntry => {
    const existing = entries.get(id);
    if (existing) return existing;
    const fresh: ComputedFusionEntry = {
      id,
      fts: 0,
      semantic: 0,
      entityLeg: 0,
      clip: 0,
      fusedBase: 0,
      temporalRecencyMultiplier: 1,
      entityOverlapMultiplier: 1,
      trustMultiplier: 1,
      provenanceMultiplier: 1,
      confidenceMultiplier: 1,
      recencyTieBreakDelta: 0,
      fusedScore: 0,
    };
    entries.set(id, fresh);
    return fresh;
  };

  let effectiveWeights: RecallTracePayload["effectiveWeights"];

  if (config.fusionMode === "convex") {
    let keyword = config.keywordWeight;
    let semantic = config.semanticWeight;
    let entityLeg = config.entityLegWeight;
    if (config.adaptiveWeighting && hasQueryText) {
      if (config.queryTokenCount > 0 && config.queryTokenCount <= 3) {
        keyword *= 1.25;
      }
      if (config.queryEntityCount >= 2) {
        entityLeg = Math.min(0.4, entityLeg * 2);
      }
      const sum = keyword + semantic + entityLeg;
      if (sum > 0) {
        keyword /= sum;
        semantic /= sum;
        entityLeg /= sum;
      }
    }
    const wSum =
      keyword + semantic + entityLeg + (clipActive ? config.imageLegWeight : 0);
    const wk = wSum > 0 ? keyword / wSum : 0;
    const ws = wSum > 0 ? semantic / wSum : 0;
    const we = wSum > 0 ? entityLeg / wSum : 0;
    const wi = wSum > 0 && clipActive ? config.imageLegWeight / wSum : 0;
    effectiveWeights = { keyword: wk, semantic: ws, entityLeg: we, clip: wi };

    const ftsNorm = minMaxNormalizeCandidates(legs.fts, false);
    const semNorm = minMaxNormalizeCandidates(legs.semantic, true);
    const entNorm = minMaxNormalizeCandidates(legs.entity, true);
    const clipNorm = clipActive
      ? minMaxNormalizeCandidates(legs.clip, true)
      : new Map<string, number>();

    const semRawById = new Map<string, number>();
    for (const c of legs.semantic) {
      const raw = Math.max(0, c.rawScore);
      const prev = semRawById.get(c.id);
      if (prev === undefined || raw > prev) semRawById.set(c.id, raw);
    }
    const clipRawById = new Map<string, number>();
    for (const c of legs.clip) {
      const raw = Math.max(0, c.rawScore);
      const prev = clipRawById.get(c.id);
      if (prev === undefined || raw > prev) clipRawById.set(c.id, raw);
    }

    if (wk > 0) {
      for (const [id, n] of [...ftsNorm.entries()].sort((a, b) =>
        compareIds(a[0], b[0]),
      )) {
        const e = ensureEntry(id);
        const contrib = wk * n;
        e.fts += contrib;
        e.fusedBase += contrib;
      }
    }
    if (ws > 0) {
      for (const [id, n] of [...semNorm.entries()].sort((a, b) =>
        compareIds(a[0], b[0]),
      )) {
        const e = ensureEntry(id);
        const contrib = ws * n;
        e.semantic += contrib;
        e.fusedBase += contrib;
        const raw = semRawById.get(id);
        if (raw !== undefined) e.semanticRaw = raw;
      }
    }
    if (we > 0) {
      for (const [id, n] of [...entNorm.entries()].sort((a, b) =>
        compareIds(a[0], b[0]),
      )) {
        const e = ensureEntry(id);
        const contrib = we * n;
        e.entityLeg += contrib;
        e.fusedBase += contrib;
      }
    }
    if (wi > 0) {
      for (const [id, n] of [...clipNorm.entries()].sort((a, b) =>
        compareIds(a[0], b[0]),
      )) {
        const e = ensureEntry(id);
        const contrib = wi * n;
        e.clip += contrib;
        e.fusedBase += contrib;
        const raw = clipRawById.get(id);
        if (raw !== undefined) e.clipRaw = raw;
      }
    }

    for (const id of [...entries.keys()].sort(compareIds)) {
      const e = entries.get(id)!;
      let score = e.fusedBase;
      if (
        config.adaptiveWeighting &&
        hasQueryText &&
        config.temporalQuery &&
        config.temporalRecencyStrength > 0 &&
        config.recencyHalfLifeMs > 0
      ) {
        const attr = attributesById.get(id);
        const updatedAt = attr?.updatedAt ?? nowMs;
        const ageMs = Math.max(0, nowMs - updatedAt);
        const freshness = Math.pow(0.5, ageMs / config.recencyHalfLifeMs);
        const mult = 1 + config.temporalRecencyStrength * freshness;
        e.temporalRecencyMultiplier = mult;
        score *= mult;
      }
      e.fusedScore = score;
    }
  } else {
    const rrfK = config.rrfK;
    const kw = config.keywordWeight;
    const sw = config.semanticWeight;
    const ew = config.entityLegWeight;
    const iw = clipActive ? config.imageLegWeight : 0;
    effectiveWeights = { keyword: kw, semantic: sw, entityLeg: ew, clip: iw };

    for (let idx = 0; idx < legs.fts.length; idx += 1) {
      const c = legs.fts[idx]!;
      const e = ensureEntry(c.id);
      const contrib = kw / (rrfK + idx + 1);
      e.fts += contrib;
      e.fusedBase += contrib;
    }
    for (let idx = 0; idx < legs.semantic.length; idx += 1) {
      const c = legs.semantic[idx]!;
      const e = ensureEntry(c.id);
      const contrib = sw / (rrfK + idx + 1);
      e.semantic += contrib;
      e.fusedBase += contrib;
      e.semanticRaw = Math.max(0, c.rawScore);
    }
    if (ew > 0 && legs.entity.length > 0) {
      for (let idx = 0; idx < legs.entity.length; idx += 1) {
        const c = legs.entity[idx]!;
        const e = ensureEntry(c.id);
        const contrib = ew / (rrfK + idx + 1);
        e.entityLeg += contrib;
        e.fusedBase += contrib;
      }
    }
    if (iw > 0 && legs.clip.length > 0) {
      for (let idx = 0; idx < legs.clip.length; idx += 1) {
        const c = legs.clip[idx]!;
        const e = ensureEntry(c.id);
        const contrib = iw / (rrfK + idx + 1);
        e.clip += contrib;
        e.fusedBase += contrib;
        e.clipRaw = Math.max(0, c.rawScore);
      }
    }
    for (const id of [...entries.keys()].sort(compareIds)) {
      const e = entries.get(id)!;
      e.fusedScore = e.fusedBase;
    }
  }

  // Post-leg multipliers: entity overlap, trust, provenance, confidence
  const sortedIds = [...entries.keys()].sort(compareIds);
  for (const id of sortedIds) {
    const e = entries.get(id)!;
    const attr = attributesById.get(id);
    const trustScore = attr?.trustScore ?? 1.0;
    const overlap = attr?.entityOverlap ?? 0;

    if (config.entityWeight > 0 && config.queryEntityCount > 0 && overlap > 0) {
      const mult = 1 + config.entityWeight * overlap;
      e.entityOverlapMultiplier = mult;
      e.fusedScore *= mult;
    }

    const trustMult = config.trustFloor + trustScore * (1 - config.trustFloor);
    e.trustMultiplier = trustMult;
    e.fusedScore *= trustMult;

    if (
      config.provenanceWeightStrength > 0 &&
      attr?.provenance !== undefined &&
      isProvenanceTier(attr.provenance)
    ) {
      const provMult = provenanceMultiplier(
        attr.provenance,
        config.provenanceWeightStrength,
      );
      e.provenanceMultiplier = provMult;
      e.fusedScore *= provMult;
    }

    if (config.confidenceWeightStrength > 0) {
      const combined = confidenceWeight(trustScore, attr?.confidence);
      const confMult =
        1 -
        config.confidenceWeightStrength +
        config.confidenceWeightStrength * (combined / 1.0);
      e.confidenceMultiplier = confMult;
      e.fusedScore *= confMult;
    }
  }

  // Recency tie-break within RECENCY_EPSILON
  if (config.recencyHalfLifeMs > 0 && sortedIds.length > 1) {
    const ranked = sortedIds
      .map((id) => ({
        id,
        score: entries.get(id)!.fusedScore,
        updatedAt: attributesById.get(id)?.updatedAt ?? nowMs,
      }))
      .sort(compareByScoreThenId);
    for (let i = 1; i < ranked.length; i += 1) {
      const curr = ranked[i]!;
      const prev = ranked[i - 1]!;
      if (
        prev.score - curr.score <= RECENCY_EPSILON &&
        curr.updatedAt > prev.updatedAt
      ) {
        const ageMs = Math.max(0, nowMs - curr.updatedAt);
        const boost = Math.pow(0.5, ageMs / config.recencyHalfLifeMs);
        if (boost > 0) {
          const delta = RECENCY_EPSILON * boost * 0.5;
          curr.score += delta;
          const entry = entries.get(curr.id)!;
          entry.recencyTieBreakDelta = delta;
          entry.fusedScore += delta;
        }
      }
    }
  }

  return { effectiveWeights, entries };
}

/** Input collected during a traced search in `MemOS` to assemble a trace row. */
export interface BuildRecallTraceInput {
  id: string;
  sessionId: string | null;
  query: string;
  createdAt: number;
  latencyMs: number;
  captureText: boolean;
  fusionOptions: FusionOptions;
  queryEntities: string[];
  limit: number;
  offset: number;
  candidateLimit: number;
  semanticMode?: string;
  clipEnabled: boolean;
  legs: {
    fts: {
      timingMs: number;
      results: ScoredMemory[];
      prfAddedIds?: Set<string>;
    };
    semantic: { timingMs: number; enabled: boolean; results: ScoredMemory[] };
    entity: { timingMs: number; enabled: boolean; results: ScoredMemory[] };
    clip: { timingMs: number; enabled: boolean; results: ScoredMemory[] };
    graph: {
      timingMs: number;
      enabled: boolean;
      injected: Array<{
        memory: ScoredMemory;
        source: string;
        seedId?: string;
        seedFactor?: number;
        fixedScore?: number;
      }>;
    };
  };
  fusedResults: ScoredMemory[];
  preRerankResults: ScoredMemory[];
  postRerankResults: ScoredMemory[];
  rerankConfig: {
    enabled: boolean;
    applied: boolean;
    timingMs: number;
    candidates: number;
  };
  dedupDroppedIds: Set<string>;
  relativeTimeWindowIds?: Set<string>;
  modulatedResults: ScoredMemory[];
  relevanceGateConfig: {
    enabled: boolean;
    ratio: number;
    abstainSimilarity: number | null;
    minResults: number;
  };
  gatedOutcome: {
    results: ScoredMemory[];
    abstained: boolean;
    trimmed: boolean;
    dropped: number;
  };
  mmrConfig: {
    enabled: boolean;
    lambda: number;
    timingMs: number;
  };
  diversifiedResults: ScoredMemory[];
  finalResults: ScoredMemory[];
}

function toLegCandidates(
  results: readonly ScoredMemory[],
  sourceResolver?: (id: string) => string | undefined,
): TraceLegCandidate[] {
  return results.map((r, index) => {
    const source = sourceResolver?.(r.node.id);
    return {
      id: r.node.id,
      rank: index + 1,
      rawScore: r.score,
      ...(source ? { source } : {}),
    };
  });
}

/**
 * Assemble a canonical `RecallTraceRecord` from the stage snapshots captured
 * during a traced retrieval run.
 */
export function buildRecallTraceRecord(
  input: BuildRecallTraceInput,
): RecallTraceRecord {
  const queryTokens = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const clipResults = input.legs.clip.results;
  const defaultImageWeight =
    clipResults.length > 0 ? DEFAULT_IMAGE_LEG_WEIGHT : 0;
  const defaultEntityWeight =
    input.queryEntities.length > 0 ? DEFAULT_ENTITY_WEIGHT : 0;

  const config: TraceRetrievalConfig = {
    fusionMode: input.fusionOptions.fusionMode ?? DEFAULT_FUSION_MODE,
    keywordWeight: input.fusionOptions.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT,
    semanticWeight:
      input.fusionOptions.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT,
    entityLegWeight:
      input.fusionOptions.entityLegWeight ?? DEFAULT_ENTITY_LEG_WEIGHT,
    imageLegWeight: input.fusionOptions.imageLegWeight ?? defaultImageWeight,
    entityWeight: input.fusionOptions.entityWeight ?? defaultEntityWeight,
    rrfK: input.fusionOptions.rrfK ?? DEFAULT_RRF_K,
    adaptiveWeighting: input.fusionOptions.adaptiveWeighting ?? true,
    trustFloor: input.fusionOptions.trustFloor ?? DEFAULT_TRUST_FLOOR,
    confidenceWeightStrength:
      input.fusionOptions.confidenceWeightStrength ?? DEFAULT_CONFIDENCE_WEIGHT,
    provenanceWeightStrength:
      input.fusionOptions.provenanceWeightStrength ??
      DEFAULT_PROVENANCE_WEIGHT_STRENGTH,
    recencyHalfLifeMs:
      input.fusionOptions.recencyHalfLifeMs ?? DEFAULT_RECENCY_HALF_LIFE_MS,
    temporalRecencyStrength:
      input.fusionOptions.temporalRecencyStrength ??
      DEFAULT_TEMPORAL_RECENCY_STRENGTH,
    queryEntityCount: input.queryEntities.length,
    queryTokenCount: queryTokens.length,
    temporalQuery: TEMPORAL_QUERY_RE.test(input.query),
    rerank: {
      enabled: input.rerankConfig.enabled,
      candidates: input.rerankConfig.candidates,
    },
    relevanceGate: {
      enabled: input.relevanceGateConfig.enabled,
      ratio: input.relevanceGateConfig.ratio,
      abstainSimilarity: input.relevanceGateConfig.abstainSimilarity,
      minResults: input.relevanceGateConfig.minResults,
    },
    mmr: {
      enabled: input.mmrConfig.enabled,
      lambda: input.mmrConfig.lambda,
    },
    limit: input.limit,
    offset: input.offset,
    candidateLimit: input.candidateLimit,
  };

  const configHash = computeTraceConfigHash(config);

  const ftsCandidates = toLegCandidates(input.legs.fts.results, (id) =>
    input.legs.fts.prfAddedIds?.has(id) ? "prf" : undefined,
  );
  const semanticCandidates = toLegCandidates(input.legs.semantic.results);
  const entityCandidates = toLegCandidates(input.legs.entity.results);
  const clipCandidates = toLegCandidates(input.legs.clip.results);
  const graphCandidates: TraceLegCandidate[] = input.legs.graph.injected.map(
    (entry, idx) => ({
      id: entry.memory.node.id,
      rank: idx + 1,
      rawScore: entry.memory.score,
      source: entry.source,
    }),
  );

  // Collect every unique MemoryNode in deterministic ID order
  const nodesById = new Map<string, MemoryNode>();
  const registerResults = (list: readonly ScoredMemory[]): void => {
    for (const r of list) {
      if (!nodesById.has(r.node.id)) {
        nodesById.set(r.node.id, r.node);
      }
    }
  };
  registerResults(input.legs.fts.results);
  registerResults(input.legs.semantic.results);
  registerResults(input.legs.entity.results);
  registerResults(input.legs.clip.results);
  registerResults(input.legs.graph.injected.map((x) => x.memory));
  registerResults(input.modulatedResults);
  registerResults(input.finalResults);

  // Track canonical leg introduction order: fts -> semantic -> entity -> clip -> graph
  const matchedLegsById = new Map<string, TraceLegName[]>();
  const recordLegMatch = (
    candidates: readonly TraceLegCandidate[],
    leg: TraceLegName,
  ): void => {
    for (const c of candidates) {
      const list = matchedLegsById.get(c.id);
      if (!list) {
        matchedLegsById.set(c.id, [leg]);
      } else if (!list.includes(leg)) {
        list.push(leg);
      }
    }
  };
  recordLegMatch(ftsCandidates, "fts");
  recordLegMatch(semanticCandidates, "semantic");
  recordLegMatch(entityCandidates, "entity");
  recordLegMatch(clipCandidates, "clip");
  recordLegMatch(graphCandidates, "graph");

  const fusedScoreById = new Map<string, number>();
  for (const r of input.fusedResults) fusedScoreById.set(r.node.id, r.score);

  const preRerankScoreById = new Map<string, number>();
  const preRerankRankById = new Map<string, number>();
  input.preRerankResults.forEach((r, idx) => {
    preRerankScoreById.set(r.node.id, r.score);
    preRerankRankById.set(r.node.id, idx + 1);
  });

  const postRerankScoreById = new Map<string, number>();
  const postRerankRankById = new Map<string, number>();
  input.postRerankResults.forEach((r, idx) => {
    postRerankScoreById.set(r.node.id, r.score);
    postRerankRankById.set(r.node.id, idx + 1);
  });

  const modulatedScoreById = new Map<string, number>();
  for (const r of input.modulatedResults) {
    modulatedScoreById.set(r.node.id, r.score);
  }

  const finalScoreById = new Map<string, number>();
  for (const r of input.finalResults) {
    finalScoreById.set(r.node.id, r.score);
  }

  const graphInjectedById = new Map<
    string,
    BuildRecallTraceInput["legs"]["graph"]["injected"][number]
  >();
  for (const item of input.legs.graph.injected) {
    if (!graphInjectedById.has(item.memory.node.id)) {
      graphInjectedById.set(item.memory.node.id, item);
    }
  }

  // Build candidate attributes first so computeDeterministicFusion has exact metadata
  const attributesById = new Map<
    string,
    TraceCandidateBreakdown["attributes"]
  >();
  for (const id of [...nodesById.keys()].sort(compareIds)) {
    const node = nodesById.get(id)!;
    const overlap =
      input.queryEntities.length > 0
        ? entityOverlap(input.queryEntities, {
            tags: node.tags,
            metadata: node.metadata,
          })
        : 0;
    const fusedLive = fusedScoreById.get(id);
    const preRerank = preRerankScoreById.get(id);
    const postRerank = postRerankScoreById.get(id);
    const modulated = modulatedScoreById.get(id);

    // Combine post-fusion multiplicative effects (anomaly, contradiction, PPR, modulators)
    // excluding rerank replacement so replay can toggle rerank cleanly.
    const preRerankRatio =
      fusedLive !== undefined && fusedLive > 0 && preRerank !== undefined
        ? preRerank / fusedLive
        : 1;
    const postRerankModRatio =
      postRerank !== undefined &&
      postRerank > 0 &&
      modulated !== undefined &&
      !input.dedupDroppedIds.has(id)
        ? modulated / postRerank
        : 1;
    const postFusionMultiplier = preRerankRatio * postRerankModRatio;

    const graphMeta = graphInjectedById.get(id);
    const rerankScore =
      input.rerankConfig.applied &&
      postRerankRankById.has(id) &&
      (preRerankRankById.get(id) ?? Infinity) <= input.rerankConfig.candidates
        ? postRerankScoreById.get(id)
        : undefined;

    attributesById.set(id, {
      updatedAt: node.updatedAt,
      trustScore: node.trustScore ?? 1.0,
      ...(node.confidence !== undefined ? { confidence: node.confidence } : {}),
      ...(node.provenance !== undefined && isProvenanceTier(node.provenance)
        ? { provenance: node.provenance }
        : {}),
      entityOverlap: overlap,
      exactTermMatch: computeCandidateExactTermMatch(input.query, node),
      postFusionMultiplier,
      dedupDropped: input.dedupDroppedIds.has(id),
      ...(input.relativeTimeWindowIds?.has(id)
        ? { relativeTimeInWindow: true }
        : {}),
      ...(graphMeta?.seedId !== undefined
        ? { graphSeedId: graphMeta.seedId }
        : {}),
      ...(graphMeta?.seedFactor !== undefined
        ? { graphSeedFactor: graphMeta.seedFactor }
        : {}),
      ...(graphMeta?.fixedScore !== undefined
        ? { graphFixedScore: graphMeta.fixedScore }
        : {}),
      ...(rerankScore !== undefined ? { rerankScore } : {}),
    });
  }

  const fusionComputed = computeDeterministicFusion(
    {
      fts: ftsCandidates,
      semantic: semanticCandidates,
      entity: entityCandidates,
      clip: clipCandidates,
    },
    attributesById,
    config,
    input.query.length > 0,
    input.createdAt,
  );

  // Build rerank deltas
  const rerankDeltas: TraceRerankDelta[] = [];
  if (input.rerankConfig.applied) {
    for (const r of input.postRerankResults) {
      const id = r.node.id;
      const rankBefore = preRerankRankById.get(id);
      const rankAfter = postRerankRankById.get(id);
      const scoreBefore = preRerankScoreById.get(id);
      const scoreAfter = postRerankScoreById.get(id);
      if (
        rankBefore !== undefined &&
        rankAfter !== undefined &&
        scoreBefore !== undefined &&
        scoreAfter !== undefined &&
        (rankBefore !== rankAfter || scoreBefore !== scoreAfter)
      ) {
        rerankDeltas.push({
          id,
          rankBefore,
          rankAfter,
          rankDelta: rankBefore - rankAfter,
          scoreBefore,
          scoreAfter,
          scoreDelta: scoreAfter - scoreBefore,
        });
      }
    }
  }

  // Build relevance gate summary
  const keptGateSet = new Set(input.gatedOutcome.results.map((r) => r.node.id));
  const droppedIds = input.modulatedResults
    .map((r) => r.node.id)
    .filter((id) => !keptGateSet.has(id));

  // Build MMR deltas (comparing gated canonical order vs diversified order)
  const mmrDeltas: TraceMmrDelta[] = [];
  if (input.mmrConfig.enabled && input.gatedOutcome.results.length > 1) {
    const preMmrRank = new Map<string, number>();
    input.gatedOutcome.results.forEach((r, idx) =>
      preMmrRank.set(r.node.id, idx + 1),
    );
    input.diversifiedResults.forEach((r, idx) => {
      const before = preMmrRank.get(r.node.id);
      const after = idx + 1;
      if (before !== undefined && before !== after) {
        mmrDeltas.push({
          id: r.node.id,
          rankBefore: before,
          rankAfter: after,
          rankDelta: before - after,
        });
      }
    });
  }

  // Assemble candidate breakdowns sorted deterministically by (finalScore DESC, id ASC)
  const candidates: TraceCandidateBreakdown[] = [...nodesById.keys()]
    .sort(compareIds)
    .map((id) => {
      const node = nodesById.get(id)!;
      const attr = attributesById.get(id)!;
      const fusedEntry = fusionComputed.entries.get(id);
      const matchedLegs = matchedLegsById.get(id) ?? ["fts"];
      const introducedBy = matchedLegs[0]!;
      const graphMeta = graphInjectedById.get(id);

      const fusedScore = fusedEntry?.fusedScore ?? fusedScoreById.get(id) ?? 0;
      const preRerankScore =
        preRerankScoreById.get(id) ??
        graphMeta?.memory.score ??
        fusedScore * attr.postFusionMultiplier;
      const finalScore =
        finalScoreById.get(id) ??
        modulatedScoreById.get(id) ??
        postRerankScoreById.get(id) ??
        preRerankScore;

      const breakdown: TraceCandidateBreakdown = {
        id,
        introducedBy,
        matchedLegs,
        attributes: attr,
        contributions: {
          fts: fusedEntry?.fts ?? 0,
          semantic: fusedEntry?.semantic ?? 0,
          ...(fusedEntry?.semanticRaw !== undefined
            ? { semanticRaw: fusedEntry.semanticRaw }
            : {}),
          entityLeg: fusedEntry?.entityLeg ?? 0,
          clip: fusedEntry?.clip ?? 0,
          ...(fusedEntry?.clipRaw !== undefined
            ? { clipRaw: fusedEntry.clipRaw }
            : {}),
          fusedBase: fusedEntry?.fusedBase ?? 0,
          temporalRecencyMultiplier: fusedEntry?.temporalRecencyMultiplier ?? 1,
          entityOverlapMultiplier: fusedEntry?.entityOverlapMultiplier ?? 1,
          trustMultiplier: fusedEntry?.trustMultiplier ?? 1,
          provenanceMultiplier: fusedEntry?.provenanceMultiplier ?? 1,
          confidenceMultiplier: fusedEntry?.confidenceMultiplier ?? 1,
          recencyTieBreakDelta: fusedEntry?.recencyTieBreakDelta ?? 0,
          fusedScore,
          postFusionMultiplier: attr.postFusionMultiplier,
          ...(graphMeta !== undefined
            ? { graphInjectedScore: graphMeta.memory.score }
            : {}),
          preRerankScore,
          ...(attr.rerankScore !== undefined
            ? { rerankScore: attr.rerankScore }
            : {}),
          finalScore,
        },
        ...(input.captureText
          ? {
              text: {
                summary: node.summary,
                content: node.content,
              },
            }
          : {}),
      };
      return breakdown;
    })
    .sort((a, b) => {
      if (b.contributions.finalScore !== a.contributions.finalScore) {
        return b.contributions.finalScore - a.contributions.finalScore;
      }
      return compareIds(a.id, b.id);
    });

  const allNodesSorted = [...nodesById.keys()]
    .sort(compareIds)
    .map((id) => nodesById.get(id)!);
  const pairwiseSimilarity = computePairwiseMmrSimilarity(allNodesSorted);

  const legs: RecallTracePayload["legs"] = {
    fts: {
      enabled: true,
      timingMs: input.legs.fts.timingMs,
      candidates: ftsCandidates,
    },
    semantic: {
      enabled: input.legs.semantic.enabled,
      timingMs: input.legs.semantic.timingMs,
      candidates: semanticCandidates,
      ...(input.semanticMode ? { mode: input.semanticMode } : {}),
    },
    entity: {
      enabled: input.legs.entity.enabled,
      timingMs: input.legs.entity.timingMs,
      candidates: entityCandidates,
    },
    graph: {
      enabled: input.legs.graph.enabled,
      timingMs: input.legs.graph.timingMs,
      candidates: graphCandidates,
    },
    ...(input.clipEnabled
      ? {
          clip: {
            enabled: input.legs.clip.enabled,
            timingMs: input.legs.clip.timingMs,
            candidates: clipCandidates,
          } satisfies TraceLegRecord,
        }
      : {}),
  };

  const payload: RecallTracePayload = {
    schemaVersion: 1,
    captureText: input.captureText,
    config,
    effectiveWeights: fusionComputed.effectiveWeights,
    legs,
    candidates,
    rerank: {
      enabled: input.rerankConfig.enabled,
      applied: input.rerankConfig.applied,
      timingMs: input.rerankConfig.timingMs,
      candidateWindow: input.rerankConfig.candidates,
      deltas: rerankDeltas,
    },
    relevanceGate: {
      enabled: input.relevanceGateConfig.enabled,
      abstained: input.gatedOutcome.abstained,
      trimmed: input.gatedOutcome.trimmed,
      droppedCount: droppedIds.length,
      droppedIds,
    },
    mmr: {
      enabled: input.mmrConfig.enabled,
      applied: input.mmrConfig.enabled && input.gatedOutcome.results.length > 1,
      lambda: input.mmrConfig.enabled ? input.mmrConfig.lambda : null,
      timingMs: input.mmrConfig.timingMs,
      deltas: mmrDeltas,
    },
    pairwiseSimilarity,
    finalIds: input.finalResults.map((r) => r.node.id),
  };

  return {
    id: input.id,
    sessionId: input.sessionId,
    query: input.query,
    configHash,
    createdAt: input.createdAt,
    latencyMs: input.latencyMs,
    payload,
  };
}

/**
 * Build a structured `ExplainRecallReport` from a stored `RecallTraceRecord`.
 */
export function explainRecallTrace(
  trace: RecallTraceRecord,
): ExplainRecallReport {
  const { payload } = trace;
  const candidateById = new Map<string, TraceCandidateBreakdown>();
  for (const c of payload.candidates) {
    candidateById.set(c.id, c);
  }
  const rerankById = new Map<string, TraceRerankDelta>();
  for (const d of payload.rerank.deltas) {
    rerankById.set(d.id, d);
  }
  const mmrById = new Map<string, TraceMmrDelta>();
  for (const d of payload.mmr.deltas) {
    mmrById.set(d.id, d);
  }

  const finalItems = payload.finalIds.map((id, idx) => {
    const breakdown = candidateById.get(id);
    const rerankDelta = rerankById.get(id);
    const mmrDelta = mmrById.get(id);
    return {
      rank: idx + 1,
      id,
      finalScore: breakdown?.contributions.finalScore ?? 0,
      introducedBy: breakdown?.introducedBy ?? ("fts" as TraceLegName),
      matchedLegs: breakdown?.matchedLegs ?? (["fts"] as TraceLegName[]),
      contributions: breakdown?.contributions ?? {
        fts: 0,
        semantic: 0,
        entityLeg: 0,
        clip: 0,
        fusedBase: 0,
        temporalRecencyMultiplier: 1,
        entityOverlapMultiplier: 1,
        trustMultiplier: 1,
        provenanceMultiplier: 1,
        confidenceMultiplier: 1,
        recencyTieBreakDelta: 0,
        fusedScore: 0,
        postFusionMultiplier: 1,
        preRerankScore: 0,
        finalScore: 0,
      },
      ...(rerankDelta ? { rerankDelta } : {}),
      ...(mmrDelta ? { mmrDelta } : {}),
      ...(breakdown?.text ? { text: breakdown.text } : {}),
    };
  });

  return {
    traceId: trace.id,
    sessionId: trace.sessionId,
    query: trace.query,
    configHash: trace.configHash,
    createdAt: trace.createdAt,
    latencyMs: trace.latencyMs,
    captureText: payload.captureText,
    config: payload.config,
    effectiveWeights: payload.effectiveWeights,
    legs: payload.legs,
    rerank: payload.rerank,
    relevanceGate: payload.relevanceGate,
    mmr: payload.mmr,
    finalItems,
  };
}

function fmtNum(val: number, digits = 4): string {
  if (val !== 0 && Math.abs(val) < 10 ** -digits) {
    return val.toExponential(2);
  }
  return val.toFixed(digits);
}

/**
 * Format an `ExplainRecallReport` into a human-readable CLI breakdown.
 */
export function formatExplainRecall(report: ExplainRecallReport): string {
  const lines: string[] = [];
  lines.push(`Trace:       ${report.traceId}`);
  if (report.sessionId) {
    lines.push(`Session:     ${report.sessionId}`);
  }
  lines.push(`Query:       ${JSON.stringify(report.query)}`);
  lines.push(`Created:     ${new Date(report.createdAt).toISOString()}`);
  lines.push(`Latency:     ${report.latencyMs.toFixed(2)} ms`);
  lines.push(`Config hash: ${report.configHash}`);
  lines.push("");

  const cfg = report.config;
  const ew = report.effectiveWeights;
  lines.push("Configuration:");
  lines.push(
    `  Fusion mode:       ${cfg.fusionMode} (adaptive=${cfg.adaptiveWeighting}, rrfK=${cfg.rrfK})`,
  );
  lines.push(
    `  Configured weights: kw=${fmtNum(cfg.keywordWeight, 3)} sem=${fmtNum(cfg.semanticWeight, 3)} ent=${fmtNum(cfg.entityLegWeight, 3)} clip=${fmtNum(cfg.imageLegWeight, 3)}`,
  );
  lines.push(
    `  Effective weights:  kw=${fmtNum(ew.keyword, 3)} sem=${fmtNum(ew.semantic, 3)} ent=${fmtNum(ew.entityLeg, 3)} clip=${fmtNum(ew.clip, 3)}`,
  );
  lines.push(
    `  Rerank:            ${report.rerank.enabled ? (report.rerank.applied ? `applied (window=${report.rerank.candidateWindow}, ${report.rerank.timingMs.toFixed(2)} ms)` : "enabled (not applied)") : "off"}`,
  );
  lines.push(
    `  Relevance gate:    ${
      !report.relevanceGate.enabled
        ? "off"
        : report.relevanceGate.abstained
          ? `ABSTAINED (floor=${cfg.relevanceGate.abstainSimilarity ?? "n/a"})`
          : `on (ratio=${cfg.relevanceGate.ratio}, dropped=${report.relevanceGate.droppedCount})`
    }`,
  );
  lines.push(
    `  MMR:               ${report.mmr.enabled ? `on (lambda=${report.mmr.lambda ?? cfg.mmr.lambda}, ${report.mmr.timingMs.toFixed(2)} ms)` : "off"}`,
  );
  lines.push("");

  lines.push("Per-leg candidates & timings:");
  const legOrder: Array<readonly [string, TraceLegRecord | undefined]> = [
    ["fts", report.legs.fts],
    ["semantic", report.legs.semantic],
    ["entity", report.legs.entity],
    ["graph", report.legs.graph],
    ...(report.legs.clip ? ([["clip", report.legs.clip]] as const) : []),
  ];
  for (const [name, leg] of legOrder) {
    if (!leg) continue;
    const modeTag = leg.mode ? ` [${leg.mode}]` : "";
    const status = leg.enabled ? "enabled" : "disabled";
    lines.push(
      `  - ${name.padEnd(8)} (${status}${modeTag}) ${leg.timingMs.toFixed(2)} ms — ${leg.candidates.length} candidate(s)`,
    );
    for (const c of leg.candidates.slice(0, 10)) {
      const srcTag = c.source ? ` (${c.source})` : "";
      lines.push(
        `      #${c.rank} ${c.id}  raw=${fmtNum(c.rawScore)}${srcTag}`,
      );
    }
    if (leg.candidates.length > 10) {
      lines.push(`      ... +${leg.candidates.length - 10} more`);
    }
  }
  lines.push("");

  lines.push(`Final ranking (${report.finalItems.length} item(s)):`);
  if (report.finalItems.length === 0) {
    lines.push("  (no results returned)");
  } else {
    for (const item of report.finalItems) {
      const c = item.contributions;
      const parts: string[] = [];
      if (c.fts !== 0) parts.push(`fts=${fmtNum(c.fts)}`);
      if (c.semantic !== 0) {
        const rawNote =
          c.semanticRaw !== undefined
            ? ` (cos=${fmtNum(c.semanticRaw, 3)})`
            : "";
        parts.push(`sem=${fmtNum(c.semantic)}${rawNote}`);
      }
      if (c.entityLeg !== 0) parts.push(`entLeg=${fmtNum(c.entityLeg)}`);
      if (c.clip !== 0) parts.push(`clip=${fmtNum(c.clip)}`);
      if (c.graphInjectedScore !== undefined) {
        parts.push(`graph=${fmtNum(c.graphInjectedScore)}`);
      }
      if (c.entityOverlapMultiplier !== 1) {
        parts.push(`entBoost=x${fmtNum(c.entityOverlapMultiplier, 3)}`);
      }
      if (c.trustMultiplier !== 1) {
        parts.push(`trust=x${fmtNum(c.trustMultiplier, 3)}`);
      }
      if (c.provenanceMultiplier !== 1) {
        parts.push(`prov=x${fmtNum(c.provenanceMultiplier, 3)}`);
      }
      if (c.confidenceMultiplier !== 1) {
        parts.push(`conf=x${fmtNum(c.confidenceMultiplier, 3)}`);
      }
      if (c.postFusionMultiplier !== 1) {
        parts.push(`mod=x${fmtNum(c.postFusionMultiplier, 3)}`);
      }
      if (c.rerankScore !== undefined) {
        parts.push(`rerank=${fmtNum(c.rerankScore)}`);
      }
      if (item.rerankDelta) {
        const sign = item.rerankDelta.rankDelta >= 0 ? "+" : "";
        parts.push(`rerankRank=${sign}${item.rerankDelta.rankDelta}`);
      }
      if (item.mmrDelta) {
        const sign = item.mmrDelta.rankDelta >= 0 ? "+" : "";
        parts.push(`mmrRank=${sign}${item.mmrDelta.rankDelta}`);
      }

      lines.push(
        `  #${item.rank} ${item.id}  score=${fmtNum(item.finalScore)}  introduced=${item.introducedBy}  legs=[${item.matchedLegs.join(",")}]`,
      );
      lines.push(`      contributions: ${parts.join(", ") || "none"}`);
      if (item.text) {
        lines.push(`      summary: ${item.text.summary}`);
      }
    }
  }

  return lines.join("\n");
}

function resolveReplayConfig(
  base: TraceRetrievalConfig,
  override: ReplayConfigOverride = {},
): TraceRetrievalConfig {
  const next: TraceRetrievalConfig = {
    ...base,
    rerank: { ...base.rerank },
    relevanceGate: { ...base.relevanceGate },
    mmr: { ...base.mmr },
  };

  const fusionMode = override.fusionMode ?? override.fusion?.fusionMode;
  if (fusionMode === "convex" || fusionMode === "rrf") {
    next.fusionMode = fusionMode;
  }

  const keywordWeight =
    override.keywordWeight ??
    override.fusion?.keywordWeight ??
    override.weights?.keyword;
  if (typeof keywordWeight === "number" && Number.isFinite(keywordWeight)) {
    next.keywordWeight = Math.max(0, keywordWeight);
  }

  const semanticWeight =
    override.semanticWeight ??
    override.fusion?.semanticWeight ??
    override.weights?.semantic;
  if (typeof semanticWeight === "number" && Number.isFinite(semanticWeight)) {
    next.semanticWeight = Math.max(0, semanticWeight);
  }

  const entityLegWeight =
    override.entityLegWeight ??
    override.fusion?.entityLegWeight ??
    override.weights?.entityLeg;
  if (typeof entityLegWeight === "number" && Number.isFinite(entityLegWeight)) {
    next.entityLegWeight = Math.max(0, entityLegWeight);
  }

  const imageLegWeight =
    override.imageLegWeight ??
    override.fusion?.imageLegWeight ??
    override.weights?.imageLeg ??
    override.weights?.clip;
  if (typeof imageLegWeight === "number" && Number.isFinite(imageLegWeight)) {
    next.imageLegWeight = Math.max(0, imageLegWeight);
  }

  const entityWeight = override.entityWeight ?? override.fusion?.entityWeight;
  if (typeof entityWeight === "number" && Number.isFinite(entityWeight)) {
    next.entityWeight = Math.max(0, entityWeight);
  }

  const rrfK = override.rrfK ?? override.fusion?.rrfK;
  if (typeof rrfK === "number" && Number.isFinite(rrfK) && rrfK > 0) {
    next.rrfK = rrfK;
  }

  const adaptiveWeighting =
    override.adaptiveWeighting ?? override.fusion?.adaptiveWeighting;
  if (typeof adaptiveWeighting === "boolean") {
    next.adaptiveWeighting = adaptiveWeighting;
  }

  const trustFloor = override.trustFloor ?? override.fusion?.trustFloor;
  if (typeof trustFloor === "number" && Number.isFinite(trustFloor)) {
    next.trustFloor = trustFloor;
  }

  const confStrength =
    override.confidenceWeightStrength ??
    override.fusion?.confidenceWeightStrength;
  if (typeof confStrength === "number" && Number.isFinite(confStrength)) {
    next.confidenceWeightStrength = confStrength;
  }

  const provStrength =
    override.provenanceWeightStrength ??
    override.fusion?.provenanceWeightStrength;
  if (typeof provStrength === "number" && Number.isFinite(provStrength)) {
    next.provenanceWeightStrength = provStrength;
  }

  const recencyHalfLife =
    override.recencyHalfLifeMs ?? override.fusion?.recencyHalfLifeMs;
  if (typeof recencyHalfLife === "number" && Number.isFinite(recencyHalfLife)) {
    next.recencyHalfLifeMs = recencyHalfLife;
  }

  const temporalStrength =
    override.temporalRecencyStrength ??
    override.fusion?.temporalRecencyStrength;
  if (
    typeof temporalStrength === "number" &&
    Number.isFinite(temporalStrength)
  ) {
    next.temporalRecencyStrength = temporalStrength;
  }

  // MMR overrides
  if (override.mmr === false || override.mmrLambda === null) {
    next.mmr.enabled = false;
  } else if (override.mmr === true) {
    next.mmr.enabled = true;
  } else if (
    typeof override.mmr === "number" &&
    Number.isFinite(override.mmr)
  ) {
    next.mmr.enabled = override.mmr < 1;
    next.mmr.lambda = Math.min(1, Math.max(0, override.mmr));
  } else if (typeof override.mmr === "object" && override.mmr !== null) {
    if (typeof override.mmr.enabled === "boolean") {
      next.mmr.enabled = override.mmr.enabled;
    }
    if (
      typeof override.mmr.lambda === "number" &&
      Number.isFinite(override.mmr.lambda)
    ) {
      next.mmr.lambda = Math.min(1, Math.max(0, override.mmr.lambda));
      if (override.mmr.enabled === undefined) next.mmr.enabled = true;
    }
  }
  if (override.retrieval?.mmr) {
    const m = override.retrieval.mmr;
    if (typeof m.enabled === "boolean") next.mmr.enabled = m.enabled;
    if (typeof m.lambda === "number" && Number.isFinite(m.lambda)) {
      next.mmr.lambda = Math.min(1, Math.max(0, m.lambda));
      if (m.enabled === undefined) next.mmr.enabled = true;
    }
  }
  if (
    typeof override.mmrLambda === "number" &&
    Number.isFinite(override.mmrLambda)
  ) {
    next.mmr.lambda = Math.min(1, Math.max(0, override.mmrLambda));
    next.mmr.enabled = override.mmrLambda < 1;
  }

  // Relevance gate overrides
  if (override.relevanceGate === false) {
    next.relevanceGate.enabled = false;
  } else if (override.relevanceGate === true) {
    next.relevanceGate.enabled = true;
  } else if (
    typeof override.relevanceGate === "object" &&
    override.relevanceGate !== null
  ) {
    const g = override.relevanceGate;
    if (typeof g.enabled === "boolean") next.relevanceGate.enabled = g.enabled;
    if (typeof g.ratio === "number" && Number.isFinite(g.ratio)) {
      next.relevanceGate.ratio = Math.max(0, g.ratio);
      if (g.enabled === undefined) next.relevanceGate.enabled = true;
    }
    if (g.abstainSimilarity === null) {
      next.relevanceGate.abstainSimilarity = null;
    } else if (
      typeof g.abstainSimilarity === "number" &&
      Number.isFinite(g.abstainSimilarity)
    ) {
      next.relevanceGate.abstainSimilarity = g.abstainSimilarity;
      if (g.enabled === undefined) next.relevanceGate.enabled = true;
    }
    if (typeof g.minResults === "number" && Number.isFinite(g.minResults)) {
      next.relevanceGate.minResults = Math.max(0, Math.floor(g.minResults));
    }
  }
  if (override.retrieval?.relevanceGate) {
    const g = override.retrieval.relevanceGate;
    if (typeof g.enabled === "boolean") next.relevanceGate.enabled = g.enabled;
    if (typeof g.ratio === "number" && Number.isFinite(g.ratio)) {
      next.relevanceGate.ratio = Math.max(0, g.ratio);
      if (g.enabled === undefined) next.relevanceGate.enabled = true;
    }
    if (g.abstainSimilarity === null) {
      next.relevanceGate.abstainSimilarity = null;
    } else if (
      typeof g.abstainSimilarity === "number" &&
      Number.isFinite(g.abstainSimilarity)
    ) {
      next.relevanceGate.abstainSimilarity = g.abstainSimilarity;
      if (g.enabled === undefined) next.relevanceGate.enabled = true;
    }
    if (typeof g.minResults === "number" && Number.isFinite(g.minResults)) {
      next.relevanceGate.minResults = Math.max(0, Math.floor(g.minResults));
    }
  }
  const thresholdOverride =
    override.relevanceGateThreshold !== undefined
      ? override.relevanceGateThreshold
      : override.relevanceRatio;
  if (thresholdOverride === null) {
    next.relevanceGate.ratio = 0;
  } else if (
    typeof thresholdOverride === "number" &&
    Number.isFinite(thresholdOverride)
  ) {
    next.relevanceGate.ratio = Math.max(0, thresholdOverride);
    if (override.relevanceGate !== false) {
      next.relevanceGate.enabled = true;
    }
  }
  if (override.abstainSimilarity === null) {
    next.relevanceGate.abstainSimilarity = null;
  } else if (
    typeof override.abstainSimilarity === "number" &&
    Number.isFinite(override.abstainSimilarity)
  ) {
    next.relevanceGate.abstainSimilarity = override.abstainSimilarity;
    if (override.relevanceGate !== false) {
      next.relevanceGate.enabled = true;
    }
  }

  // Rerank override
  if (typeof override.rerank === "boolean") {
    next.rerank.enabled = override.rerank;
  }

  // Limit override
  if (
    typeof override.limit === "number" &&
    Number.isFinite(override.limit) &&
    override.limit > 0
  ) {
    next.limit = Math.floor(override.limit);
  }

  return next;
}

function diffConfigs(
  before: TraceRetrievalConfig,
  after: TraceRetrievalConfig,
): Array<{ field: string; before: unknown; after: unknown }> {
  const flatBefore: Record<string, unknown> = {
    fusionMode: before.fusionMode,
    keywordWeight: before.keywordWeight,
    semanticWeight: before.semanticWeight,
    entityLegWeight: before.entityLegWeight,
    imageLegWeight: before.imageLegWeight,
    entityWeight: before.entityWeight,
    rrfK: before.rrfK,
    adaptiveWeighting: before.adaptiveWeighting,
    trustFloor: before.trustFloor,
    confidenceWeightStrength: before.confidenceWeightStrength,
    provenanceWeightStrength: before.provenanceWeightStrength,
    recencyHalfLifeMs: before.recencyHalfLifeMs,
    temporalRecencyStrength: before.temporalRecencyStrength,
    "rerank.enabled": before.rerank.enabled,
    "relevanceGate.enabled": before.relevanceGate.enabled,
    "relevanceGate.ratio": before.relevanceGate.ratio,
    "relevanceGate.abstainSimilarity": before.relevanceGate.abstainSimilarity,
    "relevanceGate.minResults": before.relevanceGate.minResults,
    "mmr.enabled": before.mmr.enabled,
    "mmr.lambda": before.mmr.lambda,
    limit: before.limit,
  };
  const flatAfter: Record<string, unknown> = {
    fusionMode: after.fusionMode,
    keywordWeight: after.keywordWeight,
    semanticWeight: after.semanticWeight,
    entityLegWeight: after.entityLegWeight,
    imageLegWeight: after.imageLegWeight,
    entityWeight: after.entityWeight,
    rrfK: after.rrfK,
    adaptiveWeighting: after.adaptiveWeighting,
    trustFloor: after.trustFloor,
    confidenceWeightStrength: after.confidenceWeightStrength,
    provenanceWeightStrength: after.provenanceWeightStrength,
    recencyHalfLifeMs: after.recencyHalfLifeMs,
    temporalRecencyStrength: after.temporalRecencyStrength,
    "rerank.enabled": after.rerank.enabled,
    "relevanceGate.enabled": after.relevanceGate.enabled,
    "relevanceGate.ratio": after.relevanceGate.ratio,
    "relevanceGate.abstainSimilarity": after.relevanceGate.abstainSimilarity,
    "relevanceGate.minResults": after.relevanceGate.minResults,
    "mmr.enabled": after.mmr.enabled,
    "mmr.lambda": after.mmr.lambda,
    limit: after.limit,
  };

  const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
  for (const key of Object.keys(flatBefore).sort(compareIds)) {
    if (flatBefore[key] !== flatAfter[key]) {
      changes.push({
        field: key,
        before: flatBefore[key],
        after: flatAfter[key],
      });
    }
  }
  return changes;
}

/**
 * Recompute retrieval ranking purely from stored candidate scores inside a
 * `RecallTraceRecord` — zero re-embedding, zero database access, 100%
 * deterministic across runs.
 */
export function replayRecallTrace(
  trace: RecallTraceRecord,
  override: ReplayConfigOverride = {},
): ReplayRecallReport {
  const { payload } = trace;
  const effectiveConfig = resolveReplayConfig(payload.config, override);
  const replayConfigHash = computeTraceConfigHash(effectiveConfig);
  const configChanges = diffConfigs(payload.config, effectiveConfig);
  const warnings: string[] = [];

  const candidateById = new Map<string, TraceCandidateBreakdown>();
  const attributesById = new Map<
    string,
    TraceCandidateBreakdown["attributes"]
  >();
  for (const c of payload.candidates) {
    candidateById.set(c.id, c);
    attributesById.set(c.id, c.attributes);
  }

  // Stage 1: Re-run fusion over stored per-leg raw scores
  const fusion = computeDeterministicFusion(
    {
      fts: payload.legs.fts.candidates,
      semantic: payload.legs.semantic.candidates,
      entity: payload.legs.entity.candidates,
      clip: payload.legs.clip?.candidates ?? [],
    },
    attributesById,
    effectiveConfig,
    trace.query.length > 0,
    trace.createdAt,
  );

  // Stage 2: Apply stored post-fusion multipliers + graph-injected candidates
  interface ReplayScoredItem {
    id: string;
    score: number;
    semanticRaw?: number;
    clipRaw?: number;
    exactTermMatch: boolean;
    relativeTimeInWindow: boolean;
    rerankScore?: number;
  }

  const poolMap = new Map<string, ReplayScoredItem>();
  for (const id of [...fusion.entries.keys()].sort(compareIds)) {
    const f = fusion.entries.get(id)!;
    const attr = attributesById.get(id);
    if (attr?.dedupDropped) continue;
    const mult = attr?.postFusionMultiplier ?? 1;
    poolMap.set(id, {
      id,
      score: f.fusedScore * mult,
      ...(f.semanticRaw !== undefined ? { semanticRaw: f.semanticRaw } : {}),
      ...(f.clipRaw !== undefined ? { clipRaw: f.clipRaw } : {}),
      exactTermMatch: attr?.exactTermMatch ?? false,
      relativeTimeInWindow: attr?.relativeTimeInWindow === true,
      ...(attr?.rerankScore !== undefined
        ? { rerankScore: attr.rerankScore }
        : {}),
    });
  }

  // Graph-injected candidates (neighbours / PPR unseen / session / multiHop)
  for (const gc of payload.legs.graph.candidates) {
    if (poolMap.has(gc.id)) continue;
    const attr = attributesById.get(gc.id);
    if (attr?.dedupDropped) continue;
    let score: number;
    if (
      attr?.graphSeedId !== undefined &&
      attr?.graphSeedFactor !== undefined &&
      poolMap.has(attr.graphSeedId)
    ) {
      score =
        poolMap.get(attr.graphSeedId)!.score *
        attr.graphSeedFactor *
        (attr.postFusionMultiplier ?? 1);
    } else {
      score = attr?.graphFixedScore ?? gc.rawScore;
    }
    poolMap.set(gc.id, {
      id: gc.id,
      score,
      exactTermMatch: attr?.exactTermMatch ?? false,
      relativeTimeInWindow: attr?.relativeTimeInWindow === true,
      ...(attr?.rerankScore !== undefined
        ? { rerankScore: attr.rerankScore }
        : {}),
    });
  }

  let ranked: ReplayScoredItem[] = [...poolMap.keys()]
    .sort(compareIds)
    .map((id) => poolMap.get(id)!)
    .sort(compareByScoreThenId);

  // Preserve relative-time window promotion if recorded during live run
  if (ranked.some((r) => r.relativeTimeInWindow)) {
    const inWindow = ranked.filter((r) => r.relativeTimeInWindow);
    const outOfWindow = ranked.filter((r) => !r.relativeTimeInWindow);
    ranked = [...inWindow, ...outOfWindow];
  }

  // Stage 3: Rerank on/off using stored cross-encoder scores
  if (effectiveConfig.rerank.enabled && ranked.length >= 2) {
    const anyRerankScore = ranked.some((r) => r.rerankScore !== undefined);
    if (!anyRerankScore) {
      warnings.push(
        "rerank=true requested, but trace was captured without cross-encoder scores; keeping fused order.",
      );
    } else {
      const windowSize = Math.min(
        effectiveConfig.rerank.candidates || 20,
        ranked.length,
      );
      const head = ranked.slice(0, windowSize).map((item) => ({
        ...item,
        score: item.rerankScore ?? item.score,
      }));
      head.sort(compareByScoreThenId);
      const tail = ranked.slice(windowSize);
      ranked = [...head, ...tail];
    }
  }

  const allReplayedScores = new Map<string, number>();
  for (const r of ranked) {
    allReplayedScores.set(r.id, r.score);
  }

  // Stage 4: Relevance gate (abstention + tail trimming + minResults floor)
  let abstained = false;
  let trimmed = false;
  const droppedIds: string[] = [];

  let gated = ranked;
  if (effectiveConfig.relevanceGate.enabled && ranked.length > 0) {
    const abstainFloor = effectiveConfig.relevanceGate.abstainSimilarity;
    if (abstainFloor !== null && abstainFloor !== undefined) {
      const sims: number[] = [];
      for (const r of ranked) {
        const sim = r.semanticRaw ?? r.clipRaw;
        if (typeof sim === "number") sims.push(sim);
      }
      if (
        sims.length > 0 &&
        Math.max(...sims) < abstainFloor &&
        !ranked.some((r) => r.exactTermMatch)
      ) {
        abstained = true;
        gated = [];
      }
    }

    if (!abstained && effectiveConfig.relevanceGate.ratio > 0) {
      const topScore = ranked[0]!.score;
      if (topScore > 0) {
        const floor = topScore * effectiveConfig.relevanceGate.ratio;
        let kept = ranked.filter((r) => r.score >= floor);
        const minRes = effectiveConfig.relevanceGate.minResults;
        if (minRes > 0 && kept.length < minRes && kept.length < ranked.length) {
          kept = ranked.slice(0, Math.min(minRes, ranked.length));
        }
        gated = kept;
      }
    }

    const keptSet = new Set(gated.map((r) => r.id));
    for (const r of ranked) {
      if (!keptSet.has(r.id)) droppedIds.push(r.id);
    }
    trimmed = droppedIds.length > 0;
  }

  // Stage 5: MMR diversification (or deterministic canonical sort)
  let ordered: ReplayScoredItem[];
  if (
    effectiveConfig.mmr.enabled &&
    effectiveConfig.mmr.lambda < 1 &&
    gated.length > 1
  ) {
    const lambda = Math.min(1, Math.max(0, effectiveConfig.mmr.lambda));
    const simLookup = new Map<string, number>();
    for (const [a, b, sim] of payload.pairwiseSimilarity) {
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      simLookup.set(key, sim);
    }
    const getSim = (a: string, b: string): number => {
      if (a === b) return 1;
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      return simLookup.get(key) ?? 0;
    };

    const maxScore = Math.max(...gated.map((r) => r.score));
    const scaled = gated.map((item) => ({
      item,
      relevance: maxScore > 0 ? item.score / maxScore : 0,
    }));
    const picked: ReplayScoredItem[] = [];
    const remainingIndices = scaled.map((_, idx) => idx);

    while (remainingIndices.length > 0) {
      let bestPos = 0;
      let bestVal = -Infinity;
      for (let pos = 0; pos < remainingIndices.length; pos += 1) {
        const idx = remainingIndices[pos]!;
        const cand = scaled[idx]!;
        let maxSim = 0;
        for (const chosen of picked) {
          const s = getSim(cand.item.id, chosen.id);
          if (s > maxSim) maxSim = s;
        }
        const val = lambda * cand.relevance - (1 - lambda) * maxSim;
        if (val > bestVal) {
          bestVal = val;
          bestPos = pos;
        }
      }
      const chosenIdx = remainingIndices.splice(bestPos, 1)[0]!;
      picked.push(scaled[chosenIdx]!.item);
    }
    ordered = picked;
  } else {
    ordered = [...gated].sort(compareByScoreThenId);
  }

  // Stage 6: Pagination slice
  const offset = effectiveConfig.offset;
  const limit = effectiveConfig.limit;
  const finalSlice = ordered.slice(offset, offset + limit);
  const replayFinalIds = finalSlice.map((r) => r.id);

  // Stage 7: Compute structured diff against original trace
  const originalFinalIds = payload.finalIds;
  const originalRankById = new Map<string, number>();
  originalFinalIds.forEach((id, idx) => originalRankById.set(id, idx + 1));

  const replayRankById = new Map<string, number>();
  const finalReplayScoreById = new Map<string, number>();
  finalSlice.forEach((r, idx) => {
    replayRankById.set(r.id, idx + 1);
    finalReplayScoreById.set(r.id, r.score);
  });

  const originalScoreOf = (id: string): number | null => {
    const c = candidateById.get(id);
    return c ? c.contributions.finalScore : null;
  };
  const textOf = (id: string): string | undefined =>
    candidateById.get(id)?.text?.summary;

  const added: ReplayRecallReport["diff"]["added"] = [];
  const removed: ReplayRecallReport["diff"]["removed"] = [];
  const reordered: ReplayRecallReport["diff"]["reordered"] = [];
  const unchanged: ReplayRecallReport["diff"]["unchanged"] = [];

  for (let i = 0; i < replayFinalIds.length; i += 1) {
    const id = replayFinalIds[i]!;
    const newRank = i + 1;
    const replayScore = finalReplayScoreById.get(id) ?? 0;
    const origRank = originalRankById.get(id);
    const origScore = originalScoreOf(id);
    const text = textOf(id);

    if (origRank === undefined) {
      added.push({
        id,
        newRank,
        originalScore: origScore,
        replayScore,
        scoreDelta: origScore !== null ? replayScore - origScore : null,
        ...(text !== undefined ? { text } : {}),
      });
    } else if (origRank !== newRank) {
      const baseScore = origScore ?? 0;
      reordered.push({
        id,
        oldRank: origRank,
        newRank,
        rankDelta: origRank - newRank,
        originalScore: baseScore,
        replayScore,
        scoreDelta: replayScore - baseScore,
        ...(text !== undefined ? { text } : {}),
      });
    } else {
      const baseScore = origScore ?? 0;
      unchanged.push({
        id,
        rank: newRank,
        originalScore: baseScore,
        replayScore,
        scoreDelta: replayScore - baseScore,
        ...(text !== undefined ? { text } : {}),
      });
    }
  }

  const droppedSet = new Set(droppedIds);
  for (let i = 0; i < originalFinalIds.length; i += 1) {
    const id = originalFinalIds[i]!;
    if (replayRankById.has(id)) continue;
    const oldRank = i + 1;
    const origScore = originalScoreOf(id) ?? 0;
    const repScore = allReplayedScores.get(id) ?? null;
    const text = textOf(id);
    const reason: ReplayRecallReport["diff"]["removed"][number]["reason"] =
      abstained
        ? "gate_abstained"
        : droppedSet.has(id)
          ? "gate_trimmed"
          : "out_of_top_k";
    removed.push({
      id,
      oldRank,
      originalScore: origScore,
      replayScore: repScore,
      scoreDelta: repScore !== null ? repScore - origScore : null,
      reason,
      ...(text !== undefined ? { text } : {}),
    });
  }

  return {
    traceId: trace.id,
    query: trace.query,
    originalConfigHash: trace.configHash,
    replayConfigHash,
    effectiveConfig,
    effectiveWeights: fusion.effectiveWeights,
    configChanges,
    originalFinalIds,
    replayFinalIds,
    gate: {
      abstained,
      trimmed,
      droppedIds,
    },
    diff: {
      added,
      removed,
      reordered,
      unchanged,
    },
    warnings,
  };
}

function fmtSigned(val: number, digits = 4): string {
  const sign = val >= 0 ? "+" : "";
  return `${sign}${val.toFixed(digits)}`;
}

/**
 * Format a `ReplayRecallReport` into a deterministic human-readable diff.
 */
export function formatReplayRecall(report: ReplayRecallReport): string {
  const lines: string[] = [];
  lines.push(`Replay trace:  ${report.traceId}`);
  lines.push(`Query:         ${JSON.stringify(report.query)}`);
  lines.push(
    `Config hash:   ${report.originalConfigHash} -> ${report.replayConfigHash}`,
  );

  if (report.configChanges.length === 0) {
    lines.push("Config diff:   (none — identical to recorded trace)");
  } else {
    lines.push("Config overrides:");
    for (const ch of report.configChanges) {
      lines.push(
        `  - ${ch.field}: ${JSON.stringify(ch.before)} -> ${JSON.stringify(ch.after)}`,
      );
    }
  }

  for (const w of report.warnings) {
    lines.push(`Warning: ${w}`);
  }
  lines.push("");

  lines.push(
    `Summary: +${report.diff.added.length} added, -${report.diff.removed.length} removed, ~${report.diff.reordered.length} reordered, =${report.diff.unchanged.length} unchanged`,
  );

  if (report.diff.added.length > 0) {
    lines.push("\nAdded:");
    for (const item of report.diff.added) {
      const deltaStr =
        item.scoreDelta !== null
          ? ` (orig=${fmtNum(item.originalScore ?? 0)}, delta=${fmtSigned(item.scoreDelta)})`
          : " (new in top-K)";
      const textSuffix = item.text ? ` — ${item.text}` : "";
      lines.push(
        `  + #${item.newRank} ${item.id}  score=${fmtNum(item.replayScore)}${deltaStr}${textSuffix}`,
      );
    }
  }

  if (report.diff.removed.length > 0) {
    lines.push("\nRemoved:");
    for (const item of report.diff.removed) {
      const repStr =
        item.replayScore !== null && item.scoreDelta !== null
          ? ` -> ${fmtNum(item.replayScore)} (delta=${fmtSigned(item.scoreDelta)})`
          : "";
      const textSuffix = item.text ? ` — ${item.text}` : "";
      lines.push(
        `  - was #${item.oldRank} ${item.id}  orig=${fmtNum(item.originalScore)}${repStr} [${item.reason}]${textSuffix}`,
      );
    }
  }

  if (report.diff.reordered.length > 0) {
    lines.push("\nReordered:");
    for (const item of report.diff.reordered) {
      const rankArrow = `#${item.oldRank} -> #${item.newRank} (${item.rankDelta >= 0 ? `+${item.rankDelta}` : `${item.rankDelta}`})`;
      const textSuffix = item.text ? ` — ${item.text}` : "";
      lines.push(
        `  ~ ${rankArrow} ${item.id}  score=${fmtNum(item.originalScore)} -> ${fmtNum(item.replayScore)} (delta=${fmtSigned(item.scoreDelta)})${textSuffix}`,
      );
    }
  }

  if (report.diff.unchanged.length > 0) {
    lines.push("\nUnchanged rank:");
    for (const item of report.diff.unchanged) {
      const textSuffix = item.text ? ` — ${item.text}` : "";
      lines.push(
        `  = #${item.rank} ${item.id}  score=${fmtNum(item.originalScore)} -> ${fmtNum(item.replayScore)} (delta=${fmtSigned(item.scoreDelta)})${textSuffix}`,
      );
    }
  }

  return lines.join("\n");
}
