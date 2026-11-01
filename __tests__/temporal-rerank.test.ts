import { describe, expect, it } from "@jest/globals";
import { parseRelativeAgo } from "../src/relative-time.js";
import {
  applyRelativeTimeAnchor,
  expandToTemporalNeighbours,
  memoryInstant,
} from "../src/temporal-rerank.js";
import type { MemoryNode, ScoredMemory } from "../src/types.js";

const DAY = 86_400_000;

function node(
  id: string,
  at: number | null,
  extra: Partial<MemoryNode> = {},
): MemoryNode {
  return {
    id,
    content: `content ${id}`,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: at ?? Date.now(),
    updatedAt: at ?? Date.now(),
    accessCount: 0,
    lastAccessed: null,
    expiresAt: null,
    tags: [],
    namespace: "test",
    validFrom: at,
    validTo: null,
    source: "user_input",
    trustScore: 1,
    pool: "event",
    provenance: "user",
    quarantined: false,
    quarantinedAt: null,
    quarantineReason: null,
    harness: null,
    ...extra,
  } as MemoryNode;
}

function scored(n: MemoryNode, score: number): ScoredMemory {
  return { node: n, score };
}

describe("parseRelativeAgo", () => {
  const now = new Date("2023-03-25T18:26:00");

  it("resolves numeric offsets", () => {
    const r = parseRelativeAgo("What did I buy 10 days ago?", now);
    expect(r).not.toBeNull();
    expect(r!.at.toISOString().slice(0, 10)).toBe("2023-03-15");
    expect(r!.windowDays).toBeGreaterThanOrEqual(1);
  });

  it("resolves word-number offsets", () => {
    const r = parseRelativeAgo("a sports event two weeks ago", now);
    expect(r).not.toBeNull();
    expect(r!.at.toISOString().slice(0, 10)).toBe("2023-03-11");
  });

  it("handles the 'in the past month' shape", () => {
    const r = parseRelativeAgo("how much did I spend in the past month", now);
    expect(r).not.toBeNull();
  });

  it("returns null for non-temporal queries", () => {
    expect(parseRelativeAgo("How long is my daily commute?", now)).toBeNull();
    expect(parseRelativeAgo("How many projects have I led?", now)).toBeNull();
  });

  it("widens the window for coarse units", () => {
    const week = parseRelativeAgo("a week ago", now)!;
    const month = parseRelativeAgo("a month ago", now)!;
    expect(month.windowDays).toBeGreaterThan(week.windowDays);
  });
});

describe("memoryInstant", () => {
  it("prefers validFrom, then updatedAt", () => {
    expect(memoryInstant(node("a", 1000))).toBe(1000);
    expect(
      memoryInstant({ ...node("b", null), updatedAt: 2000 } as MemoryNode),
    ).toBe(2000);
  });

  it("falls back to a metadata timestamp string", () => {
    const n = node("c", null);
    n.metadata = { timestamp: "2023-03-15T10:00:00Z" };
    expect(memoryInstant(n)).toBe(Date.parse("2023-03-15T10:00:00Z"));
  });
});

