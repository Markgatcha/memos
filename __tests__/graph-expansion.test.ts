/**
 * Tests for the PPR-lite graph expansion (accuracy research item 5):
 *   - `personalizedPageRank` on small synthetic graphs (pure, deterministic)
 *   - integration: post-fusion PPR blend inside hybrid search
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";
import {
  personalizedPageRank,
  DEFAULT_PPR_DAMPING,
} from "../src/graph-expansion";

/** Embeds [1,0] when the text contains the marker word, else [0,1]. */
class MarkerProvider implements EmbeddingProvider {
  public readonly id = "marker";
  public readonly model = "marker-v1";
  public readonly dimensions = 2;

  async embed(text: string): Promise<EmbeddingVector> {
    return text.includes("zebra") ? [1, 0] : [0, 1];
  }
}

function neighborsOf(
  adjacency: Record<string, string[]>,
): (id: string) => string[] {
  return (id: string) => adjacency[id] ?? [];
}

describe("personalizedPageRank", () => {
  test("chain A-B-C seeded at A ranks B above C and keeps the seed", () => {
    const scores = personalizedPageRank(
      new Map([["A", 2.0]]),
      neighborsOf({ A: ["B"], B: ["A", "C"], C: ["B"] }),
    );
    // Passage (seed) nodes are kept: the seed itself has a non-zero score.
    expect(scores.get("A")).toBeGreaterThan(0);
    expect(scores.get("B")).toBeGreaterThan(scores.get("C")!);
    expect(scores.get("C")).toBeGreaterThan(0);
    // Hand-verified fixed point (damping 0.5): A=7/12, B=1/3, C=1/12.
    expect(scores.get("A")).toBeCloseTo(7 / 12, 6);
    expect(scores.get("B")).toBeCloseTo(1 / 3, 6);
    expect(scores.get("C")).toBeCloseTo(1 / 12, 6);
    // Stochastic: rank mass is conserved.
    const total = [...scores.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  test("star: center outranks the other leaves when seeded at a leaf", () => {
    const adjacency = {
      O: ["L1", "L2", "L3", "L4"],
      L1: ["O"],
      L2: ["O"],
      L3: ["O"],
      L4: ["O"],
    };
    const scores = personalizedPageRank(
      new Map([["L1", 1]]),
      neighborsOf(adjacency),
    );
    expect(scores.get("O")).toBeGreaterThan(scores.get("L2")!);
    expect(scores.get("O")).toBeCloseTo(1 / 3, 6);
    expect(scores.get("L2")).toBeCloseTo(1 / 24, 6);
    // The seed leaf keeps the most mass.
    expect(scores.get("L1")).toBeGreaterThan(scores.get("O")!);
  });

  test("damping 0.5 respected: single iteration matches hand computation", () => {
    // Two mutually linked nodes, seed A with score 1, one power iteration
    // from the personalization vector: A passes 0.5 * 1 along its edge to
    // B, and 0.5 teleports back to A.
    const scores = personalizedPageRank(
      new Map([["A", 1]]),
      neighborsOf({ A: ["B"], B: ["A"] }),
      { maxIterations: 1 },
    );
    expect(DEFAULT_PPR_DAMPING).toBe(0.5);
    expect(scores.get("A")).toBeCloseTo(0.5, 10);
    expect(scores.get("B")).toBeCloseTo(0.5, 10);
  });

  test("maxHops bounds the explored neighbourhood", () => {
    const adjacency = {
      A: ["B"],
      B: ["A", "C"],
      C: ["B", "D"],
      D: ["C"],
    };
    const twoHops = personalizedPageRank(
      new Map([["A", 1]]),
      neighborsOf(adjacency),
      { maxHops: 2 },
    );
    expect(twoHops.has("C")).toBe(true);
    expect(twoHops.has("D")).toBe(false);

    const threeHops = personalizedPageRank(
      new Map([["A", 1]]),
      neighborsOf(adjacency),
      { maxHops: 3 },
    );
    expect(threeHops.has("D")).toBe(true);
    expect(threeHops.get("D")).toBeGreaterThan(0);
  });

  test("maxFanout caps per-node neighbours deterministically", () => {
    const adjacency = {
      O: ["L3", "L1", "L2"], // deliberately unsorted
      L1: ["O"],
      L2: ["O"],
      L3: ["O"],
    };
    const scores = personalizedPageRank(
      new Map([["O", 1]]),
      neighborsOf(adjacency),
      { maxFanout: 1 },
    );
    // Sorted first neighbour wins the single fan-out slot.
    expect(scores.has("L1")).toBe(true);
    expect(scores.has("L2")).toBe(false);
    expect(scores.has("L3")).toBe(false);
  });

  test("all-zero seed scores fall back to a uniform restart", () => {
    const scores = personalizedPageRank(
      new Map([
        ["A", 0],
        ["B", -1],
      ]),
      neighborsOf({ A: ["B"], B: ["A"] }),
    );
    expect(scores.get("A")).toBeCloseTo(scores.get("B")!, 10);
    expect(scores.get("A")).toBeGreaterThan(0);
  });

  test("empty seeds produce an empty score map", () => {
    expect(
      personalizedPageRank(new Map(), neighborsOf({ A: ["B"] })).size,
    ).toBe(0);
  });

  test("deterministic across runs regardless of adjacency order", () => {
    const run = (adjacency: Record<string, string[]>) =>
      personalizedPageRank(new Map([["A", 1]]), neighborsOf(adjacency));
    const first = run({ A: ["B", "C"], B: ["A", "C"], C: ["A", "B"] });
    const second = run({ A: ["C", "B"], B: ["C", "A"], C: ["B", "A"] });
    expect([...second.entries()]).toEqual([...first.entries()]);
  });
});

describe("hybridSearch PPR-lite graph expansion", () => {
  function makeMemos(fusion?: Record<string, unknown>): MemOS {
    return new MemOS({
      storage: new SQLiteStorage(":memory:", true),
      experimental: { semanticSearch: true, namespaces: true },
      embeddings: { enabled: true, provider: new MarkerProvider() },
      ...(fusion ? { fusion } : {}),
    });
  }

  /**
   * Chain A - B - C where only A matches the query "zebra": B and C are
   * invisible to both the keyword leg (no shared terms) and the semantic
   * leg (MarkerProvider gives them cosine 0, below the fusion threshold).
   */
  async function searchChain(
    fusion?: Record<string, unknown>,
    extraFilter: Record<string, unknown> = {},
  ) {
    // Re-seed per config: MemOS takes `fusion` at construction time.
    const memos = makeMemos(fusion);
    await memos.init();
    const a = await memos.store("zebra migration patterns");
    const b = await memos.store("savanna rainfall statistics");
    const c = await memos.store("river crossing seasons");
    await memos.link(a.node.id, b.node.id);
    await memos.link(b.node.id, c.node.id);
    const results = await memos.search({
      query: "zebra",
      limit: 5,
      ...extraFilter,
    });
    await memos.close();
    return { results, a: a.node.id, b: b.node.id, c: c.node.id };
  }

  test("graphExpansion:false is byte-identical to the pre-expansion pipeline", async () => {
    const { results, a } = await searchChain({ graphExpansion: false });
    // Only the fused hit survives: no neighbour injection, no PPR scores.
    expect(results).toHaveLength(1);
    expect(results[0]!.node.id).toBe(a);
    for (const r of results) {
      expect(r.scores?.ppr).toBeUndefined();
    }
  });

  test("default-on: a graph neighbour of a seed enters the results", async () => {
    const { results, a, b } = await searchChain();
    const ids = results.map((r) => r.node.id);
    expect(ids[0]).toBe(a);
    expect(ids).toContain(b);
    const injected = results.find((r) => r.node.id === b)!;
    // Injected neighbours carry their normalized PPR score; their final
    // score is alpha * pprNorm (no fused contribution).
    expect(injected.scores?.ppr).toBeGreaterThan(0);
    expect(injected.score).toBeCloseTo(0.2 * injected.scores!.ppr!, 10);
  });

  test("blend formula: (1 - alpha) * fused + alpha * pprNorm", async () => {
    const baseline = await searchChain({ graphExpansion: false });
    const expanded = await searchChain();
    const fusedScore = baseline.results[0]!.score;
    const head = expanded.results[0]!;
    expect(head.node.id).toBe(expanded.a);
    // The top seed has the maximum PPR score, so pprNorm == 1.
    expect(head.scores?.ppr).toBeCloseTo(1, 10);
    expect(head.score).toBeCloseTo(0.8 * fusedScore + 0.2 * 1, 10);
  });

  test("graphExpansionHops: 1-hop reaches B only, 2-hop reaches C", async () => {
    const one = await searchChain({ graphExpansionHops: 1 });
    expect(one.results.map((r) => r.node.id)).toEqual([one.a, one.b]);

    const two = await searchChain({ graphExpansionHops: 2 });
    expect(two.results.map((r) => r.node.id)).toEqual([two.a, two.b, two.c]);
    const cResult = two.results.find((r) => r.node.id === two.c)!;
    expect(cResult.scores?.ppr).toBeGreaterThan(0);
  });

  test("graphExpansionAlpha: 0 disables blending cleanly", async () => {
    const { results, a } = await searchChain({ graphExpansionAlpha: 0 });
    expect(results).toHaveLength(1);
    expect(results[0]!.node.id).toBe(a);
    expect(results[0]!.scores?.ppr).toBeUndefined();
  });

  test("per-query graphExpansion:false disables expansion for one search", async () => {
    const { results, a } = await searchChain(undefined, {
      graphExpansion: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.node.id).toBe(a);
    for (const r of results) {
      expect(r.scores?.ppr).toBeUndefined();
    }
  });

  test("structured filters apply to injected neighbours (no cross-type leak)", async () => {
    const memos = makeMemos();
    await memos.init();
    const a = await memos.store("zebra migration patterns", { type: "fact" });
    const b = await memos.store("savanna rainfall statistics", {
      type: "preference",
    });
    await memos.link(a.node.id, b.node.id);

    // Without the filter the linked neighbour is injected (recall win).
    const unfiltered = await memos.search({ query: "zebra", limit: 5 });
    expect(unfiltered.map((r) => r.node.id)).toContain(b.node.id);

    // With a type filter the neighbour must not leak across the boundary
    // that the SQL legs enforce at scan time.
    const filtered = await memos.search({
      query: "zebra",
      limit: 5,
      type: "fact",
    });
    expect(filtered.map((r) => r.node.id)).not.toContain(b.node.id);
    expect(filtered.map((r) => r.node.id)).toContain(a.node.id);
    await memos.close();
  });

  test("expansion is deterministic across identical instances", async () => {
    const first = await searchChain();
    const second = await searchChain();
    // Node ids are random per instance; compare length + scores only.
    expect(second.results).toHaveLength(first.results.length);
    expect(second.results.map((r) => r.score)).toEqual(
      first.results.map((r) => r.score),
    );
  });
});
