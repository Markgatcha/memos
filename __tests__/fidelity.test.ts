/**
 * Tests for fidelity-level compaction (L0–L3) + query-adaptive recall.
 *
 * Covers: level generation (L0/L1/L2 content correctness), the
 * query-adaptive router, in-call escalation, token-count ordering,
 * backfill via `compact()`, and context-pack fidelity metadata.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  fidelityL0,
  fidelityL1,
  fidelityL2,
  fidelityStats,
  hasFidelityCache,
  levelText,
  nextFidelityLevel,
  rankSentencesByCentrality,
  routeFidelity,
  scoreLevelCorpus,
  splitSentences,
  stampFidelityCache,
} from "../src/fidelity";
import type { FidelityLevel } from "../src/fidelity";
import {
  buildContextPack,
  estimateTokens,
  packToToon,
  packToToonCompact,
  parseToonCompact,
} from "../src/context-pack";
import type { MemoryNode, ScoredMemory } from "../src/types";

/** Minimal MemoryNode factory. */
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

function scored(node: MemoryNode, score: number): ScoredMemory {
  return { node, score };
}

function makeMemos() {
  // Embeddings stay off: this suite is hermetic (no ONNX/model downloads).
  const storage = new SQLiteStorage(":memory:", true);
  const memos = new MemOS({ storage, embeddings: { enabled: false } });
  return { memos, storage };
}

// ---------------------------------------------------------------------------
// Level generation
// ---------------------------------------------------------------------------

describe("fidelityL0", () => {
  test("derives tags + entities only, no content words", () => {
    const node = makeNode(
      "a",
      "The Postgres connection pool saturates under load.",
      {
        tags: ["postgres", "database"],
        entities: ["postgres", "connection pool"],
      },
    );
    const l0 = fidelityL0(node);
    expect(l0).toContain("postgres");
    expect(l0).toContain("database");
    expect(l0).toContain("connection pool");
    expect(l0).not.toContain("saturates");
  });

  test("empty when the memory has no tags or entities", () => {
    expect(fidelityL0(makeNode("a", "hello world"))).toBe("");
  });

  test("is free: reads tags/entities without generating anything", () => {
    const node = makeNode("a", "content", { tags: ["x"] });
    expect(node.metadata.fidelity).toBeUndefined();
    fidelityL0(node);
    expect(node.metadata.fidelity).toBeUndefined();
  });
});

describe("fidelityL1", () => {
  const content =
    "The Postgres connection pool is configured with a maximum of 25 connections. " +
    "This is just some filler narrative without any named thing in it whatsoever. " +
    "Timeouts were tuned after last week's outage. " +
    "Another generic observation about systems in general terms.";

  test("extracts typed facts from entity-bearing sentences", () => {
    const node = makeNode("a", content, {
      tags: ["database"],
      entities: ["postgres", "connection pool", "outage"],
    });
    const l1 = fidelityL1(node);
    expect(l1).toContain("[fact]");
    expect(l1).toContain("25 connections");
    expect(l1).toContain("Timeouts were tuned");
    // Filler sentences without entities are dropped.
    expect(l1).not.toContain("filler narrative");
    expect(l1).not.toContain("generic observation");
  });

  test("uses the memory type as the fact prefix", () => {
    const node = makeNode(
      "a",
      "Mark prefers dark mode across all of his development tools. " +
        "He uses the Zed editor with the One Dark theme. " +
        "His terminal uses the Tokyo Night color scheme. " +
        "The office coffee machine was replaced on Tuesday.",
      { type: "preference", entities: ["mark", "dark mode", "zed"] },
    );
    const l1 = fidelityL1(node);
    expect(l1).toContain("[preference]");
    expect(l1.length).toBeLessThan(node.content.length);
  });

  test("falls back to verbatim when facts would cost as much as content", () => {
    // Two short sentences: prefixing the lead would exceed the content
    // length, so the level degrades to verbatim (never L1 > L3).
    const node = makeNode(
      "a",
      "Something happened today. It was quite ordinary in every way.",
    );
    expect(fidelityL1(node)).toBe(node.content);
  });

  test("never costs more than verbatim", () => {
    const node = makeNode("a", "Short.");
    expect(fidelityL1(node).length).toBeLessThanOrEqual(node.content.length);
  });

  test("caps at three facts", () => {
    const sentences = Array.from(
      { length: 6 },
      (_, i) => `Postgres fact number ${i} about the connection pool sizing.`,
    ).join(" ");
    const node = makeNode("a", sentences, { entities: ["postgres"] });
    const l1 = fidelityL1(node);
    expect(l1.split("[fact]").length - 1).toBeLessThanOrEqual(3);
  });
});

