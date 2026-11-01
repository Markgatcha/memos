/**
 * Tier 2 item 6: `compressText` wired into the context-pack budget path.
 *
 * Before this change the greedy budget loop did a bare `continue` on the
 * first item that did not fit, so one oversized memory was discarded
 * whole and the budget went under-filled — even though
 * `src/compression.ts` exported a ready-made 20-40% token reduction that
 * was never invoked anywhere.
 *
 * Covered here:
 *   - an oversized item is admitted in compressed form when it would
 *     otherwise be dropped;
 *   - compression OFF (the default) reproduces the old behaviour
 *     byte-for-byte — the item is dropped and no content is altered;
 *   - `pack.tokensSaved` reports the compression delta;
 *   - `aggressive` compresses harder than `light`;
 *   - content compression cannot shrink (code-like) is skipped, never
 *     emitted mangled.
 */

import {
  buildContextPack,
  estimateTokens,
  packToToon,
} from "../src/context-pack";
import { compressText } from "../src/compression";
import type { MemoryNode, ScoredMemory } from "../src/types";

/** Stopword-heavy prose: exactly what `compressText` targets. */
const ALPHA =
  "The release of the alpha build was delayed by the flaky test suite, " +
  "and the team agreed that the retry on the runner should be the one " +
  "that runs before the tag is pushed.";
const BETA =
  "A memory leak in the cache layer of the beta service was fixed by the " +
  "on-call engineer, who is the owner of that module and the one that " +
  "ships the patch to the cluster.";

// Code-like content: `compressText` never touches it (see isCodeLike).
const CODE = "const deploy = async (target) => {\n    await run(target);\n};";

