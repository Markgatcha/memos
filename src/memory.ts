/**
 * MemoryManager — the public API surface of MemOS.
 *
 * Orchestrates graph operations, persistence, auto-linking, and
 * extractive summarisation. This is the class that application
 * code interacts with.
 *
 * @module @memos/memory
 */

import { GraphEngine, generateId, textSimilarity } from "./graph.js";
import { SQLiteStorage } from "./storage/sqlite.js";
import { defaultDbPath } from "./storage/sqlite.js";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  parseExternalMemoryExport,
  parseExportDirectory,
  synthesizeImportInsights,
  type DetectedExportSource,
  type ExternalImportSource,
} from "./external-import.js";
import {
  DEFAULT_LESSON_PACK_K,
  applyLessonOutcome,
  rankProceduralLessons,
} from "./procedural.js";
import {
  citationToken,
  formatCitationResolution,
  parseCitationToken,
  type CitationResolution,
} from "./citations.js";
import { createEmbeddingProvider, cosineSimilarity } from "./embeddings.js";
import { EmbeddingQueue } from "./embedding-queue.js";
import {
  buildContextPack,
  estimateTokens,
  searchResultsToToon,
  searchResultsToToonCompact,
  serializeContextPack,
} from "./context-pack.js";
import type { ContextPack } from "./context-pack.js";
import { compareScoredMemories, fuseResults } from "./retrieval.js";
import {
  DEFAULT_GRAPH_EXPANSION_ALPHA,
  DEFAULT_GRAPH_EXPANSION_HOPS,
  DEFAULT_GRAPH_EXPANSION_SEEDS,
  DEFAULT_PPR_MAX_INJECTED,
  DEFAULT_PPR_MIN_INJECT_SCORE,
  personalizedPageRank,
} from "./graph-expansion.js";
import {
  canonicalizeEntities,
  extractQueryEntities,
} from "./entity-extraction.js";
import {
  fidelityStats,
  hasFidelityCache,
  levelText,
  nextFidelityLevel,
  resolveRecallLevels,
  scoreLevelCorpus,
  stampFidelityCache,
} from "./fidelity.js";
import type {
  CompactOptions,
  CompactResult,
  FidelityLevel,
  FidelityRecallOptions,
  FidelityRecallResult,
} from "./fidelity.js";
import { composeScope } from "./scope.js";
import { decideRetain } from "./retain-filter.js";
import type {
  MemoryNode,
  MemoryEdge,
  MemoryPool,
  MemoryScope,
  MemoryHistory,
  HistoryOptions,
  CreateMemoryInput,
  UpdateMemoryInput,
  ScoredMemory,
  SearchFilter,
  SemanticSearchOptions,
  GraphSnapshot,
  MemOSConfig,
  StorageAdapter,
  MemOSEvent,
  MemOSEventListener,
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  ExperimentalConfig,
  EmbeddingProvider,
  EmbeddingRuntimeInfo,
  MemoryType,
  MemorySource,
  EmbeddingNodeStatus,
  EmbeddingNodeStatusInfo,
  EmbeddingQueueStatus,
  EmbeddingVector,
  DedupeOptions,
  DedupeMerge,
  DedupeResult,
  DecaySuperseded,
  DecayForgettingOptions,
  DecayForgetResult,
  ArchiveOptions,
  ArchiveMove,
  ArchiveResult,
  ConsolidateOptions,
  ConsolidateResult,
  SummarizeClusterOptions,
  RevertOptions,
  RevertResult,
  RevertTargetResolution,
  RevertScopeInput,
  SummarizeClusterResult,
  ClusterSummary,
  ConversationMessage,
  ExtractedFact,
  ExtractFactsOptions,
  ExtractFactsResult,
  DiagnosticsResult,
  LessonOutcome,
  NewProceduralLesson,
  ProceduralLesson,
  ProvenanceTier,
  HarnessCount,
  HarnessMergeOptions,
  HarnessMergeResult,
} from "./types.js";
import { DEFAULT_TRUST_SCORES } from "./types.js";
import {
  INITIAL_CONFIDENCE,
  applyEvidence,
  classifyEvidence,
  sharesSubject,
} from "./confidence-machine.js";
import {
  CONTRADICTION_SCAN_LIMIT,
  CONTRADICTION_SIM_MIN,
  findContradictionCandidates,
  nodeContradictionCandidates,
  resolveContradictionsAtRead,
} from "./contradictions.js";
import type { ContradictionRecord } from "./types.js";
import { detectRevertIntent } from "./revert.js";
import { detectHarness } from "./harness.js";
import {
  detectEvent,
  detectEventUpdate,
  isScheduledEventNode,
  type EventMetadata,
  type EventUpdate,
} from "./event-memory.js";
import { addDuration } from "./temporal.js";
import {
  QUARANTINE_RELEASED_METADATA_KEY,
  isProvenanceTier,
  quarantineVisible,
  resolveProvenance,
} from "./provenance.js";
import { screenWrite } from "./quarantine.js";
import type { QuarantineVerdict } from "./quarantine.js";

/**
 * Minimum cosine similarity for a memory to enter the semantic leg of
 * hybrid search. Zero-similarity rows are unrelated and must not vote
 * in fusion (nor occupy candidate slots); genuine paraphrase matches
 * land far above this floor for any real embedder.
 */
const SEMANTIC_FUSION_THRESHOLD = 0.05;

/** Squash a cross-encoder logit into [0,1] for score display/ordering. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * JSON.stringify with object keys recursively sorted, so semantically
 * identical filter objects always produce the same search-cache key
 * regardless of property insertion order. Arrays keep their order.
 */ function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * Thrown by `store({ filterRetain: true })` when the Hermes-style retain
 * pre-filter decides the content is too low-signal to store (v1.6.26).
 * Catch this to silently skip noise instead of treating it as an error.
 *
 * @example
 *   try {
 *     await memos.store("ok got it", { filterRetain: true });
 *   } catch (e) {
 *     if (e instanceof MemorySkippedError) return; // expected — low signal
 *     throw e;
 *   }
 */
export class MemorySkippedError extends Error {
  readonly score: number;
  constructor(reason: string, score: number) {
    super(`Memory write skipped by retain filter: ${reason}`);
    this.name = "MemorySkippedError";
    this.score = score;
  }
}

/**
 * Extractive summariser — picks the most important sentence from the text.
 *
 * Scores each sentence by word frequency (excluding stop words) and
 * returns the top-scoring sentence. Entirely local, no API calls.
 *
 * @param text — Raw text to summarise.
 * @returns Extractive summary sentence.
 */

// Module-level so every store() call doesn't re-allocate a 45-word Set.
const EXTRACTIVE_SUMMARY_STOP_WORDS = new Set([
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
]);

