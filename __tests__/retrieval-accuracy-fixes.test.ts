/**
 * Regression tests for two retrieval accuracy bugs.
 *
 * 1. ABSTENTION WAS DEAD CODE UNDER CONVEX FUSION (the default mode).
 *    `convexFuse` stores the min-max-normalized leg score in
 *    `scores.semantic`, and min-max maps a leg's best candidate to
 *    exactly `1`. `shouldAbstain` read that field expecting a raw cosine
 *    to compare against `abstainBelowSimilarity`, so `max >= floor` was
 *    always true and the gate could never abstain — while still
 *    reporting `abstained: false`. Verified: raw cosines 0.06 / 0.05
 *    produced `scores.semantic === [1, 0]` and `shouldAbstain === false`;
 *    the same input under `fusionMode: "rrf"` correctly returned `true`.
 *
 * 2. THE ENTITY LEG LEAKED OUT-OF-SCOPE MEMORIES. `fetchEntityLeg`
 *    checked `filter.namespace` and `filter.namespacePrefix` but not
 *    `filter.namespaces` (the plural OR-list) that `queryNodes` honors,
 *    so a `namespaces: ["project:alpha"]` query also returned
 *    `project:beta` rows that entered via the entity leg.
 *
 * The first suite is pure (no storage / embeddings); the second is
 * end-to-end against a real SQLite `MemOS` instance, mirroring the
 * harness in `__tests__/entity-index.test.ts`.
 */

import {
  fuseResults,
  shouldAbstain,
  applyRelevanceGate,
  DEFAULT_ABSTAIN_SIMILARITY,
  DEFAULT_FUSION_MODE,
} from "../src/retrieval";
import { SQLiteStorage } from "../src/storage/sqlite";
import { MemOS } from "../src/memory";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  MemoryNode,
  ScoredMemory,
} from "../src/types";

/** Minimal MemoryNode factory — convex fusion only reads score fields. */
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

/**
 * Semantic-leg candidate carrying a RAW cosine. The text deliberately
 * shares no token with the query so the literal-term-match escape hatch
 * cannot rescue these results — the abstention decision must come from
 * the cosine floor alone.
 */
function semanticHit(id: string, cosine: number): ScoredMemory {
  return {
    node: node(id, `unrelated prose number ${id}`),
    score: cosine,
    scores: { semantic: cosine },
  };
}

const FLOOR = DEFAULT_ABSTAIN_SIMILARITY; // 0.3
const QUERY = "kubernetes ingress controller";

/** Gate options as a caller enabling `retrieval.relevanceGate` would set. */
const GATE = { abstainBelowSimilarity: FLOOR };

