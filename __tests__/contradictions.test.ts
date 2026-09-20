/**
 * Tests for contradiction candidate detection at write time and
 * rule-based resolution at read time (accuracy item 4).
 *
 * Covered:
 *   - `findContradictionCandidates`: the 0.5–0.85 similarity band +
 *     entity overlap + shared-subject guard (no LLM anywhere);
 *   - `resolveContradictionsAtRead`: older pair member demoted, never
 *     removed; single-member sets untouched; deterministic;
 *   - `contradictions` table: round-trip, canonical ordering, UNIQUE
 *     dedup on reversed pairs, status transitions;
 *   - end-to-end: store() writes trigger the bounded write-time scan
 *     once the embedding is persisted, and search() demotes the older
 *     member of a recorded pair.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  CONTRADICTION_DEMOTION_FACTOR,
  CONTRADICTION_SIM_MAX,
  CONTRADICTION_SIM_MIN,
  findContradictionCandidates,
  resolveContradictionsAtRead,
} from "../src/contradictions";
import type { ContradictionCandidateInput } from "../src/contradictions";
import type {
  ContradictionRecord,
  EmbeddingProvider,
  EmbeddingVector,
  MemoryNode,
  ScoredMemory,
} from "../src/types";

/** Vector with cosine similarity `sim` to [1, 0]. */
function bandVector(sim: number): [number, number] {
  return [sim, Math.sqrt(Math.max(0, 1 - sim * sim))];
}

// "Alice moved to Berlin last year" extracts entities ["berlin"];
// "Alice no longer lives in Berlin" extracts ["berlin"] too, and the
// two share the subject word "alice".
const NEW_CONTENT = "Alice moved to Berlin last year";
const OLD_CONTENT = "Alice no longer lives in Berlin";

function candidate(
  sim: number,
  overrides: Partial<ContradictionCandidateInput> = {},
): ContradictionCandidateInput {
  return {
    id: "cand-old",
    content: OLD_CONTENT,
    vector: bandVector(sim),
    entities: ["berlin"],
    ...overrides,
  };
}

function makeNode(id: string, createdAt: number): MemoryNode {
  return {
    id,
    content: `content of ${id}`,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt,
    updatedAt: createdAt,
    accessCount: 0,
    lastAccessed: createdAt,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    pool: "event",
    trustScore: 1,
    confidence: 0.5,
    evidenceCount: 0,
  };
}

function makeResult(node: MemoryNode, score: number): ScoredMemory {
  return { node, score, scores: { hybrid: score } };
}

function makePair(
  nodeA: string,
  nodeB: string,
  overrides: Partial<ContradictionRecord> = {},
): ContradictionRecord {
  return {
    id: `${nodeA}::${nodeB}`,
    nodeA,
    nodeB,
    detectedAt: Date.now(),
    status: "unresolved",
    ...overrides,
  };
}

describe("findContradictionCandidates", () => {
  test("flags a pair in the band with shared entity and subject", () => {
    const flagged = findContradictionCandidates(
      NEW_CONTENT,
      [1, 0],
      [candidate(0.7)],
    );
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.id).toBe("cand-old");
    expect(flagged[0]!.similarity).toBeCloseTo(0.7, 5);
  });

  test("does not flag duplicates (similarity >= 0.85)", () => {
    expect(
      findContradictionCandidates(NEW_CONTENT, [1, 0], [candidate(0.85)]),
    ).toHaveLength(0);
    expect(
      findContradictionCandidates(NEW_CONTENT, [1, 0], [candidate(0.95)]),
    ).toHaveLength(0);
  });

  test("does not flag unrelated memories (similarity < 0.5)", () => {
    expect(
      findContradictionCandidates(NEW_CONTENT, [1, 0], [candidate(0.2)]),
    ).toHaveLength(0);
  });

  test("flags at the inclusive lower bound (similarity == 0.5)", () => {
    expect(
      findContradictionCandidates(NEW_CONTENT, [1, 0], [candidate(0.5)]),
    ).toHaveLength(1);
  });

  test("does not flag when there is no shared entity", () => {
    const flagged = findContradictionCandidates(
      NEW_CONTENT,
      [1, 0],
      [candidate(0.7, { entities: ["tokyo"] })],
    );
    expect(flagged).toHaveLength(0);
  });

  test("does not flag when the texts share no subject", () => {
    const flagged = findContradictionCandidates(
      NEW_CONTENT,
      [1, 0],
      [
        candidate(0.7, {
          content: "Xyzzy plugh qwerty",
          entities: ["berlin"],
        }),
      ],
    );
    expect(flagged).toHaveLength(0);
  });

  test("preserves candidate order (deterministic)", () => {
    const flagged = findContradictionCandidates(
      NEW_CONTENT,
      [1, 0],
      [
        candidate(0.7, { id: "first" }),
        candidate(0.6, { id: "second" }),
        candidate(0.2, { id: "unrelated" }),
        candidate(0.75, { id: "third" }),
      ],
    );
    expect(flagged.map((f) => f.id)).toEqual(["first", "second", "third"]);
  });

  test("exports the nirdiamant band thresholds", () => {
    expect(CONTRADICTION_SIM_MIN).toBe(0.5);
    expect(CONTRADICTION_SIM_MAX).toBe(0.85);
  });
});