describe("fidelityL2", () => {
  const content =
    "The Postgres connection pool is configured with a maximum of 25 connections. " +
    "The connection pool saturates under peak load every Friday. " +
    "We tuned the connection pool timeouts after last week's outage. " +
    "Separately, the office coffee machine was replaced on Tuesday. " +
    "The new coffee machine makes much better espresso than the old one.";

  test("selects central sentences by word overlap", () => {
    const node = makeNode("a", content, { tags: ["database"] });
    const l2 = fidelityL2(node);
    // The three pool sentences share vocabulary ("connection pool" x3);
    // the top-ranked sentence is one of them.
    expect(l2).toContain("connection pool");
    expect(l2.length).toBeLessThan(content.length);
    const ranked = rankSentencesByCentrality(splitSentences(content));
    expect(ranked[0]).toContain("connection pool");
  });

  test("emits picked sentences in original order", () => {
    const node = makeNode("a", content);
    const l2 = fidelityL2(node);
    const sentences = splitSentences(l2);
    const original = splitSentences(content);
    const indices = sentences.map((s) => original.indexOf(s));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  test("passes short content through unchanged", () => {
    const short = "Mark prefers dark mode over light mode.";
    expect(fidelityL2(makeNode("a", short))).toBe(short);
  });

  test("never longer than verbatim", () => {
    const node = makeNode("a", content);
    expect(fidelityL2(node).length).toBeLessThanOrEqual(content.length);
  });
});

describe("rankSentencesByCentrality", () => {
  test("ranks the most connected sentence first", () => {
    const sentences = [
      "The cat sat on the mat.",
      "The dog chased the cat around the house.",
      "Quantum entanglement enables instant correlation.",
    ];
    const ranked = rankSentencesByCentrality(sentences);
    // The cat/dog sentences share vocabulary; the quantum one is isolated.
    expect(ranked[2]).toBe(sentences[2]);
    expect(ranked.slice(0, 2)).toContain(sentences[0]);
    expect(ranked.slice(0, 2)).toContain(sentences[1]);
  });

  test("is deterministic", () => {
    const sentences = [
      "Alpha beta gamma delta.",
      "Beta gamma epsilon zeta.",
      "Gamma delta eta theta.",
      "Completely unrelated words here.",
    ];
    expect(rankSentencesByCentrality(sentences)).toEqual(
      rankSentencesByCentrality(sentences),
    );
  });
});

describe("levelText + cache", () => {
  test("dispatches to the right generator per level", () => {
    const node = makeNode("a", "The Postgres pool has 25 connections.", {
      tags: ["postgres"],
      entities: ["postgres"],
    });
    expect(levelText(node, "L0")).toBe(fidelityL0(node));
    expect(levelText(node, "L1")).toBe(fidelityL1(node));
    expect(levelText(node, "L2")).toBe(fidelityL2(node));
    expect(levelText(node, "L3")).toBe(node.content);
  });

  test("stampFidelityCache persists L1/L2; levelText prefers the cache", () => {
    const node = makeNode(
      "a",
      "The Postgres connection pool is configured with a maximum of 25 connections. Timeouts were tuned after the outage.",
      { tags: ["database"], entities: ["postgres"] },
    );
    expect(hasFidelityCache(node)).toBe(false);
    const { l1, l2 } = stampFidelityCache(node);
    expect(hasFidelityCache(node)).toBe(true);
    expect(typeof l1).toBe("string");
    expect(typeof l2).toBe("string");
    // Mutate content: the cache still serves the stamped text (write-time snapshot).
    node.content = "Completely different content now.";
    expect(levelText(node, "L1")).toBe(l1);
    expect(levelText(node, "L2")).toBe(l2);
    expect(levelText(node, "L3")).toBe(node.content);
  });
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

describe("routeFidelity", () => {
  test("entity lookup -> L0", () => {
    const r = routeFidelity("postgres connection pool");
    expect(r.level).toBe("L0");
    expect(r.signals.entities).toContain("postgres");
  });

  test("entity-anchored factoid -> L1", () => {
    expect(
      routeFidelity("What is the Postgres connection pool size?").level,
    ).toBe("L1");
    expect(routeFidelity("Who approved the Redis migration?").level).toBe("L1");
  });

  test("explanatory / conceptual query -> L3", () => {
    expect(
      routeFidelity("why did we choose postgres over mysql for sessions?")
        .level,
    ).toBe("L3");
    expect(routeFidelity("explain our caching strategy").level).toBe("L3");
    expect(
      routeFidelity("how does the retry policy interact with backoff?").level,
    ).toBe("L3");
  });

  test("summarization request -> L2", () => {
    expect(
      routeFidelity("summarize everything we know about the auth migration")
        .level,
    ).toBe("L2");
  });

  test("open question without entities -> L2", () => {
    expect(routeFidelity("what did we discuss about deployment?").level).toBe(
      "L2",
    );
  });

  test("long narrative query -> L2", () => {
    const q =
      "I am trying to remember all of the various details we talked about last week " +
      "regarding the production incident, the rollback procedure we followed, and who " +
      "was on call during the whole thing from start to finish";
    expect(q.split(/\s+/).length).toBeGreaterThanOrEqual(30);
    expect(routeFidelity(q).level).toBe("L2");
  });

  test("short keyword query falls back to L1", () => {
    expect(routeFidelity("deploy checklist").level).toBe("L1");
  });

  test("quoted spans boost specificity toward L0", () => {
    const r = routeFidelity('"connection pool"');
    expect(r.signals.quoted).toBe(true);
    expect(["L0", "L1"]).toContain(r.level);
  });
});

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

describe("scoreLevelCorpus", () => {
  test("returns IDF-weighted coverage in [0,1]", () => {
    const scores = scoreLevelCorpus("postgres pool size", [
      "tags: postgres | entities: postgres",
      "tags: redis | entities: redis",
    ]);
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[0]).toBeLessThanOrEqual(1);
    expect(scores[1]).toBe(0);
  });

  test("full coverage scores 1.0", () => {
    expect(scoreLevelCorpus("alpha beta", ["alpha beta gamma"])[0]).toBe(1);
  });

  test("empty query scores zero everywhere", () => {
    expect(scoreLevelCorpus("", ["something"])).toEqual([0]);
  });

  test("canonicalizes through the entity alias table", () => {
    // "postgres" (query) matches "postgresql" (doc) via aliases.
    const scores = scoreLevelCorpus("postgres", ["postgresql database"]);
    expect(scores[0]).toBeGreaterThan(0);
  });
});

describe("nextFidelityLevel", () => {
  test("walks the ladder", () => {
    expect(nextFidelityLevel("L0")).toBe("L1");
    expect(nextFidelityLevel("L1")).toBe("L2");
    expect(nextFidelityLevel("L2")).toBe("L3");
    expect(nextFidelityLevel("L3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recall() — adaptive routing + in-call escalation
// ---------------------------------------------------------------------------

describe("MemOS.recall", () => {
  const target =
    "The Postgres connection pool is configured with a maximum of 25 connections. " +
    "Timeouts were tuned after last week's outage.";
  const distractor =
    "The office coffee machine was replaced on Tuesday. It makes great espresso.";

  async function seed() {
    const { memos, storage } = makeMemos();
    await memos.init();
    const a = await memos.store(target, {
      tags: ["database"],
      type: "fact",
    });
    await memos.store(distractor, { tags: ["office"], type: "fact" });
    await memos.store("Redis handles the session cache with a 30 minute TTL.", {
      tags: ["redis"],
      type: "fact",
    });
    return { memos, storage, targetId: a.node.id };
  }

  test("defaults to L3-equivalent output (verbatim, no routing)", async () => {
    const { memos } = await seed();
    const hits = await memos.recall("timeouts tuned");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.level).toBe("L3");
    expect(hits[0]!.text).toBe(hits[0]!.node.content);
    expect(hits[0]!.escalations).toEqual([]);
    expect(hits[0]!.route).toBeUndefined();
    await memos.close();
  });

  test("miss at L0 escalates and finds the answer at L1", async () => {
    const { memos, targetId } = await seed();
    // "configured maximum" appears in the L1 facts but in neither the
    // tags nor the extracted entities (L0), so the call escalates.
    const hits = await memos.recall("configured maximum", {
      fidelity: "L0",
      maxFidelity: "L3",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.node.id).toBe(targetId);
    expect(hits[0]!.level).toBe("L1");
    expect(hits[0]!.escalations).toEqual(["L1"]);
    expect(hits[0]!.text).toContain("maximum of 25 connections");
    await memos.close();
  });

  test("maxFidelity is respected: no escalation past the ceiling", async () => {
    const { memos } = await seed();
    // Zero L0 coverage and the ceiling forbids escalation -> no hits.
    const hits = await memos.recall("configured maximum", {
      fidelity: "L0",
      maxFidelity: "L0",
    });
    expect(hits).toEqual([]);
    await memos.close();
  });

  test("no escalation when the starting level already satisfies", async () => {
    const { memos, targetId } = await seed();
    // "postgres" is in L0 entities -> hit at L0, no escalation.
    const hits = await memos.recall("postgres", {
      fidelity: "L0",
      maxFidelity: "L3",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.node.id).toBe(targetId);
    expect(hits[0]!.level).toBe("L0");
    expect(hits[0]!.escalations).toEqual([]);
    await memos.close();
  });

  test("adaptive routing picks the starting level per query", async () => {
    const { memos, targetId } = await seed();
    const hits = await memos.recall("postgres", { fidelity: "adaptive" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.node.id).toBe(targetId);
    expect(hits[0]!.route).toBeDefined();
    expect(hits[0]!.route!.level).toBe("L0");
    // Adaptive serves the cheapest sufficient level: L0 text, not verbatim.
    expect(hits[0]!.level).toBe("L0");
    expect(hits[0]!.text.length).toBeLessThan(hits[0]!.node.content.length);
    await memos.close();
  });

  test("filter scopes the candidate set", async () => {
    const { memos } = await seed();
    const hits = await memos.recall("postgres", {
      fidelity: "L3",
      filter: { tags: ["office"] },
    });
    for (const h of hits) expect(h.node.tags).toContain("office");
    await memos.close();
  });

  test("start level is clamped to maxFidelity", async () => {
    const { memos } = await seed();
    const hits = await memos.recall("postgres", {
      fidelity: "L3",
      maxFidelity: "L1",
    });
    for (const h of hits) {
      expect(["L0", "L1"]).toContain(h.level);
    }
    await memos.close();
  });
});

// ---------------------------------------------------------------------------
// Token counts
// ---------------------------------------------------------------------------

describe("fidelity token ordering", () => {
  /** Realistic multi-sentence memories with tags/entities. */
  function fixtureNodes(): MemoryNode[] {
    const texts = [
      "The Postgres connection pool is configured with a maximum of 25 connections. The pool saturates under peak load every Friday afternoon. We tuned the timeouts after last week's outage caused cascading failures. The on-call engineer paged the database team at 3am. Connection pool metrics are exported to Prometheus every fifteen seconds.",
      "Mark prefers dark mode across all of his development tools. He uses the Zed editor with the One Dark theme and a customized status bar. His terminal uses the Tokyo Night color scheme with ligature support enabled. Font size is set to fourteen points with a line height of one point six. He disables the minimap and breadcrumbs to keep the interface minimal.",
      "The Redis session cache uses a 30 minute TTL with sliding expiration. Cache stampedes are prevented with probabilistic early refresh. We migrated from Memcached to Redis in March for persistence support. Session data is namespaced by deployment region to avoid collisions. Eviction policy is set to allkeys-lru across the three node cluster.",
      "The deploy pipeline runs on GitHub Actions with a matrix of Node versions. Docker images are built with multi-stage builds to keep them small. Rollbacks are automated via the previous successful artifact tag. Integration tests run against an ephemeral Postgres service container. Deployments to production require two approvals from the platform team.",
    ];
    return texts.map((content, i) =>
      makeNode(`m${i}`, content, {
        tags: [["database"], ["editor"], ["cache"], ["ci"]][i]!,
        entities: [
          ["postgres", "connection pool"],
          ["zed", "dark mode"],
          ["redis", "session cache"],
          ["github actions", "docker"],
        ][i]!,
      }),
    );
  }

  test("L0 and L1 average strictly fewer tokens than verbatim", () => {
    const stats = fidelityStats(fixtureNodes(), estimateTokens);
    const avg = Object.fromEntries(stats.map((s) => [s.level, s.avgTokens]));
    expect(avg["L0"]).toBeLessThan(avg["L3"]!);
    expect(avg["L1"]).toBeLessThan(avg["L3"]!);
    expect(avg["L2"]).toBeLessThanOrEqual(avg["L3"]!);
  });

  test("L1/L2 never cost more than verbatim on any single memory", () => {
    for (const node of fixtureNodes()) {
      const l3 = estimateTokens(levelText(node, "L3"));
      expect(estimateTokens(levelText(node, "L1"))).toBeLessThanOrEqual(l3);
      expect(estimateTokens(levelText(node, "L2"))).toBeLessThanOrEqual(l3);
    }
  });

  test("savingsVsVerbatim is a proper fraction for L0/L1", () => {
    const stats = fidelityStats(fixtureNodes(), estimateTokens);
    for (const s of stats) {
      if (s.level === "L3") {
        expect(s.savingsVsVerbatim).toBe(0);
      } else if (s.level === "L2") {
        // L2 degrades to verbatim on short content — never negative.
        expect(s.savingsVsVerbatim).toBeGreaterThanOrEqual(0);
        expect(s.savingsVsVerbatim).toBeLessThan(1);
      } else {
        expect(s.savingsVsVerbatim).toBeGreaterThan(0);
        expect(s.savingsVsVerbatim).toBeLessThan(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// compact() backfill
// ---------------------------------------------------------------------------

describe("MemOS.compact", () => {
  test("write-time stamping means fresh stores need no backfill", async () => {
    const { memos } = makeMemos();
    await memos.init();
    await memos.store("The Postgres pool has 25 connections.", {
      tags: ["database"],
    });
    await memos.store("Mark prefers dark mode.", { type: "preference" });
    const res = await memos.compact();
    expect(res.scanned).toBe(2);
    expect(res.backfilled).toBe(0);
    expect(res.skipped).toBe(2);
    await memos.close();
  });

  test("backfills legacy memories missing cached levels", async () => {
    const { memos, storage } = makeMemos();
    await memos.init();
    const { node } = await memos.store(
      "The Postgres connection pool is configured with a maximum of 25 connections. " +
        "The pool saturates under peak load every Friday afternoon when the batch jobs run. " +
        "We tuned the timeouts after last week's outage caused cascading failures across regions. " +
        "The on-call engineer paged the database team at 3am during the incident. " +
        "Connection pool metrics are exported to Prometheus every fifteen seconds for dashboards.",
      { tags: ["database"] },
    );
    // Simulate a pre-fidelity row: wipe the cache in storage AND the
    // live graph object (getGraph returns shared references).
    const wiped = { ...(node.metadata ?? {}) } as Record<string, unknown>;
    delete wiped.fidelity;
    await storage.updateNode(node.id, { metadata: wiped });
    const live = (await memos.getGraph()).nodes.find((n) => n.id === node.id)!;
    live.metadata = wiped;
    expect(hasFidelityCache(live)).toBe(false);

    const res = await memos.compact();
    expect(res.scanned).toBe(1);
    expect(res.backfilled).toBe(1);
    expect(res.skipped).toBe(0);

    const reloaded = (await memos.retrieve(node.id))!;
    expect(hasFidelityCache(reloaded)).toBe(true);
    expect(levelText(reloaded, "L1")).toContain("[fact]");
    await memos.close();
  });

  test("dryRun computes stats without writing", async () => {
    const { memos, storage } = makeMemos();
    await memos.init();
    const { node } = await memos.store(
      "The Postgres pool has 25 connections.",
      {
        tags: ["database"],
      },
    );
    const wiped = { ...(node.metadata ?? {}) } as Record<string, unknown>;
    delete wiped.fidelity;
    await storage.updateNode(node.id, { metadata: wiped });
    const live = (await memos.getGraph()).nodes.find((n) => n.id === node.id)!;
    live.metadata = wiped;

    const res = await memos.compact({ dryRun: true, stats: true });
    expect(res.backfilled).toBe(0);
    expect(res.stats).toBeDefined();
    expect(res.stats!.map((s) => s.level)).toEqual(["L0", "L1", "L2", "L3"]);
    expect(hasFidelityCache(live)).toBe(false);
    await memos.close();
  });

  test("namespace filter scopes the backfill", async () => {
    const { memos, storage } = makeMemos();
    await memos.init();
    const a = await memos.store("Memory in namespace a.", {
      namespace: "a",
    });
    await memos.store("Memory in namespace b.", { namespace: "b" });
    for (const n of [a.node.id]) {
      const wiped = {} as Record<string, unknown>;
      await storage.updateNode(n, { metadata: wiped });
      const live = (await memos.getGraph()).nodes.find((x) => x.id === n)!;
      live.metadata = wiped;
    }
    const res = await memos.compact({ namespace: "a" });
    expect(res.scanned).toBe(1);
    expect(res.backfilled).toBe(1);
    await memos.close();
  });
});

// ---------------------------------------------------------------------------
// Context-pack integration
// ---------------------------------------------------------------------------

describe("context pack fidelity", () => {
  const content =
    "The Postgres connection pool is configured with a maximum of 25 connections. " +
    "The pool saturates under peak load every Friday afternoon when the batch jobs run. " +
    "We tuned the timeouts after last week's outage caused cascading failures across regions. " +
    "The on-call engineer paged the database team at 3am during the incident. " +
    "Connection pool metrics are exported to Prometheus every fifteen seconds for dashboards.";

  function packItems(): ScoredMemory[] {
    const node = makeNode("p1", content, {
      tags: ["database"],
      entities: ["postgres", "connection pool"],
    });
    stampFidelityCache(node);
    return [scored(node, 0.9)];
  }

  test("records per-item and pack-level fidelity metadata", () => {
    const pack = buildContextPack({
      query: "postgres pool",
      namespace: "default",
      tokenBudget: 1000,
      items: packItems(),
      fidelity: "L1",
    });
    expect(pack.items[0]!.fidelity).toBe("L1");
    expect(pack.fidelity).toBeDefined();
    expect(pack.fidelity!.level).toBe("L1");
    expect(pack.fidelity!.adaptive).toBe(false);
    expect(pack.fidelity!.contentTokens).toBeLessThan(
      pack.fidelity!.verbatimTokens,
    );
    expect(pack.items[0]!.content).toContain("[fact]");
  });

  test("adaptive resolves the level from the query", () => {
    const pack = buildContextPack({
      query: "postgres",
      namespace: "default",
      tokenBudget: 1000,
      items: packItems(),
      fidelity: "adaptive",
    });
    expect(pack.fidelity!.adaptive).toBe(true);
    expect(pack.fidelity!.level).toBe("L0");
    expect(pack.items[0]!.fidelity).toBe("L0");
  });

  test("default path records no fidelity metadata (behavior preserved)", () => {
    const pack = buildContextPack({
      query: "postgres pool",
      namespace: "default",
      tokenBudget: 1000,
      items: packItems(),
    });
    expect(pack.fidelity).toBeUndefined();
    expect(pack.items[0]!.fidelity).toBeUndefined();
    expect(pack.items[0]!.content).toBe(packItems()[0]!.node.content);
  });

  test("verbose TOON emits the fidelity header", () => {
    const pack = buildContextPack({
      query: "postgres pool",
      namespace: "default",
      tokenBudget: 1000,
      items: packItems(),
      fidelity: "L2",
    });
    const toon = packToToon(pack);
    expect(toon).toContain("# fidelity=L2");
  });

  test("compact TOON round-trips the per-item level", () => {
    const pack = buildContextPack({
      query: "postgres pool",
      namespace: "default",
      tokenBudget: 1000,
      items: packItems(),
      fidelity: "L1",
    });
    const wire = packToToonCompact(pack);
    expect(wire).toContain("|f=L1");
    const rows = wire.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(rows[0]!.split("|").length).toBe(8);
    const parsed = parseToonCompact(wire);
    expect(parsed[0]!.fidelity).toBe("L1");
  });

  test("7-field compact strings still parse (back-compat)", () => {
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 1000,
      items: packItems(),
    });
    const wire = packToToonCompact(pack);
    const rows = wire.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(rows[0]!.split("|").length).toBe(7);
    expect(parseToonCompact(wire)[0]!.fidelity).toBeUndefined();
  });

  test("MemOS.contextPack passes fidelity through", async () => {
    const { memos } = makeMemos();
    await memos.init();
    await memos.store(content, { tags: ["database"] });
    const pack = (await memos.contextPack({
      query: "postgres pool",
      tokenBudget: 2000,
      fidelity: "L1",
    })) as unknown as {
      fidelity?: { level: FidelityLevel };
      items: { fidelity?: FidelityLevel; content: string }[];
    };
    expect(pack.fidelity?.level).toBe("L1");
    expect(pack.items[0]?.fidelity).toBe("L1");
    expect(pack.items[0]?.content).toContain("[fact]");

    const plain = (await memos.contextPack({
      query: "postgres pool",
      tokenBudget: 2000,
    })) as unknown as { fidelity?: unknown };
    expect(plain.fidelity).toBeUndefined();
    await memos.close();
  });
});

// ---------------------------------------------------------------------------
// store()/update() integration
// ---------------------------------------------------------------------------

describe("write-time fidelity", () => {
  test("store() stamps the L1/L2 cache", async () => {
    const { memos } = makeMemos();
    await memos.init();
    const { node } = await memos.store(
      "The Postgres connection pool is configured with a maximum of 25 connections. Timeouts were tuned.",
      { tags: ["database"] },
    );
    expect(hasFidelityCache(node)).toBe(true);
    const reloaded = (await memos.retrieve(node.id))!;
    expect(hasFidelityCache(reloaded)).toBe(true);
    await memos.close();
  });

  test("update() regenerates levels when content changes", async () => {
    const { memos } = makeMemos();
    await memos.init();
    const { node } = await memos.store("Mark prefers dark mode.", {
      type: "preference",
    });
    const before = levelText(node, "L1");
    const updated = (await memos.update(node.id, {
      content: "The Redis session cache uses a 30 minute TTL.",
    }))!;
    const after = levelText(updated, "L1");
    expect(after).not.toBe(before);
    expect(after).toContain("Redis");
    await memos.close();
  });
});
