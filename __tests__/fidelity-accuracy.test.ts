/**
 * Fidelity accuracy tests — the composition bugs the unit tests miss.
 *
 * `__tests__/fidelity.test.ts` tests `routeFidelity`, `levelText` and
 * `recall()` separately. The bugs lived in their COMPOSITION:
 *   - an adaptive route to L0 whose tag/entity listing cleared the
 *     0.15 coverage threshold, so the model received
 *     "tags: postgres | entities: postgres" as the answer to
 *     "postgres pool size" and everything it said was invention;
 *   - escalation gated purely on IDF term presence, which scores
 *     "pool size = 20" and "pool size reduced from 40" identically;
 *   - the L2 extractive summary dropping the sentence that carries
 *     the number — a unique sentence scores LOW on centrality
 *     precisely because it shares vocabulary with nothing.
 *
 * Each test below pins one of those behaviors.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  fidelityL2,
  isInformationDense,
  queryDecisiveTokens,
  rankSentencesByCentrality,
  resolveRecallLevels,
  routeFidelity,
  splitSentences,
  textHasDecisiveToken,
  fidelityLevelSufficient,
  shouldCompressFidelityItem,
} from "../src/fidelity";
import type { MemoryNode } from "../src/types";

/** Minimal MemoryNode factory (mirrors fidelity.test.ts). */
function makeNode(
  id: string,
  content: string,
  opts: {
    tags?: string[];
    entities?: string[];
    type?: MemoryNode["type"];
  } = {},
): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: opts.type ?? "fact",
    metadata: {
      ...(opts.entities ? { entities: opts.entities } : {}),
    },
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags: opts.tags ?? [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  } as MemoryNode;
}

function makeMemos() {
  const storage = new SQLiteStorage(":memory:", true);
  const memos = new MemOS({ storage, embeddings: { enabled: false } });
  return { memos, storage };
}

/**
 * The live-verified regression fixture: a node whose L0 renders as
 * `tags: postgres, config | entities: postgres, railway` and whose
 * content holds the actual answer with a number.
 */
const FACT_NODE = {
  tags: ["postgres", "config"],
  entities: ["postgres", "railway"],
  content:
    "Set the postgres connection pool size to 20 in src/db.ts. " +
    "The default was 10 and it saturated under batch load. " +
    "Railway's hobby plan caps connections at 20, so raising it further " +
    "requires a paid plan upgrade.",
};

// ---------------------------------------------------------------------------
// 1. A factoid query never gets L0 tag soup as the answer
// ---------------------------------------------------------------------------

