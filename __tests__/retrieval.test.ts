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
    // Confidence-aware ranking is DISABLED here (strength 0) so this test
    // isolates pure fusion math; see the confidence tests below.
    const expectedA =
      DEFAULT_KEYWORD_WEIGHT / (DEFAULT_RRF_K + 1) +
      DEFAULT_SEMANTIC_WEIGHT / (DEFAULT_RRF_K + 1);
    const fusedNoConf = fuseResults(keyword, semantic, {
      confidenceWeightStrength: 0,
      recencyHalfLifeMs: 0,
    });
    const byIdNoConf = new Map(fusedNoConf.map((r) => [r.node.id, r]));
    expect(byIdNoConf.get("a")!.score).toBeCloseTo(expectedA, 10);
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
    // Confidence strength 0 isolates the trust multiplier.
    const lowTrust = fuseResults([scored("a", 0.9, 0.0)], [], {
      confidenceWeightStrength: 0,
    });
    const highTrust = fuseResults([scored("a", 0.9, 1.0)], [], {
      confidenceWeightStrength: 0,
    });

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
      // Disable the confidence/recency passes so this test pins pure
      // RRF weight math.
      confidenceWeightStrength: 0,
      recencyHalfLifeMs: 0,
    });
    // rrfK=0, rank 1 → 1.0/(0+1) = 1.0; trustFloor 1.0 disables trust.
    expect(fused[0].score).toBeCloseTo(1.0, 10);
  });

  test("trustFloor=1.0 disables trust weighting entirely", () => {
    const low = fuseResults([scored("a", 0.9, 0.0)], [], {
      trustFloor: 1.0,
      confidenceWeightStrength: 0,
    });
    const high = fuseResults([scored("a", 0.9, 1.0)], [], {
      trustFloor: 1.0,
      confidenceWeightStrength: 0,
    });
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

describe("fuseResults — confidence-aware ranking (evidence state machine)", () => {
  /** Node factory with explicit confidence. */
  function confNode(id: string, confidence: number): MemoryNode {
    return {
      ...node(id),
      confidence,
      updatedAt: Date.now(),
    } as MemoryNode;
  }

  test("reinforced memory outranks a contradicted one at equal relevance", () => {
    // Two candidates at identical ranks in their legs; only the evidence
    // state differs: `good` was reinforced toward 0.95, `bad` was
    // contradicted (confidence 0 → below the CONFIDENCE_FLOOR).
    const keyword = [
      { node: confNode("good", 0.95), score: 0.9 },
      { node: confNode("bad", 0.0), score: 0.9 },
    ];
    const fused = fuseResults(keyword, []);
    expect(fused[0].node.id).toBe("good");
    // The gap must be meaningful, not a rounding artifact.
    const byId = new Map(fused.map((r) => [r.node.id, r]));
    expect(byId.get("good")!.score).toBeGreaterThan(
      byId.get("bad")!.score * 1.2,
    );
  });

  test("default confidence leaves ordering unchanged vs strength-0 run", () => {
    // A brand-new memory carries INITIAL_CONFIDENCE = 0.5; the gentle
    // default blend must not reorder two otherwise-identical memories.
    const keyword = [
      { node: confNode("x1", 0.5), score: 0.9 },
      { node: confNode("x2", 0.5), score: 0.8 },
    ];
    const withConf = fuseResults(keyword, [], { recencyHalfLifeMs: 0 });
    const withoutConf = fuseResults(keyword, [], {
      confidenceWeightStrength: 0,
      recencyHalfLifeMs: 0,
    });
    expect(withConf.map((r) => r.node.id)).toEqual(
      withoutConf.map((r) => r.node.id),
    );
  });

  test("confidenceWeightStrength=0 restores pure RRF scores exactly", () => {
    const keyword = [{ node: confNode("a", 0.0), score: 0.9 }];
    const off = fuseResults(keyword, [], {
      confidenceWeightStrength: 0,
      recencyHalfLifeMs: 0,
    });
    const expected = DEFAULT_KEYWORD_WEIGHT / (DEFAULT_RRF_K + 1);
    expect(off[0].score).toBeCloseTo(expected, 10);
  });
});

describe("fuseResults — recency tie-break", () => {
  function timedNode(id: string, updatedAt: number): MemoryNode {
    return { ...node(id), updatedAt } as MemoryNode;
  }

  const NOW = 1_800_000_000_000;

  test("fresher candidate swaps ahead within the epsilon tie window", () => {
    // EXACT tie construction: fuseResults fuses by RANK (it ignores leg
    // entry scores), so a true tie needs each candidate at rank 1 of its
    // own leg under EQUAL leg weights. Both earn 0.5/(K+1); recency
    // arbitrates — the 1-minute-old memory takes the lead.
    const fused = fuseResults(
      [{ node: timedNode("old", NOW - 60 * 60 * 1000), score: 0.9 }],
      [{ node: timedNode("new", NOW - 1 * 60 * 1000), score: 0.9 }],
      {
        nowMs: NOW,
        keywordWeight: 0.5,
        semanticWeight: 0.5,
        confidenceWeightStrength: 0,
      },
    );
    expect(fused[0].node.id).toBe("new");
  });

  test("recency never overrides a clear relevance gap", () => {
    // Adjacent ranks differ by a full RRF step (~2e-4) — three orders of
    // magnitude above the epsilon window — so the fresher but lower-ranked
    // candidate stays behind.
    const keyword = [
      {
        node: timedNode("relevant-old", NOW - 90 * 24 * 60 * 60 * 1000),
        score: 0.9,
      },
      { node: timedNode("stale-new", NOW - 1 * 60 * 1000), score: 0.8 }, // far behind
    ];
    const fused = fuseResults(keyword, [], {
      nowMs: NOW,
      confidenceWeightStrength: 0,
    });
    expect(fused[0].node.id).toBe("relevant-old");
  });

  test("recencyHalfLifeMs=0 disables the tie-break entirely", () => {
    const fused = fuseResults(
      [{ node: timedNode("old", NOW - 60 * 60 * 1000), score: 0.9 }],
      [{ node: timedNode("new", NOW - 1 * 60 * 1000), score: 0.9 }],
      {
        nowMs: NOW,
        keywordWeight: 0.5,
        semanticWeight: 0.5,
        recencyHalfLifeMs: 0,
        confidenceWeightStrength: 0,
      },
    );
    // Keyword leg is merged first, so without the tie-break the stable
    // sort keeps "old" on top.
    expect(fused[0].node.id).toBe("old");
  });

  test("older candidate trailing within epsilon does NOT jump ahead", () => {
    // The tie-break must only favor FRESHNESS: here the trailing candidate
    // is older, so it stays second even though the scores are tied.
    const keyword = [
      { node: timedNode("newer-leader", NOW - 1 * 60 * 1000), score: 0.9 },
      {
        node: timedNode("older-trailer", NOW - 90 * 24 * 60 * 60 * 1000),
        score: 0.9,
      },
    ];
    const fused = fuseResults(keyword, [], {
      nowMs: NOW,
      confidenceWeightStrength: 0,
    });
    expect(fused.map((r) => r.node.id)).toEqual([
      "newer-leader",
      "older-trailer",
    ]);
  });
});
