/**
 * Tests for the effective importance model in `src/importance.ts`.
 *
 * The historical bug these pin down: recency decay was anchored on
 * `lastAccessed`, which is optional on imported / migrated / externally
 * supplied rows (`UpdateMemoryInput.lastAccessed?`, src/types.ts:339).
 * A row arriving with it unset or 0 computed `ageDays` in decades and had
 * its importance halved. The anchor now falls back through
 * `lastAccessed` → `createdAt` → `updatedAt` → `now`.
 *
 * Also covered: the access bonus is no longer immune to decay.
 */

import {
  computeEffectiveImportance,
  DEFAULT_IMPORTANCE_CONFIG,
  importanceRankFactor,
  recencyScore,
} from "../src/importance";
import type { MemoryNode } from "../src/types";

const DAY = 86_400_000;

type ImportanceNode = Pick<
  MemoryNode,
  "importance" | "accessCount" | "lastAccessed" | "createdAt" | "updatedAt"
>;

function makeNode(over: Partial<ImportanceNode> = {}): ImportanceNode {
  return {
    importance: 0.9,
    accessCount: 0,
    lastAccessed: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Recency anchor fallback chain
// ---------------------------------------------------------------------------

describe("computeEffectiveImportance — recency anchor", () => {
  test("a never-accessed node is treated as fresh, not ancient", () => {
    const now = Date.now();
    // lastAccessed left at 0: the imported-row case.
    expect(
      computeEffectiveImportance(makeNode({ lastAccessed: 0 }), now),
    ).toBeCloseTo(0.9, 2);
  });

  test("lastAccessed === now and lastAccessed === 0 agree at write time", () => {
    const now = Date.now();
    const fresh = computeEffectiveImportance(
      makeNode({ lastAccessed: now }),
      now,
    );
    const unset = computeEffectiveImportance(
      makeNode({ lastAccessed: 0 }),
      now,
    );
    expect(unset).toBeCloseTo(fresh, 6);
  });

  test("recency uses createdAt when lastAccessed is absent", () => {
    const now = 1_000_000 * DAY;
    const createdAt = now - 30 * DAY; // exactly one half-life
    const anchored = computeEffectiveImportance(
      makeNode({ lastAccessed: 0, createdAt }),
      now,
    );
    // decay at one half-life = decayFloor + (1 - decayFloor) · e^-1
    const expectedDecay =
      DEFAULT_IMPORTANCE_CONFIG.decayFloor +
      (1 - DEFAULT_IMPORTANCE_CONFIG.decayFloor) * Math.exp(-1);
    expect(anchored).toBeCloseTo(0.9 * expectedDecay, 6);

    // Decisively NOT the ancient case (which lands on the floor).
    const floor = 0.9 * DEFAULT_IMPORTANCE_CONFIG.decayFloor;
    expect(anchored).toBeGreaterThan(floor);
  });

  test("falls back to updatedAt when createdAt is also missing", () => {
    const now = 1_000_000 * DAY;
    const updatedAt = now - 30 * DAY;
    expect(
      computeEffectiveImportance(
        makeNode({ lastAccessed: 0, createdAt: 0, updatedAt }),
        now,
      ),
    ).toBeCloseTo(
      computeEffectiveImportance(
        makeNode({ lastAccessed: 0, createdAt: updatedAt, updatedAt }),
        now,
      ),
      6,
    );
  });

  test("with no usable timestamp at all the node is brand new", () => {
    const now = 1_700_000_000_000;
    expect(
      computeEffectiveImportance(
        { importance: 0.8, accessCount: 0 } as ImportanceNode,
        now,
      ),
    ).toBeCloseTo(0.8, 6);
  });

  test("undefined and non-finite timestamps are skipped", () => {
    const now = 1_000_000 * DAY;
    const createdAt = now - 15 * DAY;
    const weird = makeNode({
      lastAccessed: undefined,
      createdAt,
      updatedAt: Number.NaN,
    } as Partial<ImportanceNode>);
    expect(computeEffectiveImportance(weird, now)).toBeCloseTo(
      computeEffectiveImportance(makeNode({ lastAccessed: 0, createdAt }), now),
      6,
    );
  });

  test("lastAccessed still wins when it is set (usage refresh)", () => {
    const now = 1_000_000 * DAY;
    const readToday = makeNode({
      lastAccessed: now,
      createdAt: now - 400 * DAY,
    });
    const writtenToday = makeNode({
      lastAccessed: 0,
      createdAt: now,
    });
    const createdAt = now - 400 * DAY;
    // Read today → anchor = today → decay 1 → 0.9 exactly.
    expect(computeEffectiveImportance(readToday, now)).toBeCloseTo(0.9, 6);
    expect(computeEffectiveImportance(writtenToday, now)).toBeCloseTo(0.9, 6);
    // And a read 200 days ago must beat a read 400 days ago (which hits
    // the floor: 0.9 · 0.5 = 0.45) — proving the anchor is lastAccessed
    // when it is set, not createdAt.
    const read200 = makeNode({
      lastAccessed: now - 200 * DAY,
      createdAt: now - 400 * DAY,
    });
    const read400 = makeNode({
      lastAccessed: now - 3650 * DAY,
      createdAt: now - 3650 * DAY,
    });
    // 3650 days is ~121 half-lives → decay is the floor to float precision.
    expect(computeEffectiveImportance(read400, now)).toBeCloseTo(0.45, 6);
    expect(computeEffectiveImportance(read200, now)).toBeGreaterThan(
      computeEffectiveImportance(read400, now),
    );
  });

  test("recencyScore applies the same fallback chain", () => {
    const now = 1_000_000 * DAY;
    const createdAt = now - 14 * DAY; // one half-life of the 14-day default
    expect(
      recencyScore(makeNode({ lastAccessed: 0, createdAt }), now),
    ).toBeCloseTo(Math.exp(-1), 6);
    // Nothing usable → fresh.
    expect(
      recencyScore({ lastAccessed: 0, createdAt: 0, updatedAt: 0 }, now),
    ).toBeCloseTo(1, 6);
  });
});

// ---------------------------------------------------------------------------
// Decay of the access bonus
// ---------------------------------------------------------------------------

describe("computeEffectiveImportance — access boost decay", () => {
  test("the access bonus no longer immunizes a memory from aging", () => {
    const now = 1_000_000 * DAY;
    const createdAt = now - 60 * DAY;
    const decayed = computeEffectiveImportance(
      makeNode({ lastAccessed: 0, createdAt, accessCount: 100 }),
      now,
    );
    // Old shape: importance * decay + accessBoost ≈ 0.9 * floor + 0.3,
    // fully boosted. New shape must be strictly lower.
    const floor = DEFAULT_IMPORTANCE_CONFIG.decayFloor;
    const oldShape = 0.9 * floor + DEFAULT_IMPORTANCE_CONFIG.accessCap;
    expect(decayed).toBeLessThan(oldShape);
    // 60 days = two half-lives → decay = floor + (1-floor)·e^-2
    const twoHalves = floor + (1 - floor) * Math.exp(-2);
    expect(decayed).toBeCloseTo((0.9 + 0.3) * twoHalves, 6);
  });

  test("access boost still outranks an untouched equal-scoring memory", () => {
    const now = 1_000_000 * DAY;
    const createdAt = now - 20 * DAY;
    const read = computeEffectiveImportance(
      makeNode({ lastAccessed: 0, createdAt, accessCount: 8 }),
      now,
    );
    const untouched = computeEffectiveImportance(
      makeNode({ lastAccessed: 0, createdAt, accessCount: 0 }),
      now,
    );
    expect(read).toBeGreaterThan(untouched);
  });

  test("access bonus is capped", () => {
    const now = 1_000_000 * DAY;
    const atCap = computeEffectiveImportance(
      makeNode({ lastAccessed: now, accessCount: 64 }),
      now,
    );
    const wayPastCap = computeEffectiveImportance(
      makeNode({ lastAccessed: now, accessCount: 1_000_000 }),
      now,
    );
    // (0.9 + 0.3) · 1 = 1.2 → clamped to 1.
    expect(atCap).toBe(1);
    expect(wayPastCap).toBeCloseTo(atCap, 6);
  });

  test("aging never drops below decayFloor × the boosted base", () => {
    const now = 1_000_000 * DAY;
    const ancient = computeEffectiveImportance(
      makeNode({
        lastAccessed: 0,
        createdAt: 1,
        accessCount: 4,
      }),
      now,
    );
    const boost = DEFAULT_IMPORTANCE_CONFIG.accessGain * Math.log2(1 + 4);
    expect(ancient).toBeCloseTo(
      (0.9 + boost) * DEFAULT_IMPORTANCE_CONFIG.decayFloor,
      6,
    );
  });
});

// ---------------------------------------------------------------------------
// Config knobs & rank factor
// ---------------------------------------------------------------------------

describe("computeEffectiveImportance — config", () => {
  test("halfLifeDays 0 disables decay", () => {
    const now = 1_000_000 * DAY;
    // (0.9 + boost) · 1 = 1.132… → clamped to 1.
    expect(
      computeEffectiveImportance(
        makeNode({ lastAccessed: 0, createdAt: 1, accessCount: 4 }),
        now,
        { halfLifeDays: 0 },
      ),
    ).toBe(1);
  });

  test("halfLifeDays 0 with a modest importance leaves decay untouched", () => {
    const now = 1_000_000 * DAY;
    const boost = DEFAULT_IMPORTANCE_CONFIG.accessGain * Math.log2(5);
    expect(
      computeEffectiveImportance(
        makeNode({
          importance: 0.3,
          lastAccessed: 0,
          createdAt: 1,
          accessCount: 4,
        }),
        now,
        { halfLifeDays: 0 },
      ),
    ).toBeCloseTo(0.3 + boost, 6);
  });

  test("decayFloor and accessGain overrides are honoured", () => {
    const now = 1_000_000 * DAY;
    // decayFloor 1 pins the decay factor at 1; (0.9 + 0.5·log2(4)) = 1.9 → 1.
    expect(
      computeEffectiveImportance(
        makeNode({ lastAccessed: now, accessCount: 3 }),
        now,
        { decayFloor: 1, accessGain: 0.5, accessCap: 0.9 },
      ),
    ).toBe(1);

    // accessCount 0 → no boost → 0 + 0 = 0 is the floor, so use count 1
    // (log2(2) = 1 → boost 0.5) with importance 0 to isolate the gain.
    expect(
      computeEffectiveImportance(
        makeNode({ importance: 0, lastAccessed: now, accessCount: 1 }),
        now,
        { decayFloor: 1, accessGain: 0.5, accessCap: 0.9 },
      ),
    ).toBeCloseTo(0.5, 6);
  });

  test("a future timestamp clamps to zero age rather than going negative", () => {
    const now = 1_000_000 * DAY;
    const value = computeEffectiveImportance(
      makeNode({ lastAccessed: now + 10 * DAY }),
      now,
    );
    expect(value).toBeCloseTo(0.9, 6);
  });

  test("output stays within [0, 1] at the extremes", () => {
    const now = 1_000_000 * DAY;
    const high = computeEffectiveImportance(
      makeNode({ importance: 1, lastAccessed: now, accessCount: 1000 }),
      now,
    );
    const low = computeEffectiveImportance(
      makeNode({ importance: 0, lastAccessed: 0, createdAt: 1 }),
      now,
    );
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(low).toBeCloseTo(0, 6);
  });
});

describe("importanceRankFactor", () => {
  test("maps 0.5 to 1.0 and clamps weight", () => {
    expect(importanceRankFactor(0.5, 0.25)).toBeCloseTo(1, 6);
    expect(importanceRankFactor(0, 0.25)).toBeCloseTo(0.75, 6);
    expect(importanceRankFactor(1, 0.25)).toBeCloseTo(1.25, 6);
    expect(importanceRankFactor(0.5, 5)).toBeCloseTo(1, 6);
    expect(importanceRankFactor(0.5, -1)).toBeCloseTo(1, 6);
  });

  test("out-of-range effective values are clamped", () => {
    expect(importanceRankFactor(2, 0.25)).toBeCloseTo(1.25, 6);
    expect(importanceRankFactor(-2, 0.25)).toBeCloseTo(0.75, 6);
  });
});