describe("L0 is never served as the answer", () => {
  test("routeFidelity lifts a decisive-token entity lookup off L0", () => {
    // Exactly the failing query from the audit: 3 words, one entity,
    // no question words — old rule 1 sent it to L0.
    const route = routeFidelity("postgres pool size");
    expect(route.signals.entities).toContain("postgres");
    expect(route.level).not.toBe("L0");
    expect(["L1", "L2", "L3"]).toContain(route.level);
    expect(route.signals.decisiveTokens.length).toBeGreaterThan(0);
  });

  test("bare entity lookup without decisive tokens still routes to L0", () => {
    // L0 remains a legitimate RETRIEVAL affordance: "which memory is
    // about X" — it just is not the answer text.
    expect(routeFidelity("postgres").level).toBe("L0");
    expect(routeFidelity("postgres connection pool").level).toBe("L0");
    expect(routeFidelity("postgres").signals.decisiveTokens).toEqual([]);
  });

  test("resolveRecallLevels floors an adaptive L0 route at L1", () => {
    // Even if a future router revision returned L0 for a decisive
    // query, the escalation floor must lift the start level.
    const { start, floor } = resolveRecallLevels("postgres pool size", {
      fidelity: "adaptive",
    });
    expect(floor).toBe("L1");
    expect(start).not.toBe("L0");
  });

  test("an explicit fidelity:L0 request may still serve L0", () => {
    const { start } = resolveRecallLevels("postgres pool size", {
      fidelity: "L0",
    });
    expect(start).toBe("L0");
  });

  test("recall(adaptive) never returns L0 text for the factoid", async () => {
    const { memos } = makeMemos();
    await memos.init();
    const a = await memos.store(FACT_NODE.content, FACT_NODE);
    const b = await memos.store(
      "The office coffee machine was replaced on Tuesday. It makes great espresso.",
      { tags: ["office"], type: "fact" },
    );
    expect(a.node.id).not.toBe(b.node.id);

    const hits = await memos.recall("postgres pool size", {
      fidelity: "adaptive",
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.level).not.toBe("L0");
    }
    // The served text must actually contain the value, not the tags.
    expect(hits[0]!.text).toContain("20");
    expect(hits[0]!.text).not.toBe(
      "tags: postgres, config | entities: postgres, railway",
    );
    await memos.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Escalation fires when a decisive token is absent from served text
// ---------------------------------------------------------------------------

describe("decisive-token escalation", () => {
  test("queryDecisiveTokens finds numbers, units and negations", () => {
    // "postgres" alone: a pure entity lookup, no decisive token.
    expect(queryDecisiveTokens("postgres")).toEqual([]);
    // "pool size" is a factoid whose answer is a value — decisive.
    expect(queryDecisiveTokens("postgres pool size")).toContain("size");
    expect(queryDecisiveTokens("postgres pool size 20")).toEqual(
      expect.arrayContaining(["20", "size"]),
    );
    expect(queryDecisiveTokens("why not 25 connections?")).toEqual(
      expect.arrayContaining(["not", "25 connections"]),
    );
    expect(queryDecisiveTokens("only 3 retries")).toEqual(
      expect.arrayContaining(["only"]),
    );
    expect(queryDecisiveTokens("only 3 retries")[0]).toMatch(/^3/);
    expect(queryDecisiveTokens("who approved the redis migration?")).toEqual(
      [],
    );
  });

  test("textHasDecisiveToken matches numbers and negations", () => {
    expect(textHasDecisiveToken("pool size is 20", "20")).toBe(true);
    expect(textHasDecisiveToken("pool size is 20", "40")).toBe(false);
    expect(textHasDecisiveToken("we did not migrate", "not")).toBe(true);
    expect(textHasDecisiveToken("we migrated", "not")).toBe(false);
  });

  test("fidelityLevelSufficient fails when the token is absent", () => {
    // The decisive-token leg: coverage can be perfect while the
    // served text still does not answer the question.
    expect(
      fidelityLevelSufficient("pool size 40", "L1", ["pool size is 20"], {
        floor: "L1",
        checkDecisiveTokens: true,
      }),
    ).toBe(false);
    expect(
      fidelityLevelSufficient("pool size 20", "L1", ["pool size is 20"], {
        floor: "L1",
        checkDecisiveTokens: true,
      }),
    ).toBe(true);
    // Below the floor, even perfect coverage is insufficient.
    expect(
      fidelityLevelSufficient("postgres", "L0", ["tags: postgres"], {
        floor: "L1",
        checkDecisiveTokens: false,
      }),
    ).toBe(false);
  });

  test("recall escalates past L1 when the query's number is missing there", async () => {
    const { memos } = makeMemos();
    await memos.init();
    // L1 keeps entity-bearing sentences; make the answer sentence
    // entity-poor so L1 is the trap: high term coverage, wrong value.
    const content =
      "The deploy pipeline runs on GitHub Actions every morning. " +
      "Docker images are built with multi-stage builds to keep them small. " +
      "Integration tests run against an ephemeral Postgres service container. " +
      "The Postgres connection pool size is 40 after last week's tuning pass.";
    await memos.store(content, { tags: ["ci"], type: "fact" });

    const hits = await memos.recall("postgres pool size 40", {
      fidelity: "L1",
      maxFidelity: "L3",
    });
    expect(hits.length).toBeGreaterThan(0);
    // Whatever level served it, the decisive number must be present.
    expect(hits[0]!.text).toContain("40");
    await memos.close();
  });

  test("escalation stops at the ceiling and reports the ledger correctly", async () => {
    const { memos } = makeMemos();
    await memos.init();
    await memos.store(FACT_NODE.content, FACT_NODE);
    const hits = await memos.recall("postgres pool size 20", {
      fidelity: "L0",
      maxFidelity: "L2",
    });
    expect(hits.length).toBeGreaterThan(0);
    // The final served level must NOT appear in its own escalation
    // history (the old off-by-one pushed it before assignment).
    expect(hits[0]!.level).not.toBe("L0");
    expect(hits[0]!.escalations).not.toContain(hits[0]!.level);
    expect(hits[0]!.escalations).toContain("L0");
    await memos.close();
  });
});

// ---------------------------------------------------------------------------
// 3. The L2 summary keeps the sentence holding the number
// ---------------------------------------------------------------------------

describe("L2 preserves information-dense sentences", () => {
  test("isInformationDense detects numbers, dates and negations", () => {
    expect(isInformationDense("The pool size exceeds 120 connections.")).toBe(
      true,
    );
    expect(isInformationDense("Rollback happened on March 3rd.")).toBe(true);
    expect(isInformationDense("The migration did not complete.")).toBe(true);
    expect(isInformationDense("The migration went smoothly.")).toBe(false);
  });

  test("the unique number-bearing sentence survives L2", () => {
    // Push past L2_PASSTHROUGH_CHARS so the centrality pass runs.
    // The pool/eviction sentences share vocabulary; the "exceeds 120"
    // sentence shares none, so centrality alone would drop it.
    const content =
      "Background: we migrated the cache layer in January. " +
      "The migration of the cache layer went smoothly overall. " +
      "Later we discovered a bug in the eviction path of the cache layer. " +
      "The bug in the eviction path only triggers when the pool size " +
      "exceeds 120 connections during a batch eviction. " +
      "Rollback of the cache layer happened on March 3rd after review.";
    expect(content.length).toBeGreaterThan(280);

    const l2 = fidelityL2(makeNode("n", content));
    expect(l2).toContain("120 connections");
  });

  test("centrality alone would have ranked that sentence last", () => {
    const sentences = splitSentences(
      "The cache layer migrated smoothly in January. " +
        "The cache layer migration proceeded without incidents. " +
        "The cache layer handles all eviction paths today. " +
        "The pool size must never exceed 120 connections.",
    );
    const ranked = rankSentencesByCentrality(sentences);
    // Guards the premise of the fix: the number sentence is not
    // naturally central, which is exactly why the rescue slot exists.
    expect(ranked[ranked.length - 1]).toContain("120");
  });

  test("the final (conclusion) sentence of a note survives L2", () => {
    const content =
      "The retry policy uses exponential backoff with a base delay. " +
      "The retry policy doubles the delay on every failed attempt. " +
      "The retry policy caps the total delay at five minutes overall. " +
      "Set MAX_RETRIES to 3 in the deployment manifest tomorrow.";
    const l2 = fidelityL2(makeNode("n", content));
    expect(l2).toContain("MAX_RETRIES");
  });

  test("L2 stays within its char cap and never exceeds verbatim", () => {
    const content =
      "Alpha beta gamma delta epsilon zeta eta theta. " +
      "Beta gamma delta epsilon zeta eta theta iota kappa. " +
      "Gamma delta epsilon zeta eta theta iota kappa lambda mu. " +
      "Delta epsilon zeta eta theta iota kappa lambda mu nu xi. " +
      "Epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi. " +
      "The threshold was raised to 42 percent after the audit.";
    const node = makeNode("n", content);
    const l2 = fidelityL2(node);
    expect(l2.length).toBeLessThanOrEqual(content.length);
    expect(l2).toContain("42 percent");
  });

  test("L2 still compresses: fewer sentences than verbatim", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) =>
        `The scheduler processes queue item ${i} with the standard retry logic applied.`,
    ).join(" ");
    const node = makeNode("n", sentences);
    const l2 = fidelityL2(node);
    expect(splitSentences(l2).length).toBeLessThan(
      splitSentences(sentences).length,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. fidelity × compression composition guard
// ---------------------------------------------------------------------------

describe("fidelity × compression composition", () => {
  test("compression is skipped on already-compressed levels", () => {
    // Two lossy passes composed is worse than either: stopword-dropping
    // an L2 extractive summary removes the connective tissue that made
    // the selected sentences readable.
    expect(shouldCompressFidelityItem("L0")).toBe(false);
    expect(shouldCompressFidelityItem("L1")).toBe(false);
    expect(shouldCompressFidelityItem("L2")).toBe(false);
  });

  test("compression still runs on verbatim (or fidelity-less) items", () => {
    // L3 has full prose structure to lose; the filter is a net win there.
    expect(shouldCompressFidelityItem("L3")).toBe(true);
    expect(shouldCompressFidelityItem(undefined)).toBe(true);
  });
});
