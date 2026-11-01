/**
 * Regression suite for the default-on dedup guard and the
 * compress-before-drop trimming fallback (compression accuracy audit
 * findings 4 and 7g).
 *
 * THE BUG (finding 4, live-verified): pack dedup was ON by default at a
 * Jaccard threshold of 0.85 (with an opt-in semantic pass at cosine
 * 0.99), and both passes were pure similarity gates. Token-set
 * similarity is order-blind and value-blind, so two facts that shared
 * ~90% of their vocabulary scored 1.0/0.99 and the pack silently deleted
 * one of them:
 *
 * ```
 * A: "User moved the deploy script from the runner to the cluster and set retries to 3."
 * B: "User moved the deploy script from the cluster to the runner and set retries to 3."
 * ```
 *
 * Source and destination inverted — the single most decision-relevant
 * difference there is — was scored as noise. `pool size 20` vs
 * `pool size 40` collapsed the same way. The token savings that
 * motivated the feature were real; the collateral deletion of distinct
 * facts was not.
 *
 * The fix gates every drop (lexical AND semantic) on
 * `carriesDistinctFact`: a drop only happens when the discriminating
 * tokens agree. Genuine redundancy still collapses — a dedup pass that
 * stops saving tokens is not the goal.
 *
 * THE SECOND BUG (finding 7g): `packToToonCompact(maxTokens)` trimmed by
 * score alone, discarding the lowest-scored items whole without first
 * attempting compression. The tail is where the specific facts live, so
 * a tight budget lost entire memories when their filler alone would
 * have paid for the row.
 *
 * Both fixes are covered here at the public API surface.
 */

import {
  buildContextPack,
  estimateTokens,
  packToToonCompact,
  parseToonCompact,
} from "../src/context-pack";
import type { EmbeddingVector, MemoryNode, ScoredMemory } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The audit's live-verified inversion pair. Jaccard(A, B) === 1.0 —
 * identical token SETS — because source and destination are the same two
 * words in the opposite order.
 */
const INVERTED_A =
  "User moved the deploy script from the runner to the cluster and set retries to 3";
const INVERTED_B =
  "User moved the deploy script from the cluster to the runner and set retries to 3";

/** Same fact, same number changed. Set-similarity cannot see the value. */
const POOL_20 = "The postgres connection pool size is 20 in src/db.ts";
const POOL_40 = "The postgres connection pool size is 40 in src/db.ts";

/** Unit-glued numbers: `250ms` vs `250s` is a 1000x difference. */
const LAT_MS = "Latency budget is 250ms";
const LAT_S = "Latency budget is 250s";

/** Negation is polarity, not vocabulary. */
const MIG_OK = "The migration has not failed";
const MIG_FAIL = "The migration has failed";

/** Genuine redundancy — byte-identical. Must still collapse. */
const DUP_1 = "User prefers dark mode in editors";
const DUP_2 = "User prefers dark mode in editors";

/** Differs ONLY in function words — no fact changed. Must still collapse. */
const STOPWORDS_1 = "the user prefers dark mode in the editors";
const STOPWORDS_2 = "User prefers dark mode in editors";

