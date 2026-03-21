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

export { MemOS } from "./memory";
export { GraphEngine, textSimilarity, generateId } from "./graph";
export { SQLiteStorage } from "./storage/sqlite";
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
} from "./types";
