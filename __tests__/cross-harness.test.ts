/**
 * Tests for cross-harness memory sync ("one memory, every harness").
 *
 * Covered:
 *   - `detectHarness()`: MEMOS_HARNESS override, known env markers,
 *     priority order, "unknown" fallback (pure — no process.env
 *     mutation in the unit tests);
 *   - write attribution: every store() stamps the detected harness,
 *     explicit `opts.harness` wins, storage boundary defaults to
 *     "unknown" for legacy literals;
 *   - scoped recall: `search({ harness })` / `recall(q, { harness })`
 *     filter on the keyword, structured, and fidelity legs; "all" is
 *     the behavior-preserving default;
 *   - `memos harness list` counts via `getHarnessCounts()`;
 *   - `mergeHarnessDb`: dry-run plans without writing, id remap on
 *     collision, bitemporal intervals + provenance tiers + harness tags
 *     preserved, edges follow the remap, citations keep working;
 *   - cross-harness contradiction flow: a merged contradicting memory
 *     is picked up by the EXISTING write-time contradiction scan (no
 *     second resolution system);
 *   - cross-harness update: harness A writes, a fresh instance as
 *     harness B supersedes on the same DB — bitemporal supersession +
 *     the contradiction read-time machinery resolve it exactly like a
 *     same-harness update.
 *
 * Hermetic: no embeddings except the scripted 2-D provider in the
 * contradiction-flow test, no LLM anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  detectHarness,
  normalizeHarness,
  UNKNOWN_HARNESS,
  MEMOS_HARNESS_ENV,
  HARNESS_MARKERS,
} from "../src/harness";
import {
  CONTRADICTION_DEMOTION_FACTOR,
  resolveContradictionsAtRead,
} from "../src/contradictions";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  MemoryNode,
} from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDb(prefix = "memos-xharness-"): {
  dir: string;
  dbPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, "memos.db") };
}

function newMemos(dbPath: string): MemOS {
  return new MemOS({ dbPath, embeddings: { enabled: false } });
}

/** Full MemoryNode literal (for raw storage writes). */
function makeNode(overrides: Partial<MemoryNode> & { id: string }): MemoryNode {
  const now = Date.now();
  return {
    content: `content of ${overrides.id}`,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessed: now,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    provenance: "user",
    quarantined: false,
    quarantinedAt: null,
    quarantineReason: null,
    trustScore: 1,
    ...overrides,
  };
}

// --- harness env manipulation (save/restore around each mutation) ---

function snapshotHarnessEnv(): Record<string, string | undefined> {
  const prev: Record<string, string | undefined> = {};
  const names = new Set<string>([MEMOS_HARNESS_ENV, "CLAUDECODE"]);
  for (const m of HARNESS_MARKERS) {
    if (m.match.endsWith("_")) {
      for (const k of Object.keys(process.env)) {
        if (k.startsWith(m.match)) names.add(k);
      }
    } else {
      names.add(m.match);
    }
  }
  for (const n of names) {
    prev[n] = process.env[n];
    delete process.env[n];
  }
  return prev;
}

function restoreHarnessEnv(prev: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Drop any harness vars the test introduced that were absent before.
  const known = new Set<string>([MEMOS_HARNESS_ENV, "CLAUDECODE"]);
  for (const m of HARNESS_MARKERS) {
    if (m.match.endsWith("_")) {
      for (const k of Object.keys(process.env)) {
        if (k.startsWith(m.match)) known.add(k);
      }
    } else {
      known.add(m.match);
    }
  }
  for (const k of known) {
    if (!(k in prev)) delete process.env[k];
  }
}

/** Scripted 2-D provider: pins vectors so the contradiction band is hit
 *  deterministically (same recipe as contradictions.test.ts). */
class ScriptedProvider implements EmbeddingProvider {
  public readonly id = "scripted";
  public readonly model = "scripted-v1";
  public readonly dimensions = 2;

