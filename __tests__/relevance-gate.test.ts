/**
 * Unit tests for relevance gating and pseudo-relevance query expansion
 * (src/retrieval.ts).
 *
 * Both are pure functions — no storage, no embeddings, no MemOS
 * instance — matching the design of the fusion tests in
 * `retrieval.test.ts`.
 */

import {
  applyRelevanceGate,
  expandQueryWithPseudoRelevance,
  hasExactTermMatch,
  shouldAbstain,
  DEFAULT_ABSTAIN_SIMILARITY,
  DEFAULT_RELEVANCE_RATIO,
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

function scored(
  id: string,
  score: number,
  scores?: ScoredMemory["scores"],
  content?: string,
): ScoredMemory {
  return {
    node: node(id, content ?? `content of ${id}`),
    score,
    ...(scores ? { scores } : {}),
  };
}

describe("applyRelevanceGate — tail trimming", () => {
  test("drops candidates trailing far behind the top score", () => {
    const results = [
      scored("a", 1.0),
      scored("b", 0.9),
      scored("c", 0.05), // 5% of top — below the 0.15 default
    ];
    const gated = applyRelevanceGate(results, "anything", {
      relevanceRatio: DEFAULT_RELEVANCE_RATIO,
    });
    expect(gated.map((r) => r.node.id)).toEqual(["a", "b"]);
  });

  test("keeps the whole list when trimming is disabled", () => {
    const results = [scored("a", 1.0), scored("c", 0.001)];
    const gated = applyRelevanceGate(results, "anything", {
      relevanceRatio: 0,
    });
    expect(gated).toHaveLength(2);
  });

  test("never trims down to nothing — the top result always survives", () => {
    const results = [scored("a", 1.0), scored("b", 0.01)];
    const gated = applyRelevanceGate(results, "anything", {
      relevanceRatio: 0.5,
    });
    expect(gated.map((r) => r.node.id)).toEqual(["a"]);
  });

  test("a single result is always kept", () => {
    const gated = applyRelevanceGate([scored("a", 1.0)], "q", {
      relevanceRatio: 0.99,
    });
    expect(gated).toHaveLength(1);
  });
});

describe("shouldAbstain", () => {
  test("abstains when every candidate is below the cosine floor", () => {
    const results = [
      scored("a", 0.5, { semantic: 0.1 }),
      scored("b", 0.4, { semantic: 0.2 }),
    ];
    expect(
      shouldAbstain(results, "what is the airspeed of a swallow", {
        abstainBelowSimilarity: DEFAULT_ABSTAIN_SIMILARITY,
      }),
    ).toBe(true);
  });

  test("does not abstain when any candidate clears the floor", () => {
    const results = [
      scored("a", 0.5, { semantic: 0.1 }),
      scored("b", 0.4, { semantic: 0.62 }),
    ];
    expect(
      shouldAbstain(results, "unrelated question", {
        abstainBelowSimilarity: DEFAULT_ABSTAIN_SIMILARITY,
      }),
    ).toBe(false);
  });

  test("never abstains without a configured floor", () => {
    const results = [scored("a", 0.5, { semantic: 0.01 })];
    expect(shouldAbstain(results, "anything")).toBe(false);
  });

  test("never abstains when no candidate carries a semantic score", () => {
    // Keyword-only retrieval (or no embedding provider): similarity
    // cannot be judged, so abstention must stay silent.
    const results = [
      scored("a", 0.5, { keyword: 1 }),
      scored("b", 0.4, { keyword: 0.5 }),
    ];
    expect(
      shouldAbstain(results, "anything", { abstainBelowSimilarity: 0.9 }),
    ).toBe(false);
  });

  test("a literal term match rescues a low-cosine bullseye", () => {
    // A rare proper noun can score a poor cosine while being a perfect
    // hit. Abstaining there would throw away the right answer.
    const results = [
      scored("a", 0.5, { semantic: 0.08 }, "we talked about Kubernetes today"),
    ];
    expect(
      shouldAbstain(results, "what did we say about kubernetes", {
        abstainBelowSimilarity: DEFAULT_ABSTAIN_SIMILARITY,
      }),
    ).toBe(false);
  });

  test("an empty result set never abstains", () => {
    expect(shouldAbstain([], "anything", { abstainBelowSimilarity: 0.9 })).toBe(
      false,
    );
  });
});

describe("applyRelevanceGate — abstention end to end", () => {
  test("returns an empty list when abstaining", () => {
    const results = [scored("a", 0.5, { semantic: 0.02 }, "totally unrelated")];
    const gated = applyRelevanceGate(results, "question about zebras", {
      abstainBelowSimilarity: DEFAULT_ABSTAIN_SIMILARITY,
    });
    expect(gated).toEqual([]);
  });
});

describe("hasExactTermMatch", () => {
  test("matches a term of three or more characters", () => {
    const results = [scored("a", 1, undefined, "the Eiffel Tower is tall")];
    expect(hasExactTermMatch("where is the eiffel tower", results)).toBe(true);
  });

  test("ignores short tokens to avoid stopword false positives", () => {
    const results = [scored("a", 1, undefined, "nothing relevant here")];
    expect(hasExactTermMatch("a an of", results)).toBe(false);
  });

  test("returns false when nothing matches", () => {
    const results = [scored("a", 1, undefined, "completely different topic")];
    expect(hasExactTermMatch("zebra sighting", results)).toBe(false);
  });
});

describe("expandQueryWithPseudoRelevance", () => {
  test("harvests distinctive vocabulary from the top candidates", () => {
    const results = [
      scored("a", 0.9, undefined, "the user adopted a corgi named Pixel"),
      scored("b", 0.8, undefined, "Pixel the corgi loves agility training"),
      scored("c", 0.1, undefined, "stock prices fell sharply today"),
    ];
    const expanded = expandQueryWithPseudoRelevance("what pet", results);
    expect(expanded.startsWith("what pet")).toBe(true);
    // Harvested from the top two documents only.
    expect(expanded).toContain("corgi");
    expect(expanded).toContain("pixel");
    // The third document is outside maxDocs, so its terms are excluded.
    expect(expanded).not.toContain("stock");
  });

  test("excludes stopwords and query terms from the expansion", () => {
    const results = [
      scored("a", 0.9, undefined, "the user went to the park with a friend"),
    ];
    const query = "the user";
    const expanded = expandQueryWithPseudoRelevance(query, results);
    // Inspect only the harvested tail — the query is always the prefix.
    const harvested = expanded.slice(query.length).trim().split(/\s+/);
    expect(harvested).not.toContain("user"); // query term
    expect(harvested).not.toContain("the"); // stopword
    expect(harvested).not.toContain("with"); // stopword
    expect(harvested).toContain("park");
    expect(harvested).toContain("friend");
  });

  test("returns an empty string when nothing can be harvested", () => {
    const results = [scored("a", 0.9, undefined, "an it of the and")];
    expect(expandQueryWithPseudoRelevance("query", results)).toBe("");
  });

  test("returns an empty string for an empty result set", () => {
    expect(expandQueryWithPseudoRelevance("query", [])).toBe("");
  });

  test("does not let one long document dominate via raw term frequency", () => {
    // Document frequency across candidates is the ranking signal, so
    // repeating a word inside one memory cannot push it to the front.
    const results = [
      scored("a", 0.9, undefined, "alpha alpha alpha alpha alpha"),
      scored("b", 0.8, undefined, "beta"),
    ];
    const expanded = expandQueryWithPseudoRelevance("query", results, {
      maxTerms: 1,
    });
    // Both appear in exactly one document, so ordering is alphabetical
    // rather than by repetition count.
    expect(expanded).toBe("query alpha");
  });
});
