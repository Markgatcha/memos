/**
 * Tier 2 item 8: the context-pack token budget scales with the context
 * window, and budget accounting reflects real wire cost.
 *
 * Three defects are covered here:
 *   1. `contextPack()` derived its item limit with a hard `Math.min(50, …)`
 *      cap, so a 200k-token budget bought exactly the same evidence
 *      volume as a 4k budget. Candidate depth (`limit * 4`) inherited the
 *      same ceiling.
 *   2. Budget accounting charged `content + summary + 4` per item, which
 *      omits the TOON row scaffolding (`id|score|trust|src|epochDelta|
 *      tags|content`, base64url ids ≈ 24 chars) and citations — so the
 *      enforced budget understated the real wire cost.
 *   3. `packToToonCompact(pack, _tokenCounter)` documented its token
 *      counter as "unused, reserved for future budget enforcement", so
 *      the compact format that `mcp.ts` defaults to enforced nothing.
 *
 * Backwards compatibility is asserted on every path: with no new options
 * the item selection and rendered bytes are unchanged.
 *
 * NOTE: this file imports `src/context-pack` only (no `src/memory`), so
 * the pure unit coverage here is unaffected by unrelated module state.
 */

import {
  buildContextPack,
  derivePackCandidateDepth,
  derivePackItemLimit,
  estimateTokens,
  itemWireOverheadTokens,
  packToToonCompact,
  parseToonCompact,
  PACK_ITEM_LIMIT_MAX,
  PACK_ITEM_LIMIT_MIN,
  PACK_TOKENS_PER_ITEM,
  serializeContextPack,
  type ContextPack,
  type ContextPackItem,
} from "../src/context-pack";
import type { MemoryNode, ScoredMemory } from "../src/types";

function makeNode(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    accessCount: 0,
    lastAccessed: 1_700_000_000_000,
    tags: ["work", "release"],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 0.9,
  };
}

function toScored(id: string, content: string, score: number): ScoredMemory {
  return { node: makeNode(id, content), score };
}

