/**
 * Tests for write-time memory formation: the evidence state machine's
 * content-change classifier and the retain gate's restatement test.
 *
 * The accuracy contract under test: a value update must NEVER be folded
 * into, or reinforced on top of, the stale version it replaces. Two
 * write-time bugs in this area were caught by a write-time harness
 * (`/tmp` scratch, numbers in the PR notes) and are pinned here:
 *
 *   1. short numeric values ("20" → "50", "3" → "12") were dropped by the
 *      length>2 token filter, so a count swap reduced to an identical
 *      token set and was classified `reaffirm`;
 *   2. a displacement update ("moved FROM X TO Y") carries no negation
 *      word, so the polarity test stayed false on both sides and the pair
 *      read as `distinct`.
 *
 * The retain gate is deliberately conservative in the other direction
 * too: a genuine restatement is still collapsed, and low-value noise is
 * still skipped.
 */

import {
  classifyContentChange,
  classifyEvidence,
  contentTokens,
  contentWords,
  displacedTokens,
  hasNegationMarker,
} from "../src/confidence-machine";
import {
  findRestatement,
  isRestatement,
  shouldRetain,
} from "../src/retain-filter";
import { resolveContradictionsAtRead } from "../src/contradictions";
import { extractTriples, triplesMatch } from "../src/triple-extraction";
import type {
  ContradictionRecord,
  MemoryNode,
  ScoredMemory,
} from "../src/types";

describe("contentWords — short numeric values survive tokenization", () => {
  test("1-2 character counts are salient tokens", () => {
    expect(contentTokens("capped at 20 connections")).toContain("20");
    expect(contentTokens("scales between 3 and 12 replicas")).toContain("3");
    expect(contentWords("port 7 is admin")).toContain("7");
  });

  test("alphabetic tokens still need more than two characters", () => {
    // "is" is a function word; "ab" is too short; "port" survives.
    expect(contentTokens("ab is port")).toContain("port");
    expect(contentTokens("ab is port")).not.toContain("ab");
    expect(contentTokens("ab is port")).not.toContain("is");
  });
});

describe("classifyContentChange — a value update is never a restatement", () => {
  test("numeric slot swap is a replace", () => {
    expect(
      classifyContentChange(
        "Postgres connection pool is capped at 20 connections per service.",
        "Postgres connection pool is capped at 50 connections per service.",
      ),
    ).toBe("replace");
  });

  test("port swap is a replace", () => {
    expect(
      classifyContentChange(
        "The api listens on port 5432.",
        "The api listens on port 6543.",
      ),
    ).toBe("replace");
  });

  test("value swap inside an unchanged sentence is a replace", () => {
    expect(
      classifyContentChange(
        "The user prefers dark mode in every editor and terminal.",
        "The user prefers light mode in every editor and terminal.",
      ),
    ).toBe("replace");
  });

  test("polarity flip stays a flip even with identical tokens", () => {
    expect(
      classifyContentChange(
        "The user prefers dark mode.",
        "The user no longer prefers dark mode.",
      ),
    ).toBe("flip");
  });

  test("restatement with extra detail is an augment, not a replace", () => {
    expect(
      classifyContentChange(
        "The api reads config from env at boot.",
        "The api reads config from env at boot and fails fast.",
      ),
    ).toBe("augment");
  });

  test("identical text is a reaffirm", () => {
    expect(
      classifyContentChange(
        "PostgreSQL nightly backups run at 02:00 UTC.",
        "PostgreSQL nightly backups run at 02:00 UTC.",
      ),
    ).toBe("reaffirm");
  });

  test("two facts that merely share a subject stay distinct", () => {
    expect(
      classifyContentChange(
        "The staging database is a Postgres 16 instance.",
        "The production database is a Postgres 16 instance.",
      ),
    ).toBe("distinct");
  });

  test("reusing a revision verb is not enough on its own", () => {
    // "migrated" with no named displaced value must not invalidate the
    // stored fact — both statements are true at the same time.
    expect(
      classifyContentChange(
        "The deploy pipeline runs on GitHub Actions and deploys staging on every merge to main.",
        "The deploy pipeline moved to GitHub Actions last month.",
      ),
    ).not.toBe("replace");
  });

  test("an explicit displacement of a stored value is a replace", () => {
    expect(
      classifyContentChange(
        "Our production deploy runs on AWS Elastic Beanstalk.",
        "Our production deploy moved from AWS to Fly.io machines.",
      ),
    ).toBe("replace");
  });

  test("a migration of an unstated value does not supersede", () => {
    expect(
      classifyContentChange(
        "The deploy pipeline runs on GitHub Actions and deploys staging on every merge to main.",
        "We migrated the deploy pipeline from Jenkins to GitHub Actions in March.",
      ),
    ).not.toBe("replace");
  });
});

describe("displacedTokens", () => {
  test("reads the value after a displacement preposition", () => {
    expect(displacedTokens("moved from AWS to Fly.io machines")).toContain(
      "aws",
    );
    expect(displacedTokens("moved from AWS to Fly.io machines")).not.toContain(
      "fly",
    );
  });

  test("reads the value before a with-preposition", () => {
    expect(
      displacedTokens("replaced the Redis limiter with a token bucket"),
    ).toContain("redis");
  });

  test("empty when the verb names no displaced value", () => {
    expect(displacedTokens("The user moved to Berlin.")).toEqual([]);
  });
});

describe("hasNegationMarker", () => {
  test("whole-word matches only", () => {
    expect(hasNegationMarker("not npm")).toBe(true);
    expect(hasNegationMarker("nothing notable")).toBe(false);
  });
});

