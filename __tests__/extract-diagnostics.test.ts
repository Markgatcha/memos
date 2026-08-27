/**
 * Tests for extractFacts (conversation-to-memory extraction) and
 * diagnostics (memory store health report).
 */

import { MemOS } from "../src/memory";
import type { ConversationMessage } from "../src/types";
import { existsSync, unlinkSync } from "node:fs";

let dbCounter = 0;
function tmpDb(): string {
  dbCounter += 1;
  return `${process.cwd()}/.tmp-extract-diag-${dbCounter}-${Date.now()}.db`;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
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
  const path = dbPath ?? tmpDb();
  const memos = makeMemos(path);
  await memos.init();
  try {
    return await fn(memos);
  } finally {
    await memos.close();
    // Remove auto-generated temp DBs (and WAL/SHM sidecars). Explicitly
    // passed paths are managed by the caller.
    if (dbPath === undefined) cleanupDb(path);
  }
}

describe("extractFacts", () => {
  test("extracts preference facts from user messages", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "I like dark mode for coding" },
        { role: "assistant", content: "I'll remember that preference" },
      ];
      const result = await memos.extractFacts(messages);
      expect(result.facts.length).toBeGreaterThan(0);

      const preferenceFact = result.facts.find((f) => f.type === "preference");
      expect(preferenceFact).toBeDefined();
      expect(preferenceFact!.content).toContain("dark mode");
      expect(preferenceFact!.source).toBe("user_input");
    });
  });

  test("extracts entity facts from identity statements", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "My name is Alice and I work as a developer" },
      ];
      const result = await memos.extractFacts(messages);
      const entityFact = result.facts.find((f) => f.type === "entity");
      expect(entityFact).toBeDefined();
      expect(entityFact!.content).toContain("Alice");
      expect(entityFact!.tags).toContain("identity");
    });
  });

  test("extracts context facts from planning statements", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "I'm working on a migration to PostgreSQL this week" },
      ];
      const result = await memos.extractFacts(messages);
      const contextFact = result.facts.find((f) => f.type === "context");
      expect(contextFact).toBeDefined();
    });
  });

  test("extracts generic facts from declarative user statements", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "The server uses Redis for caching sessions." },
      ];
      const result = await memos.extractFacts(messages);
      const fact = result.facts.find((f) => f.type === "fact");
      expect(fact).toBeDefined();
    });
  });

  test("skips system messages", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "system", content: "I like dark mode" },
      ];
      const result = await memos.extractFacts(messages);
      expect(result.facts).toHaveLength(0);
    });
  });

  test("agent_inferred source for assistant messages", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        {
          role: "assistant",
          content: "I prefer to use Python for data processing tasks.",
        },
      ];
      const result = await memos.extractFacts(messages);
      const fact = result.facts.find((f) => f.source === "agent_inferred");
      expect(fact).toBeDefined();
    });
  });

  test("autoStore stores facts above minConfidence", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "I like dark mode" },
        { role: "user", content: "I prefer tabs over spaces" },
      ];
      const result = await memos.extractFacts(messages, {
        autoStore: true,
        minConfidence: 0.5,
      });
      expect(result.storedIds.length).toBeGreaterThan(0);
      expect(result.storedIds.length).toBeLessThanOrEqual(result.facts.length);

      // Verify the stored nodes exist
      for (const id of result.storedIds) {
        const node = await memos.retrieve(id);
        expect(node).not.toBeNull();
        expect(node!.source).toBe("user_input");
      }
    });
  });

  test("autoStore skips facts below minConfidence", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "The weather is nice today I guess." },
      ];
      const result = await memos.extractFacts(messages, {
        autoStore: true,
        minConfidence: 0.99, // Set very high to skip all
      });
      expect(result.storedIds).toHaveLength(0);
    });
  });

  test("emits facts:extracted event", async () => {
    await withMemos(async (memos) => {
      const events: unknown[] = [];
      memos.on("facts:extracted", (data) => events.push(data));

      const messages: ConversationMessage[] = [
        { role: "user", content: "I like dark mode" },
      ];
      await memos.extractFacts(messages);
      expect(events).toHaveLength(1);
    });
  });

  test("confidence is boosted for short sentences", async () => {
    await withMemos(async (memos) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: "I like tea." },
      ];
      const result = await memos.extractFacts(messages);
      const fact = result.facts[0];
      expect(fact.confidence).toBeGreaterThan(0.8); // 0.8 base + 0.1 short boost
    });
  });

  test("handles empty conversation", async () => {
    await withMemos(async (memos) => {
      const result = await memos.extractFacts([]);
      expect(result.facts).toHaveLength(0);
      expect(result.storedIds).toHaveLength(0);
      expect(result.duplicates).toBe(0);
    });
  });
});

