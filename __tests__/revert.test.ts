/**
 * Tests for command-driven belief revision ("natural-language revert").
 *
 * Covers:
 *   - intent detection: positive + negative patterns, named-target
 *     extraction, target normalization
 *   - CLI flag parsing (pure parseRevertCliArgs)
 *   - scope resolution: last-thing, natural-language text, named entity,
 *     ambiguous (most-recent-wins + alternatives), id, and error cases
 *   - revert execution: validity closed on the target, predecessor
 *     reactivated, recall returns the pre-correction belief, history
 *     intact (add-only), audit event recorded (who/when/why),
 *     memory:reverted emitted, dry-run writes nothing
 *   - predecessor discovery via temporal_precedes edges AND resolved
 *     contradiction pairs
 *   - MCP tool metadata registration (memos_revert, count)
 */

import { existsSync, unlinkSync } from "node:fs";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  detectRevertIntent,
  normalizeRevertTarget,
  parseRevertCliArgs,
} from "../src/revert";
import { getMcpTools } from "../src/mcp";

let dbCounter = 0;
function tmpDb(): string {
  dbCounter += 1;
  return `${process.cwd()}/.tmp-revert-${dbCounter}-${Date.now()}.db`;
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
}

async function withMemos<T>(
  fn: (memos: MemOS, storage: SQLiteStorage) => Promise<T>,
): Promise<T> {
  const path = tmpDb();
  const storage = new SQLiteStorage(path, true);
  const memos = new MemOS({
    storage,
    autoLinkThreshold: 0,
    embeddings: { enabled: false },
  });
  await memos.init();
  try {
    return await fn(memos, storage);
  } finally {
    await memos.close();
    cleanupDb(path);
  }
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

describe("detectRevertIntent", () => {
  const lastScope: string[] = [
    "go back",
    "Go back.",
    "revert that",
    "undo that",
    "undo it",
    "revert the last thing",
    "undo what I just told you",
    "undo what I said",
    "forget the last thing",
    "forget what I just said",
    "take that back",
    "strike it back",
    "that last thing was wrong",
    "the last thing was wrong",
    "that was wrong",
    "this is wrong",
    "scratch that",
    "disregard that",
    "never mind that",
    "actually, revert that",
  ];
  for (const text of lastScope) {
    it(`detects last-scope intent in "${text}"`, () => {
      const intent = detectRevertIntent(text);
      expect(intent.detected).toBe(true);
      expect(intent.scope).toBe("last");
    });
  }

  const namedScope: Array<[string, string]> = [
    ["revert what I said about the dentist", "the dentist"],
    ["revert what I told you about the dentist!", "the dentist"],
    ["undo what I said about my vacation", "my vacation"],
    ["undo the dentist appointment", "dentist appointment"],
    ["revert my note about paris", "paris"],
    ["the dentist thing was wrong", "dentist"],
    ['revert what I said about "the gym"', "the gym"],
  ];
  for (const [text, target] of namedScope) {
    it(`detects named-scope intent in "${text}" -> "${target}"`, () => {
      const intent = detectRevertIntent(text);
      expect(intent.detected).toBe(true);
      expect(intent.scope).toBe("named");
      expect(intent.target).toBe(target);
    });
  }

  const negatives: string[] = [
    "I like the dentist",
    "remember this",
    "don't forget the dentist",
    "forget the dentist",
    "that was great",
    "recall that",
    "delete my account",
    "go back home",
    "go back to sleep",
    "the dentist is great",
    "what did I say about the dentist?",
    "",
  ];
  for (const text of negatives) {
    it(`does not fire on "${text}"`, () => {
      expect(detectRevertIntent(text).detected).toBe(false);
    });
  }
});

describe("normalizeRevertTarget", () => {
  it("strips quotes, punctuation and extra whitespace", () => {
    expect(normalizeRevertTarget('  "the dentist"! ')).toBe("the dentist");
    expect(normalizeRevertTarget("my   vacation.")).toBe("my vacation");
  });
});

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

describe("parseRevertCliArgs", () => {
  it("parses --last", () => {
    const p = parseRevertCliArgs(["--last"]);
    expect(p.scope).toEqual({ kind: "last" });
    expect(p.dryRun).toBe(false);
    expect(p.error).toBeUndefined();
  });

  it("parses --id/--dry-run/--reason/--actor/--namespace", () => {
    const p = parseRevertCliArgs([
      "--id",
      "abc123",
      "--dry-run",
      "--reason",
      "oops",
      "--actor",
      "agent:coder",
      "--namespace",
      "work",
    ]);
    expect(p.scope).toEqual({ kind: "id", id: "abc123" });
    expect(p.dryRun).toBe(true);
    expect(p.reason).toBe("oops");
    expect(p.actor).toBe("agent:coder");
    expect(p.namespace).toBe("work");
  });

  it("maps --about to entity scope", () => {
    const p = parseRevertCliArgs(["--about", "dentist"]);
    expect(p.scope).toEqual({ kind: "entity", entity: "dentist" });
  });

  it("accepts natural-language positional text with revert intent", () => {
    const p = parseRevertCliArgs(["revert that"]);
    expect(p.scope).toEqual({ kind: "text", text: "revert that" });
    expect(p.error).toBeUndefined();
  });

  it("rejects positional text without revert intent", () => {
    const p = parseRevertCliArgs(["hello world"]);
    expect(p.error).toMatch(/No revert intent detected/);
  });

  it("rejects conflicting scopes", () => {
    const p = parseRevertCliArgs(["--last", "--id", "x"]);
    expect(p.error).toMatch(/Conflicting scope/);
  });

  it("rejects missing scope", () => {
    const p = parseRevertCliArgs([]);
    expect(p.error).toMatch(/Nothing to revert/);
  });
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

describe("resolveRevertTarget", () => {
  it("resolves 'last' to the most recent write", async () => {
    await withMemos(async (memos) => {
      await memos.store("first fact");
      await memos.store("second fact");
      const third = await memos.store("third fact");
      const { target, alternatives } = await memos.resolveRevertTarget({
        kind: "last",
      });
      expect(target.id).toBe(third.node.id);
      expect(alternatives).toEqual([]);
    });
  });

  it("resolves natural-language 'revert that' to the last write", async () => {
    await withMemos(async (memos) => {
      await memos.store("first fact");
      const second = await memos.store("second fact");
      const { target } = await memos.resolveRevertTarget("revert that");
      expect(target.id).toBe(second.node.id);
    });
  });

  it("resolves a named entity to the most recent match and lists alternatives", async () => {
    await withMemos(async (memos) => {
      const older = await memos.store("my dentist appointment is tuesday");
      const newer = await memos.store("my dentist appointment moved to friday");
      await memos.store("unrelated note about gardening");
      const { target, alternatives } = await memos.resolveRevertTarget(
        "revert what I said about the dentist",
      );
      // Ambiguous: most recent wins, the other is reported, not guessed over.
      expect(target.id).toBe(newer.node.id);
      expect(alternatives.map((a) => a.node.id)).toContain(older.node.id);
    });
  });

  it("resolves { kind: 'entity' } directly", async () => {
    await withMemos(async (memos) => {
      const node = await memos.store("the gym opens at six");
      const { target } = await memos.resolveRevertTarget({
        kind: "entity",
        entity: "gym",
      });
      expect(target.id).toBe(node.node.id);
    });
  });

  it("resolves { kind: 'id' } directly", async () => {
    await withMemos(async (memos) => {
      const node = await memos.store("a specific memory");
      const { target } = await memos.resolveRevertTarget({
        kind: "id",
        id: node.node.id,
      });
      expect(target.id).toBe(node.node.id);
    });
  });

  it("throws for unknown id, unmatched entity, and non-intent text", async () => {
    await withMemos(async (memos) => {
      await expect(
        memos.resolveRevertTarget({ kind: "id", id: "nope" }),
      ).rejects.toThrow(/not found/);
      await expect(
        memos.resolveRevertTarget({ kind: "entity", entity: "zzz-no-match" }),
      ).rejects.toThrow(/No memory matches/);
      await expect(memos.resolveRevertTarget("hello there")).rejects.toThrow(
        /No revert intent detected/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Revert execution
// ---------------------------------------------------------------------------

describe("revert", () => {
  it("closes the target interval, reactivates the predecessor, keeps history", async () => {
    await withMemos(async (memos) => {
      const v1 = await memos.store("dentist appointment on tuesday");
      const v2 = await memos.store("dentist appointment on wednesday");
      await memos.supersede(v1.node.id, v2.node.id);

      // Sanity: v1 is historical, v2 is believed.
      expect((await memos.retrieve(v1.node.id))!.validTo).not.toBeNull();

      const events: unknown[] = [];
      memos.on("memory:reverted", (data) => events.push(data));

      const result = await memos.revert(
        { kind: "id", id: v2.node.id },
        { reason: "actually it is tuesday", actor: "user" },
      );

      // Validity ledger: target closed NOW, predecessor reopened.
      expect(result.target.id).toBe(v2.node.id);
      expect(result.target.validTo).not.toBeNull();
      expect(result.predecessor.id).toBe(v1.node.id);
      expect(result.predecessor.validTo).toBeNull();
      expect(result.dryRun).toBe(false);
      expect(result.auditId).not.toBeNull();

      // Recall returns the pre-correction belief again.
      const hits = await memos.search("dentist appointment");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.node.id).toBe(v1.node.id);
      expect(hits[0]!.node.content).toContain("tuesday");

      // History intact: the reverted-away version is still retrievable.
      const v2Historical = await memos.retrieve(v2.node.id);
      expect(v2Historical).not.toBeNull();
      expect(v2Historical!.content).toContain("wednesday");
      expect(v2Historical!.validTo).not.toBeNull();

      // Audit event recorded: who/when/why.
      const audit = await memos.retrieve(result.auditId!);
      expect(audit).not.toBeNull();
      expect(audit!.tags).toContain("revert");
      const meta = audit!.metadata.revert as Record<string, unknown>;
      expect(meta.targetId).toBe(v2.node.id);
      expect(meta.predecessorId).toBe(v1.node.id);
      expect(meta.actor).toBe("user");
      expect(meta.reason).toBe("actually it is tuesday");
      expect(typeof meta.at).toBe("number");

      // Event emitted.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        targetId: v2.node.id,
        predecessorId: v1.node.id,
        auditId: result.auditId,
      });
    });
  });

  it("dry-run resolves without writing anything", async () => {
    await withMemos(async (memos) => {
      const v1 = await memos.store("dentist appointment on tuesday");
      const v2 = await memos.store("dentist appointment on wednesday");
      await memos.supersede(v1.node.id, v2.node.id);

      const result = await memos.revert({ kind: "last" }, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.auditId).toBeNull();
      expect(result.target.id).toBe(v2.node.id);
      expect(result.predecessor.id).toBe(v1.node.id);

      // Nothing changed: v2 still valid, v1 still historical, no audit node.
      expect((await memos.retrieve(v2.node.id))!.validTo).toBeNull();
      expect((await memos.retrieve(v1.node.id))!.validTo).not.toBeNull();
      const all = await memos.search("dentist");
      expect(all.some((h) => h.node.tags.includes("revert"))).toBe(false);
    });
  });

  it("reverts via natural-language text end to end", async () => {
    await withMemos(async (memos) => {
      const v1 = await memos.store("dentist appointment on tuesday");
      const v2 = await memos.store("dentist appointment on wednesday");
      await memos.supersede(v1.node.id, v2.node.id);
      const result = await memos.revert("undo what I just told you", {
        reason: "misspoke",
      });
      expect(result.predecessor.id).toBe(v1.node.id);
      expect(result.target.validTo).not.toBeNull();
    });
  });

  it("discovers the predecessor through a resolved contradiction pair", async () => {
    await withMemos(async (memos, storage) => {
      const old = await memos.store("i love coffee");
      const cur = await memos.store("i no longer drink coffee");
      // Simulate the evidence state machine's contradict path: the old
      // version is marked historical and a resolved pair is recorded
      // (pair ids are canonical-sorted, so direction comes from validity).
      await memos.setValidity(old.node.id, old.node.validFrom, Date.now());
      await storage.addContradiction(old.node.id, cur.node.id, "resolved");

      const predecessor = await memos.findRevertPredecessor(cur.node.id);
      expect(predecessor).not.toBeNull();
      expect(predecessor!.id).toBe(old.node.id);

      const result = await memos.revert({ kind: "id", id: cur.node.id });
      expect(result.predecessor.id).toBe(old.node.id);
      expect((await memos.retrieve(old.node.id))!.validTo).toBeNull();
    });
  });

  it("throws when the target is already historical or has no history", async () => {
    await withMemos(async (memos) => {
      const solo = await memos.store("a lonely fact");
      await expect(
        memos.revert({ kind: "id", id: solo.node.id }),
      ).rejects.toThrow(/no supersession history/i);
      const v1 = await memos.store("version one");
      const v2 = await memos.store("version two");
      await memos.supersede(v1.node.id, v2.node.id);
      // v1 is already historical — nothing to revert.
      await expect(
        memos.revert({ kind: "id", id: v1.node.id }),
      ).rejects.toThrow(/already historical/);
    });
  });

  it("excludes its own audit events from 'last'-scope resolution", async () => {
    await withMemos(async (memos) => {
      const v1 = await memos.store("dentist appointment on tuesday");
      const v2 = await memos.store("dentist appointment on wednesday");
      await memos.supersede(v1.node.id, v2.node.id);
      await memos.revert({ kind: "id", id: v2.node.id });
      // The newest row is now the audit event; "last" must skip it and
      // land on the restored belief (v1), not its own record.
      const { target } = await memos.resolveRevertTarget({ kind: "last" });
      expect(target.id).toBe(v1.node.id);
    });
  });
});

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

describe("memos_revert MCP tool", () => {
  it("is registered in the tool metadata", () => {
    const tools = getMcpTools();
    const revert = tools.find((t) => t.name === "memos_revert");
    expect(revert).toBeDefined();
    expect(revert!.description).toMatch(/dryRun/i);
    expect(tools).toHaveLength(18);
  });
});
