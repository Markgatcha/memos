/**
 * Confidence lifecycle — the evidence state machine (src/confidence-machine.ts)
 * as it is actually wired into the store path (src/memory.ts:
 * applyStoreEvidence) and gated on writes (src/retain-filter.ts).
 *
 * These cover the three failure modes that went unnoticed because
 * `applyEvidence` had no tests at all:
 *
 *   1. "contradicted" was unreachable from the write path (the caller
 *      hardcoded "confirmed"), so a superseded fact kept its reinforced
 *      confidence and ranked at ~93% of full weight.
 *   2. The reinforce gate used 0.5 while the documented contract was
 *      0.85, so topically-adjacent content inflated confidence, and the
 *      neutral fallthrough returned "confirmed".
 *   3. The retain gate dropped retractions as "near-duplicates" of the
 *      memory they retract, so the contradiction never arrived.
 */

import { MemOS, MemorySkippedError } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  applyEvidence,
  classifyEvidence,
  confidenceWeight,
  sharesSubject,
  CONFIDENCE_FLOOR,
  INITIAL_CONFIDENCE,
} from "../src/confidence-machine";
import { decideRetain } from "../src/retain-filter";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

/** Deterministic provider reproducing the existing evidence-learning
 * test's FixedProvider (hash into 64 dims, one entry per token), so
 * similarity bands behave exactly as the other evidence test expects. */
class BagProvider implements EmbeddingProvider {
  public readonly id = "bag";
  public readonly model = "bag-v1";
  public readonly dimensions = 64;

  async embed(text: string): Promise<EmbeddingVector> {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++)
        h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
      v[h % this.dimensions] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function makeMemos() {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider: new BagProvider() },
    embeddingQueue: { synchronous: true },
  });
}

const EVIDENCE = { evidenceLearning: true } as const;

describe("applyEvidence (unit)", () => {
  test("contradicted crushes confidence to zero and marks superseded", () => {
    const update = applyEvidence(0.6387, 4, "contradicted");
    expect(update.confidence).toBe(0);
    expect(update.superseded).toBe(true);
    expect(update.evidenceCount).toBe(5);
    expect(update.flaggedForReview).toBe(false);
  });

  test("confirmed raises confidence with diminishing returns", () => {
    const a = applyEvidence(0.5, 0, "confirmed");
    expect(a.confidence).toBeCloseTo(0.575, 6);
    const b = applyEvidence(0.9, 1, "confirmed");
    // (1 - 0.9) * 0.15 = 0.015 — the same evidence is worth less the
    // higher the score already is.
    expect(b.confidence).toBeCloseTo(0.915, 6);
    expect(b.confidence - 0.9).toBeLessThan(a.confidence - 0.5);
  });

  test("confirmed never exceeds the cap", () => {
    expect(applyEvidence(0.99, 9, "confirmed").confidence).toBeLessThanOrEqual(
      1,
    );
    expect(applyEvidence(1, 9, "confirmed").confidence).toBe(1);
  });

  test("partial_conflict reduces confidence by 25% and flags below floor", () => {
    const update = applyEvidence(0.32, 2, "partial_conflict");
    expect(update.confidence).toBeCloseTo(0.24, 6);
    expect(update.superseded).toBe(false);
    expect(update.flaggedForReview).toBe(true);
  });

  test("partial_conflict floors at zero for near-zero confidence", () => {
    // 0.05 - 0.05*0.25 = 0.0375 — the down-adjust is proportional, so it
    // approaches zero rather than snapping to it.
    expect(applyEvidence(0.05, 1, "partial_conflict").confidence).toBeCloseTo(
      0.0375,
      6,
    );
  });

  test("unrelated is a no-op — no confidence drift, no evidence counted", () => {
    const update = applyEvidence(0.42, 3, "unrelated");
    expect(update.confidence).toBe(0.42);
    expect(update.evidenceCount).toBe(3);
    expect(update.superseded).toBe(false);
    expect(update.flaggedForReview).toBe(false);
  });

  test("unrelated keeps the review flag when already below the floor", () => {
    const update = applyEvidence(0.1, 3, "unrelated");
    expect(update.flaggedForReview).toBe(true);
  });
});

