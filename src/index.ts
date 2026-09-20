/**
 * MemOS — Universal memory layer for AI agents, LLM apps, and chatbots.
 *
 * This is the package entry point. Import `MemOS` to get started:
 *
 * ```ts
 * import { MemOS } from "@memos/sdk";
 *
 * const memos = new MemOS();
 * await memos.init();
 *
 * await memos.store("User likes dark mode", { type: "preference" });
 * const results = await memos.search("dark mode");
 * ```
 *
 * @packageDocumentation
 * @module @memos/sdk
 */

export { MemOS, MemorySkippedError } from "./memory.js";
export {
  decideRetain,
  shouldRetain,
  scoreRetain,
  setRetainClassifier,
  type RetainInput,
  type RetainDecision,
} from "./retain-filter.js";
export { getMcpTools, runMcpServer } from "./mcp.js";
export { GraphEngine, textSimilarity, generateId } from "./graph.js";
export {
  LocalHashEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  VoyageAIEmbeddingProvider,
  CohereEmbeddingProvider,
  FastEmbedEmbeddingProvider,
  cosineSimilarity,
  createEmbeddingProvider,
  normalizeVector,
} from "./embeddings.js";
export { SQLiteStorage } from "./storage/sqlite.js";
export {
  EmbeddingQueue,
  type EmbeddingJob,
  type EmbeddingJobStatus,
  type EmbeddingQueueConfig,
  type PersistEmbeddingFn,
  type EmbeddingStatusChangeFn,
} from "./embedding-queue.js";
export {
  buildContextPack,
  CONTEXT_PACK_SCHEMA,
  packToToon,
  packToToonCompact,
  searchResultsToToon,
  searchResultsToToonCompact,
  serializeContextPack,
  parseToonCompact,
  encodeCompactId,
  decodeCompactId,
  type ContextPack,
  type ContextPackItem,
  type BuildContextPackOptions,
} from "./context-pack.js";
export type {
  MemoryNode,
  MemoryEdge,
  MemoryType,
  MemorySource,
  EdgeRelation,
  CreateMemoryInput,
  UpdateMemoryInput,
  CreateEdgeInput,
  SearchFilter,
  SemanticSearchOptions,
  ScoredMemory,
  GraphSnapshot,
  StorageAdapter,
  MemOSConfig,
  MemOSEvent,
  MemOSEventListener,
  ExportFormat,
  ExportOptions,
  ExportResult,
  ImportFormat,
  ImportOptions,
  ImportResult,
  ExperimentalConfig,
  EmbeddingProvider,
  EmbeddingVector,
  EmbeddingRuntimeInfo,
  EmbeddingRecordInfo,
  EmbeddingNodeStatus,
  EmbeddingNodeStatusInfo,
  EmbeddingQueueStatus,
  EmbeddingProviderKind,
  DedupeOptions,
  DedupeMerge,
  DedupeResult,
  ArchiveOptions,
  ArchiveMove,
  ArchiveResult,
  ConsolidateOptions,
  ConsolidateResult,
  ConversationMessage,
  ExtractedFact,
  ExtractFactsOptions,
  ExtractFactsResult,
  DiagnosticsResult,
  LessonOutcome,
  NewProceduralLesson,
  ProceduralLesson,
} from "./types.js";
export { DEFAULT_TRUST_SCORES } from "./types.js";
export {
  applyEvidence,
  classifyEvidence,
  confidenceWeight,
  INITIAL_CONFIDENCE,
  CONFIDENCE_FLOOR,
  CONFIDENCE_CAP,
} from "./confidence-machine.js";
export type {
  EvidenceOutcome,
  ConfidenceUpdate,
} from "./confidence-machine.js";
export {
  fuseResults,
  DEFAULT_RRF_K,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_SEMANTIC_WEIGHT,
  DEFAULT_TRUST_FLOOR,
  DEFAULT_ENTITY_LEG_WEIGHT,
} from "./retrieval.js";
export type { FusionOptions } from "./retrieval.js";
export {
  personalizedPageRank,
  type PersonalizedPageRankOptions,
  DEFAULT_PPR_DAMPING,
  DEFAULT_PPR_MAX_HOPS,
  DEFAULT_PPR_MAX_FANOUT,
  DEFAULT_PPR_MAX_NODES,
  DEFAULT_PPR_MAX_ITERATIONS,
  DEFAULT_PPR_TOLERANCE,
  DEFAULT_GRAPH_EXPANSION_ALPHA,
  DEFAULT_GRAPH_EXPANSION_SEEDS,
  DEFAULT_GRAPH_EXPANSION_HOPS,
  DEFAULT_PPR_MAX_INJECTED,
  DEFAULT_PPR_MIN_INJECT_SCORE,
} from "./graph-expansion.js";
export {
  applyLessonOutcome,
  clampLessonScore,
  effectiveLessonScore,
  lessonCitationToken,
  lessonShortId,
  rankProceduralLessons,
  DEFAULT_LESSON_PACK_K,
  LESSON_DECAY_HALF_LIFE_DAYS,
  LESSON_FAILURE_STEP,
  LESSON_INITIAL_SCORE,
  LESSON_RELEVANCE_WEIGHT,
  LESSON_SCORE_CAP,
  LESSON_SCORE_FLOOR,
  LESSON_SCORE_WEIGHT,
  LESSON_SUCCESS_STEP,
  type RankedProceduralLesson,
} from "./procedural.js";
export {
  contentHash,
  parseExportDirectory,
  parseExternalMemoryExport,
  parseSlackExportDirectory,
  synthesizeImportInsights,
  type DetectedExportSource,
  type ExternalImportSource,
  type ExternalMemoryItem,
  type ParsedExternalExport,
  type SynthesizedInsight,
  type SynthesizedKind,
} from "./external-import.js";
