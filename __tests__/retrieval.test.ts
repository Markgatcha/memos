/**
 * Unit tests for the RRF retrieval fusion module (src/retrieval.ts).
 *
 * The fusion logic was extracted from MemOS.hybridSearch() so it can be
 * tested in isolation — no storage, no embeddings, no MemOS instance.
 */

import {
  fuseResults,
  DEFAULT_RRF_K,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_SEMANTIC_WEIGHT,
  DEFAULT_TRUST_FLOOR,
} from "../src/retrieval";
import type { MemoryNode, ScoredMemory } from "../src/types";

/** Minimal MemoryNode factory for fusion tests. */
function node(id: string, trustScore?: number): MemoryNode {
  return {
    id,
    content: `content of ${id}`,
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
    trustScore,
    confidence: 0.5,
  } as MemoryNode;
}

function scored(id: string, score = 0.9, trustScore?: number): ScoredMemory {
  return { node: node(id, trustScore), score };
}

describe("fuseResults — RRF fusion", () => {
  test("candidates in both legs accumulate both RRF contributions", () => {
    const keyword = [scored("a"), scored("b")];
    const semantic = [scored("a"), scored("c")];

    const fused = fuseResults(keyword, semantic);
    const byId = new Map(fused.map((r) => [r.node.id, r]));

    // "a" appears in both legs → highest score.
    expect(byId.get("a")!.score).toBeGreaterThan(byId.get("b")!.score);
    expect(byId.get("a")!.score).toBeGreaterThan(byId.get("c")!.score);

    // Exact RRF math: a = 0.8/(60+1) + 0.2/(60+1)
    const expectedA =
      DEFAULT_KEYWORD_WEIGHT / (DEFAULT_RRF_K + 1) +
      DEFAULT_SEMANTIC_WEIGHT / (DEFAULT_RRF_K + 1);
    expect(byId.get("a")!.score).toBeCloseTo(expectedA, 10);
  });

  test("output is sorted by descending hybrid score", () => {
    const fused = fuseResults(
      [scored("k1"), scored("k2"), scored("k3")],
      [scored("s1"), scored("k1")],
    );
    const scores = fused.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("every entry carries a scores breakdown", () => {
    const fused = fuseResults([scored("a")], [scored("b")]);
    for (const entry of fused) {
      expect(entry.scores).toBeDefined();
      expect(typeof entry.scores!.hybrid).toBe("number");
    }
    // Keyword-only candidate has semantic 0 / undefined-free breakdown.
    const a = fused.find((r) => r.node.id === "a")!;
    expect(a.scores!.keyword).toBeGreaterThan(0);
  });

  test("semantic-only candidates are not dropped", () => {
    const fused = fuseResults([scored("k")], [scored("s")]);
    const ids = fused.map((r) => r.node.id);
    expect(ids).toContain("k");
    expect(ids).toContain("s");
  });

  test("empty legs produce empty output", () => {
    expect(fuseResults([], [])).toEqual([]);
  });

  test("trust weighting boosts high-trust memories gently", () => {
    // Same rank in both configurations; only trust differs.
    const lowTrust = fuseResults([scored("a", 0.9, 0.0)], []);
    const highTrust = fuseResults([scored("a", 0.9, 1.0)], []);

    const low = lowTrust[0].score;
    const high = highTrust[0].score;

    // trustScore 0 → multiplier = trustFloor (0.7); trustScore 1 → 1.0.
    expect(high).toBeGreaterThan(low);
    expect(low / high).toBeCloseTo(DEFAULT_TRUST_FLOOR, 10);
    // The boost is bounded: never more than 1/trustFloor ratio.
    expect(high / low).toBeLessThan(1 / DEFAULT_TRUST_FLOOR + 1e-9);
  });

  test("trustScore defaults to 1.0 when absent", () => {
    const noTrust = fuseResults([scored("a")], []);
    const fullTrust = fuseResults([scored("a", 0.9, 1.0)], []);
    expect(noTrust[0].score).toBeCloseTo(fullTrust[0].score, 10);
  });

  test("custom weights are honoured", () => {
    const fused = fuseResults([scored("a")], [], {
      keywordWeight: 1.0,
      semanticWeight: 0,
      rrfK: 0,
      trustFloor: 1.0,
    });
    // rrfK=0, rank 1 → 1.0/(0+1) = 1.0; trustFloor 1.0 disables trust.
    expect(fused[0].score).toBeCloseTo(1.0, 10);
  });

  test("trustFloor=1.0 disables trust weighting entirely", () => {
    const low = fuseResults([scored("a", 0.9, 0.0)], [], { trustFloor: 1.0 });
    const high = fuseResults([scored("a", 0.9, 1.0)], [], { trustFloor: 1.0 });
    expect(low[0].score).toBeCloseTo(high[0].score, 10);
  });

  test("higher-ranked candidates beat lower-ranked within a leg", () => {
    const fused = fuseResults(
      [scored("first"), scored("second"), scored("third")],
      [],
    );
    expect(fused.map((r) => r.node.id)).toEqual(["first", "second", "third"]);
  });
});