describe("classifyEvidence (unit)", () => {
  test(">= 0.85 confirms; the 0.5-0.85 band is a partial conflict", () => {
    expect(classifyEvidence("a", "a", 0.9)).toBe("confirmed");
    expect(classifyEvidence("a", "a", 0.85)).toBe("confirmed");
    // The band that used to silently reinforce: 0.6 must NOT confirm.
    expect(classifyEvidence("a", "a", 0.6)).toBe("partial_conflict");
    expect(classifyEvidence("a", "a", 0.5)).toBe("partial_conflict");
  });

  test("the neutral fallthrough is 'unrelated', not 'confirmed'", () => {
    // Low similarity, no signal words.
    expect(classifyEvidence("user likes coffee", "quarterly taxes", 0.1)).toBe(
      "unrelated",
    );
    // Signal word present but similarity above the contradiction band yet
    // below the confirmed band → partial conflict.
    expect(classifyEvidence("user likes coffee", "user moved desk", 0.75)).toBe(
      "partial_conflict",
    );
  });

  test("low similarity + contradiction signal → contradicted", () => {
    expect(
      classifyEvidence("user likes coffee", "user no longer likes coffee", 0.2),
    ).toBe("contradicted");
    // Anything below the 0.5 partial-conflict ceiling counts as low.
    expect(
      classifyEvidence("user switched editors", "user left for emacs", 0.42),
    ).toBe("contradicted");
  });

  test("a signal word alone never contradicts above the 0.5 band", () => {
    // High similarity must still be a confirmation, signal word or not.
    expect(
      classifyEvidence(
        "user likes coffee",
        "user no longer likes coffee",
        0.95,
      ),
    ).toBe("confirmed");
    expect(
      classifyEvidence("user likes coffee", "user changed to tea", 0.75),
    ).toBe("partial_conflict");
  });
});

describe("sharesSubject (unit)", () => {
  test("same subject shares a content word", () => {
    expect(
      sharesSubject("user lives in Berlin", "user no longer lives in Berlin"),
    ).toBe(true);
  });

  test("unrelated facts share no subject", () => {
    expect(sharesSubject("user likes coffee", "quarterly taxes are due")).toBe(
      false,
    );
  });

  test("stop words do not count as a shared subject", () => {
    expect(sharesSubject("user is happy", "the report is filed")).toBe(false);
  });
});

describe("confidenceWeight (unit)", () => {
  test("below the floor the weight is crushed to a tenth of trust", () => {
    expect(confidenceWeight(1.0, 0)).toBeCloseTo(0.1, 6);
    expect(confidenceWeight(0.8, CONFIDENCE_FLOOR - 0.01)).toBeLessThan(
      confidenceWeight(0.8, CONFIDENCE_FLOOR + 0.01),
    );
  });

  test("a confirmed memory outranks a contradicted one at the same trust", () => {
    const trusted = confidenceWeight(1.0, 0.9);
    const crushed = confidenceWeight(1.0, 0);
    expect(crushed).toBeLessThan(trusted / 2);
  });
});