describe("diagnostics", () => {
  test("returns correct counts for empty store", async () => {
    await withMemos(async (memos) => {
      const diag = await memos.diagnostics();
      expect(diag.totalNodes).toBe(0);
      expect(diag.totalEdges).toBe(0);
      expect(diag.avgImportance).toBe(0);
      expect(diag.avgTrustScore).toBe(0);
    });
  });

  test("returns correct counts after storing memories", async () => {
    await withMemos(async (memos) => {
      await memos.store("Fact one", { source: "user_input" });
      await memos.store("Fact two", { source: "agent_inferred", trustScore: 0.5 });
      await memos.store("Fact three", { source: "external_data", trustScore: 0.3 });

      const diag = await memos.diagnostics();
      expect(diag.totalNodes).toBe(3);
      expect(diag.bySource["user_input"]).toBe(1);
      expect(diag.bySource["agent_inferred"]).toBe(1);
      expect(diag.bySource["external_data"]).toBe(1);
      expect(diag.byType["fact"]).toBe(3);
      expect(diag.byNamespace["default"]).toBe(3);
    });
  });

  test("counts historical nodes", async () => {
    await withMemos(async (memos) => {
      const { node } = await memos.store("Will be superseded");
      await memos.store("Current memory");

      // Before superseding: no historical
      let diag = await memos.diagnostics();
      expect(diag.historicalNodes).toBe(0);

      // Supersede it
      await memos.supersede(node.id);

      diag = await memos.diagnostics();
      expect(diag.historicalNodes).toBe(1);
    });
  });

  test("counts nodes with validity", async () => {
    await withMemos(async (memos) => {
      await memos.store("No validity");
      await memos.store("With validity", {
        validFrom: Date.now() - 1000,
        validTo: Date.now() + 1000,
      });

      const diag = await memos.diagnostics();
      expect(diag.nodesWithValidity).toBe(1);
    });
  });

  test("reports storage capabilities", async () => {
    await withMemos(async (memos) => {
      const diag = await memos.diagnostics();
      expect(diag.storageCapabilities.peekNode).toBe(true);
      expect(diag.storageCapabilities.evictLeastImportant).toBe(true);
      expect(diag.storageCapabilities.saveEmbedding).toBe(true);
    });
  });

  test("reports db file size", async () => {
    await withMemos(async (memos) => {
      await memos.store("Some data to make the file non-trivial");
      const diag = await memos.diagnostics();
      expect(diag.dbSizeBytes).toBeGreaterThan(0);
    });
  });

  test("reports average trust score", async () => {
    await withMemos(async (memos) => {
      await memos.store("High trust", { trustScore: 1.0 });
      await memos.store("Low trust", { trustScore: 0.2 });

      const diag = await memos.diagnostics();
      expect(diag.avgTrustScore).toBeCloseTo(0.6, 5);
    });
  });

  test("breakdown by type includes all types", async () => {
    await withMemos(async (memos) => {
      await memos.store("A fact", { type: "fact" });
      await memos.store("A preference", { type: "preference" });
      await memos.store("An entity", { type: "entity" });

      const diag = await memos.diagnostics();
      expect(diag.byType["fact"]).toBe(1);
      expect(diag.byType["preference"]).toBe(1);
      expect(diag.byType["entity"]).toBe(1);
    });
  });
});