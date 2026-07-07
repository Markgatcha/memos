/**
 * Tests for temporal validity, trust scoring, and provenance.
 *
 * Covers:
 *   - store() with validFrom / validTo / source / trustScore
 *   - setValidity() / supersede()
 *   - searchTemporal()
 *   - default search excludes historical memories
 *   - trust() / setTrust() / adjustTrust()
 *   - search filters by source, minTrustScore
 */

import { MemOS } from "../src/memory";
import type { MemoryNode } from "../src/types";
import { existsSync, unlinkSync } from "node:fs";

let dbCounter = 0;
function tmpDb(): string {
  dbCounter += 1;
  return `${process.cwd()}/.tmp-temporal-trust-${dbCounter}-${Date.now()}.db`;
}

function makeMemos(dbPath?: string): MemOS {
  return new MemOS({
    dbPath: dbPath ?? tmpDb(),
    wal: true,
    autoLinkThreshold: 0,
  });
}

async function withMemos<T>(
  fn: (memos: MemOS) => Promise<T>,
  dbPath?: string,
): Promise<T> {
  const memos = makeMemos(dbPath);
  await memos.init();
  try {
    return await fn(memos);
  } finally {
    await memos.close();
  }
}

describe("Temporal validity", () => {
  test("store() accepts validFrom and validTo", async () => {
    await withMemos(async (memos) => {
      const now = Date.now();
      const { node } = await memos.store("User works at Google", {
        validFrom: now - 86_400_000,
        validTo: null,
      });
      expect(node.validFrom).toBe(now - 86_400_000);
      expect(node.validTo).toBeNull();
    });
  });

  test("setValidity sets both validFrom and validTo", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("User lives in NYC");
      expect(node.validFrom).toBeNull();
      expect(node.validTo).toBeNull();

      const from = Date.now() - 1000;
      const to = Date.now() + 1000;
      const updated = await memos.setValidity(node.id, from, to);
      expect(updated).not.toBeNull();
      expect(updated!.validFrom).toBe(from);
      expect(updated!.validTo).toBe(to);
    });
  });

  test("setValidity emits validity:changed event", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("test memory");
      const events: unknown[] = [];
      memos.on("validity:changed", (data) => events.push(data));

      await memos.setValidity(node.id, null, Date.now());
      expect(events).toHaveLength(1);
    });
  });

  test("supersede marks a memory as historical", async () => {
    await withMemos(async (memos) => {
      const { node: old } = await memos.store("User works at Google");
      const { node: replacement } = await memos.store("User works at Apple");

      const superseded = await memos.supersede(old.id, replacement.id);
      expect(superseded).not.toBeNull();
      expect(superseded!.validTo).not.toBeNull();
      expect(superseded!.validTo!).toBeLessThanOrEqual(Date.now());

      // Edge should be created
      const edges = await memos.getEdges(old.id);
      const temporalEdge = edges.find((e) => e.relation === "temporal_precedes");
      expect(temporalEdge).toBeDefined();
      expect(temporalEdge!.targetId).toBe(replacement.id);
    });
  });

  test("default search excludes historical memories", async () => {
    await withMemos(async (memos) => {
      const { node: old } = await memos.store("User works at Google");
      await memos.store("User works at Apple");

      // Supersede the old memory
      await memos.supersede(old.id);

      // Default search should not return the superseded memory
      const results = await memos.search("works at");
      const ids = results.map((r) => r.node.id);
      expect(ids).not.toContain(old.id);
    });
  });

  test("includeHistorical: false explicitly excludes historical", async () => {
    await withMemos(async (memos) => {
      const { node: old } = await memos.store("User works at Google");
      await memos.store("User works at Apple");
      await memos.supersede(old.id);

      const results = await memos.search({ query: "works at", includeHistorical: false });
      expect(results.map((r) => r.node.id)).not.toContain(old.id);
    });
  });

  test("includeHistorical: true includes historical memories", async () => {
    await withMemos(async (memos) => {
      const { node: old } = await memos.store("User works at Google");
      await memos.store("User works at Apple");
      await memos.supersede(old.id);

      const results = await memos.search({ query: "works at", includeHistorical: true });
      const ids = results.map((r) => r.node.id);
      expect(ids).toContain(old.id);
    });
  });

  test("searchTemporal returns memories valid at a specific time", async () => {
    await withMemos(async (memos) => {
      const pastTime = Date.now() - 86_400_000; // 1 day ago
      const futureTime = Date.now() + 86_400_000; // 1 day from now

      // Memory valid in the past
      await memos.store("Old job", {
        validFrom: pastTime - 1000,
        validTo: pastTime + 1000,
      });

      // Memory valid now
      await memos.store("Current job");

      // Memory valid in the future
      await memos.store("Future job", {
        validFrom: futureTime,
        validTo: futureTime + 1000,
      });

      // Query at the past time — should find "Old job"
      const pastResults = await memos.searchTemporal("job", pastTime + 500);
      const pastContents = pastResults.map((r) => r.node.content);
      expect(pastContents).toContain("Old job");
      expect(pastContents).not.toContain("Future job");
    });
  });

  test("searchTemporal with no validity set returns all", async () => {
    await withMemos(async (memos) => {
      await memos.store("No validity set");
      const results = await memos.searchTemporal("validity", Date.now());
      expect(results.length).toBeGreaterThan(0);
    });
  });
});