describe("resolveContradictionsAtRead", () => {
  test("demotes the older member when both members are present", () => {
    const older = makeNode("node-a", 1000);
    const newer = makeNode("node-b", 2000);
    const results = [makeResult(older, 0.9), makeResult(newer, 0.8)];

    const resolved = resolveContradictionsAtRead(results, [
      makePair("node-a", "node-b"),
    ]);

    const byId = new Map(resolved.map((r) => [r.node.id, r]));
    const demoted = byId.get("node-a")!;
    const kept = byId.get("node-b")!;
    // Older is demoted by the factor, marked, and never removed.
    expect(demoted.score).toBeCloseTo(0.9 * CONTRADICTION_DEMOTION_FACTOR, 10);
    expect(demoted.scores?.contradiction_demoted).toBe(
      CONTRADICTION_DEMOTION_FACTOR,
    );
    expect(demoted.scores?.hybrid).toBeCloseTo(demoted.score, 10);
    // Newer keeps its score and carries no marker.
    expect(kept.score).toBe(0.8);
    expect(kept.scores?.contradiction_demoted).toBeUndefined();
    // The newer version now outranks the older one.
    expect(resolved[0]!.node.id).toBe("node-b");
    expect(resolved).toHaveLength(2);
  });

  test("leaves results untouched when only one member is present", () => {
    const older = makeNode("node-a", 1000);
    const stranger = makeNode("node-z", 1500);
    const results = [makeResult(older, 0.9), makeResult(stranger, 0.8)];

    const resolved = resolveContradictionsAtRead(results, [
      makePair("node-a", "node-b"),
    ]);

    expect(resolved[0]!.score).toBe(0.9);
    expect(resolved[1]!.score).toBe(0.8);
    for (const r of resolved) {
      expect(r.scores?.contradiction_demoted).toBeUndefined();
    }
  });

  test("does not mutate the input results", () => {
    const older = makeNode("node-a", 1000);
    const newer = makeNode("node-b", 2000);
    const results = [makeResult(older, 0.9), makeResult(newer, 0.8)];
    const originalScores = results.map((r) => ({ ...r.scores }));

    resolveContradictionsAtRead(results, [makePair("node-a", "node-b")]);

    expect(results[0]!.score).toBe(0.9);
    expect(results[0]!.scores).toEqual(originalScores[0]);
    expect(results[1]!.score).toBe(0.8);
  });

  test("a node in two pairs is demoted only once", () => {
    const a = makeNode("node-a", 1000);
    const b = makeNode("node-b", 2000);
    const c = makeNode("node-c", 3000);
    const results = [
      makeResult(a, 0.9),
      makeResult(b, 0.8),
      makeResult(c, 0.7),
    ];

    const resolved = resolveContradictionsAtRead(results, [
      makePair("node-a", "node-b"),
      makePair("node-a", "node-c"),
    ]);

    const demoted = resolved.find((r) => r.node.id === "node-a")!;
    // Exactly one demotion, not 0.9 * 0.5 * 0.5.
    expect(demoted.score).toBeCloseTo(0.9 * CONTRADICTION_DEMOTION_FACTOR, 10);
  });

  test("deterministic across pair input orders", () => {
    const a = makeNode("node-a", 1000);
    const b = makeNode("node-b", 2000);
    const c = makeNode("node-c", 3000);
    const results = [
      makeResult(a, 0.9),
      makeResult(b, 0.8),
      makeResult(c, 0.7),
    ];
    const pairs = [makePair("node-b", "node-c"), makePair("node-a", "node-b")];
    const reversed = [...pairs].reverse();

    const r1 = resolveContradictionsAtRead(results, pairs);
    const r2 = resolveContradictionsAtRead(results, reversed);
    expect(r1.map((r) => [r.node.id, r.score])).toEqual(
      r2.map((r) => [r.node.id, r.score]),
    );
  });

  test("returns a copy when there is nothing to resolve", () => {
    const results = [makeResult(makeNode("node-a", 1000), 0.9)];
    const resolved = resolveContradictionsAtRead(results, []);
    expect(resolved).not.toBe(results);
    expect(resolved).toEqual(results);
  });
});

