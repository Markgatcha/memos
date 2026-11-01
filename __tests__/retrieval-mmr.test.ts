/**
 * Unit tests for MMR diversification (src/retrieval.ts).
 *
 * `applyMmr` is pure, like `applyRelevanceGate` — no storage, no
 * embeddings, no MemOS instance.
 */

import {
  applyMmr,
  DEFAULT_MMR_LAMBDA,
  type MmrOptions,
} from "../src/retrieval";
import type { MemoryNode, ScoredMemory } from "../src/types";

function node(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 0,
    updatedAt: 0,
    accessCount: 0,
    lastAccessed: 0,
    tags: [],
    namespace: "default",
    expiresAt: null,
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1,
    confidence: 0.5,
  } as MemoryNode;
}

function scored(id: string, score: number, content: string): ScoredMemory {
  return { node: node(id, content), score };
}

const DUP_A = "alpha beta gamma delta";
const DISTINCT = "unrelated words about postgres pooling";

describe("applyMmr — relevance floor", () => {
  test("lambda >= 1 is the identity", () => {
    const results = [
      scored("a", 1.0, DUP_A),
      scored("b", 0.95, DUP_A),
      scored("c", 0.7, DISTINCT),
    ];
    expect(applyMmr(results, { lambda: 1 }).map((r) => r.node.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Default lambda is a real trade-off, not the identity.
    expect(DEFAULT_MMR_LAMBDA).toBeLessThan(1);
  });

  test("a single result is returned as-is", () => {
    expect(applyMmr([scored("a", 1, DUP_A)])).toHaveLength(1);
    expect(applyMmr([])).toHaveLength(0);
  });
});

describe("applyMmr — diversification", () => {
  test("demotes a near-duplicate below a distinct lower-scored result", () => {
    const results = [
      scored("a", 1.0, DUP_A),
      scored("b", 0.95, DUP_A), // paraphrase of a
      scored("c", 0.7, DISTINCT),
    ];
    const out = applyMmr(results, { lambda: 0.5 });
    // a first (nothing to be similar to), then the DISTINCT c, and only
    // then the duplicate b.
    expect(out.map((r) => r.node.id)).toEqual(["a", "c", "b"]);
  });

  test("the top-scoring result is never demoted", () => {
    const results = [scored("a", 1.0, DUP_A), scored("b", 0.95, DUP_A)];
    // Even at lambda 0 (pure novelty) the head keeps its slot.
    for (const lambda of [0, 0.1, 0.5]) {
      const out = applyMmr(results, { lambda });
      expect(out[0]!.node.id).toBe("a");
    }
  });

  test("limit truncates the diversified list", () => {
    const results = [
      scored("a", 1.0, DUP_A),
      scored("b", 0.95, DUP_A),
      scored("c", 0.7, DISTINCT),
    ];
    const out = applyMmr(results, { lambda: 0.5, limit: 2 });
    expect(out.map((r) => r.node.id)).toEqual(["a", "c"]);
  });

  test("fully-distinct results keep their relevance order", () => {
    const results = [
      scored("a", 1.0, "one two three"),
      scored("b", 0.9, "four five six"),
      scored("c", 0.8, "seven eight nine"),
    ];
    const out = applyMmr(results, { lambda: 0.5 });
    expect(out.map((r) => r.node.id)).toEqual(["a", "b", "c"]);
  });

  test("lambda is clamped into [0, 1]", () => {
    const results = [
      scored("a", 1.0, DUP_A),
      scored("b", 0.95, DUP_A),
      scored("c", 0.7, DISTINCT),
    ];
    const opts: MmrOptions = { lambda: 5 };
    // > 1 must behave like the identity, not NaN-poison the loop.
    expect(applyMmr(results, opts).map((r) => r.node.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // 0 = pure novelty: a still first, then the distinct item.
    expect(applyMmr(results, { lambda: 0 }).map((r) => r.node.id)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
});
