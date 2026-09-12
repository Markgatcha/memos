// Minimal type surface for the in-browser folding engine.
//
// This is a faithful subset of llm-guardian's src/core/types.ts — kept in
// sync by hand with the engine copy in folding-engine.ts (upstream:
// https://github.com/Markgatcha/llm-guardian). Only the types the engine
// actually touches are included.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface EntityHeadline {
  /** The entity-dense headlinese representation, e.g. "[ACTION:Refactor][TARGET:VCM]" */
  headline: string;
  /** Number of tokens in the original text */
  originalTokens: number;
  /** Number of tokens after folding */
  foldedTokens: number;
  /** Compression ratio: foldedTokens / originalTokens */
  compressionRatio: number;
  /** Semantic density score (0-1) — higher means more information per token */
  semanticDensity: number;
  /** Named entities extracted and preserved */
  entities: string[];
  /** The action verbs extracted */
  actions: string[];
}

export interface FoldingResult {
  /** The compressed prompt ready for LLM submission */
  foldedPrompt: string;
  /** Token count of the folded prompt */
  foldedTokens: number;
  /** Metadata about the folding process */
  metadata: EntityHeadline;
  /** Estimated USD saved by folding */
  estimatedSavingsUsd: number;
  /** Time taken for folding in milliseconds */
  foldingTimeMs: number;
}