describe("Trust scoring & provenance", () => {
  test("store() defaults source to user_input with trust 1.0", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("User said this");
      expect(node.source).toBe("user_input");
      expect(node.trustScore).toBe(1.0);
    });
  });

  test("store() with source agent_inferred gets default trust 0.7", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Inferred fact", {
        source: "agent_inferred",
      });
      expect(node.source).toBe("agent_inferred");
      expect(node.trustScore).toBeCloseTo(0.7, 5);
    });
  });

  test("store() with explicit trustScore overrides default", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Custom trust", {
        source: "external_data",
        trustScore: 0.9,
      });
      expect(node.trustScore).toBe(0.9);
    });
  });

  test("trust() returns the trust score", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Test");
      const score = await memos.trust(node.id);
      expect(score).toBe(1.0);
    });
  });

  test("trust() returns null for non-existent node", async () => {
    await withMemos(async (memos) => {
      const score = await memos.trust("nonexistent-id");
      expect(score).toBeNull();
    });
  });

  test("setTrust() updates the trust score", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Test");
      const updated = await memos.setTrust(node.id, 0.5);
      expect(updated).not.toBeNull();
      expect(updated!.trustScore).toBe(0.5);

      const score = await memos.trust(node.id);
      expect(score).toBe(0.5);
    });
  });

  test("setTrust() clamps to [0, 1]", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Test");
      const tooHigh = await memos.setTrust(node.id, 5.0);
      expect(tooHigh!.trustScore).toBe(1.0);

      const tooLow = await memos.setTrust(node.id, -1.0);
      expect(tooLow!.trustScore).toBe(0.0);
    });
  });

  test("setTrust() emits trust:changed event", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Test");
      const events: unknown[] = [];
      memos.on("trust:changed", (data) => events.push(data));

      await memos.setTrust(node.id, 0.3);
      expect(events).toHaveLength(1);
    });
  });

  test("adjustTrust() adds delta to current score", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Test", { trustScore: 0.5 });
      const updated = await memos.adjustTrust(node.id, 0.3);
      expect(updated!.trustScore).toBeCloseTo(0.8, 5);
    });
  });

  test("adjustTrust() clamps at boundaries", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Test", { trustScore: 0.9 });
      const updated = await memos.adjustTrust(node.id, 0.5);
      expect(updated!.trustScore).toBe(1.0);
    });
  });

  test("search filters by minTrustScore", async () => {
    await withMemos(async (memos) => {
      await memos.store("High trust", { trustScore: 0.9 });
      await memos.store("Low trust", { trustScore: 0.2 });

      const results = await memos.search({ query: "trust", minTrustScore: 0.5 });
      const contents = results.map((r) => r.node.content);
      expect(contents).toContain("High trust");
      expect(contents).not.toContain("Low trust");
    });
  });

  test("search filters by source", async () => {
    await withMemos(async (memos) => {
      await memos.store("User fact", { source: "user_input" });
      await memos.store("Inferred fact", { source: "agent_inferred" });

      const userResults = await memos.search({ query: "fact", source: "user_input" });
      const userContents = userResults.map((r) => r.node.content);
      expect(userContents).toContain("User fact");
      expect(userContents).not.toContain("Inferred fact");
    });
  });

  test("search sorts by trustScore", async () => {
    await withMemos(async (memos) => {
      await memos.store("Medium trust", { trustScore: 0.5 });
      await memos.store("High trust", { trustScore: 0.9 });
      await memos.store("Low trust", { trustScore: 0.1 });

      const results = await memos.search({
        query: "trust",
        sortBy: "trustScore",
        sortOrder: "desc",
      });
      expect(results.length).toBeGreaterThanOrEqual(3);
      expect(results[0].node.trustScore).toBeGreaterThanOrEqual(
        results[1].node.trustScore,
      );
    });
  });

  test("persisted nodes retain source and trustScore across restarts", async () => {
    const dbPath = tmpDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);

    await withMemos(async (memos) => {
      await memos.store("Persistent fact", {
        source: "external_data",
        trustScore: 0.6,
      });
    }, dbPath);

    await withMemos(async (memos) => {
      const results = await memos.search("Persistent");
      expect(results.length).toBe(1);
      expect(results[0].node.source).toBe("external_data");
      expect(results[0].node.trustScore).toBeCloseTo(0.6, 5);
    }, dbPath);

    if (existsSync(dbPath)) unlinkSync(dbPath);
  });
});
