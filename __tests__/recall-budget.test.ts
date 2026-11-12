/**
 * Recall budget test suite:
 * - Tier selection thresholds and min/max clamps
 * - Soft/hard deadline behaviour
 * - Token capping (best-first, always keeps at least one result)
 * - Receipt formatting
 * - End-to-end: tier 0 keyword-only search reports skipped stages
 * - End-to-end: `maxTokens` trims results and marks the receipt
 * - `searchWithReceipt()` without a budget reports the full pipeline
 */

import { MemOS } from "../src/memory.js";
import {
  capResultsByTokens,
  createRecallClock,
  formatRecallReceipt,
  isOverHardDeadline,
  isOverSoftDeadline,
  selectRecallTier,
} from "../src/recall-budget.js";
import type { RecallBudget, ScoredMemory } from "../src/types.js";

function fakeResult(content: string, id: string): ScoredMemory {
  return {
    node: {
      id,
      content,
      summary: "",
      type: "fact",
      tags: [],
      namespace: "default",
      pool: "note",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      importance: 0.5,
      trustScore: 0.5,
      accessCount: 0,
      lastAccessed: Date.now(),
      provenance: "user",
      verified: false,
    },
    score: 1,
  } as unknown as ScoredMemory;
}

describe("selectRecallTier", () => {
  test("maps latency budgets to tiers", () => {
    expect(selectRecallTier({ maxMs: 10 })).toBe(0);
    expect(selectRecallTier({ maxMs: 25 })).toBe(0);
    expect(selectRecallTier({ maxMs: 50 })).toBe(1);
    expect(selectRecallTier({ maxMs: 80 })).toBe(1);
    expect(selectRecallTier({ maxMs: 200 })).toBe(2);
    expect(selectRecallTier({ maxMs: 250 })).toBe(2);
    expect(selectRecallTier({ maxMs: 5000 })).toBe(3);
  });

  test("a tiny token cap without a latency budget chooses tier 1", () => {
    expect(selectRecallTier({ maxTokens: 200 })).toBe(1);
    expect(selectRecallTier({ maxTokens: 4000 })).toBe(3);
  });

  test("minTier and maxTier clamp the policy", () => {
    expect(selectRecallTier({ maxMs: 1, minTier: 2 })).toBe(2);
    expect(selectRecallTier({ maxMs: 5000, maxTier: 1 })).toBe(1);
    expect(selectRecallTier({ maxMs: 1, minTier: 3, maxTier: 2 })).toBe(2);
  });

  test("no budget means the full pipeline", () => {
    expect(selectRecallTier()).toBe(3);
    expect(selectRecallTier(null)).toBe(3);
  });
});

describe("recall clock", () => {
  test("soft deadline is 75% of the budget", () => {
    const clock = createRecallClock({ maxMs: 100 }, 1000);
    expect(clock.softDeadline).toBe(1075);
    expect(clock.hardDeadline).toBe(1100);
  });

  test("no maxMs means no deadlines", () => {
    const clock = createRecallClock({ maxTokens: 100 }, 1000);
    expect(Number.isFinite(clock.softDeadline)).toBe(false);
    expect(Number.isFinite(clock.hardDeadline)).toBe(false);
  });

  test("deadline predicates respect the clock", () => {
    const clock = createRecallClock({ maxMs: 100 }, 1000);
    const plan = { tier: 3 as const, clock, receipt: { skip: 0 } };
    // `isOverSoftDeadline` only reads `clock`, so a minimal plan shape works.
    expect(isOverSoftDeadline(plan as never, 1050)).toBe(false);
    expect(isOverSoftDeadline(plan as never, 1080)).toBe(true);
    expect(isOverHardDeadline(plan as never, 1099)).toBe(false);
    expect(isOverHardDeadline(plan as never, 1101)).toBe(true);
  });
});

describe("capResultsByTokens", () => {
  test("keeps best-first results up to the cap", () => {
    const results = [
      fakeResult("alpha beta gamma", "a"),
      fakeResult("delta epsilon", "b"),
      fakeResult("zeta", "c"),
    ];
    const capped = capResultsByTokens(results, 3);
    expect(capped.results).toHaveLength(1);
    expect(capped.results[0]?.node.id).toBe("a");
    expect(capped.capped).toBe(true);
  });

  test("keeps at least one result even when it exceeds the cap", () => {
    const results = [fakeResult("a very long memory ".repeat(50), "a")];
    const capped = capResultsByTokens(results, 1);
    expect(capped.results).toHaveLength(1);
    expect(capped.capped).toBe(false);
  });

  test("no cap returns everything", () => {
    const results = [fakeResult("alpha", "a"), fakeResult("beta", "b")];
    const capped = capResultsByTokens(results);
    expect(capped.results).toHaveLength(2);
    expect(capped.capped).toBe(false);
  });
});

describe("formatRecallReceipt", () => {
  test("renders budget, tier, stages and token count", () => {
    const text = formatRecallReceipt({
      budget: { maxMs: 50, maxTokens: 800 },
      tier: 1,
      elapsedMs: 12.34,
      degraded: true,
      stages: [
        { stage: "fts", ms: 3.2, ran: true },
        { stage: "rerank", ms: 0, ran: false, skippedReason: "tier" },
      ],
      skipped: ["rerank"],
      resultCount: 3,
      estimatedTokens: 120,
      tokenCapped: true,
    });
    expect(text).toContain("50ms / 800 tokens");
    expect(text).toContain("Tier: 1 (parallel-legs)");
    expect(text).toContain("Skipped: rerank (tier)");
    expect(text).toContain("~120 tokens (token-capped)");
  });
});

describe("MemOS search budgets", () => {
  async function seeded(): Promise<MemOS> {
    const memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    await memos.store("Production deployment runbook requires two approvals", {
      tags: ["deploy"],
    });
    await memos.store("Rollback procedure for production releases", {
      tags: ["deploy"],
    });
    await memos.store("PostgreSQL failover notes for regional incidents", {
      tags: ["db"],
    });
    return memos;
  }

  test("a 1ms budget runs keyword-only and records skipped stages", async () => {
    const memos = await seeded();
    const { results, receipt } = await memos.searchWithReceipt({
      query: "deployment runbook",
      budget: { maxMs: 1 },
    });

    expect(receipt.tier).toBe(0);
    expect(receipt.degraded).toBe(true);
    expect(receipt.stages.find((s) => s.stage === "fts")?.ran).toBe(true);
    expect(receipt.stages.find((s) => s.stage === "semantic")).toMatchObject({
      ran: false,
      skippedReason: "tier",
    });
    expect(receipt.skipped).toContain("semantic");
    expect(results.length).toBeGreaterThan(0);

    await memos.close();
  });

  test("maxTokens trims results and flags the receipt", async () => {
    const memos = await seeded();
    const budget: RecallBudget = { maxTokens: 1, maxTier: 0 };
    const { results, receipt } = await memos.searchWithReceipt({
      query: "production",
      limit: 10,
      budget,
    });

    expect(receipt.tokenCapped).toBe(true);
    expect(receipt.resultCount).toBe(results.length);
    expect(results).toHaveLength(1);

    await memos.close();
  });

  test("searchWithReceipt without a budget reports the full pipeline", async () => {
    const memos = await seeded();
    const { results, receipt } =
      await memos.searchWithReceipt("deployment runbook");

    expect(receipt.tier).toBe(3);
    expect(receipt.degraded).toBe(false);
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(receipt.budget).toBeNull();
    expect(results.length).toBeGreaterThan(0);

    await memos.close();
  });
});