  async embed(text: string): Promise<EmbeddingVector> {
    if (text.includes("no longer lives in Berlin")) return [0.7, 0.714];
    if (text.includes("moved to Berlin")) return [1, 0];
    return [0, 1];
  }
}

function newMemosScripted(dbPath: string): MemOS {
  return new MemOS({
    dbPath,
    embeddings: { enabled: true, provider: new ScriptedProvider() },
    embeddingQueue: { synchronous: true },
  });
}

// ---------------------------------------------------------------------------
// detectHarness()
// ---------------------------------------------------------------------------

describe("detectHarness", () => {
  test("MEMOS_HARNESS override wins over every marker", () => {
    expect(
      detectHarness({ [MEMOS_HARNESS_ENV]: "my-harness", CLAUDECODE: "1" }),
    ).toBe("my-harness");
  });

  test("known env markers map to harness slugs", () => {
    expect(detectHarness({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectHarness({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(
      "claude-code",
    );
    expect(detectHarness({ CLINE_ACTIVE: "x" })).toBe("cline");
    expect(detectHarness({ CODEX_HOME: "/tmp/x" })).toBe("codex");
    expect(detectHarness({ GEMINI_API_KEY: "x" })).toBe("gemini-cli");
    expect(detectHarness({ OPENCLAW_STATE_DIR: "/tmp/y" })).toBe("openclaw");
  });

  test("markers apply in priority order", () => {
    expect(detectHarness({ CLINE_X: "1", CODEX_Y: "1" })).toBe("cline");
    expect(detectHarness({ CODEX_A: "1", GEMINI_B: "1" })).toBe("codex");
    expect(detectHarness({ GEMINI_C: "1", OPENCLAW_D: "1" })).toBe(
      "gemini-cli",
    );
  });

  test("empty values do not match; unknown fallback", () => {
    expect(detectHarness({ CLAUDECODE: "" })).toBe(UNKNOWN_HARNESS);
    expect(detectHarness({})).toBe(UNKNOWN_HARNESS);
    expect(detectHarness({ SOME_OTHER_VAR: "1" })).toBe(UNKNOWN_HARNESS);
  });

  test("normalizeHarness", () => {
    expect(normalizeHarness("Claude Code")).toBe("claude-code");
    expect(normalizeHarness("  CODEX ")).toBe("codex");
    expect(normalizeHarness("")).toBe(UNKNOWN_HARNESS);
    expect(normalizeHarness("   ")).toBe(UNKNOWN_HARNESS);
  });
});

// ---------------------------------------------------------------------------
// Write attribution
// ---------------------------------------------------------------------------

describe("harness attribution on write", () => {
  test("store() stamps MEMOS_HARNESS and it survives a re-read", async () => {
    const prev = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memos = newMemos(dbPath);
      await memos.init();
      const stored = await memos.store("the sky is blue");
      expect(stored.node.harness).toBe("claude-code");
      const reread = await memos.retrieve(stored.node.id);
      expect(reread!.harness).toBe("claude-code");
      await memos.close();
    } finally {
      restoreHarnessEnv(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no env markers → unknown", async () => {
    const prev = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      const stored = await memos.store("plain unattributed memory");
      expect(stored.node.harness).toBe("unknown");
      await memos.close();
    } finally {
      restoreHarnessEnv(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit opts.harness wins over the environment", async () => {
    const prev = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memos = newMemos(dbPath);
      await memos.init();
      const stored = await memos.store("explicit harness tag", {
        harness: "codex",
      });
      expect(stored.node.harness).toBe("codex");
      await memos.close();
    } finally {
      restoreHarnessEnv(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("storage boundary: node literals without a tag read back as unknown", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const storage = new SQLiteStorage(dbPath);
      await storage.init();
      const { harness: _dropped, ...literal } = makeNode({ id: randomUUID() });
      void _dropped;
      await storage.saveNode(literal as MemoryNode);
      const reread = await storage.getNode(literal.id);
      expect(reread!.harness).toBe("unknown");
      await storage.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scoped recall
// ---------------------------------------------------------------------------

describe("scoped recall", () => {
  test("search({ harness }) filters; default is cross-harness", async () => {
    const prev = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memos = newMemos(dbPath);
      await memos.init();
      await memos.store("nebula drive calibration complete");
      await memos.store("nebula coolant levels nominal");

      process.env[MEMOS_HARNESS_ENV] = "cline";
      await memos.store("quasar array alignment complete");
      await memos.store("quasar shielding at full power");

      const onlyA = await memos.search({
        query: "nebula",
        harness: "claude-code",
      });
      expect(onlyA).toHaveLength(2);
      expect(onlyA.every((r) => r.node.harness === "claude-code")).toBe(true);

      const onlyB = await memos.search({ query: "quasar", harness: "cline" });
      expect(onlyB).toHaveLength(2);
      expect(onlyB.every((r) => r.node.harness === "cline")).toBe(true);

      // Cross-harness leakage check: no B rows under the A scope.
      const noneB = await memos.search({
        query: "nebula",
        harness: "cline",
      });
      expect(noneB).toHaveLength(0);

      // "all" (and the default) span every harness.
      expect(
        (await memos.search({ query: "quasar", harness: "all" })).length,
      ).toBe(2);
      expect((await memos.search({ query: "quasar" })).length).toBe(2);
      // "unknown" matches unattributed rows only.
      expect(
        (await memos.search({ query: "quasar", harness: "unknown" })).length,
      ).toBe(0);

      await memos.close();
    } finally {
      restoreHarnessEnv(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("recall(q, { harness }) scopes the fidelity candidate set", async () => {
    const prev = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memos = newMemos(dbPath);
      await memos.init();
      await memos.store("nebula drive calibration complete");

      process.env[MEMOS_HARNESS_ENV] = "cline";
      await memos.store("quasar array alignment complete");

      const scoped = await memos.recall("quasar array", { harness: "cline" });
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.every((r) => r.node.harness === "cline")).toBe(true);

      const excluded = await memos.recall("quasar array", {
        harness: "claude-code",
      });
      expect(excluded).toHaveLength(0);

      // filter.harness is honored too; top-level harness wins.
      const viaFilter = await memos.recall("quasar array", {
        filter: { harness: "cline" },
      });
      expect(viaFilter.every((r) => r.node.harness === "cline")).toBe(true);
      const conflict = await memos.recall("quasar array", {
        harness: "claude-code",
        filter: { harness: "cline" },
      });
      expect(conflict).toHaveLength(0);

      await memos.close();
    } finally {
      restoreHarnessEnv(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// harness list
// ---------------------------------------------------------------------------

describe("getHarnessCounts", () => {
  test("per-harness counts, legacy rows under unknown", async () => {
    const prev = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memos = newMemos(dbPath);
      await memos.init();
      await memos.store("first claude memory");
      await memos.store("second claude memory");
      process.env[MEMOS_HARNESS_ENV] = "codex";
      await memos.store("a codex memory");

      const counts = await memos.getHarnessCounts();
      const byHarness = new Map(counts.map((c) => [c.harness, c.count]));
      expect(byHarness.get("claude-code")).toBe(2);
      expect(byHarness.get("codex")).toBe(1);
      expect(counts[0]!.count).toBeGreaterThanOrEqual(counts[1]!.count);
      await memos.close();
    } finally {
      restoreHarnessEnv(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mergeHarnessDb
// ---------------------------------------------------------------------------

describe("mergeHarnessDb", () => {
  /** Target DB with one claude-code node; source DB with two codex
   *  nodes (one colliding id, one historical) plus an edge. */
  async function setupMerge(): Promise<{
    dir: string;
    targetPath: string;
    sourcePath: string;
    targetNodeId: string;
    sourceFreshId: string;
    memos: MemOS;
    prevEnv: Record<string, string | undefined>;
  }> {
    const prevEnv = snapshotHarnessEnv();
    const dir = mkdtempSync(join(tmpdir(), "memos-xharness-merge-"));
    const targetPath = join(dir, "target.db");
    const sourcePath = join(dir, "source.db");

    process.env[MEMOS_HARNESS_ENV] = "claude-code";
    const memos = newMemos(targetPath);
    await memos.init();
    const targetStored = await memos.store("the launch checklist is finalized");
    const targetNodeId = targetStored.node.id;

    const sourceFreshId = randomUUID();
    const t0 = Date.now() - 100_000;
    const source = new SQLiteStorage(sourcePath);
    await source.init();
    // Colliding id: the source DB independently created a node with the
    // same UUID (near-impossible in practice; the remap path must work).
    await source.saveNode(
      makeNode({
        id: targetNodeId,
        content: "codex rewrote the launch checklist",
        harness: "codex",
        provenance: "user-verified",
        source: "user_input",
        createdAt: t0,
        updatedAt: t0,
      }),
    );
    // Historical node: bitemporal interval must survive the merge.
    await source.saveNode(
      makeNode({
        id: sourceFreshId,
        content: "codex staging notes",
        harness: "codex",
        provenance: "chat",
        source: "agent_inferred",
        createdAt: t0,
        updatedAt: t0,
        validFrom: t0,
        validTo: t0 + 1000,
      }),
    );
    await source.saveEdge({
      id: randomUUID(),
      sourceId: sourceFreshId,
      targetId: targetNodeId,
      relation: "relates_to",
      weight: 0.9,
      metadata: {},
      createdAt: t0,
      validFrom: null,
      validTo: null,
    });
    await source.close();
    return {
      dir,
      targetPath,
      sourcePath,
      targetNodeId,
      sourceFreshId,
      memos,
      prevEnv,
    };
  }

  test("dry-run plans without writing", async () => {
    const s = await setupMerge();
    try {
      const plan = await s.memos.mergeHarnessDb(s.sourcePath, {
        dryRun: true,
      });
      expect(plan.dryRun).toBe(true);
      expect(plan.sourceNodes).toBe(2);
      expect(plan.sourceEdges).toBe(1);
      expect(plan.nodesImported).toBe(2); // would-import
      expect(plan.edgesImported).toBe(1); // would-import
      expect(plan.nodesRemapped).toBe(1);
      const collided = plan.nodes.find((n) => n.sourceId === s.targetNodeId)!;
      expect(collided.remapped).toBe(true);
      expect(collided.targetId).not.toBe(s.targetNodeId);
      expect(collided.harness).toBe("codex");
      // Nothing was written: the target still holds only its own node.
      const counts = await s.memos.getHarnessCounts();
      expect(counts.reduce((n, c) => n + c.count, 0)).toBe(1);
      await s.memos.close();
    } finally {
      restoreHarnessEnv(s.prevEnv);
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("merge remaps collisions, preserves bitemporal intervals, provenance, harness, edges, citations", async () => {
    const s = await setupMerge();
    try {
      const result = await s.memos.mergeHarnessDb(s.sourcePath);
      expect(result.dryRun).toBe(false);
      expect(result.nodesImported).toBe(2);
      expect(result.nodesRemapped).toBe(1);
      expect(result.edgesImported).toBe(1);
      expect(result.edgesSkipped).toBe(0);

      // The colliding node kept its content under a fresh id.
      const remapped = result.nodes.find((n) => n.remapped)!;
      const importedCollision = await s.memos.retrieve(remapped.targetId);
      expect(importedCollision!.content).toBe(
        "codex rewrote the launch checklist",
      );
      expect(importedCollision!.harness).toBe("codex");
      expect(importedCollision!.provenance).toBe("user-verified");

      // The original target node is untouched.
      const original = await s.memos.retrieve(s.targetNodeId);
      expect(original!.content).toBe("the launch checklist is finalized");
      expect(original!.harness).toBe("claude-code");

      // Historical node: bitemporal interval + provenance preserved.
      const historical = await s.memos.retrieve(s.sourceFreshId);
      expect(historical!.harness).toBe("codex");
      expect(historical!.provenance).toBe("chat");
      expect(historical!.source).toBe("agent_inferred");
      expect(historical!.validTo).not.toBeNull();
      // …and it stays out of default recall (still historical).
      const live = await s.memos.search({
        query: "staging notes",
        harness: "all",
      });
      expect(live.some((r) => r.node.id === s.sourceFreshId)).toBe(false);
      const withHistory = await s.memos.search({
        query: "staging notes",
        harness: "all",
        includeHistorical: true,
      });
      expect(withHistory.some((r) => r.node.id === s.sourceFreshId)).toBe(true);

      // Edge followed the id remap.
      const edges = await s.memos.getEdges(s.sourceFreshId);
      expect(edges).toHaveLength(1);
      expect(edges[0]!.targetId).toBe(remapped.targetId);
      expect(edges[0]!.relation).toBe("relates_to");

      // Citations still resolve; the citation output names the harness.
      const resolution = await s.memos.resolveCitation(
        `[mem:${s.sourceFreshId.replace(/-/g, "").slice(0, 8)}]`,
      );
      expect(resolution.status).toBe("resolved");
      if (resolution.status === "resolved") {
        expect(resolution.memory.harness).toBe("codex");
        expect(s.memos.formatCitation(resolution)).toContain("Harness: codex");
      }

      // Per-harness counts reflect the merge.
      const counts = new Map(
        (await s.memos.getHarnessCounts()).map((c) => [c.harness, c.count]),
      );
      expect(counts.get("claude-code")).toBe(1);
      expect(counts.get("codex")).toBe(2);

      await s.memos.close();
    } finally {
      restoreHarnessEnv(s.prevEnv);
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("merge of a missing file throws", async () => {
    const prevEnv = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      await expect(memos.mergeHarnessDb(join(dir, "nope.db"))).rejects.toThrow(
        /not found/,
      );
      await memos.close();
    } finally {
      restoreHarnessEnv(prevEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cross-harness contradiction flows through the EXISTING write-time scan", async () => {
    const prevEnv = snapshotHarnessEnv();
    const dir = mkdtempSync(join(tmpdir(), "memos-xharness-contra-"));
    const targetPath = join(dir, "target.db");
    const sourcePath = join(dir, "source.db");
    try {
      // Target (this harness): the original belief, embedded.
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memos = newMemosScripted(targetPath);
      await memos.init();
      const old = await memos.store("Alice moved to Berlin last year");

      // The synchronous queue persists embeddings fire-and-forget, so
      // wait until the original's vector has landed before merging —
      // otherwise the imported node's neighbor scan may run first.
      const storage = (memos as unknown as { storage: SQLiteStorage }).storage;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const info = await storage.getEmbeddingInfo?.(old.node.id);
        if (info) break;
        if (Date.now() > deadline) {
          throw new Error("timed out waiting for the original embedding");
        }
        await new Promise((r) => setTimeout(r, 25));
      }

      // Source DB (another harness): the contradicting belief.
      const source = new SQLiteStorage(sourcePath);
      await source.init();
      await source.saveNode(
        makeNode({
          id: randomUUID(),
          content: "Alice no longer lives in Berlin",
          harness: "codex",
          // Write-time entity capture runs in store(), not in raw
          // saveNode — mirror what a real write would have stored.
          metadata: { entities: ["berlin"] },
        }),
      );
      await source.close();

      // Merge: the imported node goes through the same post-write path
      // as store() — embedding + contradictionScanPending — so the
      // EXISTING detector (not a merge-specific one) flags the pair.
      const detected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("contradiction:detected never fired")),
          10_000,
        );
        memos.on("contradiction:detected", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const result = await memos.mergeHarnessDb(sourcePath);
      expect(result.nodesImported).toBe(1);
      await detected;

      const importedId = result.nodes[0]!.targetId;
      const pairs = await storage.getContradictionPairsFor([
        old.node.id,
        importedId,
      ]);
      expect(pairs).toHaveLength(1);
      // Heuristic write-time candidate: persisted for adjudication,
      // exactly like a same-harness write would record it.
      expect(pairs[0]!.status).toBe("unresolved");
      const [a, b] = [old.node.id, importedId].sort();
      expect(pairs[0]!.nodeA).toBe(a);
      expect(pairs[0]!.nodeB).toBe(b);

      await memos.close();
    } finally {
      restoreHarnessEnv(prevEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-harness update: A writes, fresh instance as B supersedes
// ---------------------------------------------------------------------------

describe("cross-harness update", () => {
  test("harness B superseding harness A's memory resolves identically", async () => {
    const prevEnv = snapshotHarnessEnv();
    const { dir, dbPath } = tempDb();
    try {
      // Harness A writes the original belief.
      process.env[MEMOS_HARNESS_ENV] = "claude-code";
      const memosA = newMemos(dbPath);
      await memosA.init();
      const old = await memosA.store("the deploy is scheduled for Friday");
      expect(old.node.harness).toBe("claude-code");
      await memosA.close();

      // A FRESH instance as harness B on the same DB file: the
      // replacement belief. No shared process state — only the same
      // deterministic rules, mirroring the temporal-event scenario.
      process.env[MEMOS_HARNESS_ENV] = "cline";
      const memosB = newMemos(dbPath);
      await memosB.init();
      const fresh = await memosB.store("the deploy is scheduled for Saturday");
      expect(fresh.node.harness).toBe("cline");
      await memosB.supersede(old.node.id, fresh.node.id);

      // The evidence-machine supersession provenance: record the pair
      // resolved, the same way store({ evidenceLearning: true }) does.
      const storage = (memosB as unknown as { storage: SQLiteStorage }).storage;
      await storage.addContradiction(old.node.id, fresh.node.id, "resolved");

      // Bitemporal supersession: old version closed, tags preserved per
      // version (A on the old, B on the replacement).
      const oldReread = await memosB.retrieve(old.node.id);
      expect(oldReread!.validTo).not.toBeNull();
      expect(oldReread!.harness).toBe("claude-code");
      const freshReread = await memosB.retrieve(fresh.node.id);
      expect(freshReread!.validTo).toBeNull();
      expect(freshReread!.harness).toBe("cline");

      // Default recall resolves identically to a same-harness update:
      // only the new version is live.
      const live = await memosB.search({ query: "deploy scheduled" });
      expect(live.map((r) => r.node.id)).toEqual([fresh.node.id]);

      // History still shows both versions with their harness tags.
      const history = await memosB.search({
        query: "deploy scheduled",
        includeHistorical: true,
      });
      expect(history).toHaveLength(2);
      const byId = new Map(history.map((r) => [r.node.id, r]));
      expect(byId.get(old.node.id)!.node.harness).toBe("claude-code");
      expect(byId.get(fresh.node.id)!.node.harness).toBe("cline");

      // Read-time contradiction machinery: with BOTH members present,
      // the older (superseded) member is demoted, never removed.
      const pairs = await storage.getContradictionPairsFor([
        old.node.id,
        fresh.node.id,
      ]);
      const confirmed = pairs.filter((p) => p.status === "resolved");
      expect(confirmed).toHaveLength(1);
      const resolved = resolveContradictionsAtRead(history, confirmed);
      expect(resolved[0]!.node.id).toBe(fresh.node.id);
      expect(resolved[1]!.node.id).toBe(old.node.id);
      expect(resolved[1]!.scores?.contradiction_demoted).toBe(
        CONTRADICTION_DEMOTION_FACTOR,
      );
      // Sign-aware demotion: the keyword leg yields negative bm25 ranks,
      // so the older member's score must move away from zero (rank
      // worse), never toward it.
      const oldScore = byId.get(old.node.id)!.score;
      const expectedDemoted =
        oldScore >= 0
          ? oldScore * CONTRADICTION_DEMOTION_FACTOR
          : oldScore / CONTRADICTION_DEMOTION_FACTOR;
      expect(resolved[1]!.score).toBeCloseTo(expectedDemoted, 10);
      expect(resolved[1]!.score).toBeLessThan(oldScore);

      await memosB.close();
    } finally {
      restoreHarnessEnv(prevEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
