/**
 * In-product retrieval evaluation.
 *
 * This is deliberately small and honest:
 *   - `self` mode samples recent memories, turns a fragment of each into a
 *     query, and checks whether the source memory is still retrievable. It is
 *     an index-health smoke test, not a semantic-QA benchmark.
 *   - `corpus` mode runs a user-supplied JSON file of labelled queries and
 *     reports Hit@K, MRR, latency, and token cost.
 *
 * The published LongMemEval/LoCoMo harnesses live in `scripts/` and remain the
 * source of truth for benchmark claims. This command answers "is MY store
 * still retrieving?" without asking the user to clone a dataset.
 */

import { estimateTokens } from "./context-pack.js";
import type { MemoryNode } from "./types.js";

export interface RetrievalEvalCase {
  query: string;
  relevantIds: string[];
}

export interface RetrievalEvalCaseResult {
  query: string;
  relevantIds: string[];
  retrievedIds: string[];
  hit: boolean;
  reciprocalRank: number;
  latencyMs: number;
  tokens: number;
}

export interface RetrievalEvalReport {
  mode: "self" | "corpus";
  k: number;
  cases: number;
  hitAtK: number;
  mrr: number;
  avgLatencyMs: number;
  avgTokens: number;
  /** Tokens spent per successful case; null when nothing hit. */
  tokensPerHit: number | null;
  weakCases: RetrievalEvalCaseResult[];
  results: RetrievalEvalCaseResult[];
}

export interface RetrievalEvalOptions {
  k?: number;
  limit?: number;
  /** Only sample nodes that carry session metadata. */
  fromSessions?: boolean;
  /** Optional namespace filter for both sampling and search. */
  namespace?: string;
}

interface EvalMemOS {
  getGraph(): Promise<{ nodes: MemoryNode[] }>;
  search(input: {
    query: string;
    limit: number;
    namespace?: string;
  }): Promise<Array<{ node: MemoryNode }>>;
}

export async function runRetrievalEval(
  memos: EvalMemOS,
  cases: RetrievalEvalCase[],
  opts: {
    k?: number;
    mode?: "self" | "corpus";
    namespace?: string;
  } = {},
): Promise<RetrievalEvalReport> {
  const k = Math.max(1, opts.k ?? 5);
  const results: RetrievalEvalCaseResult[] = [];

  for (const testCase of cases) {
    const start = Date.now();
    const hits = await memos.search({
      query: testCase.query,
      limit: k,
      ...(opts.namespace ? { namespace: opts.namespace } : {}),
    });
    const retrievedIds = hits.map((hit) => hit.node.id);
    const rank = retrievedIds.findIndex((id) =>
      testCase.relevantIds.includes(id),
    );
    const tokens = hits.reduce(
      (sum, hit) =>
        sum + estimateTokens(hit.node.summary || hit.node.content || ""),
      0,
    );
    results.push({
      query: testCase.query,
      relevantIds: testCase.relevantIds,
      retrievedIds,
      hit: rank >= 0,
      reciprocalRank: rank >= 0 ? 1 / (rank + 1) : 0,
      latencyMs: Date.now() - start,
      tokens,
    });
  }

  const hits = results.filter((result) => result.hit);
  const totalTokens = results.reduce((sum, result) => sum + result.tokens, 0);
  return {
    mode: opts.mode ?? "corpus",
    k,
    cases: results.length,
    hitAtK: results.length === 0 ? 0 : hits.length / results.length,
    mrr:
      results.length === 0
        ? 0
        : results.reduce((sum, result) => sum + result.reciprocalRank, 0) /
          results.length,
    avgLatencyMs:
      results.length === 0
        ? 0
        : results.reduce((sum, result) => sum + result.latencyMs, 0) /
          results.length,
    avgTokens: results.length === 0 ? 0 : totalTokens / results.length,
    tokensPerHit: hits.length === 0 ? null : totalTokens / hits.length,
    weakCases: results.filter((result) => !result.hit).slice(0, 10),
    results,
  };
}

/** Build a self-recall suite from recent memories. */
export async function buildSelfEvalCases(
  memos: EvalMemOS,
  opts: RetrievalEvalOptions = {},
): Promise<RetrievalEvalCase[]> {
  const limit = Math.max(1, opts.limit ?? 20);
  const graph = await memos.getGraph();
  const candidates = graph.nodes
    .filter(
      (node) =>
        !node.quarantined &&
        (node.validTo === null || node.validTo > Date.now()) &&
        String(node.content ?? "").trim().length >= 24 &&
        (opts.namespace ? node.namespace === opts.namespace : true) &&
        (opts.fromSessions ? Boolean(node.metadata?.sessionId) : true),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);

  return candidates.map((node) => ({
    query: queryFragment(node.summary || node.content),
    relevantIds: [node.id],
  }));
}

function queryFragment(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").slice(0, 12);
  return words.join(" ").replace(/[.,;:!?]+$/, "");
}