describe("contradictions table (SQLiteStorage)", () => {
  async function makeStorage(): Promise<SQLiteStorage> {
    const storage = new SQLiteStorage(":memory:", true);
    await storage.init();
    return storage;
  }

  test("round-trip: add, fetch, canonical ordering", async () => {
    const storage = await makeStorage();
    const record = await storage.addContradiction("node-b", "node-a");
    expect(record.nodeA).toBe("node-a"); // canonically sorted
    expect(record.nodeB).toBe("node-b");
    expect(record.status).toBe("unresolved");
    expect(typeof record.id).toBe("string");

    const pairs = await storage.getContradictionPairsFor(["node-a"]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.nodeA).toBe("node-a");
    expect(pairs[0]!.nodeB).toBe("node-b");
    await storage.close();
  });

  test("UNIQUE dedup: reversed pair order is a no-op", async () => {
    const storage = await makeStorage();
    await storage.addContradiction("node-a", "node-b");
    await storage.addContradiction("node-b", "node-a");

    const pairs = await storage.getContradictionPairsFor(["node-a", "node-b"]);
    expect(pairs).toHaveLength(1);
    await storage.close();
  });

  test("pairs query matches either side and ignores unknown ids", async () => {
    const storage = await makeStorage();
    await storage.addContradiction("node-a", "node-b");
    await storage.addContradiction("node-c", "node-d");

    expect(await storage.getContradictionPairsFor(["node-b"])).toHaveLength(1);
    expect(await storage.getContradictionPairsFor(["nope"])).toHaveLength(0);
    expect(await storage.getContradictionPairsFor([])).toHaveLength(0);
    expect(
      await storage.getContradictionPairsFor(["node-a", "node-d"]),
    ).toHaveLength(2);
    await storage.close();
  });

  test("status transitions to resolved", async () => {
    const storage = await makeStorage();
    const record = await storage.addContradiction(
      "node-a",
      "node-b",
      "resolved",
    );
    expect(record.status).toBe("resolved");

    await storage.updateContradictionStatus(record.id, "unresolved");
    const pairs = await storage.getContradictionPairsFor(["node-a"]);
    expect(pairs[0]!.status).toBe("unresolved");
    await storage.close();
  });
});

/**
 * Scripted provider: pins vectors per content so the contradiction band
 * is hit deterministically. OLD ("moved to Berlin") -> [1, 0]; NEW
 * ("no longer lives in Berlin") -> [0.7, 0.714] (cosine 0.7 — inside
 * the band); "relocated far away" -> [0.2, 0.9799] (cosine 0.2 with
 * OLD — below the contradicted threshold for the evidence path);
 * everything else -> [0, 1] (orthogonal, never a neighbor).
 */
class ScriptedProvider implements EmbeddingProvider {
  public readonly id = "scripted";
  public readonly model = "scripted-v1";
  public readonly dimensions = 2;

  async embed(text: string): Promise<EmbeddingVector> {
    if (text.includes("relocated far away")) return [0.2, 0.9799];
    if (text.includes("no longer lives in Berlin")) return [0.7, 0.714];
    if (text.includes("moved to Berlin")) return [1, 0];
    return [0, 1];
  }
}

function makeMemos() {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider: new ScriptedProvider() },
    embeddingQueue: { synchronous: true },
  });
}

