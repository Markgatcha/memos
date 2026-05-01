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

export { MemOS } from "./memory.js";
export { getMcpTools, runMcpServer } from "./mcp.js";
export { GraphEngine, textSimilarity, generateId } from "./graph.js";
export { SQLiteStorage } from "./storage/sqlite.js";
export type {
  MemoryNode,
  MemoryEdge,
  MemoryType,
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
  ExperimentalConfig,
} from "./types.js";
