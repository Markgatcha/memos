/**
 * MemOS — Universal memory layer for AI agents, LLM apps, and chatbots.
 *
 * This is the package entry point. Import `MemOS` to get started:
 *
 * ```ts
 * import { MemOS } from "@mem-os/sdk";
 *
 * const memos = new MemOS();
 * await memos.init();
 *
 * await memos.store("User likes dark mode", { type: "preference" });
 * const results = await memos.search("dark mode");
 * ```
 *
 * @packageDocumentation
 * @module @mem-os/sdk
 */

export { MemOS, MemorySkippedError, MEMOS_PRESET_CONFIGS } from "./memory.js";
export type {
  MemOSPresetName,
  ForgetSourceOptions,
  ForgetSourceResult,
  DeletionStatusResult,
  BriefOptions,
  BriefItem,
  MemoryBrief,
} from "./memory.js";
export type {
  KnowledgePageDef,
  KnowledgePage,
  KnowledgePageCitation,
} from "./knowledge-pages.js";
export {
  decideRetain,
  shouldRetain,
  scoreRetain,
  setRetainClassifier,
  type RetainInput,
  type RetainDecision,
} from "./retain-filter.js";
export {
  OUTCOME_SCORES,
  NEUTRAL_UTILITY,
  DEFAULT_OUTCOME_WEIGHT,
  outcomeScore,
  emptyRecallStat,
  addOutcomeToStat,
  utilityFromStat,
  outcomeMultiplier,
  meanOutcome,
  buildMemoryUtility,
  normaliseWeight,
  memoriesWithFeedback,
} from "./feedback.js";
export {
  memoryStatus,
  ageDays,
  lastAccessedDays,
  describeRankingEvidence,
  describeStatus,
  describeUtility,
  healthGrade,
  sortFindings,
} from "./inspector.js";
export { getMcpTools, runMcpServer } from "./mcp.js";
export {
  chunkText,
  extractFileText,
  htmlToText,
  ingestPath,
  isSupportedFile,
  watchPath,
} from "./ingest.js";
export { extractPreferences, isPreferenceQuestion } from "./preferences.js";
export type { ExtractedPreference } from "./preferences.js";
export type {
  IngestOptions,
  IngestProgress,
  IngestResult,
  WatchHandle,
} from "./ingest.js";
export {
  detectRevertIntent,
  normalizeRevertTarget,
  parseRevertCliArgs,
  type RevertIntent,
  type RevertScopeKind,
  type RevertScopeInput,
  type ParsedRevertArgs,
} from "./revert.js";
export {
  parseTemporal,
  parseDuration,
  addDuration,
  type ParsedTemporal,
  type TemporalDuration,
  type TemporalGrain,
} from "./temporal.js";
export {
  detectEvent,
  detectEventUpdate,
  extractEventKind,
  splitRemindText,
  isScheduledEventNode,
  listReminders,
  type DetectedEvent,
  type EventMetadata,
  type EventStatus,
  type EventUpdate,
  type ReminderEntry,
  type ListRemindersOptions,
  type ReminderSource,
} from "./event-memory.js";
export { GraphEngine, textSimilarity, generateId } from "./graph.js";
export {
  // Fidelity-level compaction (L0–L3): cheap representations of every
  // memory, a query-adaptive router, and in-call escalation.
  FIDELITY_LEVELS,
  FIDELITY_LEVEL_LABELS,
  FIDELITY_LEVEL_DESCRIPTIONS,
  hasFidelityCache,
  stampFidelityCache,
  levelText,
  fidelityL0,
  fidelityL1,
  fidelityL2,
  splitSentences,
  nodeEntities,
  rankSentencesByCentrality,
  nextFidelityLevel,
  clampFidelityLevel,
  parseFidelityLevel,
  routeFidelity,
  routerEntities,
  scoreLevelCorpus,
  resolveRecallLevels,
  fidelityStats,
  isInformationDense,
  queryDecisiveTokens,
  textHasDecisiveToken,
  fidelityLevelSufficient,
  shouldCompressFidelityItem,
  DEFAULT_MIN_FIDELITY_LEVEL,
  type FidelityLevel,
  type FidelitySignals,
  type FidelityRoute,
  type FidelityRecallOptions,
  type FidelityRecallResult,
  type CompactOptions,
  type CompactResult,
  type FidelityLevelStats,
} from "./fidelity.js";
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
export type { SemanticScanMode, SemanticScanStats } from "./storage/sqlite.js";
export {
  ClipEmbeddingProvider,
  ClipUnavailableError,
  DEFAULT_CLIP_MODEL,
  DEFAULT_CLIP_DIMENSIONS,
  FakeClipProvider,
  ClipQueryCache,
  DEFAULT_CLIP_QUERY_CACHE_MAX,
} from "./vision/index.js";
export type { ClipEmbeddingProviderOptions } from "./vision/clip.js";
export type { FakeClipProviderOptions } from "./vision/fake-clip.js";
// Blob store + input normalization: exported so a host model can
// resolve an `[img:…]` ref from a context pack without going through
// a MemOS instance.
export {
  blobRoot,
  deleteRef,
  ImageRejectedError,
  kindFromMime,
  normalizeImageInput,
  purgeOrphanImages,
  readDimensions,
  readImage,
  refFor,
  resolveRef,
  sniffMime,
  writeImage,
  type StoredImage,
} from "./vision/store.js";
// The node-level image discriminator, shared by the pack builder and
// the fidelity renderer.
export { imageAttachmentOf } from "./context-pack.js";
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
  type ContextPackFidelityMeta,
} from "./context-pack.js";
export type {
  MemoryNode,
  MemoryEdge,
  MemoryType,
  MemorySource,
  ProvenanceTier,
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
  HarnessCount,
  HarnessMergeNode,
  HarnessMergeOptions,
  HarnessMergeResult,
  ExperimentalConfig,
  EmbeddingProvider,
  EmbeddingVector,
  EmbeddingRuntimeInfo,
  EmbeddingRecordInfo,
  EmbeddingNodeStatus,
  EmbeddingNodeStatusInfo,
  EmbeddingQueueStatus,
  EmbeddingProviderKind,
  // One-call profile API
  ProfileConfig,
  ProfileOptions,
  MemoryProfile,
  MemoryOverview,
  OverviewOptions,
  TriggerOptions,
  TriggerMatch,
  TriggerResult,
  // Retrieval-quality knobs
  MmrConfig,
  MultiHopOptions,
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
  // Outcome-conditioned recall + inspector + health
  RecallOutcome,
  RecallFeedbackInput,
  RecallBatchRecord,
  RecallBatchOutcome,
  RecallFeedbackStat,
  RecallFeedbackResult,
  MemoryUtility,
  ExplainOptions,
  ExplainResult,
  ExplainCandidate,
  ExplainFocus,
  ExplainCheck,
  ExplainScoreComponents,
  MemoryHealth,
  MemoryHealthMetrics,
  MemoryHealthFinding,
  OutcomeFeedbackConfig,
  LessonOutcome,
  NewProceduralLesson,
  ProceduralLesson,
  RevertOptions,
  RevertResult,
  RevertTargetResolution,
  // Vision (image memory)
  ImageKind,
  ImageSource,
  ImageAttachment,
  ImageMemoryMeta,
  ImageInput,
  AddImageMemoryOptions,
  AddImageMemoryResult,
  SearchImagesOptions,
  ListImagesOptions,
  ImageSearchResult,
  EmbedImageProvider,
  ClipStatus,
  ClipMeta,
  VisionConfig,
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
  // Relevance gate + MMR diversification
  applyRelevanceGate,
  shouldAbstain,
  hasExactTermMatch,
  DEFAULT_RELEVANCE_RATIO,
  DEFAULT_ABSTAIN_SIMILARITY,
  applyMmr,
  DEFAULT_MMR_LAMBDA,
  type MmrOptions,
  type RelevanceGateOptions,
} from "./retrieval.js";
export type { FusionOptions } from "./retrieval.js";
export {
  DEFAULT_MULTIHOP_MAX_ENTITIES,
  DEFAULT_MULTIHOP_MAX_SEEDS,
  DEFAULT_MULTIHOP_MAX_INJECTED,
  DEFAULT_MULTIHOP_MIN_BRIDGE_SCORE,
  extractLeadSubject,
  extractBridgeEntities,
  buildNamespaceSubjectIndex,
  expandMultiHop,
  type LeadSubject,
  type NamespaceSubjectIndex,
  type ExpandMultiHopInput,
  type MultiHopExpansionResult,
} from "./multi-hop.js";
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
  assignCitationTokens,
  citationToken,
  citationTokenForHex,
  formatCitationResolution,
  parseCitationToken,
  shortCitationId,
  CITATION_MAX_HEX,
  CITATION_MIN_HEX,
  type CitationResolution,
} from "./citations.js";
export {
  buildHandoffBrief,
  renderHandoffMarkdown,
  type HandoffBrief,
  type HandoffItem,
  type HandoffOptions,
} from "./handoff.js";
export {
  buildAuditReport,
  renderAuditMarkdown,
  type AuditOptions,
  type AuditReport,
} from "./compliance.js";
export {
  buildSelfEvalCases,
  runRetrievalEval,
  type RetrievalEvalCase,
  type RetrievalEvalCaseResult,
  type RetrievalEvalOptions,
  type RetrievalEvalReport,
} from "./eval.js";
export {
  deriveProcedureCandidates,
  normalizeQuery,
  type ProcedureCandidate,
  type PromotionOptions,
} from "./procedure-promotion.js";
export {
  MemOSError,
  asMemOSError,
  classifyError,
  errorPayload,
  formatErrorCard,
  isMemOSError,
  readLatestCrashReport,
  writeCrashReport,
  type CrashReportOptions,
  type FormatErrorOptions,
  type MemOSErrorCode,
  type MemOSErrorOptions,
} from "./errors.js";
export {
  resolveEmbeddingPrefixes,
  type EmbeddingPrefixInput,
  type ResolvedEmbeddingPrefixes,
} from "./embedding-prefixes.js";
export {
  detectHarness,
  normalizeHarness,
  UNKNOWN_HARNESS,
  MEMOS_HARNESS_ENV,
  HARNESS_MARKERS,
} from "./harness.js";
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
export {
  PROVENANCE_TIER_ORDER,
  LOW_TRUST_TIERS,
  PROVENANCE_TRUST,
  DEFAULT_PROVENANCE_WEIGHT_STRENGTH,
  QUARANTINE_RELEASED_METADATA_KEY,
  isProvenanceTier,
  defaultProvenanceForSource,
  resolveProvenance,
  compareProvenanceTier,
  isUntrustedForAgent,
  quarantineVisible,
  provenanceMultiplier,
  decorateTrustFlags,
} from "./provenance.js";
export {
  screenWrite,
  QUARANTINE_FLAG_THRESHOLD,
  type QuarantineSignal,
  type QuarantineVerdict,
} from "./quarantine.js";
export {
  EXPLORER_APP_URI,
  EXPLORER_URI_TEMPLATE,
  EXPLORER_NODE_CAP,
  EXPLORER_EDGE_CAP,
  EXPLORER_PROTOCOL,
  PROVENANCE_TIER_COLORS,
  EDGE_RELATION_COLORS,
  SUPPORTED_INTENTS,
  buildExplorerSnapshot,
  filterSnapshotAsOf,
  isNodeValidAt,
  isEdgeValidAt,
  resolveExplorerMode,
  probeHostAppsSupport,
  intentToToolCall,
  buildExplorerHtml,
  buildExplorerFallbackMarkdown,
  ExplorerUriTemplate,
  type ExplorerIntentName,
  type ExplorerMode,
  type ExplorerNode,
  type ExplorerEdge,
  type ExplorerSnapshot,
  type IntentToolCall,
  type IntentTranslation,
} from "./apps/explorer.js";
