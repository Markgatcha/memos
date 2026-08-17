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
} from "./retrieval.js";
export type { FusionOptions } from "./retrieval.js";