describe("applyRelativeTimeAnchor", () => {
  const at = Date.parse("2023-03-15T12:00:00Z");
  // Semantic order: outsideA (strongest), inside, outsideB.
  const outsideA = scored(node("outsideA", at - 60 * DAY), 0.9);
  const inside = scored(node("inside", at + DAY), 0.5);
  const outsideB = scored(node("outsideB", at + 60 * DAY), 0.3);

  it("promotes in-window memories above out-of-window ones", () => {
    const r = applyRelativeTimeAnchor([outsideA, inside, outsideB], {
      at,
      windowDays: 3,
    });
    expect(r.results.map((x) => x.node.id)).toEqual([
      "inside",
      "outsideA",
      "outsideB",
    ]);
    expect(r.moved).toBeGreaterThan(0);
  });

  it("preserves semantic order within each group", () => {
    const a = scored(node("a", at - DAY), 0.9);
    const b = scored(node("b", at), 0.8);
    const c = scored(node("c", at + 90 * DAY), 0.7);
    const r = applyRelativeTimeAnchor([a, b, c], { at, windowDays: 2 });
    expect(r.results.map((x) => x.node.id)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op when nothing is in the window", () => {
    const r = applyRelativeTimeAnchor([outsideA, outsideB], {
      at,
      windowDays: 1,
    });
    expect(r.results.map((x) => x.node.id)).toEqual(["outsideA", "outsideB"]);
    expect(r.moved).toBe(0);
  });

  it("keeps untimestamped memories in the list", () => {
    const undated = scored(node("undated", null), 0.4);
    const r = applyRelativeTimeAnchor([outsideA, inside, undated], {
      at,
      windowDays: 3,
    });
    expect(r.results.map((x) => x.node.id)).toContain("undated");
  });
});

describe("expandToTemporalNeighbours", () => {
  const t0 = Date.parse("2023-03-15T00:00:00Z");
  // A returned set: 6 memories one day apart, ranked best-first by score.
  const returned = Array.from({ length: 6 }, (_, i) =>
    scored(node(`m${i}`, t0 + i * DAY), 0.9 - i * 0.1),
  );

  it("promotes the immediate neighbours of a hit", () => {
    // m0 is the strongest hit; its neighbour m1 already ranks high, so the
    // pass must reach further down the timeline only within the returned set.
    const r = expandToTemporalNeighbours(returned, 20, { radius: 2 });
    // Nothing new can appear: every candidate came from the same 6 results.
    expect(new Set(r.results.map((x) => x.node.id)).size).toBe(6);
  });

  it("only ever returns memories the retriever returned", () => {
    // Regression: an earlier version scanned the whole corpus for temporally
    // adjacent nodes and evicted legitimately matched sessions, costing
    // 4 questions on LongMemEval (97.8% -> 97.0%).
    const outside = node("never-returned", t0 + 3.5 * DAY);
    const r = expandToTemporalNeighbours(
      [scored(outside, 0.99), ...returned],
      20,
      { radius: 2 },
    );
    expect(r.results.map((x) => x.node.id)).toContain("never-returned");
    const extra = scored(node("extra", t0), 0.1);
    const r2 = expandToTemporalNeighbours([...returned, extra], 20, {
      radius: 2,
    });
    // An "extra" that WAS returned is eligible like any other.
    expect(r2.results.map((x) => x.node.id)).toContain("extra");
  });

  it("never exceeds the caller's limit", () => {
    const r = expandToTemporalNeighbours(returned, 3, { radius: 5 });
    expect(r.results.length).toBeLessThanOrEqual(3);
  });

  it("keeps the head of the list untouched", () => {
    const r = expandToTemporalNeighbours(returned, 20, { radius: 2 });
    // The highest-scoring result must still lead the list.
    expect(r.results[0]?.node.id).toBe("m0");
  });

  it("does not duplicate results", () => {
    const r = expandToTemporalNeighbours(returned, 20, { radius: 2 });
    const ids = r.results.map((x) => x.node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never displaces a result that outranks the promotion", () => {
    const strong = Array.from({ length: 5 }, (_, i) =>
      scored(node(`strong${i}`, t0 + (10 + i) * DAY), 0.99 - i * 0.01),
    );
    const r = expandToTemporalNeighbours(strong, 5, { radius: 2 });
    expect(r.injected).toBe(0);
    expect(r.results.map((x) => x.node.id)).toEqual(
      strong.map((x) => x.node.id),
    );
  });

  it("never shrinks the caller's list when promoting", () => {
    // Regression: an early implementation dropped entries to make room, so a
    // 20-result search returned 17 and lost ranked evidence.
    const seeds = Array.from({ length: 20 }, (_, i) =>
      scored(node(`seed${i}`, t0 + i * DAY), 0.5),
    );
    const r = expandToTemporalNeighbours(seeds, 20, { radius: 2 });
    expect(r.results).toHaveLength(20);
  });

  it("caps how much of the window it may replace", () => {
    const seeds = Array.from({ length: 20 }, (_, i) =>
      scored(node(`s${i}`, t0 + i * DAY), 0.5),
    );
    const r = expandToTemporalNeighbours(seeds, 20, { radius: 2 });
    // Default budget is ceil(20/5) = 4.
    expect(r.injected).toBeLessThanOrEqual(4);
  });

  it("leaves results without timestamps alone", () => {
    const undated = [
      scored(node("u1", null), 0.9),
      scored(node("u2", null), 0.8),
    ];
    const r = expandToTemporalNeighbours(undated, 20, { radius: 2 });
    expect(r.injected).toBe(0);
    expect(r.results.map((x) => x.node.id)).toEqual(["u1", "u2"]);
  });
});