describe("shouldAbstain — convex fusion (default mode)", () => {
  test("convex is the default fusion mode", () => {
    // Pins the premise of this whole suite: the bug only existed on the
    // default path. If the default ever changes, this fails loudly.
    expect(DEFAULT_FUSION_MODE).toBe("convex");
  });

  test("fires when every raw cosine is below the floor", () => {
    // Both cosines are far below 0.3 — the store has nothing about the
    // query, so the honest answer is "no memories".
    const fused = fuseResults(
      [],
      [semanticHit("a", 0.06), semanticHit("b", 0.05)],
      {}, // default = convex
      [],
    );
    expect(fused.length).toBe(2);
    // Sanity: the normalized breakdown still maps the top hit to 1.0 —
    // that is correct fusion behaviour and must not change.
    expect(fused[0]!.scores!.semantic).toBe(1);
    expect(fused[1]!.scores!.semantic).toBe(0);
    // The raw cosine survives alongside it, on the embedder's scale.
    expect(fused[0]!.scores!.semanticRaw).toBeCloseTo(0.06, 10);
    expect(fused[1]!.scores!.semanticRaw).toBeCloseTo(0.05, 10);

    expect(shouldAbstain(fused, QUERY, GATE)).toBe(true);
  });

  test("fires through applyRelevanceGate, emptying the result list", () => {
    const fused = fuseResults(
      [],
      [semanticHit("a", 0.02), semanticHit("b", 0.01)],
      {},
      [],
    );
    expect(applyRelevanceGate(fused, QUERY, GATE)).toEqual([]);
  });

  test("fires when the floor is configured above the raw cosine band", () => {
    // A stricter floor (an embedder whose paraphrase matches start at
    // 0.7) must abstain on genuinely-mid-band matches too.
    const fused = fuseResults([], [semanticHit("a", 0.45)], {}, []);
    expect(shouldAbstain(fused, QUERY, { abstainBelowSimilarity: 0.7 })).toBe(
      true,
    );
  });

  test("does NOT fire for a genuinely relevant top hit", () => {
    // One clear match above the floor, one irrelevant tail. The
    // normalization bug made the tail candidate look identical to the
    // head after min-max, so this also guards against over-abstaining.
    const fused = fuseResults(
      [],
      [semanticHit("strong", 0.82), semanticHit("weak", 0.09)],
      {},
      [],
    );
    expect(fused[0]!.scores!.semanticRaw).toBeCloseTo(0.82, 10);
    expect(shouldAbstain(fused, QUERY, GATE)).toBe(false);
  });

  test("does NOT fire at exactly the floor (comparison is >=)", () => {
    const fused = fuseResults([], [semanticHit("edge", FLOOR)], {}, []);
    expect(shouldAbstain(fused, QUERY, GATE)).toBe(false);
  });

  test("a candidate that only appears in a non-normalized position keeps its raw cosine", () => {
    // The candidate is retrieved by BOTH legs: convex merges it through
    // the `existing` branch of addLeg, not the fresh-insert branch. The
    // raw cosine must survive that path too (it was written by both).
    const merged = {
      node: node("m", "unrelated prose number m"),
      score: -3.0,
      scores: { keyword: 1 },
    } as ScoredMemory;
    const fused = fuseResults([merged], [semanticHit("m", 0.04)], {}, []);
    const hit = fused.find((r) => r.node.id === "m")!;
    expect(hit.scores!.semantic).toBe(1); // normalized: sole semantic hit
    expect(hit.scores!.semanticRaw).toBeCloseTo(0.04, 10);
    expect(shouldAbstain(fused, QUERY, GATE)).toBe(true);
  });

  test("RRF mode abstains identically (both modes expose semanticRaw)", () => {
    const fused = fuseResults(
      [],
      [semanticHit("a", 0.06), semanticHit("b", 0.05)],
      { fusionMode: "rrf" },
      [],
    );
    // RRF already stored the raw value in `semantic`; it is now mirrored.
    expect(fused[0]!.scores!.semanticRaw).toBeCloseTo(0.06, 10);
    expect(shouldAbstain(fused, QUERY, GATE)).toBe(true);
  });

  test("keyword-only retrieval still never abstains", () => {
    // No embedding signal anywhere: similarity cannot be judged, so the
    // gate must stay silent rather than guess from absent data.
    const fused = fuseResults(
      [{ node: node("k", "prose"), score: -4 }],
      [],
      {},
    );
    expect(shouldAbstain(fused, QUERY, GATE)).toBe(false);
  });

  test("a literal term match still rescues a low-cosine bullseye", () => {
    const fused = fuseResults([], [semanticHit("bullseye", 0.01)], {}, []);
    const withTerm = fused.map((r) => ({
      ...r,
      node: { ...r.node, content: "we talked about Kubernetes today" },
    }));
    expect(shouldAbstain(withTerm, QUERY, GATE)).toBe(false);
  });

  test("hand-built results without semanticRaw fall back to semantic", () => {
    // Backward compatibility: callers that construct `ScoredMemory`
    // themselves only set `semantic`. The floor must still work there.
    const legacy: ScoredMemory[] = [
      { node: node("a", "prose"), score: 0.5, scores: { semantic: 0.11 } },
    ];
    expect(shouldAbstain(legacy, QUERY, GATE)).toBe(true);
    const relevant: ScoredMemory[] = [
      { node: node("a", "prose"), score: 0.5, scores: { semantic: 0.7 } },
    ];
    expect(shouldAbstain(relevant, QUERY, GATE)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Entity leg scope filtering (end to end)
 * ------------------------------------------------------------------ */

/** Deterministic stub embedder: avoids the ONNX runtime in CI. */
class StubEmbedder implements EmbeddingProvider {
  public readonly id = "stub";
  public readonly model = "stub-v1";
  public readonly dimensions = 4;
  async embed(_text: string): Promise<EmbeddingVector> {
    return [0, 0, 0, 0];
  }
}

async function makeMemos(): Promise<MemOS> {
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider: new StubEmbedder() },
    embeddingQueue: { synchronous: true },
  });
  await memos.init();
  return memos;
}

/**
 * Seeds one memory per namespace, all sharing the `postgres` entity.
 * The stub embedder maps every text to the zero vector (cosine 0, so the
 * semantic leg is empty) and the stored text shares no token with the
 * query (so the keyword leg is empty) — the ONLY leg that can recall
 * these rows is the entity leg, which is exactly where the leak lived.
 */
async function seedTwoNamespaces(memos: MemOS): Promise<void> {
  await memos.store("The team runs Postgres for the billing service", {
    namespace: "project:alpha",
  });
  await memos.store("The team runs Postgres for the reporting service", {
    namespace: "project:beta",
  });
}

describe("fetchEntityLeg — namespace scoping", () => {
  test("honors the plural namespaces filter (no cross-scope leak)", async () => {
    const memos = await makeMemos();
    try {
      await seedTwoNamespaces(memos);

      const results = await memos.search({
        query: "PG tuning",
        namespaces: ["project:alpha"],
        includeSharedScope: false,
        limit: 20,
      });

      // Control: the leak really did put a beta row in this set. If the
      // bug regresses, this set is non-empty and the assertions below
      // fail with the offending namespace named in the diff.
      const namespaces = results.map((r) => r.node.namespace);
      expect(namespaces).not.toContain("project:beta");
      expect(namespaces.every((ns) => ns === "project:alpha")).toBe(true);
      // And the alpha row is genuinely present — the fix narrows the
      // leg, it must not empty it.
      expect(results.length).toBeGreaterThan(0);
      expect(namespaces).toContain("project:alpha");
      expect(results[0]!.scores!.entityLeg).toBe(1);
    } finally {
      await memos.close();
    }
  });

  test("the entity leg is the leg that would have leaked", async () => {
    // Proves the harness above is actually exercising fetchEntityLeg:
    // querying both namespaces returns both rows, so the beta row is
    // reachable — the singular alpha query above is what must exclude it.
    const memos = await makeMemos();
    try {
      await seedTwoNamespaces(memos);
      const both = await memos.search({
        query: "PG tuning",
        namespaces: ["project:alpha", "project:beta"],
        includeSharedScope: false,
        limit: 20,
      });
      const namespaces = both.map((r) => r.node.namespace);
      expect(namespaces).toContain("project:alpha");
      expect(namespaces).toContain("project:beta");
      for (const r of both) {
        expect(r.scores!.entityLeg).toBe(1);
      }
    } finally {
      await memos.close();
    }
  });

  test("the singular namespace filter is still respected", async () => {
    // The pre-existing (working) constraint must not regress.
    const memos = await makeMemos();
    try {
      await seedTwoNamespaces(memos);
      const results = await memos.search({
        query: "PG tuning",
        namespace: "project:alpha",
        includeSharedScope: false,
        limit: 20,
      });
      const namespaces = results.map((r) => r.node.namespace);
      expect(namespaces).toContain("project:alpha");
      expect(namespaces).not.toContain("project:beta");
    } finally {
      await memos.close();
    }
  });

  test("the hierarchical prefix filter is still respected", async () => {
    // The other pre-existing constraint: `project:` must match both
    // children, a sibling scope must not.
    const memos = await makeMemos();
    try {
      await seedTwoNamespaces(memos);
      await memos.store("The team runs Postgres for the sales service", {
        namespace: "internal",
      });
      const results = await memos.search({
        query: "PG tuning",
        namespacePrefix: "project:",
        includeSharedScope: false,
        limit: 20,
      });
      const namespaces = results.map((r) => r.node.namespace);
      expect(namespaces).toContain("project:alpha");
      expect(namespaces).toContain("project:beta");
      expect(namespaces).not.toContain("internal");
    } finally {
      await memos.close();
    }
  });

  test("an unscoped search is untouched by the namespace predicate", async () => {
    const memos = await makeMemos();
    try {
      await seedTwoNamespaces(memos);
      const results = await memos.search({
        query: "PG tuning",
        limit: 20,
      });
      const namespaces = results.map((r) => r.node.namespace);
      expect(namespaces).toContain("project:alpha");
      expect(namespaces).toContain("project:beta");
    } finally {
      await memos.close();
    }
  });
});