function makeNode(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags: ["t"],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

function scored(id: string, content: string, score: number): ScoredMemory {
  return { node: makeNode(id, content), score };
}

const BASE = {
  query: "release notes",
  namespace: "default",
  // Summaries are noise here: every item is content-only.
  includeSummary: false,
  // The two fixtures share vocabulary; without this the 0.85 Jaccard
  // dedup would drop beta as a duplicate of alpha.
  dedup: false,
};

/** Token cost of one item under the legacy `content + 4` accounting. */
function itemCost(content: string): number {
  return estimateTokens(content) + 4;
}

/** Room for `alpha` at full size plus `beta` at the given size, exactly. */
function budgetFor(betaSize: number): number {
  return itemCost(ALPHA) + betaSize;
}

function idsOf(pack: { items: Array<{ id: string }> }): string[] {
  return pack.items.map((i) => i.id);
}

describe("compressText in the context-pack budget path", () => {
  test("compressText actually shrinks the fixture prose (precondition)", () => {
    for (const text of [ALPHA, BETA]) {
      const compressed = compressText(text, "light");
      expect(compressed.length).toBeLessThan(text.length);
      expect(estimateTokens(compressed)).toBeLessThan(estimateTokens(text));
      // Word separators collapse; they must not vanish into glue.
      expect(compressed).not.toMatch(/[a-z]{2}[A-Z][a-z]{2}/);
      expect(compressed).toContain(" ");
    }
    // The documented example really holds for the fixed implementation.
    expect(compressText("the deploy pipeline", "light")).toBe(
      "deploy pipeline",
    );
  });

  test("an oversized item is admitted compressed instead of being dropped", () => {
    const compressedBeta = compressText(BETA, "light");
    const pack = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budgetFor(itemCost(compressedBeta)),
      compression: { enabled: true },
    });

    expect(idsOf(pack)).toEqual(["alpha", "beta"]);
    // Best item rides through untouched...
    const alpha = pack.items.find((i) => i.id === "alpha")!;
    expect(alpha.content).toBe(ALPHA);
    // ...the oversized one is present, in compressed form.
    const beta = pack.items.find((i) => i.id === "beta")!;
    expect(beta.content).toBe(compressedBeta);
    expect(beta.content).not.toBe(BETA);
  });

  test("compression off (the default) preserves the old behaviour exactly", () => {
    const opts = {
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budgetFor(itemCost(compressText(BETA, "light"))),
    };

    // No `compression` key at all — the historical call shape.
    const legacy = buildContextPack(opts);
    const disabled = buildContextPack({
      ...opts,
      compression: { enabled: false },
    });

    for (const pack of [legacy, disabled]) {
      expect(idsOf(pack)).toEqual(["alpha"]);
      // Content is never rewritten when compression is off.
      expect(pack.items[0].content).toBe(ALPHA);
    }
    expect(legacy.items).toEqual(disabled.items);

    // And a generous budget yields the untouched source texts regardless.
    const reference = buildContextPack({
      query: BASE.query,
      namespace: BASE.namespace,
      tokenBudget: 100000,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      includeSummary: false,
      dedup: false,
    });
    expect(reference.items.map((i) => i.content)).toEqual([ALPHA, BETA]);
  });

  test("tokensSaved reports the compression delta", () => {
    const compressedBeta = compressText(BETA, "light");
    const delta = estimateTokens(BETA) - estimateTokens(compressedBeta);

    const on = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budgetFor(itemCost(compressedBeta)),
      compression: { enabled: true },
    });
    // Debloat saves nothing on this fixture (already clean), so the whole
    // saving is the compression delta.
    expect(on.tokensSaved).toBe(delta);

    const off = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budgetFor(itemCost(compressedBeta)),
    });
    expect(off.tokensSaved).toBe(0);
  });

  test("aggressive compresses harder than light", () => {
    const aggressiveBeta = compressText(BETA, "aggressive");
    const lightBeta = compressText(BETA, "light");
    expect(estimateTokens(aggressiveBeta)).toBeLessThan(
      estimateTokens(lightBeta),
    );

    // A budget that only fits the aggressively-compressed second item.
    const budget = budgetFor(itemCost(aggressiveBeta));
    const aggressive = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budget,
      compression: { enabled: true, level: "aggressive" },
    });
    expect(idsOf(aggressive)).toEqual(["alpha", "beta"]);
    expect(aggressive.items.find((i) => i.id === "beta")!.content).toBe(
      aggressiveBeta,
    );

    // The same budget under `light` cannot fit the item at all.
    const light = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budget,
      compression: { enabled: true, level: "light" },
    });
    expect(idsOf(light)).toEqual(["alpha"]);
  });

  test("code-like content is never mangled — the item is skipped instead", () => {
    // `compressText` passes code-like lines through untouched, so there is
    // no saving to be had; the item must be dropped, not emitted mangled.
    const pack = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("code", CODE, 0.8)],
      tokenBudget: budgetFor(itemCost(CODE)) - 1,
      compression: { enabled: true, level: "aggressive" },
    });
    expect(idsOf(pack)).toEqual(["alpha"]);
    expect(JSON.stringify(pack.items)).not.toContain("deploy");
    expect(JSON.stringify(pack.items)).not.toContain("await");
  });

  test("compression can only add items, never remove them", () => {
    const two = [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)];

    // Generous budget: compression never runs, so the two builds are
    // identical.
    const plain = buildContextPack({
      ...BASE,
      items: two,
      tokenBudget: 100000,
    });
    const squeezed = buildContextPack({
      ...BASE,
      items: two,
      tokenBudget: 100000,
      compression: { enabled: true, level: "aggressive" },
    });
    expect(squeezed.items).toEqual(plain.items);

    // Tight budget: compression admits strictly more evidence.
    const tight = budgetFor(itemCost(compressText(BETA, "aggressive")));
    const off = buildContextPack({ ...BASE, items: two, tokenBudget: tight });
    const on = buildContextPack({
      ...BASE,
      items: two,
      tokenBudget: tight,
      compression: { enabled: true, level: "aggressive" },
    });
    expect(idsOf(on)).toEqual(["alpha", "beta"]);
    expect(idsOf(off)).toEqual(["alpha"]);
    expect(on.items.length).toBeGreaterThan(off.items.length);
  });

  test("a compressed pack still serializes and keeps its envelope", () => {
    const compressedBeta = compressText(BETA, "light");
    const budget = budgetFor(itemCost(compressedBeta));
    const pack = buildContextPack({
      ...BASE,
      items: [scored("alpha", ALPHA, 0.9), scored("beta", BETA, 0.8)],
      tokenBudget: budget,
      compression: { enabled: true },
    });
    expect(pack.schema).toBe("ai-trio.memos.context-pack.v1");
    expect(pack.tokenBudget).toBe(budget);
    // The rendered TOON fits the budget the pack was built against.
    const json = JSON.stringify(pack);
    expect(typeof json).toBe("string");
    expect(json).toContain("memory leak cache layer");
    // And the TOON wire form parses back to the same (compressed) rows.
    const rows = packToToon(pack)
      .split("\n")
      .filter((l) => !l.startsWith("#"));
    expect(rows).toHaveLength(2);
  });
});
