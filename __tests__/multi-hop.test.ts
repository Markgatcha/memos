/**
 * Unit and integration tests for second-hop entity-bridge retrieval
 * (`src/multi-hop.ts` & `MemOS.search` with `SearchFilter.multiHop`).
 *
 * Covers the required acceptance invariants:
 *   1. Bounded entity count (`maxEntities` strictly respected).
 *   2. No displacement of higher-ranked first-hop results (head slots
 *      preserved, strong tail slots never evicted, already-bridged or
 *      query-named slots protected).
 *   3. No leakage of benchmark gold data (`supporting_facts`, `answer`,
 *      `hotpot_title` in `metadata` never read).
 *   4. Result list length never exceeds `limit` and contains no duplicate IDs.
 *   5. End-to-end two-hop retrieval via `MemOS.search()` and opt-in/opt-out
 *      via `SearchFilter.multiHop`.
 */

import { existsSync, unlinkSync } from "node:fs";
import { MemOS } from "../src/memory";
import {
  buildNamespaceSubjectIndex,
  expandMultiHop,
  extractBridgeEntities,
  extractLeadSubject,
} from "../src/multi-hop";
import type { MemoryNode, ScoredMemory } from "../src/types";

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

function makeNode(
  id: string,
  content: string,
  metadata: Record<string, unknown> = {},
): MemoryNode {
  return {
    id,
    content,
    summary: content.slice(0, 120),
    type: "fact",
    metadata,
    importance: 0.5,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    accessCount: 0,
    lastAccessed: 1_700_000_000_000,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

describe("multi-hop second-hop retrieval (src/multi-hop.ts)", () => {
  test("bounded entity count: extractBridgeEntities never exceeds maxEntities", () => {
    const seed = makeNode(
      "seed-1",
      'Kiss and Tell (1945 film): Kiss and Tell is a 1945 American comedy film starring Shirley Temple as Corliss Archer, directed by Richard Wallace, produced by Sol C. Siegel, distributed by Columbia Pictures, and adapted from F. Hugh Herbert\'s Broadway play "Kiss and Tell".',
    );
    const query =
      "What government position was held by the woman who portrayed Corliss Archer in the film Kiss and Tell?";

    expect(extractBridgeEntities(seed, query, { maxEntities: 0 })).toHaveLength(
      0,
    );
    const max1 = extractBridgeEntities(seed, query, { maxEntities: 1 });
    expect(max1.length).toBeLessThanOrEqual(1);

    const max3 = extractBridgeEntities(seed, query, { maxEntities: 3 });
    expect(max3.length).toBeLessThanOrEqual(3);
    expect(max3).toContain("shirley temple");

    const max5 = extractBridgeEntities(seed, query, { maxEntities: 5 });
    expect(max5.length).toBeLessThanOrEqual(5);
  });

  test("no displacement of higher-ranked results: head is untouched and strong tail hits are never evicted", () => {
    const seed = makeNode(
      "n1",
      "Kiss and Tell (1945 film): Kiss and Tell is a 1945 American comedy film starring Shirley Temple as Corliss Archer.",
    );
    const bridgeTarget = makeNode(
      "n-bridge",
      "Shirley Temple: Shirley Temple Black was an American actress and diplomat who served as United States Chief of Protocol and government ambassador.",
    );
    const distractors = Array.from({ length: 9 }, (_, i) =>
      makeNode(
        `n${i + 2}`,
        `Distractor Topic ${i + 2}: Unrelated paragraph about sports and architecture number ${i + 2}.`,
      ),
    );
    const allNodes = [seed, ...distractors, bridgeTarget];
    const subjectIndex = buildNamespaceSubjectIndex(allNodes);
    const query =
      "What government position was held by the woman who portrayed Corliss Archer in the film Kiss and Tell?";

    // Case A: All 10 first-hop results have very high scores (0.99 down to 0.90)
    // above the promotion cap (~0.88 * seed0Score). None may be displaced.
    const highScoringFirstHop: ScoredMemory[] = [seed, ...distractors].map(
      (node, idx) => ({
        node,
        score: 0.99 - idx * 0.008,
      }),
    );

    const unmoved = expandMultiHop(highScoringFirstHop, {
      query,
      limit: 10,
      subjectIndex,
    });
    expect(unmoved.injected).toBe(0);
    expect(unmoved.results.map((r) => r.node.id)).toEqual(
      highScoringFirstHop.map((r) => r.node.id),
    );

    // Case B: Realistic decaying tail scores. Head slots 0..4 are preserved
    // in exact order, and the verified second-hop target replaces a weak tail slot.
    const realisticFirstHop: ScoredMemory[] = [seed, ...distractors].map(
      (node, idx) => ({
        node,
        score: idx === 0 ? 1.0 : Math.max(0.2, 0.7 - idx * 0.05),
      }),
    );

    const expanded = expandMultiHop(realisticFirstHop, {
      query,
      limit: 10,
      subjectIndex,
      options: { maxEntities: 5, maxInjected: 2 },
    });

    expect(expanded.injected).toBe(1);
    expect(expanded.results.slice(0, 5).map((r) => r.node.id)).toEqual(
      realisticFirstHop.slice(0, 5).map((r) => r.node.id),
    );
    expect(expanded.results.map((r) => r.node.id)).toContain("n-bridge");
  });

  test("no leakage of gold data: supporting_facts, answer, and hotpot_title in metadata are ignored", () => {
    const seed = makeNode(
      "seed-clean",
      "Kiss and Tell (1945 film): Kiss and Tell is a 1945 American comedy film starring Shirley Temple as Corliss Archer.",
      {
        hotpot_title: "Decoy Poisoned Title",
        supporting_facts: { title: ["Decoy Poisoned Fact"], sent_id: [0] },
        answer: "Decoy Poisoned Answer",
      },
    );
    const poisonedDecoy = makeNode(
      "decoy-node",
      "Unrelated Topic: Completely unrelated text with no connection to the query or seed.",
      {
        hotpot_title: "Shirley Temple",
        supporting_facts: {
          title: ["Kiss and Tell (1945 film)", "Shirley Temple"],
          sent_id: [0, 0],
        },
        answer: "Chief of Protocol",
      },
    );
    const realBridge = makeNode(
      "real-bridge",
      "Shirley Temple: Shirley Temple was an American diplomat who held the government position of Chief of Protocol.",
      {
        hotpot_title: "Completely Different Metadata Label",
      },
    );
    const distractors = Array.from({ length: 9 }, (_, i) =>
      makeNode(`d-${i}`, `Filler Entry ${i}: Random botanical notes ${i}.`),
    );

    // Lead subject must come from content ("Kiss and Tell (1945 film)"), never metadata.hotpot_title
    const lead = extractLeadSubject(seed);
    expect(lead.full).toBe("Kiss and Tell (1945 film)");
    expect(lead.clean).toBe("Kiss and Tell");

    const bridgeEnts = extractBridgeEntities(
      seed,
      "What government position was held by the woman who portrayed Corliss Archer in Kiss and Tell?",
    );
    expect(bridgeEnts).not.toContain("decoy poisoned title");
    expect(bridgeEnts).not.toContain("decoy poisoned fact");
    expect(bridgeEnts).not.toContain("decoy poisoned answer");

    const subjectIndex = buildNamespaceSubjectIndex([
      seed,
      poisonedDecoy,
      realBridge,
      ...distractors,
    ]);
    const firstHop: ScoredMemory[] = [seed, ...distractors].map((node, i) => ({
      node,
      score: i === 0 ? 1.0 : 0.35 - i * 0.02,
    }));

    const res = expandMultiHop(firstHop, {
      query:
        "What government position was held by the woman who portrayed Corliss Archer in the film Kiss and Tell?",
      limit: 10,
      subjectIndex,
    });

    const ids = res.results.map((r) => r.node.id);
    expect(ids).toContain("real-bridge");
    expect(ids).not.toContain("decoy-node");
  });

  test("list length never exceeds limit and contains no duplicate IDs", () => {
    const seed = makeNode(
      "s1",
      "Alpha Project: Alpha Project was led by Dr. Elena Vance and funded by Horizon Institute.",
    );
    const hopA = makeNode(
      "hop-a",
      "Elena Vance: Dr. Elena Vance is a physicist who won the National Medal of Science in Geneva.",
    );
    const hopB = makeNode(
      "hop-b",
      "Horizon Institute: Horizon Institute is a research center in Geneva that awards the National Medal of Science.",
    );
    const poolNodes = [
      seed,
      ...Array.from({ length: 25 }, (_, i) =>
        makeNode(`p-${i}`, `Topic ${i}: General background note ${i}.`),
      ),
    ];
    const subjectIndex = buildNamespaceSubjectIndex([...poolNodes, hopA, hopB]);
    const firstHop: ScoredMemory[] = poolNodes.map((node, i) => ({
      node,
      score: i === 0 ? 1.0 : Math.max(0.1, 0.5 - i * 0.015),
    }));

    for (const limit of [3, 5, 8, 10, 15]) {
      const out = expandMultiHop(firstHop, {
        query: "What award in Geneva was won by the leader of Alpha Project?",
        limit,
        subjectIndex,
        options: { maxEntities: 8, maxInjected: 3 },
      });
      expect(out.results.length).toBeLessThanOrEqual(limit);
      const uniqueIds = new Set(out.results.map((r) => r.node.id));
      expect(uniqueIds.size).toBe(out.results.length);
    }
  });

  test("dialogue/chat-turn corpora short-circuit with zero injections", () => {
    const turns = Array.from({ length: 10 }, (_, i) =>
      makeNode(
        `turn-${i}`,
        `user: Did we discuss the deployment schedule in session ${i}?\nassistant: Yes, we agreed to ship on Tuesday.`,
      ),
    );
    const subjectIndex = buildNamespaceSubjectIndex(turns);
    expect(subjectIndex.byCleanSubject.size).toBe(0);

    const firstHop: ScoredMemory[] = turns.map((node, i) => ({
      node,
      score: 1 - i * 0.08,
    }));
    const res = expandMultiHop(firstHop, {
      query: "When did we agree to ship the deployment?",
      limit: 10,
      subjectIndex,
    });
    expect(res.injected).toBe(0);
    expect(res.results.map((r) => r.node.id)).toEqual(
      firstHop.map((r) => r.node.id),
    );
  });

  test("end-to-end MemOS.search() resolves second-hop bridge and respects SearchFilter.multiHop opt-out", async () => {
    const dbPath = `${process.cwd()}/.tmp-multihop-e2e.db`;
    cleanupDb(dbPath);
    const memos = new MemOS({
      dbPath,
      autoLinkThreshold: 0,
      embeddings: { provider: "local" },
    });
    await memos.init();

    try {
      await memos.store(
        "Kiss and Tell (1945 film): Kiss and Tell is a 1945 American comedy film in which Shirley Temple portrayed the teenage woman Corliss Archer.",
        { namespace: "test-mh" },
      );
      await memos.store(
        "Shirley Temple: Shirley Temple Black was an American actress who later served as Chief of Protocol, a diplomatic government position.",
        { namespace: "test-mh" },
      );
      for (let i = 0; i < 4; i++) {
        await memos.store(
          `Corliss Archer Sequel ${i}: Kiss and Tell featured the woman who portrayed Corliss Archer in comedy film installment ${i}.`,
          { namespace: "test-mh" },
        );
      }
      for (let i = 0; i < 6; i++) {
        await memos.store(
          `Archer Series Note ${i}: Corliss Archer appeared in comedy film review ${i}.`,
          { namespace: "test-mh" },
        );
        await memos.store(
          `Civic Registry ${i}: A government position was held by official ${i} in the state cabinet.`,
          { namespace: "test-mh" },
        );
      }
      await memos.flushEmbeddings();

      const query =
        "What government position was held by the woman who portrayed Corliss Archer in the film Kiss and Tell?";

      const withMultiHop = await memos.search({
        query,
        namespace: "test-mh",
        limit: 10,
        multiHop: { enabled: true, maxEntities: 8 },
      });
      expect(withMultiHop.length).toBeLessThanOrEqual(10);
      expect(
        withMultiHop.some((r) => r.node.content.startsWith("Shirley Temple:")),
      ).toBe(true);

      const withoutMultiHop = await memos.search({
        query,
        namespace: "test-mh",
        limit: 10,
        multiHop: false,
      });
      expect(withoutMultiHop.length).toBeLessThanOrEqual(10);

      // Default (no multiHop option) is OFF and matches explicit multiHop: false
      const defaultSearch = await memos.search({
        query,
        namespace: "test-mh",
        limit: 10,
      });
      expect(defaultSearch.map((r) => r.node.id)).toEqual(
        withoutMultiHop.map((r) => r.node.id),
      );
      expect(
        defaultSearch.some((r) => r.node.content.startsWith("Shirley Temple:")),
      ).toBe(false);

      // Explicit multiHop: true promotes the second-hop bridge target
      const booleanOptIn = await memos.search({
        query,
        namespace: "test-mh",
        limit: 10,
        multiHop: true,
      });
      expect(
        booleanOptIn.some((r) => r.node.content.startsWith("Shirley Temple:")),
      ).toBe(true);
    } finally {
      await memos.close();
      cleanupDb(dbPath);
    }
  });

  test("config-level retrieval.multiHop.enabled = true enables second-hop promotion without per-call flag", async () => {
    const dbPath = `${process.cwd()}/.tmp-multihop-cfg.db`;
    cleanupDb(dbPath);
    const memos = new MemOS({
      dbPath,
      autoLinkThreshold: 0,
      embeddings: { provider: "local" },
      retrieval: { multiHop: { enabled: true } },
    });
    await memos.init();

    try {
      await memos.store(
        "Kiss and Tell (1945 film): Kiss and Tell is a 1945 American comedy film in which Shirley Temple portrayed the teenage woman Corliss Archer.",
        { namespace: "test-mh-cfg" },
      );
      await memos.store(
        "Shirley Temple: Shirley Temple Black was an American actress who later served as Chief of Protocol, a diplomatic government position.",
        { namespace: "test-mh-cfg" },
      );
      for (let i = 0; i < 4; i++) {
        await memos.store(
          `Corliss Archer Sequel ${i}: Kiss and Tell featured the woman who portrayed Corliss Archer in comedy film installment ${i}.`,
          { namespace: "test-mh-cfg" },
        );
      }
      for (let i = 0; i < 6; i++) {
        await memos.store(
          `Archer Series Note ${i}: Corliss Archer appeared in comedy film review ${i}.`,
          { namespace: "test-mh-cfg" },
        );
        await memos.store(
          `Civic Registry ${i}: A government position was held by official ${i} in the state cabinet.`,
          { namespace: "test-mh-cfg" },
        );
      }
      await memos.flushEmbeddings();

      const query =
        "What government position was held by the woman who portrayed Corliss Archer in the film Kiss and Tell?";

      const fromConfigDefault = await memos.search({
        query,
        namespace: "test-mh-cfg",
        limit: 10,
      });
      expect(
        fromConfigDefault.some((r) =>
          r.node.content.startsWith("Shirley Temple:"),
        ),
      ).toBe(true);

      const perCallOptOut = await memos.search({
        query,
        namespace: "test-mh-cfg",
        limit: 10,
        multiHop: false,
      });
      expect(
        perCallOptOut.some((r) => r.node.content.startsWith("Shirley Temple:")),
      ).toBe(false);
    } finally {
      await memos.close();
      cleanupDb(dbPath);
    }
  });
});