describe("write-time detection + read-time resolution (integration)", () => {
  test("storing a contradicting memory records the pair", async () => {
    const memos = makeMemos();
    await memos.init();

    const detected = new Promise<{ nodeId: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("contradiction:detected never fired")),
        10000,
      );
      memos.on("contradiction:detected", (data) => {
        clearTimeout(timer);
        resolve(data as { nodeId: string });
      });
    });

    const old = await memos.store("Alice moved to Berlin last year");
    const fresh = await memos.store("Alice no longer lives in Berlin");

    const event = await detected;
    expect(event.nodeId).toBe(fresh.node.id);

    const pairs = await (
      memos as unknown as { storage: SQLiteStorage }
    ).storage.getContradictionPairsFor([old.node.id, fresh.node.id]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.status).toBe("unresolved");
    // Canonical ordering in the record.
    const [a, b] = [old.node.id, fresh.node.id].sort();
    expect(pairs[0]!.nodeA).toBe(a);
    expect(pairs[0]!.nodeB).toBe(b);

    await memos.close();
  });

  test("search() does NOT demote members of unresolved heuristic pairs", async () => {
    const memos = makeMemos();
    await memos.init();

    const detected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("contradiction:detected never fired")),
        10000,
      );
      memos.on("contradiction:detected", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const old = await memos.store("Alice moved to Berlin last year");
    const fresh = await memos.store("Alice no longer lives in Berlin");
    await detected;

    // The heuristic pair is recorded as unresolved ...
    const storage = (memos as unknown as { storage: SQLiteStorage }).storage;
    const pairs = await storage.getContradictionPairsFor([
      old.node.id,
      fresh.node.id,
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.status).toBe("unresolved");

    // ... and unresolved pairs never touch ranking: at corpus scale the
    // candidate rule's precision is too low for unreviewed pairs to
    // demote results.
    const results = await memos.search("Berlin");
    for (const r of results) {
      expect(r.scores?.contradiction_demoted).toBeUndefined();
    }

    await memos.close();
  });

  test("search() demotes the older member of a resolved pair", async () => {
    const memos = makeMemos();
    await memos.init();

    const detected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("contradiction:detected never fired")),
        10000,
      );
      memos.on("contradiction:detected", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const old = await memos.store("Alice moved to Berlin last year");
    const fresh = await memos.store("Alice no longer lives in Berlin");
    await detected;

    // Adjudication (e.g. the future sleep-time loop, or the evidence
    // state machine's supersession path) confirms the pair.
    const storage = (memos as unknown as { storage: SQLiteStorage }).storage;
    const pairs = await storage.getContradictionPairsFor([
      old.node.id,
      fresh.node.id,
    ]);
    expect(pairs).toHaveLength(1);
    await storage.updateContradictionStatus(pairs[0]!.id, "resolved");

    const results = await memos.search("Berlin");
    const oldResult = results.find((r) => r.node.id === old.node.id);
    const newResult = results.find((r) => r.node.id === fresh.node.id);
    expect(oldResult).toBeDefined();
    expect(newResult).toBeDefined();

    // Older member demoted and marked; newer untouched.
    expect(oldResult!.scores?.contradiction_demoted).toBe(
      CONTRADICTION_DEMOTION_FACTOR,
    );
    expect(newResult!.scores?.contradiction_demoted).toBeUndefined();
    // The newer version outranks the stale one.
    expect(results.findIndex((r) => r.node.id === fresh.node.id)).toBeLessThan(
      results.findIndex((r) => r.node.id === old.node.id),
    );

    await memos.close();
  });

  test("no pair is recorded for unrelated memories", async () => {
    const memos = makeMemos();
    await memos.init();

    let fired = 0;
    memos.on("contradiction:detected", () => {
      fired += 1;
    });

    await memos.store("Alice moved to Berlin last year");
    await memos.store("The quarterly report is due on Friday");
    // Let the background embedding IIFEs settle.
    await new Promise((r) => setTimeout(r, 500));

    expect(fired).toBe(0);
    const pairs = await (
      memos as unknown as { storage: SQLiteStorage }
    ).storage.getContradictionPairsFor([]);
    expect(pairs).toHaveLength(0);

    await memos.close();
  });

  test("evidenceLearning supersede records a resolved pair", async () => {
    const memos = makeMemos();
    await memos.init();

    // Pair similarity 0.2 (< 0.3) + contradiction signal ("no longer")
    // + shared subject ("alice", "berlin") → the evidence state
    // machine supersedes the old version, and store() records the
    // pair as resolved for provenance.
    const old = await memos.store("Alice moved to Berlin last year", {
      evidenceLearning: true,
    });
    const fresh = await memos.store(
      "Alice no longer lives in Berlin, she relocated far away",
      { evidenceLearning: true },
    );

    // The old version was marked historical by the contradicted outcome.
    const historical = await memos.retrieve(old.node.id);
    expect(historical?.validTo).not.toBeNull();

    const pairs = await (
      memos as unknown as { storage: SQLiteStorage }
    ).storage.getContradictionPairsFor([old.node.id, fresh.node.id]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.status).toBe("resolved");

    await memos.close();
  });
});
