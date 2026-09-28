/**
 * Unit tests for the retrieval fusion module (src/retrieval.ts).
 *
 * The fusion logic was extracted from MemOS.hybridSearch() so it can be
 * tested in isolation — no storage, no embeddings, no MemOS instance.
 *
 * Two fusion algorithms are covered: the legacy weighted RRF rank vote
 * (`fusionMode: "rrf"`) and the round-4 default convex combination of
 * min-max normalized leg scores.
 */

import {
  fuseResults,
  harvestPrfTerms,
  mergeKeywordLegs,
  prfTokenize,
  DEFAULT_RRF_K,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_SEMANTIC_WEIGHT,
  DEFAULT_TRUST_FLOOR,
  DEFAULT_FUSION_MODE,
} from "../src/retrieval";
import type { FusionOptions, MemoryNode, ScoredMemory } from "../src/types";

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
  // Pin the legacy algorithm explicitly: the default since round 4 is
  // convex combination, and these tests assert exact RRF rank-vote math.
  const rrf = (
    keyword: ScoredMemory[],
    semantic: ScoredMemory[],
    options: FusionOptions = {},
    entityResults: ScoredMemory[] = [],
  ): ScoredMemory[] =>
    fuseResults(
      keyword,
      semantic,
      { fusionMode: "rrf", ...options },
      entityResults,
    );

  test("candidates in both legs accumulate both RRF contributions", () => {
    const keyword = [scored("a"), scored("b")];
    const semantic = [scored("a"), scored("c")];

    const fused = rrf(keyword, semantic);
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
    const fusedNoConf = rrf(keyword, semantic, {
      confidenceWeightStrength: 0,
      recencyHalfLifeMs: 0,
    });
    const byIdNoConf = new Map(fusedNoConf.map((r) => [r.node.id, r]));
    expect(byIdNoConf.get("a")!.score).toBeCloseTo(expectedA, 10);
  });

  test("output is sorted by descending hybrid score", () => {
    const fused = rrf(
      [scored("k1"), scored("k2"), scored("k3")],
      [scored("s1"), scored("k1")],
    );
    const scores = fused.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("every entry carries a scores breakdown", () => {
    const fused = rrf([scored("a")], [scored("b")]);
    for (const entry of fused) {
      expect(entry.scores).toBeDefined();
      expect(typeof entry.scores!.hybrid).toBe("number");
    }
    // Keyword-only candidate has semantic 0 / undefined-free breakdown.
    const a = fused.find((r) => r.node.id === "a")!;
    expect(a.scores!.keyword).toBeGreaterThan(0);
  });

  test("semantic-only candidates are not dropped", () => {
    const fused = rrf([scored("k")], [scored("s")]);
    const ids = fused.map((r) => r.node.id);
    expect(ids).toContain("k");
    expect(ids).toContain("s");
  });

  test("empty legs produce empty output", () => {
    expect(rrf([], [])).toEqual([]);
  });

  test("trust weighting boosts high-trust memories gently", () => {
    // Same rank in both configurations; only trust differs.
    // Confidence strength 0 isolates the trust multiplier.
    const lowTrust = rrf([scored("a", 0.9, 0.0)], [], {
      confidenceWeightStrength: 0,
    });
    const highTrust = rrf([scored("a", 0.9, 1.0)], [], {
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
    const noTrust = rrf([scored("a")], []);
    const fullTrust = rrf([scored("a", 0.9, 1.0)], []);
    expect(noTrust[0].score).toBeCloseTo(fullTrust[0].score, 10);
  });

  test("custom weights are honoured", () => {
    const fused = rrf([scored("a")], [], {
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
    const low = rrf([scored("a", 0.9, 0.0)], [], {
      trustFloor: 1.0,
      confidenceWeightStrength: 0,
    });
    const high = rrf([scored("a", 0.9, 1.0)], [], {
      trustFloor: 1.0,
      confidenceWeightStrength: 0,
    });
    expect(low[0].score).toBeCloseTo(high[0].score, 10);
  });

  test("higher-ranked candidates beat lower-ranked within a leg", () => {
    const fused = rrf(
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
      fusionMode: "rrf",
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
    // EXACT tie construction: each candidate sits at rank 1 of its own
    // leg under EQUAL leg weights. Under RRF both earn 0.5/(K+1); under
    // convex each single-candidate leg normalizes to 1.0 so both earn
    // 0.5/1.1. Either way the fused scores tie exactly and recency
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
    // candidate stays behind. Keyword-leg scores are FTS5 bm25 ranks
    // (negative: the more negative, the better the match).
    const keyword = [
      {
        node: timedNode("relevant-old", NOW - 90 * 24 * 60 * 60 * 1000),
        score: -5.0,
      },
      { node: timedNode("stale-new", NOW - 1 * 60 * 1000), score: -0.5 }, // far behind
    ];
    const fused = fuseResults(keyword, [], {
      nowMs: NOW,
      confidenceWeightStrength: 0,
    });
    expect(fused[0].node.id).toBe("relevant-old");
  });

  test("recencyHalfLifeMs=0 disables the tie-break entirely", () => {
    const fused = fuseResults(
      [{ node: timedNode("aaa-old", NOW - 60 * 60 * 1000), score: 0.9 }],
      [{ node: timedNode("zzz-new", NOW - 1 * 60 * 1000), score: 0.9 }],
      {
        nowMs: NOW,
        keywordWeight: 0.5,
        semanticWeight: 0.5,
        recencyHalfLifeMs: 0,
        confidenceWeightStrength: 0,
      },
    );
    // Exact score tie (0.5/(K+1) on both legs); with the recency tie-break
    // disabled the order falls back to the deterministic id tiebreak, so
    // "aaa-old" stays on top regardless of freshness.
    expect(fused[0].node.id).toBe("aaa-old");
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

describe("fuseResults — convex fusion (round 4 default)", () => {
  const convex = (
    keyword: ScoredMemory[],
    semantic: ScoredMemory[],
    options: FusionOptions = {},
    entityResults: ScoredMemory[] = [],
  ): ScoredMemory[] =>
    fuseResults(
      keyword,
      semantic,
      { fusionMode: "convex", ...options },
      entityResults,
    );

  // Disable the tail passes so these tests pin pure fusion math.
  const clean: FusionOptions = {
    confidenceWeightStrength: 0,
    recencyHalfLifeMs: 0,
    trustFloor: 1.0,
  };

  test("convex is the default fusion mode", () => {
    expect(DEFAULT_FUSION_MODE).toBe("convex");
    const explicit = convex([scored("a", -2.0)], [], clean);
    const implicit = fuseResults([scored("a", -2.0)], [], clean);
    expect(implicit[0].score).toBeCloseTo(explicit[0].score, 12);
  });

  test("bm25 ranks normalize inverted: more negative = better", () => {
    // FTS5 bm25 rank is negative; the more negative, the better the match.
    const fused = convex(
      [scored("best", -5.0), scored("worst", -0.5)],
      [],
      clean,
    );
    const byId = new Map(fused.map((r) => [r.node.id, r]));
    expect(byId.get("best")!.scores.keyword).toBeCloseTo(1.0, 10);
    expect(byId.get("worst")!.scores.keyword).toBeCloseTo(0.0, 10);
    expect(fused[0].node.id).toBe("best");
  });

  test("convex rewards two-leg magnitude agreement where RRF rank-votes tie", () => {
    // Keyword leg: a and b nearly tied on magnitude (a rank 1, b rank 2),
    // c far behind. Semantic leg: c runaway leader, b mid, a last.
    // RRF only sees ranks: a = 0.5/61 + 0.5/63 and c = 0.5/63 + 0.5/61 tie
    // ahead of b = 0.5/62 + 0.5/62. Convex sees magnitudes: b is the only
    // candidate strong in BOTH legs and takes the lead.
    const keyword = [scored("a", -10.0), scored("b", -9.9), scored("c", -0.1)];
    const semantic = [scored("c", 0.95), scored("b", 0.5), scored("a", 0.49)];
    const opts: FusionOptions = {
      ...clean,
      keywordWeight: 0.5,
      semanticWeight: 0.5,
    };
    const convexFused = convex(keyword, semantic, opts);
    expect(convexFused[0].node.id).toBe("b");
    const rrfFused = fuseResults(keyword, semantic, {
      ...opts,
      fusionMode: "rrf",
    });
    expect(rrfFused[0].node.id).not.toBe("b");
  });

  test("degenerate leg (all scores equal) maps to 1.0, not 0", () => {
    const fused = convex(
      [scored("a", -2.0), scored("b", -2.0)],
      [],
      clean,
    );
    for (const entry of fused) {
      expect(entry.scores.keyword).toBe(1.0);
    }
  });

  test("entity leg still adds recall under convex", () => {
    const fused = convex([], [], clean, [{ node: node("e"), score: 3 }]);
    expect(fused.map((r) => r.node.id)).toContain("e");
  });

  test("normalized leg scores stay in [0,1]", () => {
    const fused = convex(
      [scored("a", -7.3), scored("b", -0.2)],
      [scored("a", 0.99), scored("b", 0.31)],
      clean,
    );
    for (const entry of fused) {
      for (const leg of ["keyword", "semantic", "entityLeg"] as const) {
        const v = entry.scores[leg] ?? 0;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  test("empty legs produce empty output", () => {
    expect(convex([], [], clean)).toEqual([]);
  });
});

describe("fuseResults — adaptive leg weighting (round 4)", () => {
  const clean: FusionOptions = {
    fusionMode: "convex",
    confidenceWeightStrength: 0,
    trustFloor: 1.0,
  };

  test("short query boosts the keyword leg enough to flip a close contest", () => {
    // "a" leads keyword, "b" leads semantic; base weights slightly favor
    // the semantic leg so "b" wins without adaptation.
    const keyword = [scored("a", -5.0), scored("b", -4.0)];
    const semantic = [scored("b", 0.9), scored("a", 0.8)];
    const base: FusionOptions = {
      ...clean,
      keywordWeight: 0.45,
      semanticWeight: 0.55,
    };
    const longQuery = fuseResults(keyword, semantic, {
      ...base,
      query: "this is a much longer query with many words in it",
    });
    expect(longQuery[0].node.id).toBe("b");
    // Two tokens → the 1.25x keyword bump flips the contest.
    const shortQuery = fuseResults(keyword, semantic, {
      ...base,
      query: "stolen bike",
    });
    expect(shortQuery[0].node.id).toBe("a");
  });

  test("adaptiveWeighting=false disables all adaptation", () => {
    const now = 1_800_000_000_000;
    const aaa = {
      ...node("aaa-old"),
      updatedAt: now - 90 * 24 * 60 * 60 * 1000,
    };
    const zzz = { ...node("zzz-new"), updatedAt: now - 60 * 1000 };
    const keyword = [{ node: aaa, score: -2.0 }];
    const semantic = [{ node: zzz, score: 0.9 }];
    const base: FusionOptions = {
      ...clean,
      nowMs: now,
      keywordWeight: 0.5,
      semanticWeight: 0.5,
      query: "what did we discuss yesterday",
    };
    const scoreOf = (fused: ScoredMemory[], id: string) =>
      fused.find((r) => r.node.id === id)!.score;
    const adapted = fuseResults(keyword, semantic, base);
    const frozen = fuseResults(keyword, semantic, {
      ...base,
      adaptiveWeighting: false,
    });
    // The temporal nudge fires with adaptation, not without.
    expect(scoreOf(adapted, "zzz-new")).toBeGreaterThan(
      scoreOf(frozen, "zzz-new"),
    );
  });

  test("entity-dense query strengthens the entity leg", () => {
    const keyword = [scored("a", -5.0)];
    const entity = [{ node: node("z"), score: 2 }];
    const base: FusionOptions = {
      ...clean,
      keywordWeight: 0.35,
      semanticWeight: 0.2,
      entityLegWeight: 0.35,
    };
    const sparse = fuseResults(
      keyword,
      [],
      {
        ...base,
        query: "notes about the quarterly planning meeting",
        queryEntities: ["alice"],
      },
      entity,
    );
    expect(sparse[0].node.id).toBe("a");
    // Two query entities → the entity leg weight doubles (capped at 0.4)
    // and the entity-only candidate takes the lead.
    const dense = fuseResults(
      keyword,
      [],
      {
        ...base,
        query: "alice and bob meeting",
        queryEntities: ["alice", "bob"],
      },
      entity,
    );
    expect(dense[0].node.id).toBe("z");
  });

  test("temporal query applies a bounded recency multiplier", () => {
    const now = 1_800_000_000_000;
    const aaa = {
      ...node("aaa-old"),
      updatedAt: now - 90 * 24 * 60 * 60 * 1000,
    };
    const zzz = { ...node("zzz-new"), updatedAt: now - 60 * 1000 };
    // Each candidate leads its own leg under equal weights: exact tie on
    // fused relevance, so any score movement is the temporal multiplier.
    const keyword = [{ node: aaa, score: -2.0 }];
    const semantic = [{ node: zzz, score: 0.9 }];
    const base: FusionOptions = {
      ...clean,
      nowMs: now,
      keywordWeight: 0.5,
      semanticWeight: 0.5,
    };
    const scoreOf = (fused: ScoredMemory[], id: string) =>
      fused.find((r) => r.node.id === id)!.score;
    const plain = fuseResults(keyword, semantic, {
      ...base,
      query: "what did we discuss",
    });
    const temporal = fuseResults(keyword, semantic, {
      ...base,
      query: "what did we discuss yesterday",
    });
    // The multiplier is freshness-proportional: the just-updated
    // candidate gets ~the full 5%, the 90-day-old one gets
    // 5% * 0.5^(90d/30d) = 0.625%.
    const zzzLift =
      scoreOf(temporal, "zzz-new") / scoreOf(plain, "zzz-new");
    const aaaLift =
      scoreOf(temporal, "aaa-old") / scoreOf(plain, "aaa-old");
    expect(zzzLift).toBeGreaterThan(1.04);
    expect(zzzLift).toBeLessThanOrEqual(1.0500001);
    expect(aaaLift).toBeCloseTo(1.00625, 6);
    expect(zzzLift).toBeGreaterThan(aaaLift);
    // And the kill switch: strength 0 disables it entirely.
    const disabled = fuseResults(keyword, semantic, {
      ...base,
      query: "what did we discuss yesterday",
      temporalRecencyStrength: 0,
    });
    expect(scoreOf(disabled, "zzz-new")).toBeCloseTo(
      scoreOf(plain, "zzz-new"),
      12,
    );
  });

});

describe("harvestPrfTerms — RM3-lite expansion", () => {
  function hit(id: string, content: string): ScoredMemory {
    return { node: { ...node(id), content, summary: "" }, score: 0.9 };
  }

  test("harvests frequent non-query terms, most frequent first", () => {
    const hits = [
      hit("1", "the kubernetes ingress controller handles routing"),
      hit("2", "ingress configuration for the kubernetes cluster"),
    ];
    const terms = harvestPrfTerms(hits, prfTokenize("kubernetes"));
    expect(terms[0]).toBe("ingress");
    expect(terms).not.toContain("kubernetes");
  });

  test("excludes stopwords and short tokens", () => {
    const hits = [hit("1", "the what and why of it all")];
    expect(harvestPrfTerms(hits, prfTokenize("query"))).toEqual([]);
  });

  test("is deterministic and honours the cap", () => {
    const hits = [hit("1", "alpha beta gamma delta epsilon")];
    const a = harvestPrfTerms(hits, prfTokenize("query"), 2);
    const b = harvestPrfTerms(hits, prfTokenize("query"), 2);
    expect(a).toEqual(b);
    expect(a).toEqual(["alpha", "beta"]);
  });

  test("prfTokenize lowercases and drops stopwords/short tokens", () => {
    expect(prfTokenize("The Kubernetes Ingress!")).toEqual([
      "kubernetes",
      "ingress",
    ]);
  });
});

describe("mergeKeywordLegs — PRF union semantics", () => {
  test("primary order preserved; expansion-only candidates appended", () => {
    const primary = [scored("a", -5), scored("b", -4)];
    const expansion = [scored("b", -9), scored("c", -9)];
    const merged = mergeKeywordLegs(primary, expansion);
    expect(merged.map((r) => r.node.id)).toEqual(["a", "b", "c"]);
  });

  test("expansion scores never outrank a primary hit (bm25 incomparability)", () => {
    // The expansion query trivially outscores the primary on raw bm25
    // (it matches its own harvested terms); the merge must demote it
    // below every primary hit so PRF stays a recall booster, not a
    // re-ranker. bm25: lower (more negative) is better.
    const primary = [scored("a", -5), scored("b", -4)];
    const expansion = [scored("c", -50)];
    const merged = mergeKeywordLegs(primary, expansion);
    const byId = new Map(merged.map((r) => [r.node.id, r.score]));
    expect(byId.get("c")).toBeGreaterThan(byId.get("b")!);
    expect(byId.get("c")).toBeGreaterThan(byId.get("a")!);
  });

  test("empty expansion returns the primary array untouched", () => {
    const primary = [scored("a")];
    expect(mergeKeywordLegs(primary, [])).toBe(primary);
  });

  test("expansion can only add, never remove or reorder primary hits", () => {
    const primary = [scored("a", -5), scored("b", -4), scored("c", -3)];
    const expansion = [scored("c", -9), scored("b", -9), scored("a", -9), scored("d", -9)];
    const merged = mergeKeywordLegs(primary, expansion);
    expect(merged.map((r) => r.node.id)).toEqual(["a", "b", "c", "d"]);
  });
});