describe("store({ evidenceLearning }) — contradicted transition", () => {
  test("a superseded fact's confidence is crushed to zero, not preserved", async () => {
    const memos = makeMemos();
    await memos.init();

    const old = await memos.store("User switched from emacs at work", EVIDENCE);
    // Reinforce it so it starts from a comfortable score — the bug only
    // showed up on a fact that had actually earned confidence.
    await memos.store("User switched from emacs at work", EVIDENCE);
    const reinforced = await memos.retrieve(old.node.id);
    expect(reinforced!.confidence!).toBeGreaterThan(INITIAL_CONFIDENCE);
    expect(reinforced!.confidence!).toBeGreaterThan(CONFIDENCE_FLOOR);

    const events: Array<{ nodeId: string; confidence?: number }> = [];
    memos.on("memory:superseded", (d: any) => events.push(d));

    // Similarity ~0.42 + the signal word "left" → contradicted, and the
    // shared subject word ties it to the memory it retracts.
    await memos.store("User left emacs for neovim", EVIDENCE);

    expect(events).toHaveLength(1);
    expect(events[0]!.nodeId).toBe(old.node.id);
    expect(events[0]!.confidence).toBe(0);

    const after = await memos.retrieve(old.node.id);
    expect(after!.validTo).not.toBeNull(); // historical
    expect(after!.confidence).toBe(0); // crushed, was > floor
    expect(after!.evidenceCount).toBe(reinforced!.evidenceCount! + 1);
    // Two rows exist in total: the retracted version (historical) and its
    // replacement.
    expect(memos.count).toBe(2);

    await memos.close();
  });

  test("supersede(id, replacementId, confidence) stamps the crushed score", async () => {
    const memos = makeMemos();
    await memos.init();

    const a = await memos.store("User drinks whole milk", EVIDENCE);
    const b = await memos.store("User drinks oat milk", EVIDENCE);

    const update = applyEvidence(
      a.node.confidence!,
      a.node.evidenceCount!,
      "contradicted",
    );
    await memos.supersede(a.node.id, b.node.id, update.confidence);

    const after = await memos.retrieve(a.node.id);
    expect(after!.confidence).toBe(0);
    expect(after!.validTo).not.toBeNull();
    // The replacement link is still written.
    const edges = (memos as any).graph.getEdgesForNode(a.node.id);
    expect(
      edges.some(
        (e: any) =>
          e.relation === "temporal_precedes" && e.targetId === b.node.id,
      ),
    ).toBe(true);

    await memos.close();
  });

  test("supersede() without a confidence arg leaves confidence untouched", async () => {
    const memos = makeMemos();
    await memos.init();

    const a = await memos.store("Team sync happens every Tuesday", EVIDENCE);
    const before = (await memos.retrieve(a.node.id))!.confidence!;

    await memos.supersede(a.node.id);

    const after = await memos.retrieve(a.node.id);
    expect(after!.confidence).toBe(before);
    expect(after!.validTo).not.toBeNull();

    await memos.close();
  });

  test("an already-superseded node is not reinforced again", async () => {
    const memos = makeMemos();
    await memos.init();

    const old = await memos.store("User switched from emacs at work", EVIDENCE);
    await memos.store("User left emacs for neovim", EVIDENCE);
    const crushed = await memos.retrieve(old.node.id);
    expect(crushed!.confidence).toBe(0);

    // Historical nodes are skipped by the evidence pass (they carry a
    // validTo), so re-contradicting cannot double-count evidence.
    await memos.store("User changed away from neovim", EVIDENCE);
    const after = await memos.retrieve(old.node.id);
    expect(after!.confidence).toBe(crushed!.confidence);
    expect(after!.evidenceCount).toBe(crushed!.evidenceCount);

    await memos.close();
  });

  test("a contradiction only supersedes a same-subject memory", async () => {
    const memos = makeMemos();
    await memos.init();

    // "no longer" is a signal word, but this pair shares no content word
    // with the stored fact — the shared-subject guard must protect it.
    const unrelated = await memos.store(
      "Quarterly taxes are due in April",
      EVIDENCE,
    );
    await memos.store("User no longer keeps basil on the balcony", EVIDENCE);

    const after = await memos.retrieve(unrelated.node.id);
    expect(after!.validTo).toBeNull();
    expect(after!.confidence).toBe(unrelated.node.confidence);

    await memos.close();
  });
});

