/**
 * Unit tests for the shared benchmark metrics module
 * (scripts/lib/bench-metrics.ts).
 *
 * These are the deterministic retrieval metrics every benchmark uses —
 * they must be exact. All expectations are hand-computed.
 */

import {
  aggregateMetrics,
  dedupeRankedIds,
  evaluateQueryAtK,
  type EvalQueryResult,
} from "../scripts/lib/bench-metrics";

describe("dedupeRankedIds", () => {
  test("keeps first (best) position of each id", () => {
    expect(dedupeRankedIds(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("empty input stays empty", () => {
    expect(dedupeRankedIds([])).toEqual([]);
  });
});

describe("evaluateQueryAtK — single relevant item", () => {
  const r = evaluateQueryAtK(["D1:3"], ["D1:3", "x", "y"], 10);
  test("hit at rank 1: all metrics", () => {
    expect(r.hitRate).toBe(1);
    expect(r.evidenceRecall).toBe(1);
    expect(r.allEvidenceRecall).toBe(1);
    expect(r.precision).toBeCloseTo(1 / 3);
    expect(r.mrr).toBe(1);
    expect(r.ndcg).toBe(1);
  });
});

describe("evaluateQueryAtK — multi-evidence partial retrieval", () => {
  // 3 relevant; 2 retrieved at ranks 2 and 5 among 6 scored rows.
  const r = evaluateQueryAtK(
    ["A", "B", "C"],
    ["j1", "A", "j2", "j3", "B", "j4"],
    10,
  );
  test("hit but not all-evidence", () => {
    expect(r.hitRate).toBe(1);
    expect(r.evidenceRecall).toBeCloseTo(2 / 3);
    expect(r.allEvidenceRecall).toBe(0); // ← multi-evidence ≠ one hit
  });
  test("precision = relevant / scored depth", () => {
    expect(r.precision).toBeCloseTo(2 / 6);
  });
  test("mrr uses FIRST relevant rank", () => {
    expect(r.mrr).toBeCloseTo(0.5);
  });
  test("ndcg = DCG/IDCG with binary gains", () => {
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(6);
    const idcg = 1 + 1 / Math.log2(3) + 1 / Math.log2(4);
    expect(r.ndcg).toBeCloseTo(dcg / idcg);
  });
});

describe("evaluateQueryAtK — K window", () => {
  test("K=1 sees only the first row", () => {
    const r = evaluateQueryAtK(["A", "B"], ["A", "x", "B"], 1);
    expect(r.hitRate).toBe(1);
    expect(r.evidenceRecall).toBeCloseTo(0.5);
    expect(r.scoredDepth).toBe(1);
  });
});

describe("evaluateQueryAtK — no relevant retrieved", () => {
  const r = evaluateQueryAtK(["A"], ["x", "y"], 5);
  test("all zeros", () => {
    expect(r.hitRate).toBe(0);
    expect(r.evidenceRecall).toBe(0);
    expect(r.allEvidenceRecall).toBe(0);
    expect(r.precision).toBe(0);
    expect(r.mrr).toBe(0);
    expect(r.ndcg).toBe(0);
  });
});

describe("evaluateQueryAtK — question with no evidence", () => {
  test("never counts as a success", () => {
    const r = evaluateQueryAtK([], ["x"], 5);
    expect(r.hitRate).toBe(0);
    expect(r.evidenceRecall).toBe(0);
    expect(r.allEvidenceRecall).toBe(0);
  });
});

describe("aggregateMetrics", () => {
  const queries: EvalQueryResult[] = [
    {
      questionId: "q1",
      relevantIds: ["A", "B", "C"],
      retrievedIds: ["j1", "A", "j2", "j3", "B", "j4"],
      category: "multi_hop",
      latencyMs: 5,
    },
    {
      questionId: "q2",
      relevantIds: ["D1:3"],
      retrievedIds: ["D1:3", "x"],
      category: "single_hop",
      latencyMs: 15,
    },
    {
      // No evidence (LoCoMo has 4 such questions) — excluded from recall
      // metrics, never counted as a success.
      questionId: "q3",
      relevantIds: [],
      retrievedIds: ["x"],
      category: "open_domain",
      latencyMs: 100,
    },
  ];
  const report = aggregateMetrics(queries);

  test("empty-evidence questions are excluded from questionCount", () => {
    expect(report.at10.questionCount).toBe(2);
  });

  test("hit rate counts both scoreable questions", () => {
    expect(report.at10.hitRate).toBe(1);
  });

  test("evidence recall is the per-question mean", () => {
    expect(report.at10.evidenceRecall).toBeCloseTo((2 / 3 + 1) / 2);
  });

  test("micro evidence recall pools evidence across questions", () => {
    expect(report.at10.evidenceRecallMicro).toBeCloseTo(3 / 4);
  });

  test("all-evidence recall: partial multi-hop fails, single hit passes", () => {
    expect(report.at10.allEvidenceRecall).toBeCloseTo(0.5);
  });

  test("precision mean vs micro", () => {
    expect(report.at10.precision).toBeCloseTo((2 / 6 + 1 / 2) / 2);
    expect(report.at10.precisionMicro).toBeCloseTo(3 / 8);
  });

  test("mrr", () => {
    expect(report.at10.mrr).toBeCloseTo(0.75);
  });

  test("latency percentiles (nearest-rank)", () => {
    expect(report.latency.p50).toBe(15);
    expect(report.latency.p95).toBe(100);
  });

  test("per-category rows only cover scoreable categories", () => {
    expect(report.perCategory.multi_hop?.questionCount).toBe(1);
    expect(report.perCategory.single_hop?.questionCount).toBe(1);
    expect(report.perCategory.open_domain).toBeUndefined();
  });

  test("@5 window is stricter than @10", () => {
    // q1: A@2, B@5 → both in @5; q2: rank 1.
    expect(report.at5.evidenceRecall).toBeCloseTo((2 / 3 + 1) / 2);
  });

  test("duplicate retrieved ids are deduped before scoring", () => {
    const dup: EvalQueryResult[] = [
      {
        questionId: "q",
        relevantIds: ["A"],
        // Same memory retrieved twice must not double-count precision.
        retrievedIds: ["A", "A"],
        category: "single_hop",
      },
    ];
    const rep = aggregateMetrics(dup);
    expect(rep.at10.precision).toBeCloseTo(1);
    expect(rep.at10.evidenceRecall).toBe(1);
  });
});
