/**
 * Tests for the effective-importance model (src/importance.ts).
 *
 * The invariant that matters for the lifecycle decisions it feeds: the
 * access boost must never let a LOW-importance memory outrank a
 * HIGH-importance one. A flat addition broke that at the clamp
 * (base 0.8 + four accesses scored 1.0000 against base 0.9 with none at
 * 0.9000), so eviction would have kept the less important memory first.
 */

import {
  computeEffectiveImportance,
  recencyScore,
  DEFAULT_IMPORTANCE_CONFIG,
} from "../src/importance";
import type { MemoryNode } from "../src/types";

const DAY = 86_400_000;
const NOW = 100 * DAY;

const node = (
  importance: number,
  accessCount: number,
  lastAccessed: number,
): Pick<MemoryNode, "importance" | "accessCount" | "lastAccessed"> => ({
  importance,
  accessCount,
  lastAccessed,
});

describe("computeEffectiveImportance", () => {
  test("stays in [0, 1] across the parameter space", () => {
    for (const importance of [0, 0.1, 0.5, 0.9, 1]) {
      for (const accessCount of [0, 1, 4, 7, 40]) {
        for (const ageDays of [0, 1, 30, 365, 3650]) {
          const v = computeEffectiveImportance(
            node(importance, accessCount, NOW - ageDays * DAY),
            NOW,
          );
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test("is monotone in the base importance", () => {
    // An access boost may pull a low-importance memory toward its own
    // ceiling, never past a genuinely more important one.
    for (const accessCount of [0, 1, 4, 7, 100]) {
      for (const ageDays of [0, 30, 365]) {
        const low = computeEffectiveImportance(
          node(0.3, accessCount, NOW - ageDays * DAY),
          NOW,
        );
        const high = computeEffectiveImportance(
          node(0.9, accessCount, NOW - ageDays * DAY),
          NOW,
        );
        expect(low).toBeLessThanOrEqual(high);
      }
    }
  });

  test("decays with age and is lifted by accesses", () => {
    const fresh = computeEffectiveImportance(node(0.5, 0, NOW), NOW);
    const old = computeEffectiveImportance(node(0.5, 0, NOW - 90 * DAY), NOW);
    expect(old).toBeLessThan(fresh);
    const touched = computeEffectiveImportance(
      node(0.5, 3, NOW - 90 * DAY),
      NOW,
    );
    expect(touched).toBeGreaterThan(old);
  });

  test("never drops below decayFloor x base, however old", () => {
    const ancient = computeEffectiveImportance(
      node(0.5, 0, NOW - 365 * 100 * DAY),
      NOW,
    );
    expect(ancient).toBeCloseTo(0.5 * DEFAULT_IMPORTANCE_CONFIG.decayFloor, 10);
  });

  test("halfLifeDays = 0 disables decay", () => {
    expect(
      computeEffectiveImportance(node(0.5, 0, NOW - 900 * DAY), NOW, {
        halfLifeDays: 0,
      }),
    ).toBe(0.5);
  });
});

describe("recencyScore", () => {
  test("1 for the present, halving at the half-life", () => {
    expect(recencyScore({ lastAccessed: NOW }, NOW)).toBe(1);
    expect(recencyScore({ lastAccessed: NOW - 14 * DAY }, NOW, 14)).toBeCloseTo(
      0.5,
      10,
    );
    expect(recencyScore({ lastAccessed: NOW - 14 * DAY }, NOW, 0)).toBe(1);
  });
});