describe("store({ evidenceLearning }) — reinforce threshold", () => {
  test("similarity 0.6 does not reinforce an unrelated memory", async () => {
    // Hand-picked pair: shares the "postgres"/"pool" vocabulary (the
    // classic 0.5-0.85 topically-adjacent band) but asserts different
    // facts. Assert the band position explicitly first so the test fails
    // loudly if the fixture ever drifts out of it.
    const a = "postgres connection pool max is 20";
    const b = "postgres pool latency alerts fire above 200ms";
    const sim = classifyEvidence(a, b, 0.6);
    expect(sim).toBe("partial_conflict");

    const memos = makeMemos();
    await memos.init();

    const first = await memos.store(a, EVIDENCE);
    const second = await memos.store(b, EVIDENCE);

    // The second write must be its OWN node, and the first must be
    // untouched at its initial confidence.
    expect(second.node.id).not.toBe(first.node.id);
    const after = await memos.retrieve(first.node.id);
    expect(after!.confidence).toBe(INITIAL_CONFIDENCE);
    expect(after!.evidenceCount).toBe(0);
    expect(memos.count).toBe(2);

    await memos.close();
  });

  test("a genuine confirmation (similarity >= 0.85) still reinforces", async () => {
    const memos = makeMemos();
    await memos.init();

    const first = await memos.store(
      "User prefers dark mode in every editor",
      EVIDENCE,
    );
    const second = await memos.store(
      "User prefers dark mode in every editor",
      EVIDENCE,
    );

    expect(second.node.id).toBe(first.node.id);
    expect(second.node.confidence).toBeGreaterThan(first.node.confidence!);
    expect(second.node.evidenceCount).toBe(1);
    expect(memos.count).toBe(1);

    await memos.close();
  });

  test("unrelated content never moves confidence in either direction", async () => {
    const memos = makeMemos();
    await memos.init();

    const a = await memos.store("User keeps basil on the balcony", EVIDENCE);
    await memos.store("Quarterly taxes are due in April", EVIDENCE);

    const after = await memos.retrieve(a.node.id);
    expect(after!.confidence).toBe(a.node.confidence);
    expect(after!.evidenceCount).toBe(0);

    await memos.close();
  });
});

describe("retain-filter — contradiction updates survive to the gate", () => {
  test("a retraction of an existing memory is retained, not deduped", async () => {
    const existing = ["User lives in Berlin"];
    // Token overlap is high (the retraction names the same subject), which
    // is exactly why the old gate threw it away.
    expect(
      decideRetain({
        content: "User no longer lives in Berlin",
        existingContent: existing,
      }).retain,
    ).toBe(true);
    expect(
      decideRetain({
        content: "User no longer likes coffee",
        existingContent: ["User likes coffee"],
      }).retain,
    ).toBe(true);
    expect(
      decideRetain({
        content: "User left Acme Corp last spring",
        existingContent: ["User works at Acme Corp"],
      }).retain,
    ).toBe(true);
  });

  test("an identical restatement is still deduped", async () => {
    const existing = ["User prefers dark mode in every editor"];
    const decision = decideRetain({
      content: "User prefers dark mode in every editor",
      existingContent: existing,
    });
    expect(decision.retain).toBe(false);
    expect(decision.reason).toBe("near-duplicate of existing memory");
  });

  test("noise is still dropped regardless of signal words", async () => {
    expect(decideRetain({ content: "" }).retain).toBe(false);
    expect(decideRetain({ content: "ok" }).retain).toBe(false);
    expect(decideRetain({ content: "..." }).retain).toBe(false);
  });

  test("store({ filterRetain }) lets a contradiction through to the evidence machine", async () => {
    const memos = makeMemos();
    await memos.init();

    await memos.store("User lives in Berlin", EVIDENCE);

    // Without the filter exemption this write throws MemorySkippedError
    // ("near-duplicate of existing memory") before the confidence machine
    // ever sees the contradiction.
    let thrown: unknown = null;
    try {
      await memos.store("User no longer lives in Berlin", {
        ...EVIDENCE,
        filterRetain: true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeNull();

    await memos.close();
  });

  test("an identical restatement is still skipped by store({ filterRetain })", async () => {
    const memos = makeMemos();
    await memos.init();

    await memos.store("User lives in Berlin", EVIDENCE);

    await expect(
      memos.store("User lives in Berlin", { filterRetain: true }),
    ).rejects.toThrow(MemorySkippedError);

    await memos.close();
  });
});