function makeNode(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags: [],
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

/** A vector with cosine similarity `sim` to [1, 0, 0, 0]. */
function nearVec(sim: number): EmbeddingVector {
  const rest = Math.sqrt(Math.max(0, 1 - sim * sim));
  return [sim, rest, 0, 0];
}

function idsOf(pack: { items: Array<{ id: string }> }): string[] {
  return pack.items.map((i) => i.id);
}

const BASE = {
  query: "deploy",
  namespace: "default",
  // Summaries are noise here: every fixture is content-only.
  includeSummary: false,
  // A budget large enough that trimming never runs — these tests are
  // about DEDUP, and dedup runs before the budget check.
  tokenBudget: 1_000_000,
} as const;

// ---------------------------------------------------------------------------
// The guard: distinct facts survive default-on dedup
// ---------------------------------------------------------------------------

describe("dedup discriminating-token guard (audit finding 4)", () => {
  // --- Preconditions: prove the similarity scores really are blind ---

  test("the inversion pair scores as an identical token set (precondition)", () => {
    // This is the whole reason the bug existed: the pack's similarity
    // signal cannot tell A from B, so the GUARD has to. Asserted here so
    // a future tokenizer change that makes the fixture discriminating is
    // visible rather than silently de-fanging the regression.
    const tokens = (t: string) =>
      new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
    const setA = tokens(INVERTED_A);
    const setB = tokens(INVERTED_B);
    expect(setA.size).toBe(setB.size);
    for (const tok of setA) expect(setB.has(tok)).toBe(true);
    // And the number pair shares most of its vocabulary too — the number
    // is 1 token out of 6, so set-similarity reads them as near-twins.
    const tokens20 = new Set(
      POOL_20.toLowerCase().split(/\W+/).filter(Boolean),
    );
    const tokens40 = new Set(
      POOL_40.toLowerCase().split(/\W+/).filter(Boolean),
    );
    let inter = 0;
    for (const t of tokens20) if (tokens40.has(t)) inter += 1;
    const union = tokens20.size + tokens40.size - inter;
    expect(inter / union).toBeGreaterThan(0.8);
  });

  // --- The regression itself ---

  test("an inverted source/destination pair BOTH survive the default pack", () => {
    const pack = buildContextPack({
      ...BASE,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
    });
    // `dedup` is not passed at all — this is the DEFAULT-ON path that
    // used to delete B.
    expect(idsOf(pack)).toEqual(["a", "b"]);
    expect(pack.items.find((i) => i.id === "a")!.content).toBe(INVERTED_A);
    expect(pack.items.find((i) => i.id === "b")!.content).toBe(INVERTED_B);
    // Nothing was suppressed, so nothing is reported as saved.
    expect(pack.tokensSaved).toBe(0);
  });

  test("the same pair survives with dedup explicitly enabled", () => {
    const pack = buildContextPack({
      ...BASE,
      dedup: true,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["a", "b"]);
  });

  test("a changed number keeps BOTH facts", () => {
    const pack = buildContextPack({
      ...BASE,
      items: [scored("p20", POOL_20, 0.9), scored("p40", POOL_40, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["p20", "p40"]);
  });

  test("a unit-glued number keeps BOTH facts (250ms vs 250s)", () => {
    const pack = buildContextPack({
      ...BASE,
      items: [scored("ms", LAT_MS, 0.9), scored("s", LAT_S, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["ms", "s"]);
  });

  test("a negated vs unnegated fact keeps BOTH", () => {
    const pack = buildContextPack({
      ...BASE,
      items: [scored("ok", MIG_OK, 0.9), scored("fail", MIG_FAIL, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["ok", "fail"]);
  });

  test("the guard survives an explicit low dedupThreshold", () => {
    // Even a caller who dials the threshold down to catch more
    // near-duplicates must not lose an inverted fact.
    const pack = buildContextPack({
      ...BASE,
      dedupThreshold: 0.6,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["a", "b"]);
  });

  test("the higher-scored item is the one that survives any suppression", () => {
    // The guard keeps both here, but its unit of work is a PAIR, so
    // confirm the sort contract still holds when the survivor is chosen.
    const pack = buildContextPack({
      ...BASE,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
    });
    expect(pack.items[0].id).toBe("a");
    expect(pack.items[0].score).toBeGreaterThan(pack.items[1].score);
  });

  // --- The semantic pass has the same guard ---

  test("semantic dedup (cosine 0.99) no longer deletes the inverted twin", () => {
    // Both items get the SAME vector, so cosine === 1.0 — far above the
    // 0.99 threshold. The guard is the only thing keeping B alive.
    const embeddings = new Map<string, EmbeddingVector>([
      ["a", [1, 0, 0, 0]],
      ["b", [1, 0, 0, 0]],
    ]);
    const pack = buildContextPack({
      ...BASE,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
      embeddings,
    });
    expect(idsOf(pack)).toEqual(["a", "b"]);
  });

  test("semantic dedup keeps BOTH of a changed number", () => {
    const embeddings = new Map<string, EmbeddingVector>([
      ["p20", nearVec(0.99)],
      ["p40", nearVec(0.99)],
    ]);
    const pack = buildContextPack({
      ...BASE,
      items: [scored("p20", POOL_20, 0.9), scored("p40", POOL_40, 0.8)],
      embeddings,
    });
    expect(idsOf(pack)).toEqual(["p20", "p40"]);
  });

  test("semantic dedup still drops a genuine paraphrase and reports the saving", () => {
    // The token savings are the point of the feature — the guard must not
    // disable dedup, only make it honest.
    const embeddings = new Map<string, EmbeddingVector>([
      ["n1", [1, 0, 0, 0]],
      ["n2", [0.98, 0.199, 0, 0]], // cosine ~0.979 — a paraphrase
      ["n3", [0, 0, 1, 0]], // orthogonal — distinct
    ]);
    const pack = buildContextPack({
      ...BASE,
      items: [
        scored("n1", "User prefers dark theme", 0.9),
        scored("n2", "dark mode is their preference", 0.8),
        scored("n3", "Completely unrelated fact", 0.7),
      ],
      embeddings,
    });
    expect(idsOf(pack)).toContain("n1");
    expect(idsOf(pack)).not.toContain("n2");
    expect(idsOf(pack)).toContain("n3");
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  // --- The savings path must keep working ---

  test("a TRUE near-duplicate still collapses and counts as saved", () => {
    const pack = buildContextPack({
      ...BASE,
      items: [
        scored("n1", DUP_1, 0.9),
        scored("n2", DUP_2, 0.8),
        scored("n3", "Completely unrelated fact about cooking", 0.7),
      ],
    });
    const ids = idsOf(pack);
    expect(ids).toContain("n1");
    expect(ids).not.toContain("n2");
    expect(ids).toContain("n3");
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  test("a difference confined to function words still collapses", () => {
    // "the user prefers dark mode in the editors" vs
    // "User prefers dark mode in editors" — no content word changed, so
    // the pack should keep paying for only one row.
    const pack = buildContextPack({
      ...BASE,
      items: [scored("x1", STOPWORDS_1, 0.9), scored("x2", STOPWORDS_2, 0.8)],
    });
    const ids = idsOf(pack);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe("x1");
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  // --- Escape hatch ---

  test("dedupKeepIfDistinct: false restores pure threshold dedup", () => {
    // The documented escape hatch for callers who want the old
    // behaviour: it must actually delete the inverted twin again.
    const pack = buildContextPack({
      ...BASE,
      dedupKeepIfDistinct: false,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["a"]);
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  test("the guard is inert when dedup is off entirely", () => {
    const pack = buildContextPack({
      ...BASE,
      dedup: false,
      items: [scored("a", INVERTED_A, 0.9), scored("b", INVERTED_B, 0.8)],
    });
    expect(idsOf(pack)).toEqual(["a", "b"]);
  });

  // --- Guard is not a blanket veto ---

  test("unrelated facts are unaffected by the guard", () => {
    const pack = buildContextPack({
      ...BASE,
      items: [
        scored(
          "u1",
          "the alpha build was delayed by the flaky test suite",
          0.9,
        ),
        scored(
          "u2",
          "the beta service has a memory leak in the cache layer",
          0.8,
        ),
      ],
    });
    // These were never duplicates; the guard never entered the picture.
    expect(idsOf(pack)).toEqual(["u1", "u2"]);
  });

  test("three-way clusters only collapse the genuine twins", () => {
    // One inverted fact plus two copies of a third: only the copies go.
    const pack = buildContextPack({
      ...BASE,
      items: [
        scored("a", INVERTED_A, 0.95),
        scored("b", INVERTED_B, 0.9),
        scored("c", DUP_1, 0.85),
        scored("d", DUP_2, 0.8),
      ],
    });
    const ids = idsOf(pack);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids.filter((id) => id === "c" || id === "d")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Compress before drop (audit finding 7g)
// ---------------------------------------------------------------------------

/** Stopword-heavy prose — exactly what `compressText` shrinks. */
const WORDY = (id: string, topic: string): ScoredMemory =>
  scored(
    id,
    `The release of the ${topic} build was delayed by the flaky test suite, ` +
      `and the team agreed that the retry on the runner should be the one ` +
      `that runs before the tag is pushed.`,
    0.9,
  );

/** Already-terse content — `compressText` cannot shrink it. */
const TERSE = (id: string, score: number): ScoredMemory =>
  scored(id, `Item ${id} evidence`, score);

describe("compact TOON trims by compressing before dropping (audit finding 7g)", () => {
  function prosePack(n: number) {
    return buildContextPack({
      query: "release notes",
      namespace: "default",
      tokenBudget: Number.MAX_SAFE_INTEGER,
      includeSummary: false,
      items: Array.from({ length: n }, (_, i) =>
        WORDY(`w${i}`, ["alpha", "beta", "gamma", "delta", "epsilon"][i % 5]),
      ),
    });
  }

  test("compression alone admits EVERY item instead of dropping the tail", () => {
    const pack = prosePack(4);
    const full = packToToonCompact(pack);
    const fullTokens = estimateTokens(full);
    expect(fullTokens).toBeGreaterThan(100);

    // A budget the full pack misses but the compressed one makes. Under
    // the old score-only trim this would have returned 1-2 rows.
    const compressedOnly = packToToonCompact(
      pack,
      estimateTokens,
      Math.floor(fullTokens * 0.85),
    );
    expect(estimateTokens(compressedOnly)).toBeLessThanOrEqual(
      Math.floor(fullTokens * 0.85),
    );
    // THE POINT: nothing was dropped — every fact is still on the wire.
    expect(parseToonCompact(compressedOnly)).toHaveLength(4);
  });

  test("the compressed output really is smaller than the dropped one", () => {
    const pack = prosePack(4);
    const full = packToToonCompact(pack);
    // A budget only the compressed form can hit.
    const target = estimateTokens(
      packToToonCompact(
        pack,
        estimateTokens,
        Math.floor(estimateTokens(full) * 0.85),
      ),
    );
    const compressed = packToToonCompact(
      pack,
      estimateTokens,
      Math.floor(estimateTokens(full) * 0.85),
    );
    // Compressed output is strictly shorter than the untrimmed full pack.
    expect(estimateTokens(compressed)).toBeLessThan(estimateTokens(full));
    // And it carried strictly more rows than a pure score-trim at the
    // same budget would have (rows the trim would have discarded).
    expect(parseToonCompact(compressed).length).toBe(4);
    expect(target).toBeGreaterThan(0);
  });

  test("content is compressed, not dropped, and function words are gone", () => {
    const pack = prosePack(2);
    const out = packToToonCompact(
      pack,
      estimateTokens,
      Math.floor(estimateTokens(packToToonCompact(pack)) * 0.85),
    );
    const rows = parseToonCompact(out);
    expect(rows).toHaveLength(2);
    // The content-word payload of the fact survives...
    expect(out).toContain("release");
    expect(out).toContain("alpha");
    // ...and the filler compression is supposed to remove is gone.
    expect(rows[0].content).not.toMatch(/\bthe\b/i);
  });

  test("an impossible budget still drops by score, from the COMPRESSED set", () => {
    // Terse content cannot be compressed, so the trim runs — and it must
    // keep the score-aware contract (U-shape pin survives, lowest score
    // dropped) while operating on compressed text.
    const pack = buildContextPack({
      query: "release notes",
      namespace: "default",
      tokenBudget: Number.MAX_SAFE_INTEGER,
      includeSummary: false,
      items: Array.from({ length: 8 }, (_, i) => TERSE(`t${i}`, 1 - i / 100)),
    });
    const out = packToToonCompact(pack, estimateTokens, 60);
    expect(estimateTokens(out)).toBeLessThanOrEqual(60);
    const ids = parseToonCompact(out).map((i) => i.id);
    expect(ids.length).toBeLessThan(8);
    // Best item always present.
    expect(ids).toContain("t0");
    // Every kept item outscores every dropped one.
    const all = pack.items;
    for (const kept of ids) {
      for (const dropped of all
        .map((i) => i.id)
        .filter((id) => !ids.includes(id))) {
        expect(all.find((i) => i.id === kept)!.score).toBeGreaterThanOrEqual(
          all.find((i) => i.id === dropped)!.score,
        );
      }
    }
  });

  test("no budget still renders the whole pack byte-identically", () => {
    const pack = prosePack(4);
    const noBudget = packToToonCompact(pack);
    const withCounter = packToToonCompact(pack, estimateTokens);
    expect(withCounter).toBe(noBudget);
    // Nothing was compressed when no ceiling was imposed — the source
    // function words are still on the wire.
    expect(noBudget).toContain("The release of the alpha");
    expect(noBudget).toContain("was delayed by the flaky test suite");
  });

  test("a budget the full pack already fits changes nothing", () => {
    const pack = prosePack(4);
    const full = packToToonCompact(pack);
    const roomy = packToToonCompact(pack, estimateTokens, 10_000);
    expect(roomy).toBe(full);
  });

  test("the compressed pack keeps its envelope, trailer and row shape", () => {
    const pack = prosePack(4);
    const out = packToToonCompact(
      pack,
      estimateTokens,
      Math.floor(estimateTokens(packToToonCompact(pack)) * 0.85),
    );
    expect(out).toContain("# ai-trio.memos.context-pack.v1");
    expect(out).toContain("# q=release notes");
    // Rows still parse — compression must not corrupt the pipe layout.
    for (const item of parseToonCompact(out)) {
      expect(typeof item.id).toBe("string");
      expect(item.content.length).toBeGreaterThan(0);
    }
  });

  test("even the single best item over budget is still emitted, compressed", () => {
    const pack = prosePack(4);
    const out = packToToonCompact(pack, estimateTokens, 1);
    const rows = parseToonCompact(out);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(out).toContain("alpha");
  });
});