describe("classifyEvidence — decisive verdicts are band-independent", () => {
  test("a value swap contradicts at every similarity", () => {
    for (const sim of [0.2, 0.41, 0.72, 0.9]) {
      expect(
        classifyEvidence(
          "Our production deploy runs on AWS Elastic Beanstalk.",
          "Our production deploy moved from AWS to Fly.io machines.",
          sim,
        ),
      ).toBe("contradicted");
    }
  });

  test("a polarity flip contradicts at every similarity", () => {
    for (const sim of [0.15, 0.8, 0.99]) {
      expect(
        classifyEvidence(
          "The user prefers dark mode.",
          "The user does not prefer dark mode.",
          sim,
        ),
      ).toBe("contradicted");
    }
  });

  test("restatement confirms in the paraphrase band", () => {
    expect(
      classifyEvidence(
        "PostgreSQL nightly backups run at 02:00 UTC.",
        "postgres nightly backups run at 02:00 utc",
        0.99,
      ),
    ).toBe("confirmed");
  });

  test("unrelated content does not reinforce", () => {
    expect(
      classifyEvidence(
        "The docs site deploys to GitHub Pages.",
        "Redis is used for rate limiting.",
        0.1,
      ),
    ).toBe("confirmed");
    // The caller (src/memory.ts) is the one that refuses to reinforce
    // below 0.5 — see isGenuineConfirm.
  });
});

describe("retain gate — updates survive, restatements collapse", () => {
  const stored = [
    "The PostgreSQL database runs on db-primary.internal and listens on port 5432.",
    "The user prefers dark mode in every editor and terminal.",
    "Postgres connection pool is capped at 20 connections per service.",
  ];

  const updates = [
    "The PostgreSQL database runs on db-primary.internal and listens on port 6543.",
    "The user no longer prefers dark mode in every editor and terminal.",
    "The user prefers light mode in every editor and terminal.",
    "Postgres connection pool is capped at 50 connections per service.",
    "Our production deploy moved from AWS to Fly.io machines.",
  ];

  for (const update of updates) {
    test(`retains "${update.slice(0, 44)}…"`, () => {
      const decision = shouldRetain({
        content: update,
        existingContent: stored,
      });
      expect(decision.retain).toBe(true);
    });
  }

  for (const dup of stored) {
    test(`collapses exact restatement "${dup.slice(0, 44)}…"`, () => {
      expect(isRestatement(dup, stored)).toBe(true);
    });
  }

  test("a value swap is never a restatement", () => {
    expect(
      findRestatement(
        "Postgres connection pool is capped at 50 connections per service.",
        stored,
      ),
    ).toBeNull();
  });
});

describe("resolveContradictionsAtRead — a supersession chain resolves fully", () => {
  const node = (id: string, createdAt: number): MemoryNode =>
    ({
      id,
      content: id,
      createdAt,
      updatedAt: createdAt,
      lastAccessed: createdAt,
      accessCount: 0,
      importance: 0.5,
    }) as unknown as MemoryNode;

  const result = (n: MemoryNode, score: number): ScoredMemory => ({
    node: n,
    score,
  });

  const pair = (nodeA: string, nodeB: string): ContradictionRecord =>
    ({
      id: `${nodeA}|${nodeB}`,
      nodeA,
      nodeB,
      status: "resolved",
    }) as unknown as ContradictionRecord;

  test("each member ranks below everything that replaced it", () => {
    // Chain a → b → c → d, each replacement scoring BELOW the version it
    // replaces so the demotion factor alone could not rescue the order.
    const results = [
      result(node("a", 1000), 4),
      result(node("b", 2000), 3),
      result(node("c", 3000), 2),
      result(node("d", 4000), 1),
    ];
    const resolved = resolveContradictionsAtRead(results, [
      pair("a", "b"),
      pair("b", "c"),
      pair("c", "d"),
    ]);
    const order = resolved.map((r) => r.node.id);
    // d is not superseded, so it may float; the superseded chain must be
    // strictly descending in recency.
    const chain = order.filter((id) => id !== "d");
    expect(chain).toEqual(["c", "b", "a"]);
  });

  test("the factor is applied at most once per node", () => {
    const results = [
      result(node("a", 1000), 0.9),
      result(node("b", 2000), 0.8),
    ];
    const resolved = resolveContradictionsAtRead(results, [
      pair("a", "b"),
      pair("a", "b"),
    ]);
    expect(resolved.find((r) => r.node.id === "a")!.score).toBeCloseTo(
      0.45,
      10,
    );
  });

  test("single-member pairs are untouched", () => {
    const results = [result(node("a", 1000), 0.9), result(node("z", 500), 0.8)];
    const resolved = resolveContradictionsAtRead(results, [pair("a", "b")]);
    expect(resolved.map((r) => r.score).sort((x, y) => y - x)).toEqual([
      0.9, 0.8,
    ]);
  });
});

describe("extractTriples — subjects normalize to a comparable noun phrase", () => {
  test("possessives do not fragment the subject", () => {
    const t = extractTriples("The user's timezone is Europe/Berlin.");
    expect(t[0]!.subject).toBe("user timezone");
  });

  test("interrogatives and auxiliaries are stripped from a question subject", () => {
    const t = extractTriples("What does the api service read its config from?");
    expect(t[0]!.subject).toBe("api service");
  });

  test("a question and the memory it asks about produce the same subject", () => {
    const query = extractTriples(
      "What does the api service read its config from?",
    );
    const stored = extractTriples(
      "The api service reads its config from environment variables validated by zod at boot.",
    );
    expect(triplesMatch(query, stored)).toBe(true);
  });

  test("an unrelated fact does not match the question", () => {
    const query = extractTriples(
      "What does the api service read its config from?",
    );
    const stored = extractTriples(
      "The docs site deploys to GitHub Pages from the website folder.",
    );
    expect(triplesMatch(query, stored)).toBe(false);
  });
});