function extractiveSummary(text: string): string {
  const sentences = text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  if (sentences.length === 0) return text.slice(0, 120);
  if (sentences.length === 1) return sentences[0];

  const stopWords = EXTRACTIVE_SUMMARY_STOP_WORDS;

  // Build word frequency across all sentences
  const freq = new Map<string, number>();
  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    for (const w of words) {
      if (w.length > 1 && !stopWords.has(w)) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }

  // Score each sentence
  let bestScore = -1;
  let bestSentence = sentences[0];

  for (const sentence of sentences) {
    const words = sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    let score = 0;
    for (const w of words) {
      score += freq.get(w) || 0;
    }
    // Normalise by sentence length to avoid favouring long sentences
    score = score / Math.max(words.length, 1);

    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }

  return bestSentence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Revert audit events are stored as event-pool nodes; they must never be
 * picked up by "last"-scope resolution or named-entity candidate lists.
 */
function isRevertAuditNode(node: MemoryNode): boolean {
  return isRecord(node.metadata) && node.metadata.audit === "revert";
}

function normalizeMemoryType(value: unknown): MemoryType {
  return value === "fact" ||
    value === "preference" ||
    value === "context" ||
    value === "relationship" ||
    value === "entity" ||
    value === "custom"
    ? value
    : "custom";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

/**
 * Core MemOS instance. This is the primary entry point for all
 * memory operations.
 *
 * @example
 * ```ts
 * import { MemOS } from "@memos/sdk";
 *
 * const memos = new MemOS({ dbPath: "./my-app.db" });
 * await memos.init();
 *
 * const { node } = await memos.store("User prefers dark mode", { type: "preference" });
 * const results = await memos.search("dark mode");
 * ```
 */
export class MemOS {
  private graph: GraphEngine;
  private storage: StorageAdapter;
  private config: Required<
    Omit<
      MemOSConfig,
      | "storage"
      | "enrichMemory"
      | "entityAliases"
      | "summarizeClusterLlm"
      | "cipherKey"
    >
  > & {
    storage?: StorageAdapter;
    entityAliases?: MemOSConfig["entityAliases"];
    enrichMemory?: MemOSConfig["enrichMemory"];
    summarizeClusterLlm?: MemOSConfig["summarizeClusterLlm"];
    cipherKey: string;
  };
  private experimental: ExperimentalConfig;
  private embeddingProvider: EmbeddingProvider | null = null;
  private listeners: Map<MemOSEvent, MemOSEventListener[]> = new Map();
  private initialised = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Background embedding queue. Null when no provider is configured. */
  private embeddingQueue: EmbeddingQueue | null = null;
  /**
   * Per-node embedding status cache. Populated as the queue emits status
   * callbacks and as nodes are reaped into the persisted embedding.
   */
  private nodeEmbeddingStatus: Map<string, EmbeddingNodeStatusInfo> = new Map();
  /**
   * LRU cache for recent search results. Prevents re-running hybrid
   * search (which embeds the query + scans the embedding table) when
   * the same query is issued repeatedly within a short window.
   * Key: `${query}::${namespace}::${limit}`. Value: { results, expiry }.
   */
  private searchCache: Map<
    string,
    { results: ScoredMemory[]; expiry: number }
  > = new Map();
  private searchCacheMaxEntries = 128;
  private searchCacheTtlMs = 5_000; // 5 seconds
  /** Warn only once when the rerank endpoint fails (graceful degradation). */
  private rerankFailureWarned = false;
  /**
   * Last timestamp handed out by `store()`. Fast successive stores can land
   * in the same millisecond, which would make createdAt ties ambiguous for
   * temporal ordering, version timelines, and recency tie-breaks — so
   * store timestamps are kept strictly monotonic per instance.
   */
  private lastStoreTime = 0;
  /**
   * Node ids written by `store()` whose embeddings have not been scanned
   * for contradiction candidates yet. The write-time scan runs when the
   * embedding is persisted (see `onEmbeddingPersisted`) — the gate keeps
   * the scan off the startup backfill path and off re-embeddings from
   * `update()`, so detection stays a bounded per-write cost.
   */
  private contradictionScanPending = new Set<string>();

  /**
   * Lifetime token-savings telemetry for context packs (in-process —
   * resets when the MemOS instance is recreated). `packTokens` counts
   * what was actually injected; `naiveBaselineTokens` counts what
   * dumping the same candidates as raw JSON nodes would have cost.
   */
  private usage: {
    packsBuilt: number;
    packTokens: number;
    naiveBaselineTokens: number;
  } = { packsBuilt: 0, packTokens: 0, naiveBaselineTokens: 0 };

  /**
   * Create a new MemOS instance.
   *
   * @param config — Configuration options. All fields are optional.
   */
  constructor(config: MemOSConfig = {}) {
    this.config = {
      dbPath: config.dbPath ?? defaultDbPath(),
      wal: config.wal ?? true,
      maxMemories: config.maxMemories ?? 0,
      autoLinkThreshold: config.autoLinkThreshold ?? 0.3,
      storage: config.storage,
      sweepInterval: config.sweepInterval ?? 60,
      experimental: config.experimental ?? {},
      // Effective-importance tuning (recency decay + access reinforcement).
      // Defaults live in `DEFAULT_IMPORTANCE_CONFIG` (src/importance.ts).
      importance: config.importance ?? {},
      // Half-life for the optional hybrid-search recency boost
      // (only consulted when `experimental.recencyBoost` is enabled).
      recencyHalfLifeDays: config.recencyHalfLifeDays ?? 14,
      embeddings: config.embeddings ?? {},
      embeddingQueue: config.embeddingQueue ?? {},
      fusion: config.fusion ?? {},
      entityAliases: config.entityAliases,
      enrichMemory: config.enrichMemory,
      summarizeClusterLlm: config.summarizeClusterLlm,
      // Encryption at rest: explicit config wins, MEMOS_KEY env is the
      // ops-friendly fallback. Empty string disables.
      cipherKey: config.cipherKey ?? process.env.MEMOS_KEY ?? "",
      storageOptions: config.storageOptions ?? {},
    };

    this.experimental = this.config.experimental;
    // Embeddings are ON by default: a plain `new MemOS()` gets real local
    // semantic search via fastembed (which degrades loudly to a local hash
    // when the optional transformers dep isn't installed). The deprecated
    // `experimental.semanticSearch` flag is now a no-op — it only ever
    // meant "opt in", which is the default. Pass
    // `embeddings: { enabled: false }` to go back to keyword-only search.
    const embeddingsEnabled = this.config.embeddings.enabled ?? true;
    this.embeddingProvider = embeddingsEnabled
      ? createEmbeddingProvider(this.config.embeddings)
      : null;

    this.graph = new GraphEngine();
    this.storage =
      this.config.storage ??
      new SQLiteStorage(this.config.dbPath, this.config.wal, {
        vectorCacheEntries:
          this.config.storageOptions?.vectorCacheEntries ?? 25_000,
        // Only forward the key when set — otherwise the default plaintext
        // driver is used and the optional cipher dependency is never loaded.
        ...(this.config.cipherKey ? { cipherKey: this.config.cipherKey } : {}),
      });
  }

  /**
   * Initialise the storage backend and hydrate the in-memory graph.
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    if (this.initialised) return;

    await this.storage.init();

    // Hydrate graph from storage
    const snapshot = await this.storage.getGraph();
    for (const node of snapshot.nodes) {
      this.graph.addNode(node);
    }
    for (const edge of snapshot.edges) {
      this.graph.addEdge({
        sourceId: edge.sourceId,
        targetId: edge.targetId,
        relation: edge.relation,
        weight: edge.weight,
        metadata: edge.metadata,
        // Bitemporal event-time validity — preserved so the in-memory
        // mirror answers as-of reads the same way storage does.
        validFrom: edge.validFrom ?? null,
        validTo: edge.validTo ?? null,
      });
    }

    // Start TTL sweep
    this.startSweep();

    if (this.embeddingProvider && this.storage.saveEmbedding) {
      // Spin up the background queue, then schedule the backfill.
      this.embeddingQueue = new EmbeddingQueue({
        provider: this.embeddingProvider,
        concurrency: this.config.embeddingQueue.concurrency ?? 2,
        batchSize: this.config.embeddingQueue.batchSize ?? 1,
        maxQueueSize: this.config.embeddingQueue.maxQueueSize ?? 10_000,
        maxRetries: this.config.embeddingQueue.maxRetries ?? 3,
        retryBackoffMs: this.config.embeddingQueue.retryBackoffMs ?? 250,
        batchLingerMs: this.config.embeddingQueue.batchLingerMs,
        onPersist: async (nodeId, vector, model) => {
          await this.onEmbeddingPersisted(nodeId, vector, model);
        },
        onStatusChange: (nodeId, status, error) => {
          // Map internal queue states onto the public node-level states.
          // "complete" (job done) -> "ready" (vector persisted).
          // "retrying" is purely an internal queue event; we don't surface
          // it as a node status but we do emit "embedding:retry".
          const nodeStatus: EmbeddingNodeStatus =
            status === "complete"
              ? "ready"
              : status === "retrying"
                ? "running"
                : status;
          this.recordEmbeddingStatus(nodeId, nodeStatus, error);
          if (status === "retrying") {
            this.emit("embedding:retry", { nodeId, error });
          }
        },
      });
      await this.backfillEmbeddings();
    }

    this.initialised = true;
  }

  // -----------------------------------------------------------------------
  // Core API
  // -----------------------------------------------------------------------

  /**
   * Store a new memory.
   *
   * Automatically generates a summary (if not provided) and attempts
   * to link the new node to existing nodes based on text similarity.
   *
   * @param content — Text content to remember.
   * @param opts    — Optional metadata, type, summary, importance, ttl, tags.
   * @returns The created node and any auto-created edges.
   */
  async store(
    content: string,
    opts: Omit<CreateMemoryInput, "content"> = {},
  ): Promise<{ node: MemoryNode; links: MemoryEdge[] }> {
    return this.storeInner(content, opts, false);
  }

  /**
   * Inner write path. `skipEventUpdate` is true only for the event-update
   * machinery below (prevents the replacement write from re-triggering
   * update detection on its own text — infinite recursion otherwise).
   */
  private async storeInner(
    content: string,
    opts: Omit<CreateMemoryInput, "content">,
    skipEventUpdate: boolean,
  ): Promise<{ node: MemoryNode; links: MemoryEdge[] }> {
    this.assertInit();

    // Hermes-style retain pre-filter (v1.6.26). When `filterRetain` is set,
    // low-signal content is skipped before the write so long-term memory isn't
    // flooded with noise that would later bloat context-packs. Callers can
    // detect a skipped write by catching `MemorySkippedError`.
    if (opts.filterRetain) {
      const decision = decideRetain({ content });
      if (!decision.retain) {
        throw new MemorySkippedError(decision.reason, decision.score);
      }
    }

    // Strictly monotonic per instance: two stores in the same millisecond
    // would otherwise be indistinguishable in every time-ordered view.
    // `opts.now` (test hook) overrides the wall clock — it is also the
    // reference time for deterministic temporal parsing below.
    let now = opts.now ?? Date.now();
    if (now <= this.lastStoreTime) now = this.lastStoreTime + 1;
    this.lastStoreTime = now;
    // Namespaces are always on now (promoted from experimental). Explicit
    // namespace wins; `scope` composes into one (fixed order user → agent
    // → run); plain writes land in "default".
    const namespace = opts.scope
      ? composeScope(opts.scope)
      : (opts.namespace ?? "default");

    // Deterministic temporal event updates ("never mind that meeting got
    // moved 3 days later", "the meeting is cancelled"): resolve BEFORE
    // the normal write. When an update/cancel resolves to an open event,
    // the replacement is written and the old version superseded via the
    // bitemporal mechanism; the resolved write is returned directly.
    // Fail-safe: unresolvable updates fall through to a normal write.
    // Skipped when the caller manages the event lifecycle directly
    // (`opts.metadata.event` preset, e.g. `memos remind`) or on the
    // replacement write itself (`skipEventUpdate`).
    if (!skipEventUpdate && opts.metadata?.event === undefined) {
      const handled = await this.applyEventUpdate(
        content,
        new Date(now),
        namespace,
        opts,
      );
      if (handled) return handled;
    }
    const source: MemorySource = opts.source ?? "user_input";
    const type = opts.type ?? "fact";
    const tags = opts.tags ?? [];

    // Provenance tier for this write: an explicit `provenance` option
    // wins; otherwise the source-derived default applies (`user_input`
    // → `user`, `external_data` → `imported`, …). `user-verified` is
    // never assigned automatically — see `resolveProvenance`.
    const provenance = resolveProvenance({
      provenance: opts.provenance,
      source,
    });

    // Write-gate quarantine: the local-heuristic classifier
    // (`screenWrite` — pure regex scoring, no LLM on the hot path) runs
    // on every write unless `quarantineScreen: false` opts out. The
    // write's provenance tier is passed through so tier-aware rules
    // (dormant instructions, trigger phrases, strict exfiltration on
    // `tool-output`/`imported`) actually activate on real writes.
    // Flagged content is still stored (add-only is preserved) but marked
    // quarantined, which excludes it from recall by default until a
    // human reviews it via `memos quarantine list|release`.
    let quarantined = false;
    let quarantinedAt: number | null = null;
    let quarantineReason: string | null = null;
    if (opts.quarantineScreen !== false) {
      const verdict = screenWrite(content, { tier: provenance });
      if (verdict.flagged) {
        quarantined = true;
        quarantinedAt = now;
        quarantineReason = verdict.reason;
      }
    }

    // Write-time entity capture for fused retrieval scoring: entities are
    // extracted once here and stored in metadata, so the query-time overlap
    // check (see `fuseResults`) is a set intersection instead of a rescan.
    // Caller-supplied `metadata.entities` always wins.
    const metadata: Record<string, unknown> = { ...(opts.metadata ?? {}) };
    if (!Array.isArray(metadata.entities)) {
      const entities = extractQueryEntities(content);
      if (entities.length > 0) {
        metadata.entities = canonicalizeEntities(
          entities,
          this.config.entityAliases,
        );
      }
    }

    // Deterministic temporal event extraction: an event noun co-occurring
    // with a temporal expression becomes structured `metadata.event`
    // (feeds `listReminders` / `memos_reminders`). Additive — plain
    // memories are untouched. An explicit `opts.metadata.event` always
    // wins (e.g. `memos remind`, or the update machinery's replacement
    // write). Year-less dates and recurring references are stored with
    // `status: "recurring"` and never produce reminders.
    if (metadata.event === undefined) {
      const detected = detectEvent(content, new Date(now));
      if (detected) metadata.event = detected;
    }

    // Contextual enrichment (contextual retrieval): an explicit
    // `opts.context` wins; otherwise consult the optional `enrichMemory`
    // config hook. Fail-soft — an enricher error must never block a write.
    let context: string | null | undefined = opts.context;
    if (context === undefined && this.config.enrichMemory) {
      try {
        context = await this.config.enrichMemory({
          content,
          type,
          tags,
          source,
          namespace,
        });
      } catch {
        context = undefined;
      }
    }
    if (context) metadata.context = context;

    // Evidence state machine (opt-in via `evidenceLearning`, default
    // OFF — append-always remains the default write semantics, matching
    // the dedupe()/consolidate() contract where near-duplicates are
    // merged EXPLICITLY in a background pass rather than at write time).
    // When enabled:
    //   - confirmed  → reinforce that memory (confidence ↑, evidenceCount
    //     ↑) and return it — no duplicate node is written, which keeps
    //     the store small and context packs lean;
    //   - contradicted → mark the old memory historical (validTo = now)
    //     and fall through to write the new version;
    //   - partial_conflict / unrelated → fall through (new node).
    // Matching uses the same embedding space as retrieval when available,
    // falling back to bag-of-words similarity otherwise.
    let supersededNodeId: string | null = null;
    if (opts.evidenceLearning === true) {
      const evidence = await this.applyStoreEvidence(
        content,
        namespace,
        source,
      );
      if (evidence.action === "reinforced") {
        return { node: evidence.node, links: [] };
      }
      // "superseded": the old version was marked historical by
      // applyStoreEvidence — continue below to persist the replacement.
      // "new": fall through and write the node.
      if (evidence.action === "superseded") {
        supersededNodeId = evidence.nodeId;
      }
    }

    const node: MemoryNode = {
      id: generateId(),
      content,
      summary: opts.summary ?? extractiveSummary(content),
      type,
      metadata,
      importance: opts.importance ?? 0.5,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      tags,
      expiresAt: opts.ttl ? Math.floor(now / 1000) + opts.ttl : null,
      namespace,
      validFrom: opts.validFrom ?? null,
      validTo: opts.validTo ?? null,
      source,
      pool: opts.pool ?? "event",
      trustScore: opts.trustScore ?? DEFAULT_TRUST_SCORES[source],
      // Provenance-trust layer: write-time tier + write-gate quarantine
      // state (see the gate above).
      provenance,
      quarantined,
      quarantinedAt,
      quarantineReason,
      // Harness attribution ("one memory, every harness"): stamp which
      // agent harness authored this memory. An explicit `opts.harness`
      // wins; otherwise detect from the environment. Updates never
      // re-stamp — each version keeps its own author's tag, so a
      // cross-harness supersession shows A on the old version and B on
      // the replacement.
      harness: opts.harness ?? detectHarness(),
      // Initialize confidence state machine values
      confidence: opts.confidence ?? INITIAL_CONFIDENCE,
      evidenceCount: opts.evidenceCount ?? 0,
    };

    // Fidelity-level compaction: generate L1 (typed facts) and L2
    // (extractive summary) at write time into the reserved
    // `metadata.fidelity` slot. L0 derives free from tags/entities; L3 is
    // the content column. Deterministic, zero LLM.
    stampFidelityCache(node);

    await this.storage.saveNode(node);
    this.graph.addNode(node);
    this.scheduleEmbedding(node);
    this.invalidateSearchCache();

    // Register the node for the write-time contradiction scan: once its
    // embedding is persisted, `onEmbeddingPersisted` runs the bounded
    // neighbor scan and records candidate pairs (see
    // `detectContradictionsForNode`). Fail-soft — detection never blocks
    // the write path.
    this.contradictionScanPending.add(node.id);

    // Provenance for the evidence state machine: when the contradicted
    // outcome already superseded an old version above, record the pair
    // in the contradictions table (status `resolved`). This feeds the
    // existing `applyEvidence` wiring into the new persistence — the
    // read-time resolver uses the same pairs.
    if (supersededNodeId && this.storage.addContradiction) {
      try {
        await this.storage.addContradiction(
          supersededNodeId,
          node.id,
          "resolved",
        );
      } catch {
        // Best-effort provenance — never fails the store.
      }
    }

    // Auto-link — batch save edges for performance
    const links: MemoryEdge[] = [];
    if (this.config.autoLinkThreshold > 0) {
      const autoEdges = this.graph.autoLink(
        node,
        this.config.autoLinkThreshold,
      );
      if (autoEdges.length > 0) {
        // Use batch save when available; fall back to individual saves.
        if (this.storage.saveEdgesBatch) {
          await this.storage.saveEdgesBatch(autoEdges);
        } else {
          for (const edge of autoEdges) {
            await this.storage.saveEdge(edge);
          }
        }
        links.push(...autoEdges);
        this.emit("link:auto", { node, edges: links });
      }
    }

    this.emit("node:created", node);

    // Eviction
    if (this.config.maxMemories > 0) {
      await this.evict();
    }

    return { node, links };
  }

  /**
   * Resolve a natural-language event update/cancel against the store.
   *
   * Cross-harness rule: the target is resolved from the CURRENT rows in
   * the shared DB file (same deterministic rules in every harness), so
   * model B can update an event stored by model A with no shared
   * conversation state.
   *
   * Deterministic tiebreaks:
   * - kind named ("that meeting") → newest open event whose kind matches
   *   `metadata.event.kind`, or whose label contains the kind;
   *   createdAt desc, id asc.
   * - kind unnamed ("it got moved") → the single open event if exactly
   *   one exists; zero or ambiguous → null (fail safe, never guess).
   *
   * @returns The resolved replacement write, or null when nothing
   *   resolves (the caller falls through to a normal write).
   */
  private async applyEventUpdate(
    content: string,
    now: Date,
    namespace: string,
    opts: Omit<CreateMemoryInput, "content">,
  ): Promise<{ node: MemoryNode; links: MemoryEdge[] } | null> {
    const update: EventUpdate | null = detectEventUpdate(content, now);
    if (!update) return null;
    const target = await this.resolveOpenEventTarget(update.kind, namespace);
    if (!target) return null;
    const oldEvent = target.metadata.event as EventMetadata;
    const oldAt = new Date(oldEvent.at);
    if (Number.isNaN(oldAt.getTime())) return null;

    const eventBase = {
      kind: oldEvent.kind,
      label: oldEvent.label,
      grain: oldEvent.grain,
    };

    if (update.intent === "cancel") {
      // Cancellation: supersede the old version and record a cancelled
      // event node carrying the same label/at (audit trail, add-only).
      const cancelled: EventMetadata = {
        ...eventBase,
        at: oldEvent.at,
        status: "cancelled",
        reminder_at: oldEvent.reminder_at,
      };
      const created = await this.storeInner(
        content,
        {
          ...opts,
          now: now.getTime(),
          metadata: { ...(opts.metadata ?? {}), event: cancelled },
        },
        true,
      );
      await this.supersede(target.id, created.node.id);
      return created;
    }

    // Update: "moved 3 days later" anchors the duration to the EVENT's
    // datetime (not now); "moved to Friday" parses absolute-ish vs now.
    let newAt: Date;
    let grain = oldEvent.grain;
    if (update.duration) {
      newAt = addDuration(oldAt, update.duration);
    } else if (update.newTime) {
      newAt = new Date(update.newTime.at);
      grain = update.newTime.grain;
    } else {
      return null; // Unreachable: detectEventUpdate guarantees one.
    }
    const at = newAt.toISOString();
    const rescheduled: EventMetadata = {
      ...eventBase,
      at,
      grain,
      status: "scheduled",
      reminder_at: at,
    };
    const created = await this.storeInner(
      content,
      {
        ...opts,
        now: now.getTime(),
        metadata: { ...(opts.metadata ?? {}), event: rescheduled },
      },
      true,
    );
    await this.supersede(target.id, created.node.id);
    return created;
  }

  /**
   * Find the currently-open scheduled event an update/cancel refers to.
   * See `applyEventUpdate` for the deterministic tiebreak rules.
   */
  private async resolveOpenEventTarget(
    kind: string | undefined,
    namespace: string,
  ): Promise<MemoryNode | null> {
    // Structured scan: default filters already exclude historical
    // (valid_to) and quarantined rows; the explicit validTo check below
    // keeps only strictly-current intervals.
    const rows = await this.storage.queryNodes({ namespace, limit: 10_000 });
    const open = rows
      .map((r) => r.node)
      .filter((n) => n.validTo === null && isScheduledEventNode(n))
      // Newest first; id asc as the final deterministic tiebreak.
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (kind !== undefined) {
      const k = kind.toLowerCase();
      return (
        open.find((n) => {
          const event = n.metadata.event as EventMetadata;
          return (
            event.kind === k ||
            (typeof event.label === "string" &&
              event.label.toLowerCase().includes(k))
          );
        }) ?? null
      );
    }
    // No kind named: only resolve when exactly one open event exists —
    // with several, guessing would be wrong; fail safe instead.
    return open.length === 1 ? (open[0] ?? null) : null;
  }

  /**
   * Retrieve a single memory by ID.
   *
   * @param id — Memory node ID.
   * @returns The node, or `null` if not found.
   */
  async retrieve(id: string): Promise<MemoryNode | null> {
    this.assertInit();
    return this.storage.getNode(id);
  }

  /**
   * Search memories by text query and/or structured filters.
   *
   * @param queryOrFilter — A plain text query string, or a full SearchFilter object.
   * @returns Array of scored memories, ordered by relevance.
   */
  async search(queryOrFilter: string | SearchFilter): Promise<ScoredMemory[]> {
    this.assertInit();

    // Drain pending embedding jobs first: the queue coalesces rapid
    // sequential stores with a short linger before batching them, so
    // without this a search issued right after store() would silently miss
    // the just-stored memories. No-op when the queue is empty.
    await this.flushEmbeddings();

    const filter: SearchFilter =
      typeof queryOrFilter === "string"
        ? { query: queryOrFilter, limit: 20 }
        : { limit: 20, ...queryOrFilter };

    // Scope → namespace matching (hierarchical prefix by default). No
    // scope/namespace means the query spans ALL namespaces.
    const scopeFilter = this.resolveScopeFilter(filter);
    if (scopeFilter.namespace !== undefined) {
      filter.namespace = scopeFilter.namespace;
    }
    if (scopeFilter.namespacePrefix !== undefined) {
      filter.namespacePrefix = scopeFilter.namespacePrefix;
    }

    // Check the search cache. Only cache text queries (not structured-only
    // queries without a `query` field, since those are cheap).
    if (filter.query) {
      const cacheKey = `v2::${stableStringify(filter)}`;
      const cached = this.searchCache.get(cacheKey);
      if (cached && cached.expiry > Date.now()) {
        return cached.results;
      }
      // Evict expired entries opportunistically; when every entry is
      // still fresh, drop the OLDEST so the cache cannot grow unbounded
      // under many unique queries (e.g. a benchmark sweep).
      if (this.searchCache.size > this.searchCacheMaxEntries) {
        const now = Date.now();
        for (const [k, v] of this.searchCache) {
          if (v.expiry <= now) this.searchCache.delete(k);
        }
        while (this.searchCache.size > this.searchCacheMaxEntries) {
          const oldest = this.searchCache.keys().next().value;
          if (oldest === undefined) break;
          this.searchCache.delete(oldest);
        }
      }
      const results =
        filter.query && this.embeddingProvider
          ? await this.hybridSearch(filter)
          : await this.storage.queryNodes(filter);

      // Post-sort by trustScore when requested — the FTS path always
      // sorts by rank, so we re-sort here.
      const sorted = this.postSortResults(results, filter);
      this.searchCache.set(cacheKey, {
        results: sorted,
        expiry: Date.now() + this.searchCacheTtlMs,
      });
      return sorted;
    }

    if (filter.query && this.embeddingProvider) {
      const results = await this.hybridSearch(filter);
      return this.postSortResults(results, filter);
    }

    const results = await this.storage.queryNodes(filter);
    return this.postSortResults(results, filter);
  }

  // -----------------------------------------------------------------------
  // Fidelity-level recall & compaction
  // -----------------------------------------------------------------------

  /**
   * Fidelity-aware recall: retrieve memories at the CHEAPEST fidelity
   * level that satisfies the query, escalating L0→L1→L2→L3 within the
   * same call when the result set looks insufficient.
   *
   * This is an ADDITIVE API — `search()` / `semanticSearch()` are
   * untouched. Scoring is a local IDF-weighted term-coverage pass over
   * the level corpus (zero LLM, zero embeddings); each result carries
   * the full node plus the level it was served at.
   *
   * Default behavior is L3-equivalent (verbatim text, no routing, no
   * escalation): existing consumers see the same output shape as a
   * plain search. Pass `fidelity: "adaptive"` (or a fixed lower level)
   * to opt into token savings.
   *
   * @example
   * ```ts
   * // Entity lookup served at L0 (~tens of tokens instead of verbatim)
   * const hits = await memos.recall("postgres pool size", {
   *   fidelity: "adaptive",
   *   maxFidelity: "L2",
   * });
   * for (const h of hits) console.log(h.level, h.text);
   * ```
   */
  async recall(
    query: string,
    opts: FidelityRecallOptions = {},
  ): Promise<FidelityRecallResult[]> {
    this.assertInit();
    const { start, max, route } = resolveRecallLevels(query, opts);
    const limit = opts.limit ?? 20;
    const threshold = opts.threshold ?? 0.15;
    const minResults = opts.minResults ?? 1;

    // Candidate set: live graph nodes scoped by the caller's filter.
    // Sorted by id for deterministic scoring and tie order.
    const nodes = this.applyRecallFilter(
      this.graph.getAllNodes(),
      opts.filter ?? {},
      opts.harness,
    ).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Start low, escalate on demand: re-score the corpus at each level
    // until enough hits clear the threshold or the ceiling is reached.
    const escalations: FidelityRecallResult["escalations"] = [];
    let level = start;
    let hits: Array<{ node: MemoryNode; score: number }> = [];
    for (;;) {
      const docs = nodes.map((n) => levelText(n, level));
      const scores = scoreLevelCorpus(query, docs);
      hits = nodes
        .map((node, i) => ({ node, score: scores[i]! }))
        .filter((h) => h.score >= threshold)
        .sort((a, b) => b.score - a.score || (a.node.id < b.node.id ? -1 : 1))
        .slice(0, limit);
      if (hits.length >= minResults || level === max) break;
      level = nextFidelityLevel(level)!;
      escalations.push(level);
    }

    return hits.map((h) => ({
      node: h.node,
      level,
      text: levelText(h.node, level),
      score: h.score,
      escalations: [...escalations],
      ...(route ? { route } : {}),
    }));
  }

  /**
   * Scope the recall candidate set. Mirrors the `SearchFilter` fields
   * that make sense for an in-memory scan (namespace / type / tags /
   * pool); full-text and vector legs live in `search()`. The harness
   * scope comes from the explicit argument first, then
   * `filter.harness` — `"all"` (or unset) keeps every harness.
   */
  private applyRecallFilter(
    nodes: MemoryNode[],
    filter: SearchFilter,
    harness?: string,
  ): MemoryNode[] {
    const pools = filter.pool
      ? Array.isArray(filter.pool)
        ? filter.pool
        : [filter.pool]
      : null;
    const harnessScope = harness ?? filter.harness;
    return nodes.filter((n) => {
      if (filter.namespace && n.namespace !== filter.namespace) return false;
      if (
        filter.namespacePrefix &&
        !n.namespace.startsWith(filter.namespacePrefix)
      )
        return false;
      if (filter.type && n.type !== filter.type) return false;
      if (pools && !pools.includes(n.pool ?? "event")) return false;
      if (filter.tags && filter.tags.some((t) => !n.tags.includes(t)))
        return false;
      if (
        harnessScope &&
        harnessScope !== "all" &&
        (n.harness ?? "unknown") !== harnessScope
      )
        return false;
      return true;
    });
  }

  /**
   * Eager fidelity backfill: generate missing L1/L2 levels for stored
   * memories and persist them into the reserved `metadata.fidelity`
   * slot. Idempotent — memories that already carry cached levels are
   * skipped. Reads (`recall`, `contextPack`) also generate lazily, so
   * this command is an optimization, not a requirement.
   *
   * `memos compact --stats` reports per-level token averages without
   * writing anything.
   */
  async compact(opts: CompactOptions = {}): Promise<CompactResult> {
    this.assertInit();
    const scoped = this.graph
      .getAllNodes()
      .filter((n) => !opts.namespace || n.namespace === opts.namespace)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const work =
      opts.limit === undefined
        ? scoped
        : scoped.slice(0, Math.max(0, opts.limit));

    let backfilled = 0;
    let skipped = 0;
    for (const node of work) {
      if (hasFidelityCache(node)) {
        skipped += 1;
        continue;
      }
      if (opts.dryRun) continue;
      const metadata = { ...(node.metadata ?? {}) };
      stampFidelityCache({ ...node, metadata });
      const updated = await this.storage.updateNode(node.id, { metadata });
      if (updated) {
        this.graph.updateNode(updated);
        backfilled += 1;
      }
    }

    const result: CompactResult = {
      scanned: work.length,
      backfilled,
      skipped,
    };
    if (opts.stats) {
      // Stats describe the namespace scope, independent of `limit`.
      result.stats = fidelityStats(scoped, estimateTokens);
    }
    return result;
  }

  /**
   * Search and return results in TOON (Token-Optimized Object Notation)
   * format — a compact pipe-delimited string that cuts token count.
   *
   * Format:
   *   # memos.search.v1
   *   # toon:pipe-delimited
   *   # fields: id|score|trust|source|updatedAt|tags|content
   *   mem_abc|0.950|local|user_input|2026-06-18T12:00:00.000Z|preference;ui|User likes dark mode
   *
   * @param opts — If a string, searches with that query. If an object,
   *   accepts `{ query, format: "toon" | "toon-compact", ...searchOptions }`.
   *   Default format is "toon-compact" for maximum token savings.
   * @returns A TOON-formatted string.
   */
  async searchToon(
    opts: string | (SearchFilter & { format?: "toon" | "toon-compact" }),
  ): Promise<string> {
    if (typeof opts === "string") {
      // Legacy: string query uses compact format by default
      const results = await this.search(opts);
      return searchResultsToToonCompact(results);
    }
    const { format = "toon-compact", ...filter } = opts;
    const results = await this.search(filter);
    if (format === "toon-compact") {
      return searchResultsToToonCompact(results);
    }
    return searchResultsToToon(results);
  }

  /**
   * Compose a scope filter into storage-facing namespace constraints.
   * Explicit `namespace` always wins over `scope`; scope matches
   * hierarchically (prefix) unless `scopeMatch: "exact"`.
   */
  private resolveScopeFilter(opts: {
    namespace?: string;
    scope?: MemoryScope;
    scopeMatch?: "exact" | "hierarchical";
  }): { namespace?: string; namespacePrefix?: string } {
    if (!opts.scope) return { namespace: opts.namespace };
    const composed = composeScope(opts.scope);
    return opts.namespace
      ? { namespace: composed }
      : opts.scopeMatch === "exact"
        ? { namespace: composed }
        : { namespacePrefix: composed };
  }

  /**
   * Apply post-query sorting that the storage layer can't do natively
   * (e.g. trustScore when the query went through FTS which always
   * sorts by rank).
   */
  private postSortResults(
    results: ScoredMemory[],
    filter: SearchFilter,
  ): ScoredMemory[] {
    if (filter.sortBy === "trustScore") {
      const order = filter.sortOrder ?? "desc";
      const sorted = [...results].sort((a, b) =>
        order === "desc"
          ? b.node.trustScore - a.node.trustScore
          : a.node.trustScore - b.node.trustScore,
      );
      return sorted;
    }
    return results;
  }

  /**
   * Permanently forget a memory and all its connected edges.
   *
   * @param id — Memory node ID to forget.
   * @returns `true` if the memory existed and was deleted.
   */
  async forget(id: string): Promise<boolean> {
    this.assertInit();

    const deleted = await this.storage.deleteNode(id);
    if (deleted) {
      this.graph.removeNode(id);
      this.emit("node:deleted", id);
      this.invalidateSearchCache();
    }
    return deleted;
  }

  /**
   * Generate a summary of all stored memories.
   *
   * Concatenates all node summaries and produces an extractive
   * summary of the combined text.
   *
   * @returns A summary string.
   */
  async summarize(): Promise<string> {
    this.assertInit();

    const nodes = this.graph.getAllNodes();
    if (nodes.length === 0) return "No memories stored.";

    const combined = nodes.map((n) => n.summary).join(". ");
    return extractiveSummary(combined);
  }

  /**
   * Manually create a link (edge) between two memories.
   *
   * @param sourceId — Source node ID.
   * @param targetId — Target node ID.
   * @param relation — Semantic relation type.
   * @param weight   — Edge weight [0, 1].
   * @returns The created edge.
   */
  async link(
    sourceId: string,
    targetId: string,
    relation: MemoryEdge["relation"] = "relates_to",
    weight = 0.5,
  ): Promise<MemoryEdge> {
    this.assertInit();

    const source = this.graph.getNode(sourceId);
    const target = this.graph.getNode(targetId);
    if (!source) throw new Error(`Node not found: ${sourceId}`);
    if (!target) throw new Error(`Node not found: ${targetId}`);

    const edge = this.graph.addEdge({ sourceId, targetId, relation, weight });
    try {
      await this.storage.saveEdge(edge);
    } catch (error) {
      this.graph.removeEdge(edge.id);
      throw error;
    }
    this.emit("edge:created", edge);
    return edge;
  }

  // -----------------------------------------------------------------------
  // TTL API
  // -----------------------------------------------------------------------

  /**
   * Set a time-to-live on a memory node.
   *
   * @param id — Memory node ID.
   * @param seconds — TTL in seconds from now.
   */
  async setTTL(id: string, seconds: number): Promise<void> {
    this.assertInit();
    await this.storage.setTTL(id, seconds);
    // Use the side-effect-free read — TTL changes must not bump
    // access_count, which would otherwise distort LRU eviction.
    const updated = await this.storage.peekNode!(id);
    if (!updated) throw new Error(`Node not found: ${id}`);
    this.graph.updateNode(updated);
  }

  /**
   * Clear the TTL on a memory node (make it persist indefinitely).
   *
   * @param id — Memory node ID.
   */
  async clearTTL(id: string): Promise<void> {
    this.assertInit();
    await this.storage.clearTTL(id);
    const updated = await this.storage.peekNode!(id);
    if (!updated) throw new Error(`Node not found: ${id}`);
    this.graph.updateNode(updated);
  }

  // ---------------------------------------------------------------------------
  // Tags API
  // ---------------------------------------------------------------------------

  /**
   * Add tags to a memory node.
   *
   * @param id — Memory node ID.
   * @param tags — Tags to add.
   */
  async tag(id: string, tags: string[]): Promise<void> {
    this.assertInit();
    // Side-effect-free read — tag updates are not retrievals.
    const node = await this.storage.peekNode!(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const merged = [...new Set([...node.tags, ...tags])];
    await this.storage.updateNode(id, { tags: merged });

    const updated = await this.storage.peekNode!(id);
    if (updated) this.graph.updateNode(updated);
  }

  /**
   * Remove tags from a memory node.
   *
   * @param id — Memory node ID.
   * @param tags — Tags to remove.
   */
  async untag(id: string, tags: string[]): Promise<void> {
    this.assertInit();
    const node = await this.storage.peekNode!(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const tagSet = new Set(tags);
    const filtered = node.tags.filter((t) => !tagSet.has(t));
    await this.storage.updateNode(id, { tags: filtered });

    const updated = await this.storage.peekNode!(id);
    if (updated) this.graph.updateNode(updated);
  }

  /**
   * List all memories with a specific tag.
   *
   * @param tag — Tag to filter by.
   * @returns Array of memory nodes with the tag.
   */
  async listByTag(tag: string): Promise<MemoryNode[]> {
    this.assertInit();
    return this.storage.queryNodesByTag(tag);
  }

  // -----------------------------------------------------------------------
  // Export API
  // -----------------------------------------------------------------------

  /**
   * Export memories in the specified format.
   */
  async export(opts: ExportOptions = {}): Promise<ExportResult> {
    this.assertInit();

    const format = opts.format ?? "json";
    let nodes: MemoryNode[];

    if (opts.tag) {
      nodes = await this.storage.queryNodesByTag(opts.tag);
    } else {
      nodes = this.graph.getAllNodes();
    }

    if (format === "json") {
      const data = JSON.stringify(nodes, null, 2);
      return { format, data, count: nodes.length };
    }

    // markdown or obsidian
    const { mkdirSync, writeSync, openSync, closeSync } = await import("fs");
    const { join } = await import("path");
    const outputDir = opts.output ?? "./memos-export";
    mkdirSync(outputDir, { recursive: true });

    for (const node of nodes) {
      const filename = `${node.id}.md`;
      const filepath = join(outputDir, filename);
      const content = this.nodeToMarkdown(node, format);
      const fd = openSync(filepath, "w");
      writeSync(fd, content);
      closeSync(fd);
    }

    return { format, data: outputDir, count: nodes.length };
  }

  // -----------------------------------------------------------------------
  // Experimental: Semantic Search
  // -----------------------------------------------------------------------

  /**
   * Import memories from a JSON file or directory of Markdown/Obsidian files.
   *
   * @param opts — Import options (source path, format).
   * @returns Import result with counts.
   */
  /**
   * Import memories from a third-party export: ChatGPT
   * (`conversations.json`), Claude (export directory or file), or Slack
   * (export directory). The parser sniffs each entry, maps messages to
   * timestamped memories, dedupes by content hash, and every item is
   * stored with `source: "external_data"` (lower trust by default) plus
   * provenance tags (`imported`, `<source>`), so imported memories are
   * rankable but never outrank first-party facts.
   *
   * With `synthesize: true`, a post-import pass extracts structured
   * decisions / preferences / milestones from the imported text using
   * rule-based heuristics (no LLM) and stores them as tagged memories.
   */
  async importExternal(opts: {
    /** Path to the export JSON file. Mutually exclusive with `data`. */
    file?: string;
    /** Pre-loaded export payload (JSON string or decoded value). */
    data?: unknown;
    /**
     * Path to an export directory. Required for `slack`; for
     * `chatgpt`/`claude` scans every `*.json`/`*.jsonl` file in the
     * directory. Mutually exclusive with `file`/`data`.
     */
    dir?: string;
    /** Parser hint. Default `"auto"` sniffs the shape. */
    source?: ExternalImportSource;
    namespace?: string;
    dryRun?: boolean;
    /** Safety cap on imported items. Default 500. */
    maxItems?: number;
    /** Extra tags applied to every imported memory. */
    tags?: string[];
    /**
     * Post-import synthesis pass: rule-based extraction of decisions,
     * preferences, and milestones into structured memories. Default
     * false.
     */
    synthesize?: boolean;
  }): Promise<{
    detected: DetectedExportSource;
    total: number;
    imported: number;
    skipped: number;
    dryRun: boolean;
    durationMs: number;
    sampleIds: string[];
    synthesized: { decisions: number; preferences: number; milestones: number };
  }> {
    this.assertInit();
    const start = Date.now();
    const dryRun = opts.dryRun ?? false;
    const maxItems = opts.maxItems ?? 500;
    const source = opts.source ?? "auto";

    let parsed;
    if (opts.dir) {
      if (source !== "chatgpt" && source !== "claude" && source !== "slack") {
        throw new Error(
          'importExternal with `dir` requires `source` to be "chatgpt", "claude", or "slack".',
        );
      }
      parsed = await parseExportDirectory(opts.dir, source, maxItems);
    } else {
      let payload: unknown = opts.data;
      if (payload === undefined && opts.file) {
        payload = await readFile(opts.file, "utf8");
      }
      if (payload === undefined) {
        throw new Error("importExternal requires `file`, `data`, or `dir`.");
      }
      parsed = parseExternalMemoryExport(payload, source, maxItems);
    }

    const sampleIds: string[] = [];
    let imported = 0;
    const storedNodes: Array<{ id: string; content: string }> = [];
    if (!dryRun) {
      for (const item of parsed.items) {
        try {
          const stored = await this.store(item.content, {
            source: "external_data",
            tags: ["imported", parsed.detected, ...(opts.tags ?? [])],
            ...(opts.namespace ? { namespace: opts.namespace } : {}),
            ...(item.createdAt ? { validFrom: item.createdAt } : {}),
            metadata: {
              importSource: parsed.detected,
              ...(item.author ? { importAuthor: item.author } : {}),
              ...(item.channel ? { importChannel: item.channel } : {}),
              ...(item.conversation
                ? { importConversation: item.conversation }
                : {}),
            },
          });
          imported += 1;
          storedNodes.push({ id: stored.node.id, content: item.content });
          if (sampleIds.length < 5) sampleIds.push(stored.node.id);
        } catch {
          // Retain-filter or other soft failure — count as skipped.
        }
      }
    }

    // Post-import synthesis: rule-based extraction of decisions,
    // preferences, and milestones (no LLM). Runs on the imported items
    // (or the parsed items in dry-run, without storing).
    const synthesized = { decisions: 0, preferences: 0, milestones: 0 };
    if (opts.synthesize) {
      const insights = synthesizeImportInsights(
        (dryRun ? parsed.items : storedNodes).map((item, i) => ({
          content: item.content,
          index: i,
        })),
      );
      for (const insight of insights) {
        synthesized[
          insight.kind === "decision"
            ? "decisions"
            : insight.kind === "preference"
              ? "preferences"
              : "milestones"
        ] += 1;
        if (!dryRun) {
          try {
            await this.store(insight.text, {
              source: "external_data",
              type: insight.kind === "preference" ? "preference" : "fact",
              tags: [
                "synthesized",
                "imported",
                parsed.detected,
                insight.kind,
                ...(opts.tags ?? []),
              ],
              ...(opts.namespace ? { namespace: opts.namespace } : {}),
              metadata: {
                importSource: parsed.detected,
                synthesized: true,
                synthesizedKind: insight.kind,
              },
            });
          } catch {
            // Soft failure — the count above already reflects detection.
          }
        }
      }
    }

    return {
      detected: parsed.detected,
      total: parsed.items.length,
      imported: dryRun ? 0 : imported,
      skipped: parsed.skipped,
      dryRun,
      durationMs: Date.now() - start,
      sampleIds,
      synthesized,
    };
  }

  // -----------------------------------------------------------------------
  // Procedural memory (self-editing instructions)
  // -----------------------------------------------------------------------

  private lessonStorage(): Pick<
    StorageAdapter,
    | "saveProceduralLesson"
    | "getProceduralLesson"
    | "updateProceduralLesson"
    | "listProceduralLessons"
  > {
    const s = this.storage;
    if (
      !s.saveProceduralLesson ||
      !s.getProceduralLesson ||
      !s.updateProceduralLesson ||
      !s.listProceduralLessons
    ) {
      throw new Error(
        "Procedural memory requires a storage adapter with procedural-lesson support (SQLiteStorage).",
      );
    }
    return s;
  }

  /**
   * Capture a procedural lesson — behavioral guidance for future tasks,
   * not a fact. Starts at the neutral prior score (0.5); outcome
   * feedback via `recordLessonOutcome` moves it from there.
   */
  async memorizeProcedural(
    lesson: string,
    opts: {
      context?: string;
      tags?: string[];
      namespace?: string;
      scope?: MemoryScope;
      initialScore?: number;
    } = {},
  ): Promise<ProceduralLesson> {
    this.assertInit();
    if (!lesson || lesson.trim().length === 0) {
      throw new Error("memorizeProcedural requires a non-empty lesson.");
    }
    const storage = this.lessonStorage();
    const namespace = opts.scope
      ? composeScope(opts.scope)
      : (opts.namespace ?? "default");
    const input: NewProceduralLesson = {
      lesson: lesson.trim(),
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
      namespace,
      ...(opts.initialScore !== undefined
        ? { initialScore: opts.initialScore }
        : {}),
    };
    return storage.saveProceduralLesson!(input);
  }

  /**
   * Record an outcome for a lesson. Successes reinforce
   * (`score += (1 - score) * 0.2`), failures demote
   * (`score -= score * 0.3`) — pure local math, fully transparent.
   * Also bumps `useCount` and refreshes timestamps (which resets the
   * read-time decay clock).
   */
  async recordLessonOutcome(
    id: string,
    outcome: LessonOutcome,
  ): Promise<ProceduralLesson> {
    this.assertInit();
    if (outcome !== "success" && outcome !== "failure") {
      throw new Error(
        'recordLessonOutcome outcome must be "success" or "failure".',
      );
    }
    const storage = this.lessonStorage();
    const current = await storage.getProceduralLesson!(id);
    if (!current) {
      throw new Error(`No procedural lesson found for id: ${id}`);
    }
    const updated = applyLessonOutcome(current, outcome);
    const saved = await storage.updateProceduralLesson!(id, updated);
    if (!saved) throw new Error(`No procedural lesson found for id: ${id}`);
    return saved;
  }

  /**
   * Retrieve the top-k procedural lessons for a query, ranked by a
   * blend of decayed score (60%) and query-token relevance (40%).
   * Lessons with no query overlap are skipped unless the query is
   * empty (empty query = top lessons by score).
   */
  async recallProcedural(
    query: string,
    k: number = DEFAULT_LESSON_PACK_K,
    opts: { namespace?: string; scope?: MemoryScope } = {},
  ): Promise<ProceduralLesson[]> {
    this.assertInit();
    const storage = this.lessonStorage();
    const namespace = opts.scope ? composeScope(opts.scope) : opts.namespace;
    const lessons = await storage.listProceduralLessons!(namespace);
    return rankProceduralLessons(lessons, query, k).map(
      ({ effectiveScore: _e, relevance: _r, rankScore: _s, ...lesson }) =>
        lesson,
    );
  }

  /** List procedural lessons, highest score first. */
  async listProceduralLessons(
    opts: {
      namespace?: string;
      scope?: MemoryScope;
    } = {},
  ): Promise<ProceduralLesson[]> {
    this.assertInit();
    const storage = this.lessonStorage();
    const namespace = opts.scope ? composeScope(opts.scope) : opts.namespace;
    return storage.listProceduralLessons!(namespace);
  }

  // -----------------------------------------------------------------------
  // Memory-grounded citations
  // -----------------------------------------------------------------------

  /**
   * Trace a citation token (e.g. `[mem:a3f9]`, `a3f9`, or a full id)
   * back to its source memory. Returns the full memory on an exact
   * prefix match, `not_found` when nothing matches, and `ambiguous`
   * with the candidate list when the token matches several memories
   * (use a longer token to disambiguate).
   */
  async resolveCitation(token: string): Promise<CitationResolution> {
    this.assertInit();
    const hex = parseCitationToken(token);
    if (!hex || !this.storage.findNodesByIdPrefix) {
      return { status: "not_found", token: token.trim() };
    }
    const candidates = await this.storage.findNodesByIdPrefix(hex);
    if (candidates.length === 0) {
      return { status: "not_found", token: token.trim() };
    }
    if (candidates.length === 1) {
      return {
        status: "resolved",
        token: citationToken(candidates[0]!.id),
        memory: candidates[0]!,
      };
    }
    return { status: "ambiguous", token: token.trim(), candidates };
  }

  /**
   * Render a citation resolution exactly as `memos cite` prints it.
   * Shared with the CLI so tests assert on the real output bytes.
   */
  formatCitation(resolution: CitationResolution, asJson = false): string {
    return formatCitationResolution(resolution, asJson);
  }

  // -----------------------------------------------------------------------
  // Provenance-trust layer: write gate, quarantine review, tier promotion
  // -----------------------------------------------------------------------

  /**
   * Screen text with the write-gate classifier without storing
   * anything. Useful for pre-flight checks and for testing the
   * classifier's verdict on a given input.
   */
  screenContent(content: string): QuarantineVerdict {
    return screenWrite(content);
  }

  /**
   * List quarantined memories — the review queue — most recently
   * flagged first. Quarantined memories are excluded from recall by
   * default; this is the explicit review path.
   */
  async listQuarantined(
    opts: { limit?: number; namespace?: string } = {},
  ): Promise<MemoryNode[]> {
    this.assertInit();
    const results = await this.storage.queryNodes({
      quarantinedOnly: true,
      limit: opts.limit ?? 50,
      sortBy: "createdAt",
      sortOrder: "desc",
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
    });
    return results.map((r) => r.node);
  }

  /**
   * Release a memory from quarantine: it becomes recallable again, but
   * stays flagged as low-trust for agent consumption — the
   * `releasedFromQuarantine` metadata marker keeps
   * `untrusted_source: true` on in MCP responses so a host agent
   * confirms it instead of silently injecting it as context.
   * Idempotent: releasing a non-quarantined memory is a no-op.
   * Add-only: `quarantinedAt`/`quarantineReason` are preserved as the
   * audit trail of the original flagging.
   */
  async releaseFromQuarantine(id: string): Promise<MemoryNode> {
    this.assertInit();
    const node = this.storage.peekNode
      ? await this.storage.peekNode(id)
      : await this.storage.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    if (!node.quarantined) return node;
    const updated = await this.storage.updateNode(id, {
      quarantined: false,
      metadata: {
        ...node.metadata,
        [QUARANTINE_RELEASED_METADATA_KEY]: true,
        quarantineReleasedAt: Date.now(),
      },
    });
    if (!updated) throw new Error(`Node not found: ${id}`);
    this.graph.updateNode(updated);
    this.invalidateSearchCache();
    return updated;
  }

  /**
   * Set a memory's provenance tier. This is the only path to the
   * `user-verified` tier — explicit user confirmation, never assigned
   * automatically at write time.
   */
  async setProvenance(id: string, tier: ProvenanceTier): Promise<MemoryNode> {
    this.assertInit();
    if (!isProvenanceTier(tier)) {
      throw new Error(`Unknown provenance tier: ${String(tier)}`);
    }
    const updated = await this.storage.updateNode(id, { provenance: tier });
    if (!updated) throw new Error(`Node not found: ${id}`);
    this.graph.updateNode(updated);
    this.invalidateSearchCache();
    return updated;
  }

  /**
   * Per-harness memory counts — "which harnesses wrote what lives in
   * this database". Powers `memos harness list`. Memories written
   * before harness attribution existed (or by clients that never set
   * the tag) read as `"unknown"`.
   */
  async getHarnessCounts(): Promise<HarnessCount[]> {
    this.assertInit();
    if (this.storage.getHarnessCounts) {
      return this.storage.getHarnessCounts();
    }
    // Fallback for custom storage adapters: page through the whole
    // store (historical + quarantined included) and count in JS.
    const counts = new Map<string, number>();
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const rows = await this.storage.queryNodes({
        includeHistorical: true,
        includeQuarantined: true,
        limit: pageSize,
        offset,
      });
      if (rows.length === 0) break;
      for (const r of rows) {
        const h = r.node.harness ?? "unknown";
        counts.set(h, (counts.get(h) ?? 0) + 1);
      }
      offset += rows.length;
    }
    return [...counts.entries()]
      .map(([harness, count]) => ({ harness, count }))
      .sort((a, b) => b.count - a.count || (a.harness < b.harness ? -1 : 1));
  }

  /**
   * Merge another harness's database file into this one — "one memory,
   * every harness."
   *
   * The merge is a faithful row-level import, not a re-write: every
   * source node keeps its id (remapped only on collision), timestamps,
   * bitemporal validity interval (`validFrom`/`validTo`), provenance
   * tier, trust score, tags, quarantine state, and harness tag. Edges
   * follow their endpoints through the id remap.
   *
   * Cross-harness duplicates and contradictions are NOT resolved here:
   * imported nodes go through the exact same post-write path as
   * `store()` — re-embedded by the local provider and registered for
   * the existing write-time contradiction scan — so the established
   * contradiction detection + read-time resolution machinery converges
   * them exactly as if they had been written locally. No second
   * resolution system exists, by design.
   *
   * Deterministic: nodes import in (createdAt, id) order; collisions
   * get fresh UUIDs recorded in the result's id map.
   *
   * @param fromPath — Path to the source `.db` file.
   * @param opts — `{ dryRun }` reports the plan without writing.
   */
  async mergeHarnessDb(
    fromPath: string,
    opts: HarnessMergeOptions = {},
  ): Promise<HarnessMergeResult> {
    this.assertInit();
    const { existsSync } = await import("node:fs");
    const start = Date.now();
    const dryRun = opts.dryRun ?? false;
    if (!existsSync(fromPath)) {
      throw new Error(`Merge source not found: ${fromPath}`);
    }

    // Open the source as a plain SQLiteStorage. We never write through
    // it, but init() must run so the harness migration applies to legacy
    // source DBs too (additive, idempotent). Closed in the finally below.
    const source = new SQLiteStorage(fromPath, false);
    await source.init();
    try {
      const sourceNodes = await source.listAllNodes();
      const sourceEdges = await source.listAllEdges();

      const idMap = new Map<string, string>(); // source id → target id
      const plan: HarnessMergeResult["nodes"] = [];
      let nodesRemapped = 0;

      // Deterministic import order: creation time, id tiebreak.
      const ordered = [...sourceNodes].sort((a, b) =>
        a.createdAt < b.createdAt
          ? -1
          : a.createdAt > b.createdAt
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
      for (const node of ordered) {
        const existing =
          (await this.storage.peekNode?.(node.id)) ??
          (await this.storage.getNode(node.id));
        let targetId = node.id;
        let remapped = false;
        if (existing) {
          // UUID collision across two independently-created DBs is
          // near-impossible; when it happens, remap and rewrite every
          // incident edge endpoint below. Citations ([mem:hex]) of the
          // colliding node change — unavoidable and reported.
          targetId = generateId();
          remapped = true;
          nodesRemapped += 1;
        }
        idMap.set(node.id, targetId);
        plan.push({
          sourceId: node.id,
          targetId,
          remapped,
          harness: node.harness ?? "unknown",
        });
        if (!dryRun) {
          const imported: MemoryNode = { ...node, id: targetId };
          await this.storage.saveNode(imported);
          this.graph.addNode(imported);
          // Same post-write path as store(): re-embed under the local
          // provider and register for the existing write-time
          // contradiction scan. Cross-harness duplicates/contradictions
          // converge through that machinery — nothing merge-specific.
          this.scheduleEmbedding(imported);
          this.contradictionScanPending.add(imported.id);
          this.emit("node:created", imported);
        }
      }

      let edgesImported = 0;
      let edgesSkipped = 0;
      for (const edge of sourceEdges) {
        const mappedSource = idMap.get(edge.sourceId);
        const mappedTarget = idMap.get(edge.targetId);
        if (!mappedSource || !mappedTarget) {
          edgesSkipped += 1;
          continue;
        }
        if (dryRun) {
          edgesImported += 1;
          continue;
        }
        try {
          const importedEdge = await this.storage.saveEdge({
            ...edge,
            id: generateId(),
            sourceId: mappedSource,
            targetId: mappedTarget,
          });
          this.graph.addEdge({
            sourceId: mappedSource,
            targetId: mappedTarget,
            relation: edge.relation,
            weight: edge.weight,
            metadata: edge.metadata,
            validFrom: edge.validFrom,
            validTo: edge.validTo,
          });
          this.emit("edge:created", importedEdge);
          edgesImported += 1;
        } catch {
          // UNIQUE(source_id, target_id, relation) already present in
          // the target — the relation exists, nothing to import.
          edgesSkipped += 1;
        }
      }

      if (!dryRun) this.invalidateSearchCache();

      return {
        from: fromPath,
        dryRun,
        sourceNodes: sourceNodes.length,
        sourceEdges: sourceEdges.length,
        // In dry-run these are the would-import counts; nothing was written.
        nodesImported: plan.length,
        nodesRemapped,
        edgesImported,
        edgesSkipped,
        nodes: plan,
        durationMs: Date.now() - start,
      };
    } finally {
      await source.close();
    }
  }

  async importMemories(opts: ImportOptions): Promise<ImportResult> {
    this.assertInit();

    const { readFileSync, readdirSync, existsSync } = await import("fs");
    const { join } = await import("path");

    const source = opts.source;
    if (!existsSync(source)) {
      throw new Error(`Import source not found: ${source}`);
    }

    // Auto-detect format from path
    let format = opts.format;
    if (!format) {
      if (source.endsWith(".json")) {
        format = "json";
      } else {
        format = "markdown";
      }
    }

    if (format === "json") {
      return this.importJson(source);
    }

    // markdown or obsidian — read all .md files from directory
    if (!existsSync(source)) {
      throw new Error(`Import directory not found: ${source}`);
    }

    const files = readdirSync(source).filter((f: string) => f.endsWith(".md"));
    let totalCount = 0;
    let edgeCount = 0;
    const nodeMap = new Map<string, string>(); // content prefix → node id (for obsidian wikilinks)

    for (const file of files) {
      const content = readFileSync(join(source, file), "utf-8");
      const parsed = this.parseMarkdownFile(content);

      const { node } = await this.store(parsed.content, {
        type: normalizeMemoryType(parsed.type),
        tags: parsed.tags,
        metadata: parsed.metadata,
      });

      totalCount++;
      nodeMap.set(node.content.slice(0, 50), node.id);

      // For obsidian format, recreate wikilink edges
      if (format === "obsidian" && parsed.wikilinks.length > 0) {
        for (const linkTarget of parsed.wikilinks) {
          // Find matching node by content prefix
          for (const [prefix, targetId] of nodeMap) {
            if (linkTarget.includes(prefix.slice(0, 20))) {
              await this.link(node.id, targetId, "relates_to", 0.5);
              edgeCount++;
              break;
            }
          }
        }
      }
    }

    return { count: totalCount, edgesCreated: edgeCount };
  }

  private async importJson(source: string): Promise<ImportResult> {
    const { readFileSync } = await import("fs");
    const raw = readFileSync(source, "utf-8");
    const items: unknown = JSON.parse(raw);

    if (!Array.isArray(items)) {
      throw new Error(
        "JSON import source must contain an array of memory objects.",
      );
    }

    let count = 0;
    for (const item of items) {
      if (
        isRecord(item) &&
        typeof item.content === "string" &&
        item.content.length > 0
      ) {
        await this.store(item.content, {
          type: normalizeMemoryType(item.type),
          tags: stringArray(item.tags),
          metadata: isRecord(item.metadata) ? item.metadata : undefined,
          summary: typeof item.summary === "string" ? item.summary : undefined,
          importance:
            typeof item.importance === "number" ? item.importance : undefined,
        });
        count++;
      }
    }

    return { count, edgesCreated: 0 };
  }

  private parseMarkdownFile(content: string): {
    content: string;
    type: string;
    tags: string[];
    metadata: Record<string, unknown>;
    wikilinks: string[];
  } {
    const lines = content.split("\n");
    let inFrontmatter = false;
    const frontmatterLines: string[] = [];
    const bodyLines: string[] = [];
    const wikilinks: string[] = [];

    for (const line of lines) {
      if (
        line.trim() === "---" &&
        !inFrontmatter &&
        frontmatterLines.length === 0
      ) {
        inFrontmatter = true;
        continue;
      }
      if (line.trim() === "---" && inFrontmatter) {
        inFrontmatter = false;
        continue;
      }
      if (inFrontmatter) {
        frontmatterLines.push(line);
      } else {
        bodyLines.push(line);
        // Extract [[wikilinks]]
        const linkMatches = line.match(/\[\[([^\]]+)\]\]/g);
        if (linkMatches) {
          for (const match of linkMatches) {
            wikilinks.push(match.slice(2, -2));
          }
        }
      }
    }

    // Parse frontmatter
    let type = "fact";
    let tags: string[] = [];
    const metadata: Record<string, unknown> = {};

    for (const line of frontmatterLines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (key === "type") {
        type = value.replace(/"/g, "");
      } else if (key === "tags") {
        // Parse [tag1, tag2] format
        const tagMatch = value.match(/\[(.*)\]/);
        if (tagMatch) {
          tags = tagMatch[1]
            .split(",")
            .map((t: string) => t.trim().replace(/"/g, ""));
        }
      } else if (key === "id" || key === "created_at" || key === "expires_at") {
        metadata[key] = value.replace(/"/g, "");
      }
    }

    return {
      content: bodyLines.join("\n").trim(),
      type,
      tags,
      metadata,
      wikilinks,
    };
  }

  /**
   * Semantic-only retrieval. Uses persisted embedding vectors when configured,
   * with the older graph text-similarity path kept as a no-provider fallback.
   *
   * Two call styles (both supported):
   *   semanticSearch(query, 10, 0.2, { namespace: "demo" })   // positional
   *   semanticSearch(query, { limit: 10, threshold: 0.2, namespace: "demo" })
   *
   * @param query — Text query to search for.
   * @param limitOrOpts — Result limit, or an options object with `limit`,
   *   `threshold`, and any `SearchFilter` field.
   * @param threshold — Minimum similarity score in [0, 1] (positional style).
   * @param filter — Extra search filters (positional style).
   */
  async semanticSearch(
    query: string,
    limitOrOpts: number | SemanticSearchOptions = 20,
    threshold = 0.1,
    filter: SearchFilter = {},
  ): Promise<ScoredMemory[]> {
    this.assertInit();

    let limit: number;
    let resolvedThreshold: number;
    let resolvedFilter: SearchFilter;
    if (typeof limitOrOpts === "number") {
      limit = limitOrOpts;
      resolvedThreshold = threshold;
      resolvedFilter = filter;
    } else {
      const { threshold: t, limit: l, ...rest } = limitOrOpts;
      limit = l ?? 20;
      resolvedThreshold = t ?? threshold;
      resolvedFilter = { ...rest, ...filter };
    }

    // Same store-then-search guarantee as search(): drain the embedding
    // queue so just-stored memories are visible. No-op when empty.
    await this.flushEmbeddings();

    if (this.embeddingProvider && this.storage.querySimilarEmbeddings) {
      // Route queries through `embedQuery` when the provider supports it:
      // asymmetric retrieval models (Liquid LFM2.5-Embedding / e5) expect
      // a query-side instruction and silently degrade without it.
      const provider = this.embeddingProvider;
      const queryVector = provider.embedQuery
        ? await provider.embedQuery(query)
        : await provider.embed(query);
      // Only compare against vectors produced by the SAME model —
      // dimension equality alone does not make vectors comparable.
      return this.storage.querySimilarEmbeddings(
        queryVector,
        resolvedFilter,
        limit,
        resolvedThreshold,
        provider.model,
      );
    }

    const nodes = this.graph.getAllNodes();
    const scored: ScoredMemory[] = [];
    const poolFilter = resolvedFilter.pool
      ? Array.isArray(resolvedFilter.pool)
        ? resolvedFilter.pool
        : [resolvedFilter.pool]
      : null;

    for (const node of nodes) {
      if (
        resolvedFilter.namespace &&
        node.namespace !== resolvedFilter.namespace
      )
        continue;
      if (
        resolvedFilter.namespacePrefix &&
        !node.namespace.startsWith(resolvedFilter.namespacePrefix)
      ) {
        continue;
      }
      if (resolvedFilter.type && node.type !== resolvedFilter.type) continue;
      if (poolFilter && !poolFilter.includes(node.pool ?? "event")) continue;
      if (
        resolvedFilter.tags &&
        resolvedFilter.tags.some((tag) => !node.tags.includes(tag))
      ) {
        continue;
      }
      // Provenance-trust: quarantined memories stay out of recall by
      // default (the write-gate guarantee), like the SQL legs.
      if (!quarantineVisible(node.quarantined, resolvedFilter)) continue;
      const score = textSimilarity(query, node.content);
      if (score >= resolvedThreshold) {
        scored.push({ node, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // -----------------------------------------------------------------------
  // Experimental: Graph Visualization
  // -----------------------------------------------------------------------

  /**
   * Generate a DOT-format graph visualization string.
   */
  async graphViz(): Promise<string> {
    this.assertInit();
    if (!this.experimental.graphViz) {
      throw new Error(
        "Graph visualization is experimental. Enable it with experimental: { graphViz: true }",
      );
    }

    const nodes = this.graph.getAllNodes();
    const edges = this.graph.getAllEdges();

    let dot = "digraph MemOS {\n";
    dot += "  rankdir=LR;\n";
    dot += "  node [shape=box, style=rounded];\n\n";

    for (const node of nodes) {
      const label =
        node.summary.length > 40
          ? node.summary.slice(0, 37) + "..."
          : node.summary;
      dot += `  "${node.id.slice(0, 8)}" [label="${this.escapeDot(label)}"];\n`;
    }

    dot += "\n";

    for (const edge of edges) {
      dot += `  "${edge.sourceId.slice(0, 8)}" -> "${edge.targetId.slice(0, 8)}" [label="${edge.relation}", weight=${edge.weight.toFixed(2)}];\n`;
    }

    dot += "}\n";
    return dot;
  }

  // -----------------------------------------------------------------------
  // Experimental: Namespaces
  // -----------------------------------------------------------------------

  /**
   * List all namespaces.
   */
  async listNamespaces(): Promise<string[]> {
    this.assertInit();

    const nodes = this.graph.getAllNodes();
    const nsSet = new Set<string>();
    for (const n of nodes) {
      nsSet.add(n.namespace);
    }
    return [...nsSet];
  }

  /**
   * Get the count of memories in a namespace.
   */
  async namespaceCount(ns: string): Promise<number> {
    this.assertInit();

    return this.graph.getAllNodes().filter((n) => n.namespace === ns).length;
  }

  // -----------------------------------------------------------------------
  // Experimental: Context Injection
  // -----------------------------------------------------------------------

  /**
   * Get context for a node by walking the graph to a given depth.
   * Returns the node's content plus contents of neighbours up to `depth` hops.
   */
  async injectContext(id: string, depth = 1, maxChars = 2000): Promise<string> {
    this.assertInit();
    if (!this.experimental.contextInjection) {
      throw new Error(
        "Context injection is experimental. Enable it with experimental: { contextInjection: true }",
      );
    }

    const visited = new Set<string>();
    const queue: Array<{ id: string; d: number }> = [{ id, d: 0 }];
    const parts: string[] = [];
    let qi = 0;

    while (qi < queue.length) {
      const { id: currentId, d } = queue[qi++];
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const node = this.graph.getNode(currentId);
      if (!node) continue;

      const prefix =
        d === 0 ? "Current memory:" : `Related memory (depth ${d}):`;
      parts.push(`${prefix}\n${node.content}`);

      if (d < depth) {
        const neighbours = this.graph.getNeighbours(currentId);
        for (const n of neighbours) {
          if (!visited.has(n.id)) {
            queue.push({ id: n.id, d: d + 1 });
          }
        }
      }
    }

    let context = parts.join("\n\n---\n\n");
    if (context.length > maxChars) {
      context = context.slice(0, maxChars) + "\n...[truncated]";
    }
    return context;
  }

  // -----------------------------------------------------------------------
  // Extended API
  // -----------------------------------------------------------------------

  /**
   * Update an existing memory node.
   */
  async update(
    id: string,
    input: UpdateMemoryInput,
  ): Promise<MemoryNode | null> {
    this.assertInit();
    let node = await this.storage.updateNode(id, input);
    if (node) {
      // The cached L1/L2 describe the old text — regenerate when the
      // content changed and persist the refreshed cache. Not hot-path
      // (explicit updates only).
      if (input.content !== undefined) {
        const metadata = { ...(node.metadata ?? {}) };
        stampFidelityCache({ ...node, metadata });
        node = (await this.storage.updateNode(id, { metadata })) ?? node;
      }
      this.graph.updateNode(node);
      if (input.content !== undefined || input.summary !== undefined) {
        this.scheduleEmbedding(node);
      }
      this.emit("node:updated", node);
      this.invalidateSearchCache();
    }
    return node;
  }

  /**
   * Get the full graph snapshot (nodes + edges).
   */
  async getGraph(): Promise<GraphSnapshot> {
    this.assertInit();
    return {
      nodes: this.graph.getAllNodes(),
      edges: this.graph.getAllEdges(),
    };
  }

  /**
   * Get the graph as of a bitemporal timestamp (unix ms) — time-travel
   * over add-only history. Backs the MCP Apps explorer's as-of scrubber.
   * Reads from storage (the in-memory graph only reflects live state);
   * adapters without `getGraphAtTime` fall back to filtering the live
   * snapshot with the same as-of predicates.
   */
  async getGraphAtTime(atTime: number): Promise<GraphSnapshot> {
    this.assertInit();
    if (typeof this.storage.getGraphAtTime === "function") {
      return this.storage.getGraphAtTime(atTime);
    }
    const graph = await this.storage.getGraph();
    return {
      nodes: graph.nodes.filter(
        (n) =>
          (n.validFrom === null ||
            n.validFrom === undefined ||
            n.validFrom <= atTime) &&
          (n.validTo === null ||
            n.validTo === undefined ||
            n.validTo >= atTime),
      ),
      edges: graph.edges.filter(
        (e) =>
          (e.validFrom === null ||
            e.validFrom === undefined ||
            e.validFrom <= atTime) &&
          (e.validTo === null || e.validTo === undefined || e.validTo > atTime),
      ),
    };
  }

  /**
   * Get direct neighbours of a memory node.
   */
  async getNeighbours(nodeId: string): Promise<MemoryNode[]> {
    this.assertInit();
    return this.graph.getNeighbours(nodeId);
  }

  /**
   * Get all edges connected to a memory node.
   */
  async getEdges(nodeId: string): Promise<MemoryEdge[]> {
    this.assertInit();
    return this.graph.getEdgesForNode(nodeId);
  }

  /**
   * Find clusters of related memories.
   */
  async clusters(minSize = 2): Promise<string[][]> {
    this.assertInit();
    return this.graph.findClusters(minSize);
  }

  /**
   * Return the total number of stored memories.
   */
  get count(): number {
    return this.graph.size;
  }

  /**
   * Remove all memories and edges.
   */
  async clear(): Promise<void> {
    this.assertInit();
    await this.storage.deleteAllNodes();
    this.graph.clear();
  }

  /**
   * Shut down MemOS and release resources.
   */
  async close(): Promise<void> {
    this.stopSweep();
    if (this.embeddingQueue) {
      await this.embeddingQueue.close();
      this.embeddingQueue = null;
    }
    await this.storage.close();
    this.graph.clear();
    this.initialised = false;
  }

  /**
   * Build an AI Trio v1 context pack for a query.
   *
   * This is the canonical read-only envelope consumed by LLM Guardian
   * and any other AI Trio member. Items are sorted by descending
   * relevance and trimmed to fit `tokenBudget`. The score is
   * reproducible for the same query, provider, model, and database.
   *
   * @example
   * ```ts
   * const pack = await memos.contextPack({
   *   query: "release blockers",
   *   namespace: "default",
   *   tokenBudget: 1200,
   * });
   * ```
   */
  async contextPack(opts: {
    query: string;
    namespace?: string;
    /** Typed multi-scope filter (hierarchical by default). */
    scope?: MemoryScope;
    /** How `scope` matches stored namespaces. Default `"hierarchical"`. */
    scopeMatch?: "exact" | "hierarchical";
    tokenBudget: number;
    limit?: number;
    trust?: string;
    source?: string;
    includeSummary?: boolean;
    /**
     * Fidelity level for pack item contents: a fixed level or
     * `"adaptive"` (the query-adaptive router picks the starting level
     * per query). Default `undefined` = L3 verbatim — current behavior
     * preserved exactly. Lower levels cut tokens per item; the chosen
     * level is recorded per item (`item.fidelity`) and in the pack
     * metadata (`pack.fidelity`).
     */
    fidelity?: FidelityLevel | "adaptive";
    /** Output format: "json" (default), "toon", or "toon-compact" */
    format?: "json" | "toon" | "toon-compact";
    /**
     * Opt-in semantic dedup: drop pack items whose stored embedding is a
     * near-duplicate (cosine >= 0.90) of an already-selected item's.
     * Catches paraphrased memories that lexical dedup misses. Costs one
     * pass over stored embedding rows (filtered to the candidate set);
     * off by default.
     */
    semanticDedup?: boolean;
    /**
     * Multi-stream retrieval (LongMemEval-V2 design lesson): run the query
     * separately against each granularity pool (`event`, `note`,
     * `procedure`) and fuse the ranked lists. Beats a single fused query
     * once distilled notes or procedures exist, and degrades to the
     * plain single-stream path when only `event` content is present.
     * Default true.
     */
    multiStream?: boolean;
    /**
     * Bounded graph expansion for this pack: 1-hop neighbours of the top
     * seeds join the candidate set (via `derived_from` / relation edges),
     * so consolidated summaries carry their sources. Default true;
     * `experimental.graphExpansion` settings take precedence when set.
     */
    graphExpansion?: boolean;
    /**
     * Memory-grounded citations (opt-in, default off): every pack item
     * carries a `[mem:xxxx]` token (unique within the pack) rendered
     * ahead of its content in TOON output, resolvable via
     * `resolveCitation` / `memos cite`.
     */
    citations?: boolean;
    /**
     * Inject top procedural lessons as an "operating instructions"
     * section (additive; default off). `true` injects the top 3 lessons
     * for the query; a number sets k. Uses the pack's namespace.
     */
    lessons?: boolean | number;
  }): Promise<ContextPack | string> {
    this.assertInit();
    const scopeFilter = this.resolveScopeFilter({
      namespace: opts.namespace,
      scope: opts.scope,
      scopeMatch: opts.scopeMatch,
    });
    const namespace =
      scopeFilter.namespace ?? scopeFilter.namespacePrefix ?? "default";
    const limit =
      opts.limit ??
      Math.min(50, Math.max(8, Math.floor(opts.tokenBudget / 80)));
    // Always go through the hybrid path so we get a score breakdown,
    // and a wider candidate set so budget trimming has material to work
    // with. Falls back to keyword search when no embedding provider is
    // configured.
    const filter: SearchFilter = {
      query: opts.query,
      limit: limit * 4,
      // Forward the pack-level graph-expansion opt-out to the hybrid
      // search's PPR-lite expansion (undefined keeps the default on).
      graphExpansion: opts.graphExpansion,
      ...scopeFilter,
    };
    const items = this.embeddingProvider
      ? opts.multiStream === false ||
        !(await this.hasPoolContent(namespace, ["note", "procedure"]))
        ? await this.hybridSearch(filter)
        : await this.multiStreamSearch(filter)
      : await this.storage.queryNodes(filter);

    // Bounded graph expansion for packs (default on): 1-hop neighbours of
    // the top seeds ride along even when no query would surface them —
    // derived_from edges from consolidation make summaries carry their
    // sources. Honors the caller's `graphExpansion: false`; when the
    // experimental config already tunes expansion, its values win.
    const expandedItems =
      opts.graphExpansion === false
        ? items
        : await this.applyGraphExpansion(
            items,
            this.experimental.graphExpansion ?? {
              enabled: true,
              maxSeeds: 3,
              maxAdded: 5,
              scoreFactor: 0.85,
            },
            filter,
          );

    // Semantic dedup needs each candidate's stored vector. Pull them in
    // one pass over the embedding table filtered to the candidate ids —
    // no new embedding compute, just a lookup of vectors we already have.
    let embeddings: Map<string, EmbeddingVector> | undefined;
    if (opts.semanticDedup && this.storage.getAllEmbeddings) {
      const wanted = new Set(expandedItems.map((i) => i.node.id));
      embeddings = new Map();
      for (const row of await this.storage.getAllEmbeddings()) {
        if (wanted.has(row.nodeId)) embeddings.set(row.nodeId, row.vector);
      }
    }

    const pack = buildContextPack({
      query: opts.query,
      namespace,
      tokenBudget: opts.tokenBudget,
      items: expandedItems,
      trust: opts.trust,
      source: opts.source,
      includeSummary: opts.includeSummary,
      fidelity: opts.fidelity,
      embeddings,
      citations: opts.citations,
      ...(await this.packLessons(opts, namespace)),
    });
    // Telemetry: the naive baseline is what dumping the SAME candidates as
    // full raw node JSON would cost (the "no memory layer" approach) —
    // punctuation-heavy minified JSON, which is exactly why TOON wins.
    // `estimateTokens` counts punctuation as tokens, matching GPT.
    const naiveBaselineTokens = estimateTokens(
      JSON.stringify(expandedItems.map((r) => r.node)),
    );

    // Serialize in the requested format if not "json"
    if (opts.format && opts.format !== "json") {
      // Guarded above: non-json formats always serialize to a string.
      const serialized = serializeContextPack(pack, opts.format) as string;
      this.trackPackUsage(estimateTokens(serialized), naiveBaselineTokens);
      return serialized;
    }

    this.trackPackUsage(
      estimateTokens(
        JSON.stringify((pack as { items?: unknown[] }).items ?? pack),
      ),
      naiveBaselineTokens,
    );
    return pack;
  }

  /**
   * Fetch procedural lessons for pack injection. Returns `{}` when the
   * caller didn't ask for lessons or the storage adapter has no lesson
   * support — packs stay additive and never fail on lessons.
   */
  private async packLessons(
    opts: { query: string; lessons?: boolean | number },
    namespace: string,
  ): Promise<{ lessons?: ProceduralLesson[] }> {
    if (!opts.lessons) return {};
    if (!this.storage.listProceduralLessons) return {};
    const k =
      opts.lessons === true
        ? DEFAULT_LESSON_PACK_K
        : Math.max(1, Math.floor(opts.lessons));
    const lessons = await this.recallProcedural(opts.query, k, {
      namespace,
    }).catch(() => [] as ProceduralLesson[]);
    return lessons.length > 0 ? { lessons } : {};
  }

  /**
   * Lifetime token-savings counters for context packs. `savedPct` is the
   * percentage of the naive baseline (raw node JSON for the same
   * candidates) that TOON packing + budget trimming eliminated.
   */
  usageStats(): {
    packsBuilt: number;
    packTokens: number;
    naiveBaselineTokens: number;
    savedTokens: number;
    savedPct: number;
  } {
    const savedTokens = this.usage.naiveBaselineTokens - this.usage.packTokens;
    return {
      packsBuilt: this.usage.packsBuilt,
      packTokens: this.usage.packTokens,
      naiveBaselineTokens: this.usage.naiveBaselineTokens,
      savedTokens,
      savedPct:
        this.usage.naiveBaselineTokens > 0
          ? Number(
              ((savedTokens / this.usage.naiveBaselineTokens) * 100).toFixed(1),
            )
          : 0,
    };
  }

  private trackPackUsage(
    packTokens: number,
    naiveBaselineTokens: number,
  ): void {
    this.usage.packsBuilt += 1;
    this.usage.packTokens += packTokens;
    this.usage.naiveBaselineTokens += naiveBaselineTokens;
  }

  /**
   * Whether any memory exists in the given pools. Cheap probe used by
   * `contextPack` to skip multi-stream retrieval on event-only stores.
   */
  private async hasPoolContent(
    namespace: string,
    pools: MemoryPool[],
  ): Promise<boolean> {
    const probe = await this.storage.queryNodes({
      namespace,
      pool: pools,
      limit: 1,
    });
    return probe.length > 0;
  }

  /**
   * Multi-stream retrieval: run the query separately against each
   * granularity pool and fuse the ranked lists by keeping each node's best
   * stream score. Candidates found by multiple streams are the strongest
   * evidence — exactly the behavior that beats single-query retrieval on
   * the LongMemEval-V2 ablations.
   */
  private async multiStreamSearch(
    filter: SearchFilter,
  ): Promise<ScoredMemory[]> {
    const pools: MemoryPool[] = ["event", "note", "procedure"];
    const streams = await Promise.all(
      pools.map((pool) => this.hybridSearch({ ...filter, pool, offset: 0 })),
    );

    const byId = new Map<string, ScoredMemory>();
    for (const stream of streams) {
      for (const result of stream) {
        const existing = byId.get(result.node.id);
        if (!existing || result.score > existing.score) {
          byId.set(result.node.id, result);
        }
      }
    }
    return [...byId.values()].sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------------------
  // Memory consolidation ("dreaming")
  // ---------------------------------------------------------------------------

  /**
   * Merge near-duplicate memories. Two memories with cosine
   * similarity over their embeddings above `threshold` collapse into
   * one: the survivor is the one with the highest importance (ties
   * broken by recency), and the merged-in nodes have their access
   * count and tag union folded in.
   */
  async dedupe(opts: DedupeOptions = {}): Promise<DedupeResult> {
    this.assertInit();
    const start = Date.now();
    const threshold = opts.threshold ?? 0.92;
    const namespace = opts.namespace ?? "default";
    const dryRun = opts.dryRun ?? false;
    const maxPairs = opts.maxPairs ?? 10_000;

    const all = await this.collectEmbeddings(namespace);
    if (all.length < 2) {
      return {
        merges: [],
        clustersFound: 0,
        dryRun,
        durationMs: Date.now() - start,
      };
    }

    // Greedy single-linkage clustering. O(n²) — fine up to a few
    // thousand nodes. For larger stores, callers should pass
    // `maxPairs` to bound the work.
    const parents: number[] = all.map((_, i) => i);
    const find = (i: number): number =>
      parents[i] === i ? i : (parents[i] = find(parents[i]));
    const union = (a: number, b: number): void => {
      parents[find(a)] = find(b);
    };

    let pairsScanned = 0;
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        if (++pairsScanned > maxPairs) break;
        if (all[i].model !== all[j].model) continue;
        const sim = cosineSimilarity(all[i].vector, all[j].vector);
        if (sim >= threshold) union(i, j);
      }
    }

    // Group by root parent.
    const groups = new Map<number, number[]>();
    for (let i = 0; i < all.length; i += 1) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    }

    const merges: DedupeMerge[] = [];
    for (const [, indices] of groups) {
      if (indices.length < 2) continue;
      // Pick survivor by importance desc, then access count desc, then
      // updatedAt desc, then id lex asc.
      const sorted = [...indices].sort((a, b) => {
        const na = all[a].node;
        const nb = all[b].node;
        if (nb.importance !== na.importance)
          return nb.importance - na.importance;
        if (nb.accessCount !== na.accessCount)
          return nb.accessCount - na.accessCount;
        if (nb.updatedAt !== na.updatedAt) return nb.updatedAt - na.updatedAt;
        return na.id.localeCompare(nb.id);
      });
      const survivor = all[sorted[0]].node;
      const removedIds = sorted.slice(1).map((idx) => all[idx].node.id);
      const unionTags = [
        ...new Set(sorted.flatMap((idx) => all[idx].node.tags)),
      ];
      const mergedAccess = sorted.reduce(
        (sum, idx) => sum + all[idx].node.accessCount,
        0,
      );
      const mergedImportance = Math.max(
        ...sorted.map((idx) => all[idx].node.importance),
      );
      // Mean similarity across the cluster.
      let simSum = 0;
      let simCount = 0;
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          simSum += cosineSimilarity(
            all[sorted[i]].vector,
            all[sorted[j]].vector,
          );
          simCount += 1;
        }
      }
      const meanSim = simCount > 0 ? simSum / simCount : 1;
      merges.push({
        kept: survivor.id,
        removed: removedIds,
        reason: "cosine_similarity_above_threshold",
        similarity: meanSim,
      });

      if (!dryRun) {
        await this.storage.updateNode(survivor.id, {
          tags: unionTags,
          importance: mergedImportance,
        });
        // Adjust access_count in the same update by reading the
        // current count and patching metadata. This avoids a
        // separate write path.
        const current = (await this.storage.peekNode!(survivor.id))!;
        const delta = mergedAccess - current.accessCount;
        if (delta > 0) {
          // Re-read + set the absolute total. We piggyback on
          // updateNode by abusing the metadata field for a counter
          // patch; the cleaner path would be a dedicated method.
          await this.storage.updateNode(survivor.id, {
            metadata: {
              ...current.metadata,
              __consolidatedAccessBoost: delta,
            },
          });
        }
        for (const removedId of removedIds) {
          await this.forget(removedId);
        }
      }
    }

    return {
      merges,
      clustersFound: merges.length,
      dryRun,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Move stale + low-importance memories to the `archived` namespace.
   * They are NOT deleted — they remain in the DB and can be restored
   * with `memos.update(id, { namespace: "default" })`.
   */
  async archive(opts: ArchiveOptions = {}): Promise<ArchiveResult> {
    this.assertInit();
    const start = Date.now();
    const afterDays = opts.afterDays ?? 90;
    const importanceBelow = opts.importanceBelow ?? 0.3;
    const namespace = opts.namespace ?? "default";
    const dryRun = opts.dryRun ?? false;
    if (!this.storage.setNodeNamespace) {
      return { moves: [], dryRun, durationMs: Date.now() - start };
    }

    const cutoff = Date.now() - afterDays * 86_400_000;
    const all = await this.storage.queryNodes({ namespace, limit: 10_000 });
    const moves: ArchiveMove[] = [];
    for (const { node } of all) {
      if (node.importance >= importanceBelow) continue;
      if (node.lastAccessed > cutoff) continue;
      if (node.expiresAt !== null) continue; // already on a TTL clock
      moves.push({ id: node.id, reason: "stale_and_low_importance" });
      if (!dryRun) {
        await this.storage.setNodeNamespace(node.id, "archived");
        this.graph.updateNode({ ...node, namespace: "archived" });
      }
    }

    return { moves, dryRun, durationMs: Date.now() - start };
  }

  /**
   * Cluster memories by embedding similarity and produce an extractive
   * summary for each cluster above `minClusterSize`. The summary is
   * stored as a regular node with `derived_from` edges to each
   * source.
   */
  async summarizeCluster(
    opts: SummarizeClusterOptions = {},
  ): Promise<SummarizeClusterResult> {
    this.assertInit();
    const start = Date.now();
    const namespace = opts.namespace ?? "default";
    const minClusterSize = opts.minClusterSize ?? 3;
    const threshold = opts.threshold ?? 0.78;
    const dryRun = opts.dryRun ?? false;

    const all = await this.collectEmbeddings(namespace);
    if (all.length < minClusterSize) {
      return { clusters: [], dryRun, durationMs: Date.now() - start };
    }

    const parents: number[] = all.map((_, i) => i);
    const find = (i: number): number =>
      parents[i] === i ? i : (parents[i] = find(parents[i]));
    const union = (a: number, b: number): void => {
      parents[find(a)] = find(b);
    };
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        if (all[i].model !== all[j].model) continue;
        const sim = cosineSimilarity(all[i].vector, all[j].vector);
        if (sim >= threshold) union(i, j);
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < all.length; i += 1) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    }

    const clusters: ClusterSummary[] = [];
    for (const [, indices] of groups) {
      if (indices.length < minClusterSize) continue;
      const sources = indices.map((i) => all[i].node);
      let summary = extractiveSummary(sources.map((n) => n.content).join(" "));
      // Optional abstractive distillation (contextual hook, fail-soft to
      // the extractive summarizer). LLM runbook notes are the
      // highest-value granularity per the LongMemEval-V2 ablations.
      if (this.config.summarizeClusterLlm) {
        try {
          const distilled = await this.config.summarizeClusterLlm({
            contents: sources.map((n) => n.content),
            sourceIds: sources.map((n) => n.id),
          });
          if (distilled && distilled.trim()) summary = distilled.trim();
        } catch {
          // Hook failure — keep the extractive summary.
        }
      }
      let summaryId: string | null = null;
      if (!dryRun) {
        const stored = await this.store(summary, {
          type: "context",
          tags: ["__consolidated_summary"],
          importance: Math.max(...sources.map((s) => s.importance)),
          // Consolidated summaries live in the `note` pool — the distilled
          // granularity that multi-stream context packs query separately.
          pool: "note",
        });
        summaryId = stored.node.id;
        for (const source of sources) {
          await this.link(summaryId, source.id, "derived_from", 0.9);
        }
      }
      clusters.push({
        summaryId,
        derivedFrom: sources.map((s) => s.id),
        summary,
      });
    }

    return { clusters, dryRun, durationMs: Date.now() - start };
  }

  /**
   * Version timeline for one memory — the audit view behind "auditable by
   * design". Returns the memory, the older versions it replaced
   * (`supersedes`), the newer versions that replaced it (`supersededBy`),
   * consolidated notes derived from it, and every graph edge touching it.
   *
   * Related versions are inferred by content similarity (cosine over
   * stored embeddings where available, text similarity otherwise) combined
   * with creation order — superseded versions are the historical ones
   * (`validTo` set), so nothing here is guesswork about intent.
   */
  async history(id: string, opts: HistoryOptions = {}): Promise<MemoryHistory> {
    this.assertInit();
    const threshold = opts.threshold ?? 0.8;
    const limit = opts.limit ?? 10;

    const node = await this.retrieve(id);
    if (!node) throw new Error(`Memory ${id} not found.`);

    const edges = this.graph.getEdgesForNode(id);

    const derivedNotes: MemoryNode[] = [];
    for (const edge of edges) {
      if (edge.relation !== "derived_from") continue;
      const otherId = edge.sourceId === id ? edge.targetId : edge.sourceId;
      const other = await this.storage.getNode(otherId);
      if (other && (other.pool ?? "event") === "note") derivedNotes.push(other);
    }

    // Related-version scan INCLUDES historical memories (includeHistorical):
    // an audit view that skipped superseded versions would defeat its own
    // purpose. With embeddings: cosine against the stored vectors; without:
    // text-similarity fallback over content.
    const related: Array<{ node: MemoryNode; sim: number }> = [];
    const all = await this.storage.queryNodes({
      namespace: node.namespace,
      includeHistorical: true,
      limit: 100_000,
    });
    const byId = new Map(all.map((row) => [row.node.id, row.node]));

    const vectors =
      this.storage.getAllEmbeddings && all.length > 1
        ? await this.storage.getAllEmbeddings()
        : [];
    const selfVector = vectors.find((v) => v.nodeId === id)?.vector;

    if (selfVector) {
      const selfRecord = vectors.find((v) => v.nodeId === id)!;
      for (const record of vectors) {
        // Only compare vectors from the SAME embedding model.
        if (record.model !== selfRecord.model) continue;
        const other = byId.get(record.nodeId);
        if (!other || other.id === id) continue;
        const sim = cosineSimilarity(selfVector, record.vector);
        if (sim >= threshold) {
          related.push({ node: other, sim: Number(sim.toFixed(4)) });
        }
      }
    } else {
      for (const other of byId.values()) {
        if (other.id === id) continue;
        const sim = textSimilarity(node.content, other.content);
        if (sim >= threshold) {
          related.push({ node: other, sim: Number(sim.toFixed(4)) });
        }
      }
    }
    related.sort((a, b) => a.node.createdAt - b.node.createdAt);

    const toScored = (r: { node: MemoryNode; sim: number }): ScoredMemory => ({
      node: r.node,
      score: r.sim,
    });
    const supersedes = related
      .filter((r) => r.node.createdAt < node.createdAt)
      .slice(-limit)
      .map(toScored);
    const supersededBy = related
      .filter((r) => r.node.createdAt > node.createdAt)
      .sort((a, b) => b.node.createdAt - a.node.createdAt)
      .slice(0, limit)
      .map(toScored);

    return { node, supersedes, supersededBy, derivedNotes, edges };
  }

  /**
   * Run dedupe + archive (+ optional cluster summary) in one pass.
   * This is the canonical entry point for "memory maintenance".
   */
  async consolidate(opts: ConsolidateOptions = {}): Promise<ConsolidateResult> {
    this.assertInit();
    const start = performance.now();
    const namespace = (opts as { namespace?: string }).namespace ?? "default";
    const dryRun = opts.dryRun ?? false;
    const summarize = opts.summarize ?? true;

    // Sequence dedupe -> archive -> summarize. The cluster summary
    // step links new summary nodes back to source memories, so it
    // must run AFTER any step that could have removed those source
    // memories (otherwise the link fails with "Node not found").
    const dedupeResult = await this.dedupe({
      threshold: opts.dedupeThreshold ?? 0.92,
      namespace,
      dryRun,
    });
    const archiveResult = await this.archive({
      afterDays: opts.archiveAfterDays ?? 90,
      importanceBelow: opts.archiveImportanceBelow ?? 0.3,
      namespace,
      dryRun,
    });
    const summarizeResult = summarize
      ? await this.summarizeCluster({
          namespace,
          minClusterSize: opts.minClusterSize ?? 3,
          threshold: opts.clusterThreshold ?? 0.78,
          dryRun,
        })
      : { clusters: [], dryRun, durationMs: 0 };

    // Decay-based forgetting runs AFTER archive (archive already moved the
    // lowest-value memories out) and BEFORE summarize (so notes are
    // distilled from the surviving store, not from memories we just
    // deprecated).
    const decayResult =
      opts.decay === false
        ? { superseded: [] as DecaySuperseded[], dryRun, durationMs: 0 }
        : await this.forgetByDecay({
            namespace,
            halfLifeDays: opts.decayHalfLifeDays,
            minScore: opts.minRetentionScore,
            olderThanDays: opts.olderThanDays,
            dryRun,
          });

    return {
      merges: dedupeResult.merges,
      moves: archiveResult.moves,
      clusters: summarizeResult.clusters,
      decayed: decayResult.superseded,
      dryRun,
      durationMs: performance.now() - start,
    };
  }

  /**
   * Decay-based algorithmic forgetting. Computes a retention score per
   * memory — importance, trust, access reinforcement, and an exponential
   * recency term — and SUPERSEDES memories whose score falls below
   * `minScore`: `validTo = now`, so they become historical and drop out
   * of default search while remaining queryable via `searchTemporal`.
   * Nothing is ever deleted.
   *
   * Weights: importance 0.35 · trust 0.15 · access 0.15 · recency 0.35.
   * With the default half-life (60 days) a month-old, never-accessed,
   * agent-inferred low-importance memory crosses the default threshold
   * (~0.2) at roughly four months of age; frequently-reinforced or
   * user-stated memories effectively never do.
   */
  async forgetByDecay(
    opts: DecayForgettingOptions = {},
  ): Promise<DecayForgetResult> {
    this.assertInit();
    const start = Date.now();
    const namespace = opts.namespace ?? "default";
    const halfLifeMs = (opts.halfLifeDays ?? 60) * 24 * 60 * 60 * 1000;
    const minScore = opts.minScore ?? 0.2;
    const olderThanMs = (opts.olderThanDays ?? 60) * 24 * 60 * 60 * 1000;
    const dryRun = opts.dryRun ?? false;
    const now = Date.now();

    const all = await this.storage.queryNodes({
      namespace,
      includeHistorical: false,
      limit: 1_000_000,
    });

    const superseded: DecaySuperseded[] = [];
    for (const row of all) {
      const node = row.node;
      // TTL'd memories expire through the TTL sweep, not decay.
      if (node.expiresAt !== null) continue;
      const anchor = Math.max(node.lastAccessed, node.createdAt);
      if (now - anchor < olderThanMs) continue;

      const recency = Math.pow(0.5, (now - anchor) / halfLifeMs);
      const accessBoost = Math.min(1, node.accessCount / 5);
      const score =
        node.importance * 0.35 +
        (node.trustScore ?? 1.0) * 0.15 +
        accessBoost * 0.15 +
        recency * 0.35;

      if (score < minScore) {
        superseded.push({ id: node.id, score: Number(score.toFixed(4)) });
        if (!dryRun) {
          await this.setValidity(node.id, node.validFrom, now);
        }
      }
    }

    if (!dryRun && superseded.length > 0) {
      this.invalidateSearchCache();
    }

    return { superseded, dryRun, durationMs: Date.now() - start };
  }

  /**
   * Internal: fetch every node's embedding for the given namespace.
   * Returns an empty array if the storage adapter doesn't expose
   * `getAllEmbeddings` (e.g. an in-memory custom adapter).
   */
  private async collectEmbeddings(
    namespace: string,
  ): Promise<
    Array<{ node: MemoryNode; vector: EmbeddingVector; model: string }>
  > {
    if (!this.storage.getAllEmbeddings) return [];
    const all = await this.storage.queryNodes({ namespace, limit: 10_000 });
    const byId = new Map(all.map((r) => [r.node.id, r.node]));
    const result: Array<{
      node: MemoryNode;
      vector: EmbeddingVector;
      model: string;
    }> = [];
    for (const row of await this.storage.getAllEmbeddings()) {
      const node = byId.get(row.nodeId);
      if (!node) continue;
      if (node.namespace !== namespace) continue;
      result.push({ node, vector: row.vector, model: row.model });
    }
    return result;
  }

  /** Clear the search result cache. Called on any mutation. */
  private invalidateSearchCache(): void {
    this.searchCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Embedding queue
  // ---------------------------------------------------------------------------

  /**
   * Wait for all pending embedding jobs to complete.
   *
   * Resolves once both the queue and any in-flight persist callbacks have
   * drained. Safe to call when no embedding provider is configured — it
   * resolves immediately.
   */
  async flushEmbeddings(): Promise<void> {
    if (!this.embeddingQueue) return;
    await this.embeddingQueue.flush();
  }

  /**
   * Re-embed every node with the CURRENTLY configured provider, replacing
   * stale vectors in place. Required after switching embedding models:
   * vectors from different models are not comparable (semantic search
   * filters by stored model), and the embedding table has no automatic
   * migration.
   *
   * @param opts.purgeStale — When true, first delete all embedding rows
   *   stored by any OTHER model (frees space; without it, old-model rows
   *   stay on disk until overwritten node-by-node).
   * @returns Summary counters. `failed` counts nodes whose embedding
   *   could not be recomputed (their status is marked `failed`).
   */
  async reindexEmbeddings(opts: { purgeStale?: boolean } = {}): Promise<{
    reembedded: number;
    purged: number;
    failed: number;
    model: string;
  }> {
    this.assertInit();
    const provider = this.embeddingProvider;
    if (!provider || !this.storage.saveEmbedding) {
      throw new Error(
        "reindexEmbeddings requires an embedding provider — configure `embeddings` first.",
      );
    }

    let purged = 0;
    if (opts.purgeStale && this.storage.deleteEmbeddingsByModel) {
      const counts = this.storage.getEmbeddingModelCounts
        ? await this.storage.getEmbeddingModelCounts()
        : [];
      for (const { model, count } of counts) {
        if (model !== provider.model) {
          purged += await this.storage.deleteEmbeddingsByModel(model);
          void count;
        }
      }
    }

    const nodes = await this.storage.queryNodes({ limit: 1_000_000 });
    const texts = nodes.map((r) => this.embeddedTextFor(r.node));

    let reembedded = 0;
    let failed = 0;
    const batchSize = 32;
    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = nodes.slice(start, start + batchSize);
      const batchTexts = texts.slice(start, start + batchSize);
      try {
        const vectors = provider.embedDocuments
          ? await provider.embedDocuments(batchTexts)
          : await Promise.all(batchTexts.map((t) => provider.embed(t)));
        for (const [index, result] of batch.entries()) {
          await this.storage.saveEmbedding(
            result.node.id,
            vectors[index],
            provider.model,
          );
          this.recordEmbeddingStatus(result.node.id, "ready", null);
          reembedded += 1;
        }
      } catch {
        // Fall back to per-node so one bad input cannot fail the batch.
        for (const [index, result] of batch.entries()) {
          try {
            const vector = await provider.embed(batchTexts[index]);
            await this.storage.saveEmbedding(
              result.node.id,
              vector,
              provider.model,
            );
            this.recordEmbeddingStatus(result.node.id, "ready", null);
            reembedded += 1;
          } catch (err) {
            failed += 1;
            this.recordEmbeddingStatus(
              result.node.id,
              "failed",
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    }

    return { reembedded, purged, failed, model: provider.model };
  }

  /**
   * Per-node embedding status, plus the queue's running/pending counters.
   *
   * @param nodeId — Optional filter; when provided, returns only that node.
   * @returns Aggregate status when called with no args, or a single info
   *   object for the requested node.
   */
  embeddingStatus(): EmbeddingQueueStatus;
  embeddingStatus(nodeId: string): EmbeddingNodeStatusInfo | null;
  embeddingStatus(
    nodeId?: string,
  ): EmbeddingQueueStatus | EmbeddingNodeStatusInfo | null {
    if (nodeId !== undefined) {
      return this.nodeEmbeddingStatus.get(nodeId) ?? null;
    }
    const nodes = [...this.nodeEmbeddingStatus.values()];
    const pending = this.embeddingQueue
      ? this.embeddingQueue.pendingJobs().length
      : 0;
    const running = this.embeddingQueue ? this.embeddingQueue.activeCount() : 0;
    return {
      pending,
      running,
      total: nodes.length,
      nodes,
    };
  }

  // -----------------------------------------------------------------------
  // Temporal validity
  // -----------------------------------------------------------------------

  /**
   * Set the temporal validity window on a memory node.
   *
   * When `validTo` is set to a past timestamp, the memory becomes
   * "historical" — it is excluded from default search results but
   * remains queryable via `searchTemporal(query, atTime)`.
   *
   * @param id — Memory node ID.
   * @param validFrom — Validity start (Unix ms), or null to clear.
   * @param validTo — Validity end (Unix ms), or null to clear.
   * @returns The updated node, or null if not found.
   */
  async setValidity(
    id: string,
    validFrom: number | null,
    validTo: number | null,
  ): Promise<MemoryNode | null> {
    this.assertInit();
    const node = await this.storage.updateNode(id, { validFrom, validTo });
    if (node) {
      this.graph.updateNode(node);
      this.emit("validity:changed", { nodeId: id, validFrom, validTo });
    }
    return node;
  }

  /**
   * Search for memories that were valid at a specific point in time.
   *
   * This is the temporal knowledge graph query: "What did we know
   * at time T?" A memory is included if:
   *   (validFrom is null OR validFrom <= atTime) AND
   *   (validTo is null OR validTo >= atTime)
   *
   * @param query — Text search query.
   * @param atTime — The point in time to query (Unix ms).
   * @param opts — Additional search filters (limit, tags, namespace, etc.).
   * @returns Scored memories valid at `atTime`.
   */
  async searchTemporal(
    query: string,
    atTime: number,
    opts: Omit<SearchFilter, "query" | "validAt"> = {},
  ): Promise<ScoredMemory[]> {
    this.assertInit();
    return this.storage.queryNodes({
      ...opts,
      query,
      validAt: atTime,
    });
  }

  /**
   * Supersede a memory — mark it as historical by setting `validTo`
   * to now, and optionally link the replacement memory with a
   * `temporal_precedes` edge.
   *
   * @param id — The memory to supersede.
   * @param replacementId — Optional ID of the new memory that replaces it.
   * @returns The superseded (updated) node, or null if not found.
   */
  async supersede(
    id: string,
    replacementId?: string,
  ): Promise<MemoryNode | null> {
    this.assertInit();
    const now = Date.now();
    // Read the current node to preserve validFrom.
    const current =
      (await this.storage.peekNode?.(id)) ?? (await this.storage.getNode(id));
    if (!current) return null;
    const node = await this.setValidity(id, current.validFrom, now);
    if (node) {
      // Read-time invalidation (add-only): close the validity interval of
      // the superseded node's currently-valid edges instead of deleting
      // them. As-of reads at earlier timestamps still return them.
      if (this.storage.closeEdgesForNode) {
        await this.storage.closeEdgesForNode(id, now);
      }
      this.graph.closeEdgesForNode(id, now);
    }
    if (node && replacementId) {
      const edgeInput = {
        sourceId: id,
        targetId: replacementId,
        relation: "temporal_precedes" as const,
        weight: 1.0,
        metadata: { superseded: true, at: now },
        // The replacement relationship holds from the supersession moment —
        // it must not appear in as-of reads of the earlier state.
        validFrom: now,
      };
      await this.storage.saveEdge({
        ...edgeInput,
        id: generateId(),
        createdAt: now,
      });
      this.graph.addEdge(edgeInput);
    }
    return node;
  }

  // -----------------------------------------------------------------------
  // Revert — command-driven belief revision ("natural-language revert")
  // -----------------------------------------------------------------------

  /**
   * Find the predecessor of a memory in its version ledger — the older
   * version the target superseded. Signals, in priority order:
   *
   * 1. `temporal_precedes` edges where the target is the newer endpoint
   *    (written by supersede(id, replacementId));
   * 2. `resolved` contradiction pairs involving the target (written by the
   *    evidence state machine's contradict path). Pair ids are stored in
   *    canonical sorted order, so direction is recovered from validity —
   *    the historical (validTo-stamped) endpoint is the predecessor.
   *
   * The most recently created candidate wins. Returns null when the
   * memory has no supersession history.
   */
  async findRevertPredecessor(targetId: string): Promise<MemoryNode | null> {
    this.assertInit();
    const candidateIds = new Set<string>();
    for (const edge of this.graph.getEdgesForNode(targetId)) {
      if (edge.relation === "temporal_precedes" && edge.targetId === targetId) {
        candidateIds.add(edge.sourceId);
      }
    }
    if (this.storage.getContradictionPairsFor) {
      try {
        const pairs = await this.storage.getContradictionPairsFor([targetId]);
        for (const pair of pairs) {
          if (pair.status !== "resolved") continue;
          candidateIds.add(pair.nodeA === targetId ? pair.nodeB : pair.nodeA);
        }
      } catch {
        // Best-effort: the edge signal alone is enough to restore a belief.
      }
    }
    candidateIds.delete(targetId);
    const candidates: MemoryNode[] = [];
    for (const id of candidateIds) {
      const node =
        (await this.storage.peekNode?.(id)) ?? (await this.storage.getNode(id));
      // The predecessor is the historical endpoint — the version that was
      // valid before the target superseded it.
      if (node && node.validTo !== null) candidates.push(node);
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt);
    return candidates[0] ?? null;
  }

  /**
   * The most recent currently-valid, non-audit memory in a namespace —
   * what "revert that" / "revert the last thing" resolves to. Revert
   * audit events are excluded so a revert can never target its own
   * record.
   */
  private async mostRecentRevertible(
    namespace: string,
  ): Promise<MemoryNode | null> {
    const rows = await this.storage.queryNodes({
      namespace,
      limit: 50,
      includeHistorical: false,
    });
    const nodes = rows
      .map((r) => r.node)
      .filter((n) => n.validTo === null && !isRevertAuditNode(n))
      .sort((a, b) => b.createdAt - a.createdAt);
    return nodes[0] ?? null;
  }

  /**
   * Resolve a named entity to the best-matching memory. Disambiguation
   * rule: when several valid memories match, the most recently created
   * one wins and the rest are returned as `alternatives` for confirmation
   * (CLI --dry-run, MCP dry_run) instead of being guessed over.
   */
  private async resolveRevertEntity(
    entity: string,
    namespace: string,
  ): Promise<RevertTargetResolution> {
    const matches = await this.search({ query: entity, namespace, limit: 10 });
    const candidates = matches
      .filter((m) => m.node.validTo === null && !isRevertAuditNode(m.node))
      .sort((a, b) => b.node.createdAt - a.node.createdAt);
    if (candidates.length === 0) {
      throw new Error(
        `No memory matches "${entity}" in namespace "${namespace}".`,
      );
    }
    const [target, ...alternatives] = candidates;
    return {
      target: target!.node,
      scope: { kind: "entity", entity },
      alternatives,
    };
  }

  /**
   * Resolve a revert scope to a concrete target memory.
   *
   * - `{ kind: "id" }` — the memory with that ID.
   * - `{ kind: "last" }` — the most recent currently-valid, non-audit
   *   memory in the namespace (durable across processes).
   * - `{ kind: "entity" }` — named-entity search, most-recent-wins.
   * - `{ kind: "text" }` — natural language run through the local intent
   *   detector (`detectRevertIntent`); "last"-scope phrasing resolves as
   *   "last", named phrasing as an entity. Throws when no revert intent
   *   is detected.
   */
  async resolveRevertTarget(
    scope: RevertScopeInput | string,
    namespace = "default",
  ): Promise<RevertTargetResolution> {
    this.assertInit();
    const input: RevertScopeInput =
      typeof scope === "string" ? { kind: "text", text: scope } : scope;
    switch (input.kind) {
      case "id": {
        const node =
          (await this.storage.peekNode?.(input.id)) ??
          (await this.storage.getNode(input.id));
        if (!node) throw new Error(`Memory ${input.id} not found.`);
        return { target: node, scope: input, alternatives: [] };
      }
      case "last": {
        const target = await this.mostRecentRevertible(namespace);
        if (!target) {
          throw new Error(
            `No revertible memory in namespace "${namespace}": the store is empty (or holds only audit events).`,
          );
        }
        return { target, scope: input, alternatives: [] };
      }
      case "entity":
        return this.resolveRevertEntity(input.entity, namespace);
      case "text": {
        const intent = detectRevertIntent(input.text);
        if (!intent.detected) {
          throw new Error(
            `No revert intent detected in "${input.text}". Try "revert that", "revert the last thing", or "revert what I said about <topic>".`,
          );
        }
        if (intent.scope === "last") {
          return this.resolveRevertTarget({ kind: "last" }, namespace);
        }
        return this.resolveRevertEntity(intent.target ?? input.text, namespace);
      }
    }
  }

  /**
   * Revert a memory to its previous version — the command-driven belief
   * revision primitive. The user/agent says "revert that" / "go back" /
   * "that last thing was wrong"; MemOS closes the target's validity
   * interval NOW and reactivates the predecessor, so the next recall
   * returns the pre-correction belief with full provenance.
   *
   * Add-only: the reverted-away version stays in history (validTo
   * stamped, the row is never deleted), and the revert itself is recorded
   * as an audit event node (tags `audit`/`revert`, metadata.audit =
   * "revert") capturing who/when/why. Edge validity intervals closed by
   * the earlier supersession are NOT reopened — edges stay add-only; the
   * node-level belief is what recall returns.
   *
   * @param scope — where the target comes from (or a raw string, run
   *   through the intent detector).
   * @param opts — actor / reason (recorded on the audit event), dryRun,
   *   namespace. Defaults are unchanged everywhere else.
   * @throws When no target resolves, the target is already historical, or
   *   it has no supersession history to restore.
   */
  async revert(
    scope: RevertScopeInput | string,
    opts: RevertOptions = {},
  ): Promise<RevertResult> {
    this.assertInit();
    const namespace = opts.namespace ?? "default";
    const { target, alternatives } = await this.resolveRevertTarget(
      scope,
      namespace,
    );
    if (target.validTo !== null) {
      throw new Error(
        `Memory ${target.id} is already historical (validTo set) — nothing to revert.`,
      );
    }
    const predecessor = await this.findRevertPredecessor(target.id);
    if (!predecessor) {
      throw new Error(
        `No earlier version to restore for ${target.id}: it has no supersession history ` +
          `(no temporal_precedes edge or resolved contradiction pair).`,
      );
    }
    const at = Date.now();
    if (opts.dryRun) {
      return {
        target,
        predecessor,
        auditId: null,
        at,
        dryRun: true,
        alternatives,
      };
    }
    // Close the target's validity interval NOW (mirrors supersede()).
    await this.setValidity(target.id, target.validFrom, at);
    if (this.storage.closeEdgesForNode) {
      await this.storage.closeEdgesForNode(target.id, at);
    }
    this.graph.closeEdgesForNode(target.id, at);
    // Reactivate the predecessor — reopen its interval, keep validFrom.
    await this.setValidity(predecessor.id, predecessor.validFrom, null);
    this.invalidateSearchCache();
    // Audit event: who/when/why, add-only, excluded from future
    // "last"-scope resolution via metadata.audit === "revert".
    const actor = opts.actor ?? "user";
    const reason = opts.reason ?? "manual revert";
    const audit = await this.store(
      `Reverted memory ${target.id.slice(0, 8)} ("${target.content.slice(0, 80)}") — ` +
        `restored predecessor ${predecessor.id.slice(0, 8)}. Reason: ${reason}`,
      {
        type: "custom",
        pool: "event",
        namespace,
        source: "system",
        importance: 0.1,
        tags: ["audit", "revert"],
        metadata: {
          audit: "revert",
          revert: {
            targetId: target.id,
            predecessorId: predecessor.id,
            actor,
            reason,
            at,
          },
        },
      },
    );
    this.emit("memory:reverted", {
      targetId: target.id,
      predecessorId: predecessor.id,
      actor,
      reason,
      at,
      auditId: audit.node.id,
    });
    const targetNow =
      (await this.storage.peekNode?.(target.id)) ??
      (await this.storage.getNode(target.id));
    const predecessorNow =
      (await this.storage.peekNode?.(predecessor.id)) ??
      (await this.storage.getNode(predecessor.id));
    return {
      target: targetNow ?? target,
      predecessor: predecessorNow ?? predecessor,
      auditId: audit.node.id,
      at,
      dryRun: false,
      alternatives,
    };
  }

  // -----------------------------------------------------------------------
  // Trust & provenance
  // -----------------------------------------------------------------------

  /**
   * Get the trust score of a memory.
   *
   * @param id — Memory node ID.
   * @returns The trust score [0, 1], or null if the node doesn't exist.
   */
  async trust(id: string): Promise<number | null> {
    this.assertInit();
    const node =
      (await this.storage.peekNode?.(id)) ?? (await this.storage.getNode(id));
    return node?.trustScore ?? null;
  }

  /**
   * Set the trust score of a memory.
   *
   * Trust scores influence retrieval ranking: higher-trust memories
   * rank above lower-trust ones for the same relevance score.
   *
   * @param id — Memory node ID.
   * @param score — Trust score in [0, 1].
   * @returns The updated node, or null if not found.
   */
  async setTrust(id: string, score: number): Promise<MemoryNode | null> {
    this.assertInit();
    const clamped = Math.max(0, Math.min(1, score));
    const node = await this.storage.updateNode(id, { trustScore: clamped });
    if (node) {
      this.graph.updateNode(node);
      this.emit("trust:changed", { nodeId: id, trustScore: clamped });
    }
    return node;
  }

  /**
   * Adjust the trust score of a memory by a delta, clamped to [0, 1].
   *
   * @param id — Memory node ID.
   * @param delta — Amount to add (positive) or subtract (negative).
   * @returns The updated node, or null if not found.
   */
  async adjustTrust(id: string, delta: number): Promise<MemoryNode | null> {
    this.assertInit();
    const current = await this.trust(id);
    if (current === null) return null;
    return this.setTrust(id, current + delta);
  }

  // -----------------------------------------------------------------------
  // Fact extraction
  // -----------------------------------------------------------------------

  /**
   * Extract candidate facts from a conversation.
   *
   * Uses a rule-based extractor that identifies user statements,
   * preferences, and entities from conversation messages. Each
   * candidate fact is scored by confidence and optionally stored.
   *
   * This is a local-first alternative to LLM-based extraction — no
   * API calls required. For higher-quality extraction, callers can
   * use an LLM to pre-process the conversation and pass the results
   * as plain text messages.
   *
   * @param messages — The conversation to extract facts from.
   * @param opts — Extraction options.
   * @returns Extracted facts and (if autoStore) stored node IDs.
   */
  async extractFacts(
    messages: ConversationMessage[],
    opts: ExtractFactsOptions = {},
  ): Promise<ExtractFactsResult> {
    this.assertInit();
    const autoStore = opts.autoStore ?? false;
    const minConfidence = opts.minConfidence ?? 0.6;
    const dedupe = opts.dedupe ?? true;
    const dedupeThreshold = opts.dedupeThreshold ?? 0.85;
    const namespace = opts.namespace ?? "default";

    const facts = this.runFactExtractor(messages);
    const storedIds: string[] = [];
    let duplicates = 0;

    if (autoStore) {
      for (const fact of facts) {
        if (fact.confidence < minConfidence) continue;

        // Dedup against existing memories if embeddings are available.
        if (
          dedupe &&
          this.embeddingProvider &&
          this.storage.querySimilarEmbeddings
        ) {
          const embedding = await this.embeddingProvider.embed(fact.content);
          const similar = await this.storage.querySimilarEmbeddings(
            embedding,
            { namespace, limit: 1 },
            1,
            dedupeThreshold,
          );
          if (similar.length > 0) {
            duplicates += 1;
            continue;
          }
        }

        const { node } = await this.store(fact.content, {
          type: fact.type,
          tags: fact.tags,
          source: fact.source,
          trustScore: fact.confidence * DEFAULT_TRUST_SCORES[fact.source],
          namespace,
          // Initialize confidence and evidence count for the new fact
          confidence: fact.confidence, // Start with extraction confidence
          evidenceCount: 1, // First evidence event (the extraction itself)
        });
        storedIds.push(node.id);
      }
    }

    this.emit("facts:extracted", {
      facts: facts.length,
      stored: storedIds.length,
      duplicates,
    });
    return { facts, storedIds, duplicates };
  }

  /**
   * Rule-based fact extractor. Scans conversation messages for
   * patterns that indicate facts, preferences, and entities.
   *
   * Heuristics:
   * - "I like/prefer/use/work at" → preference
   * - "My name is/I am/I'm" → entity (about the user)
   * - "I need/want/should" → context
   * - Declarative statements from the user → fact
   */
  private runFactExtractor(messages: ConversationMessage[]): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    // Pattern matchers for common fact patterns.
    const preferencePatterns = [
      /\bI\s+(?:like|love|prefer|enjoy|hate|dislike)\b/i,
      /\bmy\s+(?:favorite|favourite|preferred)\b/i,
      /\bI\s+(?:always|usually|typically|normally)\b/i,
      /\bI\s+use\b/i,
    ];
    const entityPatterns = [
      /\bmy\s+name\s+is\b/i,
      /\bI\s+am\s+(?:a|an|the)\b/i,
      /\bcall\s+me\b/i,
    ];
    const contextPatterns = [
      /\bI\s+(?:need|want|should|must|have\s+to|planning)\b/i,
      /\bI'?m\s+(?:working|going|planning|trying)\b/i,
      /\bI\s+work\s+(?:at|for|on)\b/i,
      /\bI\s+live\s+in\b/i,
    ];

    for (const msg of messages) {
      if (msg.role === "system") continue;

      // Split into sentences for finer-grained extraction.
      const sentences = msg.content
        .replace(/\n+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 5);

      for (const sentence of sentences) {
        let type: MemoryType | null = null;
        let confidence = 0;
        let tags: string[] = [];

        // Check preference patterns
        if (preferencePatterns.some((p) => p.test(sentence))) {
          type = "preference";
          confidence = 0.8;
          tags = ["preference"];
        }
        // Check entity patterns
        else if (entityPatterns.some((p) => p.test(sentence))) {
          type = "entity";
          confidence = 0.75;
          tags = ["identity"];
        }
        // Check context patterns
        else if (contextPatterns.some((p) => p.test(sentence))) {
          type = "context";
          confidence = 0.7;
          tags = ["context"];
        }
        // Declarative user statements → fact
        else if (msg.role === "user" && sentence.length > 15) {
          type = "fact";
          confidence = 0.5;
          tags = [];
        }

        if (type !== null && confidence > 0) {
          // Boost confidence for shorter, cleaner sentences.
          if (sentence.length < 80) confidence += 0.1;
          confidence = Math.min(1, confidence);

          facts.push({
            content: sentence,
            type,
            confidence,
            tags,
            source: msg.role === "user" ? "user_input" : "agent_inferred",
          });
        }
      }
    }

    return facts;
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  /**
   * Return a detailed diagnostics snapshot of the memory store.
   *
   * Includes counts by source, type, and namespace; temporal and
   * trust statistics; embedding coverage; storage capabilities; and
   * database file size.
   *
   * @returns A diagnostics report.
   */
  /**
   * Runtime metadata about the active embedding provider: what was
   * requested vs. what actually resolved, and whether the FastEmbed
   * local-hash fallback is active. Returns null when embeddings are
   * disabled (`embeddings: { enabled: false }`).
   */
  getEmbeddingRuntimeInfo(): EmbeddingRuntimeInfo | null {
    const provider = this.embeddingProvider;
    if (!provider) return null;
    if (provider.getRuntimeInfo) return provider.getRuntimeInfo();
    return {
      requestedProvider: provider.id,
      resolvedProvider: provider.id,
      requestedModel: provider.model,
      resolvedModel: provider.model,
      modelRevision: null,
      requestedDimensions: provider.dimensions,
      observedDimensions: null,
      fallbackActive: false,
      fallbackReason: null,
    };
  }

  async diagnostics(): Promise<DiagnosticsResult> {
    this.assertInit();
    const graph = await this.getGraph();
    const nodes = graph.nodes;
    const now = Date.now();

    const bySource: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byNamespace: Record<string, number> = {};

    let nodesWithEmbeddings = 0;
    let nodesWithValidity = 0;
    let historicalNodes = 0;
    let nodesWithTTL = 0;
    let expiredNodes = 0;
    let totalImportance = 0;
    let totalTrust = 0;

    for (const node of nodes) {
      bySource[node.source] = (bySource[node.source] ?? 0) + 1;
      byType[node.type] = (byType[node.type] ?? 0) + 1;
      byNamespace[node.namespace] = (byNamespace[node.namespace] ?? 0) + 1;

      if (node.validFrom !== null || node.validTo !== null)
        nodesWithValidity += 1;
      // Use `<= now` to match the search layer (sqlite.ts), which treats a
      // node superseded "now" (validTo === now) as historical. `< now` would
      // miss nodes superseded in the same millisecond as the diagnostics run.
      if (node.validTo !== null && node.validTo <= now) historicalNodes += 1;
      if (node.expiresAt !== null) {
        nodesWithTTL += 1;
        if (node.expiresAt * 1000 < now) expiredNodes += 1;
      }
      totalImportance += node.importance;
      totalTrust += node.trustScore;
    }

    // Count embeddings by checking storage.
    if (this.storage.getAllEmbeddings) {
      const embeddings = await this.storage.getAllEmbeddings();
      nodesWithEmbeddings = embeddings.length;
    }

    // Get DB file size.
    let dbSizeBytes = 0;
    if (this.config.dbPath) {
      try {
        const { statSync } = await import("fs");
        dbSizeBytes = statSync(this.config.dbPath).size;
      } catch {
        // Non-fatal — dbPath may be a custom adapter.
      }
    }

    return {
      totalNodes: nodes.length,
      totalEdges: graph.edges.length,
      nodesWithEmbeddings,
      nodesWithValidity,
      historicalNodes,
      nodesWithTTL,
      expiredNodes,
      avgImportance: nodes.length > 0 ? totalImportance / nodes.length : 0,
      avgTrustScore: nodes.length > 0 ? totalTrust / nodes.length : 0,
      bySource,
      byType,
      byNamespace,
      dbSizeBytes,
      embeddingQueue: this.embeddingQueue ? this.embeddingStatus() : undefined,
      storageCapabilities: {
        peekNode: !!this.storage.peekNode,
        evictLeastImportant: !!this.storage.evictLeastImportant,
        saveEmbedding: !!this.storage.saveEmbedding,
        getAllEmbeddings: !!this.storage.getAllEmbeddings,
        setNodeNamespace: !!this.storage.setNodeNamespace,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * Register an event listener.
   */
  on(event: MemOSEvent, listener: MemOSEventListener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  /**
   * Remove an event listener.
   */
  off(event: MemOSEvent, listener: MemOSEventListener): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  private emit(event: MemOSEvent, data: unknown): void {
    const arr = this.listeners.get(event);
    if (!arr) return;
    for (const fn of arr) {
      try {
        fn(data);
      } catch {
        // Swallow listener errors to avoid crashing the pipeline.
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private assertInit(): void {
    if (!this.initialised) {
      throw new Error(
        "MemOS not initialised. Call `await memos.init()` before using the API.",
      );
    }
  }

  /**
   * Evict the least-important memory when `maxMemories` is exceeded.
   *
   * The selection is a single SQL statement — we do not load the full
   * table into memory the way the old in-JS sort did. Falls back to
   * the in-memory path if the storage adapter doesn't implement
   * `evictLeastImportant`.
   */
  private async evict(): Promise<void> {
    const max = this.config.maxMemories;
    if (max <= 0) return;

    while (this.graph.size > max) {
      if (this.storage.evictLeastImportant) {
        const id = await this.storage.evictLeastImportant();
        if (!id) return; // Table empty.
        // Mirror the SQL delete in the in-memory graph + edge maps.
        const node = this.graph.getNode(id);
        if (node) {
          this.graph.removeNode(id);
          this.emit("eviction", node);
        }
        continue;
      }
      // Fallback for custom StorageAdapters without evictLeastImportant.
      const nodes = this.graph.getAllNodes();
      nodes.sort((a, b) => {
        if (a.importance !== b.importance) return a.importance - b.importance;
        return a.lastAccessed - b.lastAccessed;
      });
      const victim = nodes[0];
      await this.forget(victim.id);
      this.emit("eviction", victim);
    }
  }

  /**
   * Evidence state machine hook for `store()` (opt-in via
   * `{ evidenceLearning: true }`). Compares the incoming content against
   * the most similar existing memory in the namespace and applies the
   * outcome:
   *
   *   - `{ action: "reinforced", node }`: an existing memory was
   *     confirmed — its confidence and evidence count were bumped and
   *     the caller should NOT write a duplicate node. The returned node
   *     is the freshly-updated version.
   *   - `{ action: "superseded" }`: an existing memory was contradicted —
   *     it has been marked historical (validTo = now) and the caller
   *     SHOULD write the new version.
   *   - `{ action: "new" }`: no decisive match; the caller writes a
   *     fresh node.
   *
   * Candidate selection reuses the search index (top-8 by hybrid rank);
   * classification uses content-to-content pair similarity via
   * {@link classifyEvidence}, with a shared-subject guard so a negation
   * can only supersede a memory that is actually about the same thing.
   */
  private async applyStoreEvidence(
    content: string,
    namespace: string,
    source: MemorySource,
  ): Promise<
    | { action: "reinforced"; node: MemoryNode }
    | { action: "superseded"; nodeId: string }
    | { action: "new" }
  > {
    void source; // reserved: per-source thresholds may differ later

    try {
      // Pull a small candidate pool via the existing search index. This
      // is ONE search — not a full scan — so the evidence pass adds only
      // a few ms to an opted-in store() call.
      const candidates = this.embeddingProvider
        ? await this.hybridSearch(
            {
              query: content,
              namespace,
              limit: 8,
            },
            { internal: true },
          )
        : await this.storage.queryNodes({
            query: content,
            namespace,
            limit: 8,
          });

      let bestPairSimilarity = 0;
      let bestNode: MemoryNode | null = null;
      for (const candidate of candidates) {
        if (candidate.node.validTo !== null) continue; // historical
        const similarity = await this.pairSimilarity(
          candidate.node.content,
          content,
        );
        if (similarity > bestPairSimilarity) {
          bestPairSimilarity = similarity;
          bestNode = candidate.node;
        }
      }
      if (!bestNode) return { action: "new" };

      // Reinforce ONLY on a genuine confirmation: pair similarity in the
      // confirmed band. `classifyEvidence` also returns "confirmed" as
      // its NEUTRAL fallthrough for unrelated content (similarity < 0.3,
      // no signal words) — that case must fall through to a normal write.
      const outcome = classifyEvidence(
        bestNode.content,
        content,
        bestPairSimilarity,
      );
      const isGenuineConfirm =
        bestPairSimilarity >= 0.5 && outcome === "confirmed";

      if (isGenuineConfirm) {
        const update = applyEvidence(
          bestNode.confidence ?? INITIAL_CONFIDENCE,
          bestNode.evidenceCount ?? 0,
          "confirmed",
        );
        // updateNode stamps `updatedAt` itself, which also refreshes the
        // embedding-freshness check (info.updatedAt >= node.updatedAt).
        const updated = await this.storage.updateNode(bestNode.id, {
          confidence: update.confidence,
          evidenceCount: update.evidenceCount,
        });
        // Refresh the in-memory graph copy with the post-update version.
        if (updated) this.graph.addNode(updated);
        this.invalidateSearchCache();
        this.emit("memory:reinforced", {
          nodeId: bestNode.id,
          confidence: update.confidence,
          evidenceCount: update.evidenceCount,
        });
        return {
          action: "reinforced",
          node: updated ?? { ...bestNode, ...update },
        };
      }

      if (
        outcome === "contradicted" &&
        sharesSubject(bestNode.content, content)
      ) {
        // Mark the old version historical; the new version is written by
        // the caller as a fresh node. `supersede` preserves validFrom
        // and records a temporal_precedes edge.
        await this.supersede(bestNode.id);
        this.invalidateSearchCache();
        this.emit("memory:superseded", {
          nodeId: bestNode.id,
          by: content,
        });
        return { action: "superseded", nodeId: bestNode.id };
      }

      // partial_conflict or unrelated: keep both versions — the
      // confidence-aware ranking pass demotes the weaker one naturally.
      return { action: "new" };
    } catch {
      // Evidence matching is best-effort: any failure means "write the
      // node normally" rather than blocking the store.
      return { action: "new" };
    }
  }

  /** Cosine similarity over embeddings with a bag-of-words fallback. */
  private async pairSimilarity(a: string, b: string): Promise<number> {
    if (this.embeddingProvider) {
      try {
        const [va, vb] = await Promise.all([
          this.embeddingProvider.embed(a),
          this.embeddingProvider.embed(b),
        ]);
        let dot = 0;
        for (let i = 0; i < Math.min(va.length, vb.length); i += 1) {
          dot += va[i]! * vb[i]!;
        }
        return dot; // providers return normalized vectors
      } catch {
        // fall through to text similarity
      }
    }
    return textSimilarity(a, b);
  }

  /**
   * The text that gets embedded for a node. `embeddings.embedText`
   * selects raw content vs. the historical summary+content blend (the
   * extractive summary roughly doubles input tokens for short facts).
   * Write-time context (`metadata.context`, from `store({ context })` or
   * the `enrichMemory` hook) is prepended so the vector carries
   * situational meaning — contextual retrieval, without re-embedding
   * queries. Only nodes stored with a context line are affected; changing
   * enrichment later requires `reindexEmbeddings()`.
   */
  private embeddedTextFor(node: MemoryNode): string {
    const context =
      typeof node.metadata?.context === "string" ? node.metadata.context : "";
    const base =
      this.config.embeddings?.embedText === "content"
        ? node.content
        : `${node.summary}\n${node.content}`;
    return context ? `${context}\n${base}` : base;
  }

  private async persistEmbedding(node: MemoryNode): Promise<void> {
    if (!this.embeddingProvider || !this.storage.saveEmbedding) return;
    const text = this.embeddedTextFor(node);
    const vector = await this.embeddingProvider.embed(text);
    await this.onEmbeddingPersisted(
      node.id,
      vector,
      this.embeddingProvider.model,
    );
  }

  /**
   * Runs after an embedding vector is persisted for a node — all three
   * persist paths (background queue, synchronous queue fallback, inline
   * fallback) funnel through here.
   *
   * Beyond persisting, this is the write-time contradiction-detection
   * hook: when the node was freshly written by `store()` (the pending
   * gate), a bounded semantic-neighbor scan flags contradiction
   * candidates and persists them. The scan runs in the embedding
   * background context — never on the synchronous `store()` path — so
   * write-path overhead stays bounded. Best-effort: detection failures
   * must never break embedding persistence.
   */
  private async onEmbeddingPersisted(
    nodeId: string,
    vector: EmbeddingVector,
    model: string,
  ): Promise<void> {
    await this.storage.saveEmbedding!(nodeId, vector, model);
    if (!this.contradictionScanPending.has(nodeId)) return;
    this.contradictionScanPending.delete(nodeId);
    try {
      await this.detectContradictionsForNode(nodeId, vector, model);
    } catch {
      // Detection is best-effort — the write itself already succeeded.
    }
  }

  /**
   * Write-time contradiction candidate detection.
   *
   * Scans a BOUNDED set of semantic neighbors (top
   * {@link CONTRADICTION_SCAN_LIMIT} above
   * {@link CONTRADICTION_SIM_MIN}, same namespace, same embedding
   * model — one indexed query, never a full table scan), flags pairs
   * in the contradiction band via `findContradictionCandidates`, and
   * persists them as `unresolved` pairs. Confirmed `contradicted`
   * outcomes from the evidence state machine are recorded separately
   * by `store()` with status `resolved` (see the provenance block
   * there).
   */
  private async detectContradictionsForNode(
    nodeId: string,
    vector: EmbeddingVector,
    model: string,
  ): Promise<void> {
    if (
      !this.storage.querySimilarEmbeddings ||
      !this.storage.getEmbeddingVectors ||
      !this.storage.addContradiction
    ) {
      return;
    }
    const node = this.graph.getNode(nodeId);
    if (!node) return;

    const neighbors = await this.storage.querySimilarEmbeddings(
      vector,
      { namespace: node.namespace },
      CONTRADICTION_SCAN_LIMIT,
      CONTRADICTION_SIM_MIN,
      model,
    );
    if (neighbors.length === 0) return;

    const neighborIds = neighbors
      .map((r) => r.node.id)
      .filter((id) => id !== nodeId);
    const vectors = await this.storage.getEmbeddingVectors(neighborIds);
    const candidates = nodeContradictionCandidates(
      neighbors.map((r) => r.node),
      vectors,
      nodeId,
    );
    const flagged = findContradictionCandidates(
      node.content,
      vector,
      candidates,
    );
    for (const pair of flagged) {
      await this.storage.addContradiction(nodeId, pair.id);
    }
    if (flagged.length > 0) {
      this.emit("contradiction:detected", { nodeId, pairs: flagged });
    }
  }

  /**
   * Enqueue a node for background embedding. Returns immediately.
   *
   * If `embeddingQueue.synchronous` is true, falls back to awaiting the
   * inline persist call (useful for tests that need read-after-write
   * semantics).
   */
  private scheduleEmbedding(node: MemoryNode): void {
    if (!this.embeddingProvider || !this.storage.saveEmbedding) return;
    if (!this.embeddingQueue) {
      // No queue yet — fall back to the inline path so we never silently
      // drop embedding work.
      void this.persistEmbedding(node);
      return;
    }
    const text = this.embeddedTextFor(node);
    if (this.config.embeddingQueue.synchronous) {
      void (async () => {
        try {
          const vector = await this.embeddingProvider!.embed(text);
          await this.onEmbeddingPersisted(
            node.id,
            vector,
            this.embeddingProvider!.model,
          );
          this.recordEmbeddingStatus(node.id, "ready", null);
        } catch (err) {
          this.recordEmbeddingStatus(
            node.id,
            "failed",
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
      return;
    }
    this.embeddingQueue.enqueue(node.id, text);
  }

  private recordEmbeddingStatus(
    nodeId: string,
    status: EmbeddingNodeStatus,
    error: string | null,
  ): void {
    const now = Date.now();
    const existing = this.nodeEmbeddingStatus.get(nodeId);
    const attempts = existing ? existing.attempts : 0;
    this.nodeEmbeddingStatus.set(nodeId, {
      nodeId,
      status,
      attempts,
      lastError: error,
      updatedAt: now,
    });
    // Map internal queue lifecycle to public events.
    switch (status) {
      case "queued":
        this.emit("embedding:queued", { nodeId });
        break;
      case "running":
        this.emit("embedding:started", { nodeId });
        break;
      case "ready":
        this.emit("embedding:complete", { nodeId, ok: true });
        break;
      case "failed":
        this.emit("embedding:failed", { nodeId, error });
        break;
      case "pending":
        // No public event for the initial "not yet queued" state.
        break;
    }
  }

  private async backfillEmbeddings(): Promise<void> {
    if (!this.embeddingProvider) return;
    const nodes = this.graph.getAllNodes();
    // Bulk-fetch embedding metadata once instead of one SELECT per node
    // (N+1) — on a 5k-node store the per-node lookups cost ~100ms of init.
    let infoByNode: Map<
      string,
      { model: string; dimensions: number; updatedAt: number }
    > | null = null;
    if (this.storage.getAllEmbeddingInfos) {
      const infos = await this.storage.getAllEmbeddingInfos();
      infoByNode = new Map(infos.map((i) => [i.nodeId, i]));
    }
    const isFresh = async (node: MemoryNode): Promise<boolean> => {
      if (!this.embeddingProvider) return false;
      const info = infoByNode
        ? (infoByNode.get(node.id) ?? null)
        : this.storage.getEmbeddingInfo
          ? await this.storage.getEmbeddingInfo(node.id)
          : null;
      return Boolean(
        info &&
        info.model === this.embeddingProvider.model &&
        info.dimensions === this.embeddingProvider.dimensions &&
        info.updatedAt >= node.updatedAt,
      );
    };
    for (const node of nodes) {
      if (await isFresh(node)) {
        // Already up to date — no need to re-embed, but track status.
        this.recordEmbeddingStatus(node.id, "ready", null);
        continue;
      }
      this.scheduleEmbedding(node);
    }
    // Backfill is fire-and-forget by design. The queue will eventually
    // call `persistEmbedding` for each job.
  }

  /**
   * Read-time contradiction resolution (accuracy item 4).
   *
   * Fetches recorded contradiction pairs for the ids in the fused
   * result set (one bounded IN-query) and applies
   * {@link resolveContradictionsAtRead}: when both members of a pair
   * are present, the older one is score-demoted so the newer version
   * wins. Best-effort and storage-agnostic — any failure or a storage
   * without the contradictions table returns the input untouched.
   */
  private async applyContradictionResolution(
    results: ScoredMemory[],
  ): Promise<ScoredMemory[]> {
    if (results.length < 2 || !this.storage.getContradictionPairsFor) {
      return results;
    }
    try {
      const pairs: ContradictionRecord[] =
        await this.storage.getContradictionPairsFor(
          results.map((r) => r.node.id),
        );
      // Read-time resolution acts ONLY on confirmed (`resolved`) pairs —
      // e.g. contradictions the evidence state machine verified via
      // supersession. Heuristic write-time candidates stay `unresolved`
      // (persisted for future sleep-time adjudication) and never touch
      // ranking: at corpus scale the candidate rule's precision is too
      // low for unreviewed pairs to demote results (measured: hundreds
      // of spurious pairs per few hundred dialogue utterances).
      const confirmed = pairs.filter((p) => p.status === "resolved");
      if (confirmed.length === 0) return results;
      return resolveContradictionsAtRead(results, confirmed);
    } catch {
      // Resolution is a scoring nudge — never break the read path.
      return results;
    }
  }

  /**
   * ── item2: entity leg ── candidate generation from the entity→memories
   * inverted index (`src/entity-index.ts`). Returns ranked `ScoredMemory`s
   * (score = number of matched query entities, rank = match count desc /
   * node id tiebreak) for fusion as the third RRF leg in `fuseResults`.
   *
   * Applies the same namespace / type / pool / tag / temporal scoping as
   * the keyword and semantic legs, so the entity leg can never leak
   * out-of-scope memories into results. Degrades to `[]` when the query
   * has no entities or the storage has no entity index (custom adapters).
   */
  private async fetchEntityLeg(
    queryEntities: readonly string[],
    filter: SearchFilter,
    candidateLimit: number,
  ): Promise<ScoredMemory[]> {
    if (queryEntities.length === 0) return [];
    const storage = this.storage;
    if (!storage.searchByEntities) return [];
    const matches = await storage.searchByEntities(
      [...queryEntities],
      candidateLimit,
    );
    if (matches.length === 0) return [];

    const now = Date.now();
    const poolFilter = filter.pool
      ? Array.isArray(filter.pool)
        ? filter.pool
        : [filter.pool]
      : null;
    const results: ScoredMemory[] = [];
    for (const { nodeId, matches: matchCount } of matches) {
      const node = storage.peekNode
        ? await storage.peekNode(nodeId)
        : await storage.getNode(nodeId);
      if (!node) continue;
      // Scope parity with the keyword/semantic legs (see `queryNodes` and
      // the semantic-search filter loop).
      if (filter.namespace && node.namespace !== filter.namespace) continue;
      if (
        filter.namespacePrefix &&
        !node.namespace.startsWith(filter.namespacePrefix)
      ) {
        continue;
      }
      if (filter.type && node.type !== filter.type) continue;
      if (poolFilter && !poolFilter.includes(node.pool ?? "event")) continue;
      if (filter.tags && filter.tags.some((t) => !node.tags.includes(t))) {
        continue;
      }
      if (filter.source && node.source !== filter.source) continue;
      if (filter.validAt !== undefined) {
        if (node.validFrom !== null && node.validFrom > filter.validAt) {
          continue;
        }
        if (node.validTo !== null && node.validTo < filter.validAt) continue;
      } else if (
        filter.includeHistorical !== true &&
        node.validTo !== null &&
        node.validTo <= now
      ) {
        continue;
      }
      // Provenance-trust: quarantined memories stay out of recall by
      // default, like every other retrieval leg (see `queryNodes`).
      if (!quarantineVisible(node.quarantined, filter)) continue;
      results.push({
        node,
        score: matchCount,
        scores: { entityLeg: matchCount },
      });
    }
    return results;
  }

  private async hybridSearch(
    filter: SearchFilter,
    opts: { internal?: boolean } = {},
  ): Promise<ScoredMemory[]> {
    const limit = filter.limit ?? 20;
    const offset = filter.offset ?? 0;
    // Pull a wider candidate set from all three retrieval legs, then merge.
    // This keeps exact keyword matches visible while letting embeddings
    // rescue semantically related memories that FTS cannot match lexically,
    // and the entity leg surface memories that share entities with the
    // query but neither leg found.
    // `filter.candidateDepth` widens the pool on demand (two-stage reranking
    // or expansion stages narrow it afterwards).
    const candidateLimit = Math.max(
      limit + offset,
      filter.candidateDepth ?? limit * 4,
      20,
    );

    // ── item2: entity leg ── query entities are extracted once and feed
    // both the inverted-index candidate leg (recall: entity-matched
    // memories the other legs missed) and the post-fusion overlap boost
    // (scoring) in fuseResults.
    const queryEntities = canonicalizeEntities(
      extractQueryEntities(filter.query ?? ""),
      this.config.entityAliases,
    );

    // Run keyword, semantic, and entity retrieval in parallel for lower
    // latency.
    const [semanticResults, keywordResults, entityResults] = await Promise.all([
      // Threshold floor: cosine-0 memories are unrelated and must not
      // vote in fusion (nor occupy candidate slots). A small positive
      // floor keeps genuine paraphrase matches (typically >= 0.3 for real
      // embedders) while dropping the unrelated tail.
      this.semanticSearch(
        filter.query ?? "",
        candidateLimit,
        SEMANTIC_FUSION_THRESHOLD,
        {
          ...filter,
          limit: candidateLimit,
          offset: 0,
        },
      ),
      this.storage.queryNodes({
        ...filter,
        limit: candidateLimit,
        offset: 0,
      }),
      this.fetchEntityLeg(queryEntities, filter, candidateLimit),
    ]);

    // Fuse the three legs via weighted Reciprocal Rank Fusion + trust
    // weighting. The fusion logic lives in `src/retrieval.ts` so it can
    // be unit-tested without storage or embeddings. Weights come from
    // `config.fusion` so deployments with a stronger embedding model can
    // rebalance the legs (defaults: keyword 0.8 / semantic 0.2, entity
    // leg 0.5 — tuned for the hash baseline). Query entities are extracted
    // here (not stored) so the entity-fusion signal always reflects the
    // live query.
    const fused = fuseResults(
      keywordResults,
      semanticResults,
      {
        ...this.config.fusion,
        queryEntities,
      },
      entityResults,
    );

    // Contradiction resolution (accuracy item 4): when both members of
    // a recorded contradiction pair appear in the fused set, demote the
    // older one so the newer version wins. Pure scoring nudge — nothing
    // is removed, and the lookup is bounded by the fused set size.
    const resolved = await this.applyContradictionResolution(fused);

    const expanded = await this.applyGraphExpansion(
      resolved,
      undefined,
      filter,
    );
    const pprExpanded = await this.applyPprGraphExpansion(expanded, filter);
    const withSessions = await this.applySessionExpansion(pprExpanded, filter);
    const reranked = opts.internal
      ? withSessions
      : await this.applyRerank(withSessions, filter);
    const deduped = await this.applySearchDedup(reranked, filter);

    return deduped.slice(offset, offset + limit);
  }

  /**
   * Two-stage reranking (`experimental.rerank`, off by default). The first
   * stage — hybrid retrieval — exists to RECALL candidates; a cross-encoder
   * (e.g. bge-reranker-v2-m3 served by llama-server) then re-scores the top
   * `candidates` fused results against the query and the final ranking is
   * reordered by that score. Cross-encoders read query and document
   * together, so they are far more precise than bi-encoder similarity —
   * at O(candidates) cost per query, which is why it only ever runs on the
   * narrow head of the pool.
   *
   * On endpoint failure the fused order is kept unchanged (graceful
   * degradation) — a downed reranker degrades quality, not availability.
   */
  private async applyRerank(
    results: ScoredMemory[],
    filter: SearchFilter,
  ): Promise<ScoredMemory[]> {
    const cfg = this.experimental.rerank;
    if (!cfg?.endpoint || results.length < 2 || !filter.query) return results;

    const candidates = Math.min(cfg.candidates ?? 50, results.length);
    const head = results.slice(0, candidates);
    const tail = results.slice(candidates);

    let payload: {
      results?: Array<{
        index?: number;
        score?: number;
        relevance_score?: number;
      }>;
    };
    try {
      // Trailing-slash strip without a regex: an unanchored `/\/+$/` scan
      // is quadratic on adversarial endpoints (CodeQL polynomial-regex).
      let endpointBase = cfg.endpoint;
      while (endpointBase.endsWith("/")) {
        endpointBase = endpointBase.slice(0, -1);
      }
      const response = await fetch(`${endpointBase}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model ?? "reranker",
          query: filter.query,
          documents: head.map((r) =>
            cfg.maxDocChars && r.node.content.length > cfg.maxDocChars
              ? r.node.content.slice(0, cfg.maxDocChars)
              : r.node.content,
          ),
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 5_000),
      });
      if (!response.ok) {
        throw new Error(`rerank endpoint returned ${response.status}`);
      }
      payload = (await response.json()) as typeof payload;
    } catch (err) {
      // Graceful degradation: keep the fused order — but say so once, so a
      // misconfigured/downed endpoint can never silently lower scores.
      if (!this.rerankFailureWarned) {
        this.rerankFailureWarned = true;
        console.error(
          "[memos] rerank endpoint unreachable or timed out — falling back to fused ranking:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return results;
    }

    const scored = (payload.results ?? [])
      .map((row) => ({
        index: row.index ?? -1,
        score: sigmoid(row.relevance_score ?? row.score ?? 0),
      }))
      .filter((row) => row.index >= 0 && row.index < head.length)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return results;

    const reranked = scored.map((row) => ({
      node: head[row.index].node,
      score: row.score,
      scores: { ...head[row.index].scores, rerank: row.score },
    }));
    // Candidates the endpoint did not rank keep their fused order behind
    // the reranked head.
    const rankedSet = new Set(scored.map((row) => row.index));
    const unranked = head.filter((_, index) => !rankedSet.has(index));
    return [...reranked, ...unranked, ...tail];
  }

  /**
   * Graph-expansion recall leg (experimental, off by default). Takes the
   * top `maxSeeds` fused results, follows their graph edges in both
   * directions, and injects unseen neighbours at `seedScore × scoreFactor`
   * (halved for each subsequent neighbour of the same seed). Lifts
   * multi-evidence / multi-hop queries where related facts are connected
   * by edges but neither retrieval leg surfaces them.
   */
  private async applyGraphExpansion(
    fused: ScoredMemory[],
    config: NonNullable<ExperimentalConfig["graphExpansion"]> | undefined = this
      .experimental.graphExpansion,
    filter: SearchFilter = {},
  ): Promise<ScoredMemory[]> {
    if (!config?.enabled || fused.length === 0) return fused;

    const maxSeeds = config.maxSeeds ?? 3;
    const maxAdded = config.maxAdded ?? 5;
    const scoreFactor = config.scoreFactor ?? 0.85;

    const present = new Set(fused.map((r) => r.node.id));
    const injected = new Map<string, ScoredMemory>();

    for (const seed of fused.slice(0, maxSeeds)) {
      if (injected.size >= maxAdded) break;
      let decay = scoreFactor;
      for (const edge of this.graph.getEdgesForNode(seed.node.id)) {
        if (injected.size >= maxAdded) break;
        const neighbourId =
          edge.sourceId === seed.node.id ? edge.targetId : edge.sourceId;
        if (present.has(neighbourId)) continue;
        const neighbour = this.storage.peekNode
          ? await this.storage.peekNode(neighbourId)
          : await this.storage.getNode(neighbourId);
        if (!neighbour) continue;
        if (neighbour.namespace !== seed.node.namespace) continue;
        // Historical neighbours follow the seed's visibility: an injected
        // stale fact must never appear when defaults hide history.
        const seedHistorical = seed.node.validTo !== null;
        if ((neighbour.validTo !== null) !== seedHistorical) continue;
        // Provenance-trust: a quarantined neighbour must not ride into
        // recall along a graph edge — same visibility rule as the legs.
        if (!quarantineVisible(neighbour.quarantined, filter)) continue;
        present.add(neighbourId);
        injected.set(neighbourId, {
          node: neighbour,
          score: seed.score * decay,
          scores: { ...seed.scores, graph: seed.score * decay },
        });
        decay *= scoreFactor;
      }
    }

    if (injected.size === 0) return fused;
    return [...fused, ...injected.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * PPR-lite graph expansion (single-step, HippoRAG-style). Runs after
   * fusion (and after the experimental neighbour-injection leg): the top
   * `graphExpansionSeeds` fused results seed a personalized PageRank walk
   * (damping 0.5, `graphExpansionHops` hops) over graph edges plus
   * shared-entity links, and the final score blends as
   * `(1 - graphExpansionAlpha) * fused + graphExpansionAlpha * pprNorm`
   * with PPR scores normalized to [0,1]. Graph neighbours of seeds that
   * neither retrieval leg surfaced can enter the results this way.
   *
   * Controlled by `config.fusion`: `graphExpansion` (default true),
   * `graphExpansionAlpha` (default 0.2), `graphExpansionHops` (default 2),
   * `graphExpansionSeeds` (default 10). `filter.graphExpansion === false`
   * disables it for a single query. With expansion disabled (or
   * alpha <= 0) the fused list is returned untouched — byte-identical to
   * the pre-expansion pipeline.
   *
   * Cost: one bounded BFS + power iteration over the seed neighbourhood
   * (no LLM, no embedding calls) plus at most `DEFAULT_PPR_MAX_INJECTED`
   * `peekNode` reads for newly injected neighbours.
   */
  private async applyPprGraphExpansion(
    fused: ScoredMemory[],
    filter: SearchFilter,
  ): Promise<ScoredMemory[]> {
    const fusion = this.config.fusion ?? {};
    const enabled =
      filter.graphExpansion === true ||
      (filter.graphExpansion !== false && (fusion.graphExpansion ?? false));
    const seedCount =
      fusion.graphExpansionSeeds ?? DEFAULT_GRAPH_EXPANSION_SEEDS;
    const hops = fusion.graphExpansionHops ?? DEFAULT_GRAPH_EXPANSION_HOPS;
    const alpha = fusion.graphExpansionAlpha ?? DEFAULT_GRAPH_EXPANSION_ALPHA;
    if (!enabled || fused.length === 0 || seedCount <= 0 || alpha <= 0) {
      return fused;
    }

    const seeds = fused.slice(0, Math.min(seedCount, fused.length));
    const seedScores = new Map(seeds.map((s) => [s.node.id, s.score]));
    const pprScores = personalizedPageRank(
      seedScores,
      this.buildPprNeighbors(fused),
      { maxHops: hops },
    );

    let maxPpr = 0;
    for (const value of pprScores.values()) {
      if (value > maxPpr) maxPpr = value;
    }
    if (!(maxPpr > 0)) return fused;

    const byId = new Map(fused.map((r) => [r.node.id, r]));
    const rescored: ScoredMemory[] = [];
    const unseen: { id: string; pprNorm: number }[] = [];
    // Every fused candidate is blended per the formula; candidates the
    // walk never reached get pprNorm 0 (i.e. downweighted by (1 - alpha)).
    for (const result of fused) {
      const raw = pprScores.get(result.node.id);
      const pprNorm = raw === undefined ? 0 : raw / maxPpr;
      const score = (1 - alpha) * result.score + alpha * pprNorm;
      rescored.push({
        node: result.node,
        score,
        scores: { ...result.scores, ppr: pprNorm, hybrid: score },
      });
    }
    for (const [id, raw] of pprScores) {
      if (byId.has(id)) continue;
      const pprNorm = raw / maxPpr;
      if (pprNorm >= DEFAULT_PPR_MIN_INJECT_SCORE) {
        unseen.push({ id, pprNorm });
      }
    }

    // Inject the walk's top unseen neighbours (bounded): these are the
    // multi-hop recall wins — nodes connected to seeds that neither
    // retrieval leg surfaced. Visibility follows the same guards as the
    // experimental expansion leg: same namespace as a seed, same
    // historical/current visibility (an injected stale fact must never
    // appear when defaults hide history). The remaining structured
    // filters are enforced by `pprInjectedNodePassesFilter` below:
    // traversal crosses the pool/type/tag/metadata/importance/trust/
    // temporal boundaries that the SQL legs filter at scan time.
    const seedNamespaces = new Set(seeds.map((s) => s.node.namespace));
    const seedHistorical = new Set(seeds.map((s) => s.node.validTo !== null));
    const now = Date.now();
    unseen.sort((a, b) => b.pprNorm - a.pprNorm || (a.id < b.id ? -1 : 1));
    const injected: ScoredMemory[] = [];
    for (const { id, pprNorm } of unseen.slice(0, DEFAULT_PPR_MAX_INJECTED)) {
      const node = this.storage.peekNode
        ? await this.storage.peekNode(id)
        : await this.storage.getNode(id);
      if (!node) continue;
      if (!seedNamespaces.has(node.namespace)) continue;
      if (!seedHistorical.has(node.validTo !== null)) continue;
      if (!this.pprInjectedNodePassesFilter(node, filter, now)) continue;
      const score = alpha * pprNorm;
      injected.push({
        node,
        score,
        scores: { ppr: pprNorm, hybrid: score },
      });
    }

    return [...rescored, ...injected].sort(compareScoredMemories);
  }

  /**
   * In-memory mirror of the SQLite `queryNodes` structured-filter
   * semantics, applied to PPR-injected neighbours. The SQL legs filter
   * type, pool, tags, metadata, importance/trust bounds, and temporal
   * windows at scan time; graph traversal bypasses all of that, so an
   * injected node must satisfy the same constraints or the expansion
   * would leak across filter boundaries (e.g. a procedure-only search
   * surfacing an event-pool neighbour).
   *
   * Namespace scoping is enforced separately by the seed-namespace
   * guard (stricter: the injected node must share a seed's namespace,
   * and seeds already passed the query's namespace/scope filter). The
   * query text itself is intentionally not re-applied — injected nodes
   * are recall wins the keyword/semantic legs missed.
   */
  private pprInjectedNodePassesFilter(
    node: MemoryNode,
    filter: SearchFilter,
    now: number,
  ): boolean {
    // Provenance-trust: quarantined neighbours must not ride into recall
    // along a PPR walk — same visibility rule as the SQL legs.
    if (!quarantineVisible(node.quarantined, filter)) return false;
    if (filter.type !== undefined && node.type !== filter.type) return false;
    if (
      filter.minImportance !== undefined &&
      node.importance < filter.minImportance
    ) {
      return false;
    }
    if (
      filter.maxImportance !== undefined &&
      node.importance > filter.maxImportance
    ) {
      return false;
    }
    if (filter.source !== undefined && node.source !== filter.source) {
      return false;
    }
    if (
      filter.minTrustScore !== undefined &&
      node.trustScore < filter.minTrustScore
    ) {
      return false;
    }
    if (filter.tags !== undefined && filter.tags.length > 0) {
      // AND logic like the SQL leg. Exact membership is the safe
      // direction: the SQL `LIKE '%"tag"%'` is looser (substring), so
      // anything this rejects, the fused legs could also have rejected.
      const nodeTags = new Set(node.tags ?? []);
      for (const tag of filter.tags) {
        if (!nodeTags.has(tag)) return false;
      }
    }
    if (filter.metadata !== undefined) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
        // SQL `json_extract(metadata, '$.key') = NULL` never matches.
        if (value === null || value === undefined) return false;
        const actual: unknown = node.metadata?.[key];
        if (actual === undefined) return false;
        const matches =
          typeof value === "object" || typeof actual === "object"
            ? JSON.stringify(actual) === JSON.stringify(value)
            : actual === value;
        if (!matches) return false;
      }
    }
    if (filter.pool !== undefined) {
      const pools = Array.isArray(filter.pool) ? filter.pool : [filter.pool];
      // Pre-pool memories read as "event" (matches the SQL migration).
      if (pools.length > 0 && !pools.includes(node.pool ?? "event")) {
        return false;
      }
    }
    // Temporal windows mirror the structured branch.
    if (filter.validAt !== undefined) {
      if (
        typeof node.validFrom === "number" &&
        node.validFrom > filter.validAt
      ) {
        return false;
      }
      if (typeof node.validTo === "number" && node.validTo < filter.validAt) {
        return false;
      }
    } else if (filter.includeHistorical !== true) {
      // Strict `<=`: mirrors the SQL `valid_to > now` exclusion.
      if (typeof node.validTo === "number" && node.validTo <= now) {
        return false;
      }
    }
    return true;
  }

  /**
   * Neighbour lookup for the PPR walk, over two link types:
   *
   * (a) Graph edges — from the in-memory `GraphEngine` adjacency (both
   *     endpoints, i.e. undirected traversal). Cheapest source: no
   *     storage I/O, O(1) per node.
   * (b) Shared-entity links — nodes in the fused candidate set sharing a
   *     tag or `metadata.entities` entry (exact match, lowercased),
   *     built in-memory over the candidate set. There is no
   *     entity→memories inverted table on this branch, so this is the
   *     zero-I/O analogue; nodes discovered via edges at hop 2+ do not
   *     contribute entity links (their tags are never fetched, keeping
   *     the hot path bounded) but remain reachable/expandable via edges.
   *
   * The returned list is sorted for deterministic iteration; fan-out
   * capping happens inside {@link personalizedPageRank}.
   */
  private buildPprNeighbors(fused: ScoredMemory[]): (id: string) => string[] {
    const byId = new Map<string, MemoryNode>();
    const entityToIds = new Map<string, Set<string>>();
    const indexEntities = (node: MemoryNode): void => {
      const entities = new Set<string>();
      for (const tag of node.tags ?? [])
        entities.add(String(tag).toLowerCase());
      const metaEntities = node.metadata?.entities;
      if (Array.isArray(metaEntities)) {
        for (const entity of metaEntities) {
          entities.add(String(entity).toLowerCase());
        }
      }
      for (const entity of entities) {
        let ids = entityToIds.get(entity);
        if (!ids) {
          ids = new Set<string>();
          entityToIds.set(entity, ids);
        }
        ids.add(node.id);
      }
    };
    for (const result of fused) {
      byId.set(result.node.id, result.node);
      indexEntities(result.node);
    }

    return (id: string): string[] => {
      const neighbours = new Set<string>();
      for (const edge of this.graph.getEdgesForNode(id)) {
        neighbours.add(edge.sourceId === id ? edge.targetId : edge.sourceId);
      }
      const node = byId.get(id);
      if (node) {
        const entities = new Set<string>();
        for (const tag of node.tags ?? []) {
          entities.add(String(tag).toLowerCase());
        }
        const metaEntities = node.metadata?.entities;
        if (Array.isArray(metaEntities)) {
          for (const entity of metaEntities) {
            entities.add(String(entity).toLowerCase());
          }
        }
        for (const entity of entities) {
          for (const other of entityToIds.get(entity) ?? []) {
            if (other !== id) neighbours.add(other);
          }
        }
      }
      neighbours.delete(id);
      return [...neighbours].sort();
    };
  }

  /**
   * Near-duplicate suppression (opt-in via `filter.semanticDedup`). A
   * result whose stored embedding is a near-verbatim duplicate (cosine >=
   * `experimental.searchDedupThreshold`, default 0.95) of an
   * already-selected result is dropped and the next candidate takes its
   * slot — multi-evidence questions otherwise lose top-K slots to
   * restated facts. Similarity comes from the storage vector cache, so
   * the pass costs a few dot products, not a new embedding call.
   */
  private async applySearchDedup(
    results: ScoredMemory[],
    filter: SearchFilter,
  ): Promise<ScoredMemory[]> {
    if (!filter.semanticDedup || results.length <= 1) return results;
    if (!this.storage.getAllEmbeddings) return results;
    const threshold = this.experimental.searchDedupThreshold ?? 0.95;

    // One bulk fetch; the storage-level vector cache makes repeat calls
    // nearly free.
    const byId = new Map<string, EmbeddingVector>();
    for (const record of await this.storage.getAllEmbeddings()) {
      byId.set(record.nodeId, record.vector);
    }

    const kept: ScoredMemory[] = [];
    for (const result of results) {
      const vector = byId.get(result.node.id);
      if (!vector) {
        kept.push(result);
        continue;
      }
      let duplicate = false;
      for (const chosen of kept) {
        const chosenVector = byId.get(chosen.node.id);
        if (!chosenVector) continue;
        if (cosineSimilarity(vector, chosenVector) >= threshold) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) kept.push(result);
    }
    return kept;
  }

  /**
   * Session-sibling expansion (opt-in per search via `filter.sessionExpansion`).
   * Memories recorded from the same conversation (`metadata.sessionId` /
   * `metadata.instanceId`) are pulled in behind their seed at a decaying
   * fraction of the seed score. Multi-hop answers typically span many turns
   * of one session, so recovering the neighbours of a single relevant turn
   * raises all-evidence recall without another embedding pass.
   */
  private async applySessionExpansion(
    fused: ScoredMemory[],
    filter: SearchFilter,
  ): Promise<ScoredMemory[]> {
    if (!filter.sessionExpansion || fused.length === 0) return fused;

    const maxSeeds = 5;
    const maxSiblingsPerSeed = 20;
    const maxInjected = 10;
    const scoreFactor = 0.85;

    const present = new Set(fused.map((r) => r.node.id));
    const injected: ScoredMemory[] = [];

    for (const seed of fused.slice(0, maxSeeds)) {
      if (injected.length >= maxInjected) break;
      const sessionId =
        (seed.node.metadata.sessionId as string | undefined) ??
        (seed.node.metadata.instanceId as string | undefined);
      if (!sessionId) continue;
      const sessionKey = seed.node.metadata.sessionId
        ? "sessionId"
        : "instanceId";
      const siblings = await this.storage.queryNodes({
        metadata: { [sessionKey]: sessionId },
        limit: maxSiblingsPerSeed,
        namespace: filter.namespace,
        includeHistorical: filter.includeHistorical,
      });
      let decay = scoreFactor;
      for (const sibling of siblings) {
        if (injected.length >= maxInjected) break;
        if (sibling.node.id === seed.node.id || present.has(sibling.node.id)) {
          continue;
        }
        present.add(sibling.node.id);
        injected.push({
          node: sibling.node,
          score: seed.score * decay,
          scores: { session: seed.score * decay },
        });
        decay *= scoreFactor;
      }
    }

    if (injected.length === 0) return fused;
    return [...fused, ...injected].sort((a, b) => b.score - a.score);
  }

  /**
   * Start the background TTL sweep timer.
   */
  private startSweep(): void {
    const intervalSec = this.config.sweepInterval;
    if (intervalSec <= 0) return;

    this.sweepTimer = setInterval(async () => {
      try {
        const count = await this.storage.sweepExpired();
        if (count > 0) {
          // Remove expired nodes from in-memory graph
          const allNodes = this.graph.getAllNodes();
          const now = Math.floor(Date.now() / 1000);
          for (const n of allNodes) {
            if (n.expiresAt !== null && n.expiresAt <= now) {
              this.graph.removeNode(n.id);
              this.emit("ttl:expired", n);
            }
          }
        }
      } catch {
        // Sweep errors are non-fatal
      }
    }, intervalSec * 1000);

    // Unref so the timer doesn't prevent process exit
    if (
      this.sweepTimer &&
      typeof this.sweepTimer === "object" &&
      "unref" in this.sweepTimer
    ) {
      (this.sweepTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Stop the background TTL sweep timer.
   */
  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Convert a memory node to markdown with YAML frontmatter.
   */
  private nodeToMarkdown(
    node: MemoryNode,
    format: "markdown" | "obsidian",
  ): string {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`id: "${node.id}"`);
    lines.push(`type: "${node.type}"`);
    lines.push(`tags: [${node.tags.map((t) => `"${t}"`).join(", ")}]`);
    lines.push(`created_at: "${new Date(node.createdAt).toISOString()}"`);
    if (node.expiresAt) {
      lines.push(
        `expires_at: "${new Date(node.expiresAt * 1000).toISOString()}"`,
      );
    }
    lines.push("---");
    lines.push("");

    if (format === "obsidian") {
      // Convert linked memories to wikilinks
      const neighbours = this.graph.getNeighbours(node.id);
      let content = node.content;
      for (const n of neighbours) {
        const title = n.content.slice(0, 50).replace(/[[\]]/g, "");
        content = content.replace(
          new RegExp(this.escapeRegex(n.content.slice(0, 30)), "gi"),
          `[[${title}]]`,
        );
      }
      lines.push(content);
    } else {
      lines.push(node.content);
    }

    return lines.join("\n");
  }

  private escapeDot(str: string): string {
    return str
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

// Re-export for convenience
export type {
  MemoryNode,
  MemoryEdge,
  SearchFilter,
  ScoredMemory,
  GraphSnapshot,
  MemOSConfig,
  ExportOptions,
  ExportResult,
  ExperimentalConfig,
} from "./types.js";
export { GraphEngine, textSimilarity } from "./graph.js";
export { SQLiteStorage } from "./storage/sqlite.js";