function itemFixture(
  overrides: Partial<ContextPackItem> = {},
): ContextPackItem {
  const node = makeNode(
    "12345678-1234-1234-1234-123456789abc",
    "A fairly typical packed memory payload sentence",
  );
  return {
    id: node.id,
    content: node.content,
    summary: null,
    score: 0.95,
    scores: {},
    trust: "local",
    source: "session",
    tags: ["work", "release"],
    updatedAt: new Date(node.updatedAt).toISOString(),
    trustScore: node.trustScore,
    nodeSource: node.source,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part 1: the derived item limit scales with the budget
// ---------------------------------------------------------------------------

describe("derivePackItemLimit", () => {
  test("a small budget reproduces the historical clamp", () => {
    // Old rule: min(50, max(8, floor(budget / 80))).
    for (const budget of [0, 200, 640, 1000, 4000]) {
      expect(derivePackItemLimit(budget)).toBe(
        Math.min(50, Math.max(8, Math.floor(budget / 80))),
      );
    }
    expect(derivePackItemLimit(4000)).toBe(50);
  });

  test("a large budget buys proportionally more items (no more hard 50)", () => {
    // Linear up to the ceiling, then clamped — the 50 hard cap is gone.
    expect(derivePackItemLimit(4000)).toBe(50);
    expect(derivePackItemLimit(40_000)).toBe(PACK_ITEM_LIMIT_MAX);
    expect(derivePackItemLimit(200_000)).toBe(PACK_ITEM_LIMIT_MAX);
    // Every budget between the old cap and the new ceiling now buys more.
    // The derived value is a FLOOR division by PACK_TOKENS_PER_ITEM: an
    // item limit has to be a whole number of items — the budget loop
    // admits items one at a time, so a "62.5 item" limit is not a thing.
    // A 5000-token budget therefore buys 62 slots (floor(5000 / 80)); the
    // leftover 40 tokens cannot pay for another 80-token slot. Asserting
    // the raw quotient here (5000 / 80 === 62.5) was testing arithmetic
    // the implementation deliberately does not do.
    for (
      let budget = 5000;
      budget <= PACK_ITEM_LIMIT_MAX * 80;
      budget += 1000
    ) {
      expect(derivePackItemLimit(budget)).toBe(
        Math.floor(budget / PACK_TOKENS_PER_ITEM),
      );
    }
    // The explicit floor case that used to be asserted as the raw quotient.
    expect(derivePackItemLimit(5000)).toBe(62);
    // A 40k window now buys 10x the evidence a 4k window bought.
    expect(derivePackItemLimit(40_000)).toBeGreaterThan(
      derivePackItemLimit(4000) * 9,
    );
  });

  test("the ceiling is monotonically clamped (bounded memory use)", () => {
    // Above PACK_ITEM_LIMIT_MAX * 80 tokens the derived limit stops
    // growing, so the retrieval pool cannot explode.
    const huge = PACK_ITEM_LIMIT_MAX * 80;
    expect(derivePackItemLimit(huge)).toBe(PACK_ITEM_LIMIT_MAX);
    expect(derivePackItemLimit(huge * 10)).toBe(PACK_ITEM_LIMIT_MAX);
    expect(derivePackItemLimit(Number.MAX_SAFE_INTEGER)).toBe(
      PACK_ITEM_LIMIT_MAX,
    );
    // ...and the floor still guarantees a usable pack on a tiny budget.
    expect(derivePackItemLimit(1)).toBe(PACK_ITEM_LIMIT_MIN);
  });

  test("candidate depth scales with the derived limit", () => {
    expect(derivePackCandidateDepth(50)).toBe(200);
    // Four candidates per item slot, capped alongside the item limit so
    // the retrieval pool cannot explode either.
    expect(derivePackCandidateDepth(PACK_ITEM_LIMIT_MAX)).toBe(
      PACK_ITEM_LIMIT_MAX * 4,
    );
    // A 4k budget retrieves exactly the historical 200-row pool; a 40k
    // budget retrieves 4x that.
    expect(derivePackCandidateDepth(derivePackItemLimit(4000))).toBe(200);
    expect(derivePackCandidateDepth(derivePackItemLimit(40_000))).toBe(
      derivePackItemLimit(40_000) * 4,
    );
    expect(
      derivePackCandidateDepth(derivePackItemLimit(40_000)),
    ).toBeGreaterThan(200);
  });

  test("the constants agree with each other", () => {
    expect(PACK_ITEM_LIMIT_MIN).toBeLessThan(PACK_ITEM_LIMIT_MAX);
    expect(derivePackItemLimit(PACK_TOKENS_PER_ITEM * 10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Part 2: a large tokenBudget yields more items than a small one
// ---------------------------------------------------------------------------

describe("buildContextPack budget scaling", () => {
  const items = Array.from({ length: 200 }, (_, i) =>
    toScored(
      `${i}`.padStart(8, "0"),
      `Evidence line ${i} about the release with several words in it`,
      1 - i / 200,
    ),
  );

  test("a large tokenBudget admits more items than a small one — and more than 50", () => {
    const small = buildContextPack({
      query: "release",
      namespace: "default",
      tokenBudget: 200,
      items,
    });
    const large = buildContextPack({
      query: "release",
      namespace: "default",
      tokenBudget: 400_000,
      items,
    });
    expect(small.items.length).toBeGreaterThan(0);
    expect(large.items.length).toBeGreaterThan(small.items.length);
    // 200 short items all fit once the budget is generous.
    expect(large.items.length).toBeGreaterThan(50);
    expect(large.tokenBudget).toBe(400_000);
  });

  test("no hard 50-item ceiling: the full candidate set can be packed", () => {
    const pack = buildContextPack({
      query: "release",
      namespace: "default",
      tokenBudget: Number.MAX_SAFE_INTEGER,
      items,
    });
    expect(pack.items).toHaveLength(200);
  });
});

// ---------------------------------------------------------------------------
// Part 3: wire-accurate budget accounting
// ---------------------------------------------------------------------------

describe("itemWireOverheadTokens", () => {
  const item = itemFixture();

  test("no wire format keeps the legacy flat estimate", () => {
    expect(itemWireOverheadTokens(item)).toBe(4);
    expect(itemWireOverheadTokens(item, undefined)).toBe(4);
  });

  test("TOON serialization is charged for its scaffolding", () => {
    const toon = itemWireOverheadTokens(item, "toon");
    const compact = itemWireOverheadTokens(item, "toon-compact");
    // Both wire formats cost far more per item than the flat estimate:
    // the base64url id alone is ~24 chars.
    expect(toon).toBeGreaterThan(4);
    expect(compact).toBeGreaterThan(4);
    // Compact is the leaner of the two.
    expect(compact).toBeLessThan(toon);
  });

  test("JSON is charged for its field names and quotes", () => {
    const json = itemWireOverheadTokens(item, "json");
    expect(json).toBeGreaterThan(4);
    // JSON carries the most per-item scaffolding.
    expect(json).toBeGreaterThan(itemWireOverheadTokens(item, "toon"));
  });

  test("citations are charged when the pack uses them", () => {
    const plain = itemWireOverheadTokens(item, "toon");
    const cited = itemWireOverheadTokens(item, "toon", estimateTokens, true);
    expect(cited).toBeGreaterThan(plain);
    // ~10 chars of `[mem:1234] ` prefix.
    expect(cited - plain).toBeGreaterThanOrEqual(3);
  });

  test("the TOON estimate tracks the real serializer's scaffolding", () => {
    const row = [
      item.id,
      "0.950",
      "local",
      "session",
      item.updatedAt,
      "work;release",
      "",
    ].join("|");
    const estimate = itemWireOverheadTokens(item, "toon", estimateTokens);
    // Within a couple of tokens of the bytes the verbose serializer
    // really emits for this row (content stripped off).
    expect(Math.abs(estimate - estimateTokens(row))).toBeLessThanOrEqual(2);
  });
});

describe("wire-accurate budget accounting in buildContextPack", () => {
  const items = [
    toScored("n1", "alpha release note about deploys", 0.9),
    toScored("n2", "beta release note about deploys", 0.8),
    toScored("n3", "gamma release note about deploys", 0.7),
  ];

  test("default build is unchanged when wireFormat is not passed", () => {
    const legacy = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items,
    });
    // Byte-identical to a build that explicitly omits every new knob.
    expect(JSON.stringify(legacy)).toBe(
      JSON.stringify(
        buildContextPack({
          query: "q",
          namespace: "default",
          tokenBudget: 1000,
          items,
          wireFormat: undefined,
          compression: undefined,
        }),
      ),
    );
  });

  test("the wire cost exceeds the flat-estimate accounting (the bug)", () => {
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: Number.MAX_SAFE_INTEGER,
      items,
    });
    const flat = pack.items.reduce(
      (sum, i) => sum + estimateTokens(i.content) + 4,
      0,
    );
    // Every real serialization costs more than the flat estimate, because
    // the estimate charges nothing for id/score/trust/tags/separators.
    expect(estimateTokens(packToToonCompact(pack))).toBeGreaterThan(flat);
    expect(estimateTokens(JSON.stringify(pack.items))).toBeGreaterThan(flat);
    // TOON is still far cheaper than JSON — the compact format's raison
    // d'être holds even under wire-accurate accounting.
    expect(estimateTokens(packToToonCompact(pack))).toBeLessThan(
      estimateTokens(JSON.stringify(pack.items)),
    );
  });

  test("each item's wire cost is charged at least its flat estimate", () => {
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: Number.MAX_SAFE_INTEGER,
      items,
    });
    for (const item of pack.items) {
      for (const wireFormat of ["json", "toon", "toon-compact"] as const) {
        expect(itemWireOverheadTokens(item, wireFormat)).toBeGreaterThan(4);
      }
      // Citations add to the charged overhead.
      expect(
        itemWireOverheadTokens(item, "toon-compact", estimateTokens, true),
      ).toBeGreaterThan(itemWireOverheadTokens(item, "toon-compact"));
    }
  });

  test("TOON accounting tracks the real wire cost of an extra item", () => {
    // Marginal accounting: what ONE more item costs on the wire vs what
    // the estimator charges for it. The estimator counts the scaffold as
    // tokens, so the two agree in direction and rough magnitude.
    const build = (n: number): ContextPack =>
      buildContextPack({
        query: "q",
        namespace: "default",
        tokenBudget: Number.MAX_SAFE_INTEGER,
        items: Array.from({ length: n }, (_, i) =>
          toScored(
            `n${i}`,
            `distinct evidence line number ${i} about deploys`,
            1 - i / 100,
          ),
        ),
      });
    const one = build(1);
    const two = build(2);
    const marginalWire =
      estimateTokens(packToToonCompact(two)) -
      estimateTokens(packToToonCompact(one));
    const marginalAccounted =
      itemWireOverheadTokens(two.items[1], "toon-compact") +
      estimateTokens(two.items[1].content);
    const marginalFlat = estimateTokens(two.items[1].content) + 4;
    // Wire-accurate accounting charges strictly more than the flat
    // estimate for the same item.
    expect(marginalAccounted).toBeGreaterThan(marginalFlat);
    // ...and it lands within one item's worth of scaffolding of the real
    // marginal wire cost (the estimator's ~4-chars-per-token split of a
    // pipe-joined scaffold is deliberately generous).
    expect(Math.abs(marginalWire - marginalAccounted)).toBeLessThanOrEqual(
      itemWireOverheadTokens(two.items[1], "toon-compact") + 8,
    );
  });

  test("a tight wireFormat budget admits fewer items than the flat estimate", () => {
    // `dedup: false`: these items deliberately share vocabulary, and the
    // 0.85 Jaccard pass would otherwise collapse them all into one.
    const many = Array.from({ length: 40 }, (_, i) =>
      toScored(
        `${i}`.padStart(8, "0"),
        `A typical evidence line ${i} with several words in it about the release`,
        1 - i / 100,
      ),
    );
    const flat = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 150,
      items: many,
      dedup: false,
    });
    const wire = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 150,
      items: many,
      dedup: false,
      wireFormat: "toon-compact",
    });
    // Same budget, but wire-accurate accounting charges each item its
    // real scaffolding cost, so fewer fit.
    expect(flat.items.length).toBeGreaterThan(1);
    expect(wire.items.length).toBeLessThan(flat.items.length);
    expect(wire.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Part 4: packToToonCompact enforces the budget
// ---------------------------------------------------------------------------

describe("packToToonCompact budget enforcement", () => {
  function makePack(n: number): ContextPack {
    return buildContextPack({
      query: "release notes",
      namespace: "default",
      tokenBudget: Number.MAX_SAFE_INTEGER,
      items: Array.from({ length: n }, (_, i) =>
        toScored(
          `${i}`.padStart(8, "0"),
          `Item ${i} of a long evidence list about the release`,
          1 - i / 100,
        ),
      ),
    });
  }

  test("no budget parameter renders the whole pack (backwards compatible)", () => {
    const pack = makePack(10);
    const before = packToToonCompact(pack);
    const withCounter = packToToonCompact(pack, estimateTokens);
    expect(withCounter).toBe(before);
    expect(parseToonCompact(withCounter)).toHaveLength(10);
  });

  test("an explicit budget drops the lowest-scored rows until it fits", () => {
    const pack = makePack(20);
    const full = packToToonCompact(pack);
    const fullTokens = estimateTokens(full);
    expect(fullTokens).toBeGreaterThan(100);

    const trimmed = packToToonCompact(pack, estimateTokens, 60);
    expect(trimmed).not.toBe(full);
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(60);
    // Fewer rows on the wire, and the envelope survives intact.
    expect(parseToonCompact(trimmed).length).toBeLessThan(20);
    expect(trimmed).toContain("# ai-trio.memos.context-pack.v1");
    expect(trimmed).toContain("# q=release notes");
  });

  test("trimming is by score, so the U-shape pin is never dropped first", () => {
    const pack = makePack(20);
    // The pack's own order pins the second-best item LAST.
    const full = pack.items;
    expect(full[full.length - 1].score).toBeCloseTo(1 - 1 / 100, 6);

    const trimmed = parseToonCompact(
      packToToonCompact(pack, estimateTokens, 120),
    );
    // A score-blind tail cut would have dropped item 1 before items 2..17.
    // A score-aware cut keeps 0 and 1 and drops from the middle.
    const ids = trimmed.map((i) => i.id);
    expect(ids).toContain("00000000");
    expect(ids).toContain("00000001");
    // Dropped items are the lowest-scored ones.
    const dropped = full.map((i) => i.id).filter((id) => !ids.includes(id));
    for (const id of dropped) {
      const score = full.find((i) => i.id === id)!.score;
      for (const kept of ids) {
        expect(score).toBeLessThanOrEqual(
          full.find((i) => i.id === kept)!.score,
        );
      }
    }
  });

  test("a budget larger than the pack changes nothing", () => {
    const pack = makePack(5);
    const full = packToToonCompact(pack);
    expect(packToToonCompact(pack, estimateTokens, 10_000)).toBe(full);
  });

  test("a custom token counter is honoured", () => {
    const pack = makePack(20);
    // A deliberately brutal counter: any non-empty body costs 100 tokens.
    const counter = (text: string) => (text.length === 0 ? 0 : 100);
    const out = packToToonCompact(pack, counter, 250);
    expect(counter(out)).toBeLessThanOrEqual(250);
  });

  test("an impossible budget still emits the best item, not an empty pack", () => {
    const pack = makePack(20);
    const out = packToToonCompact(pack, estimateTokens, 1);
    expect(parseToonCompact(out).length).toBeGreaterThanOrEqual(1);
    // The top-scored row survives.
    expect(out).toContain("Item 0");
  });

  test("serializeContextPack forwards the budget to the compact serializer", () => {
    const pack = makePack(20);
    const full = serializeContextPack(pack, "toon-compact") as string;
    const trimmed = serializeContextPack(
      pack,
      "toon-compact",
      estimateTokens,
      60,
    ) as string;
    expect(full).toBe(packToToonCompact(pack));
    expect(trimmed).toBe(packToToonCompact(pack, estimateTokens, 60));
    expect(parseToonCompact(trimmed).length).toBeLessThan(
      parseToonCompact(full).length,
    );
  });

  test("the U-shape pin survives whenever two rows can actually fit", () => {
    const pack = makePack(20);
    const full = parseToonCompact(packToToonCompact(pack));
    const trimmed = parseToonCompact(
      packToToonCompact(pack, estimateTokens, 80),
    );
    // The best item is always first.
    expect(trimmed[0].id).toBe(full[0].id);
    // ...and at a budget that CAN pay for two rows, the second-best item
    // (pinned last by the U-shape) is not the casualty: the score-aware
    // trim drops from the middle first, so the runner-up survives with it.
    expect(trimmed).toHaveLength(2);
    expect(trimmed[1].id).toBe(full[full.length - 1].id);

    // Below that, the envelope plus one row simply does not fit two rows,
    // and the serializer's documented floor applies: the top fact is
    // still emitted rather than an empty evidence block. Measured cost of
    // this pack's two-row wire form is 77 tokens, so a 40-token budget
    // cannot buy it — a one-row answer is correct, not a defect.
    const twoRowCost = estimateTokens(
      packToToonCompact({ ...pack, items: pack.items.slice(0, 2) }),
    );
    const tooTight = parseToonCompact(
      packToToonCompact(pack, estimateTokens, 40),
    );
    expect(tooTight).toHaveLength(1);
    expect(tooTight[0].id).toBe(full[0].id);
    expect(twoRowCost).toBeGreaterThan(40);
  });
});
