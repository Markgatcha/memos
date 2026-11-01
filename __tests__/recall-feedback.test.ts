/**
 * Outcome-conditioned recall: feedback math, ranking integration,
 * persistence across reopen, explain(), and health().
 *
 * The point of these tests is that feedback is not a cosmetic counter:
 * it must survive a process restart, change the ranking multiplier, and
 * show up in both the inspector and the health report.
 */

import { describe, test, expect, afterEach } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  addOutcomeToStat,
  buildMemoryUtility,
  emptyRecallStat,
  outcomeMultiplier,
  utilityFromStat,
} from "../src/feedback";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  RecallBatchOutcome,
} from "../src/types";

class FixedProvider implements EmbeddingProvider {
  public readonly id = "fixed";
  public readonly model = "fixed-v1";
  public readonly dimensions = 64;

  async embed(text: string): Promise<EmbeddingVector> {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h = Math.imul(h ^ tok.charCodeAt(i), 16777619) >>> 0;
      }
      const idx = h % this.dimensions;
      const idx2 = (h >>> 8) % this.dimensions;
      v[idx] += 1;
      v[idx2] += h & 1 ? 0.5 : -0.5;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function makeMemos(dbPath = ":memory:"): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(dbPath, true),
    embeddings: { enabled: true, provider: new FixedProvider() },
    embeddingQueue: { synchronous: true },
  });
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "memos-feedback-"));
  dirs.push(dir);
  return join(dir, "memos.db");
}

describe("feedback math", () => {
  test("partial outcomes pull utility toward neutral", () => {
    const partial = addOutcomeToStat(emptyRecallStat("m1"), "partial", 1, 100);
    expect(partial.observations).toBe(1);
    expect(utilityFromStat(partial)).toBeCloseTo(0.5, 6);
    expect(utilityFromStat(undefined)).toBe(0.5);
  });

  test("weighted successes and failures move utility in the right direction", () => {
    let stat = emptyRecallStat("m1");
    stat = addOutcomeToStat(stat, "success", 2, 100);
    expect(utilityFromStat(stat)).toBeGreaterThan(0.5);
    stat = addOutcomeToStat(stat, "failure", 1, 200);
    expect(utilityFromStat(stat)).toBeLessThan(1);
    expect(stat.lastAt).toBe(200);
  });

  test("multiplier is bounded by the configured weight and neutral at 0.5", () => {
    expect(outcomeMultiplier(0.5, 0.2)).toBeCloseTo(1, 6);
    expect(outcomeMultiplier(1, 0.2)).toBeCloseTo(1.2, 6);
    expect(outcomeMultiplier(0, 0.2)).toBeCloseTo(0.8, 6);
    expect(outcomeMultiplier(1, 0)).toBe(1);
    expect(outcomeMultiplier(1, 10)).toBeCloseTo(2, 6);
  });

  test("uplift compares used and unused batches observationally", () => {
    const batches: RecallBatchOutcome[] = [
      {
        id: "b1",
        ts: 1,
        query: "deploy",
        outcome: "success",
        weight: 1,
        memoryIds: ["m1"],
      },
      {
        id: "b2",
        ts: 2,
        query: "deploy",
        outcome: "failure",
        weight: 1,
        memoryIds: ["m2"],
      },
    ];
    const a = buildMemoryUtility(
      "m1",
      addOutcomeToStat(emptyRecallStat("m1"), "success", 1, 1),
      batches,
    );
    expect(a.usedBatches).toBe(1);
    expect(a.unusedBatches).toBe(1);
    expect(a.uplift).toBeCloseTo(1, 6);

    const b = buildMemoryUtility(
      "m2",
      addOutcomeToStat(emptyRecallStat("m2"), "failure", 1, 2),
      batches,
    );
    expect(b.uplift).toBeCloseTo(-1, 6);
  });
});

describe("recordRecallFeedback", () => {
  test("records known ids, reports unknown ids, and updates utility", async () => {
    const memos = makeMemos();
    await memos.init();
    const a = await memos.store("Deploy with pnpm build then docker push", {
      namespace: "default",
    });
    const b = await memos.store("The staging cluster rotates keys weekly", {
      namespace: "default",
    });

    const result = await memos.recordRecallFeedback({
      query: "how do I deploy?",
      used: [a.node.id, b.node.id, "missing-id"],
      outcome: "success",
    });
    expect(result.recorded).toBe(2);
    expect(result.unknown).toEqual(["missing-id"]);
    expect(memos.recallUtility(a.node.id).observations).toBe(1);
    expect(memos.recallUtility(a.node.id).utility).toBeGreaterThan(0.5);
    expect(memos.recallUtility(a.node.id).lastAt).not.toBeNull();
    await memos.close();
  });

  test("a failed task demotes utility below neutral", async () => {
    const memos = makeMemos();
    await memos.init();
    const { node } = await memos.store("Use the legacy staging credentials");
    await memos.recordRecallFeedback({
      query: "how do I deploy?",
      used: [node.id],
      outcome: "failure",
    });
    expect(memos.recallUtility(node.id).utility).toBeLessThan(0.5);
    await memos.close();
  });

  test("outcome-conditioned ranking stamps a multiplier and can be ablated", async () => {
    const memos = makeMemos();
    await memos.init();
    const good = await memos.store("release checklist alpha beta", {
      importance: 0.5,
    });
    const bad = await memos.store("release checklist alpha beta", {
      importance: 0.5,
    });
    await memos.recordRecallFeedback({
      query: "release checklist",
      used: [good.node.id],
      outcome: "success",
    });
    await memos.recordRecallFeedback({
      query: "release checklist",
      used: [bad.node.id],
      outcome: "failure",
    });

    const ranked = await memos.search("release checklist");
    const goodHit = ranked.find((r) => r.node.id === good.node.id)!;
    const badHit = ranked.find((r) => r.node.id === bad.node.id)!;
    expect(goodHit.scores?.outcomeUtility).toBeGreaterThan(1);
    expect(badHit.scores?.outcomeUtility).toBeLessThan(1);

    const ablated = await memos.search({
      query: "release checklist",
      outcomeFeedback: false,
    });
    for (const hit of ablated) {
      expect(hit.scores?.outcomeUtility).toBeUndefined();
    }
    await memos.close();
  });

  test("feedback survives a close/reopen cycle", async () => {
    const dbPath = tempDbPath();
    const first = makeMemos(dbPath);
    await first.init();
    const { node } = await first.store("The production deploy uses blue/green");
    await first.recordRecallFeedback({
      query: "production deploy",
      used: [node.id],
      outcome: "success",
    });
    await first.close();

    const second = makeMemos(dbPath);
    await second.init();
    const utility = second.recallUtility(node.id);
    expect(utility.observations).toBe(1);
    expect(utility.utility).toBeGreaterThan(0.5);
    const ranked = await second.search("production deploy");
    const hit = ranked.find((r) => r.node.id === node.id)!;
    expect(hit.scores?.outcomeUtility).toBeGreaterThan(1);
    await second.close();
  });

  test("clearRecallFeedback resets ranking evidence", async () => {
    const memos = makeMemos();
    await memos.init();
    const { node } = await memos.store("Reset the recall evidence");
    await memos.recordRecallFeedback({
      query: "reset",
      used: [node.id],
      outcome: "success",
    });
    expect(memos.recallUtility(node.id).observations).toBe(1);
    await memos.clearRecallFeedback();
    expect(memos.recallUtility(node.id).observations).toBe(0);
    const ranked = await memos.search("reset");
    expect(
      ranked.find((r) => r.node.id === node.id)?.scores?.outcomeUtility,
    ).toBeUndefined();
    await memos.close();
  });
});

describe("explain", () => {
  test("returns score evidence and utility for ranked candidates", async () => {
    const memos = makeMemos();
    await memos.init();
    const { node } = await memos.store(
      "Deploy the service with pnpm build then docker push",
    );
    await memos.recordRecallFeedback({
      query: "deploy",
      used: [node.id],
      outcome: "success",
    });

    const explanation = await memos.explain("deploy");
    expect(explanation.query).toBe("deploy");
    expect(explanation.candidates.length).toBeGreaterThan(0);
    const top = explanation.candidates[0]!;
    expect(top.id).toBe(node.id);
    expect(top.reasons.length).toBeGreaterThan(0);
    expect(top.utility.observations).toBe(1);
    expect(top.components.outcomeUtility).toBeGreaterThan(1);
    expect(explanation.notes.length).toBeGreaterThan(0);
    await memos.close();
  });

  test("focus explains a namespace exclusion instead of silently omitting it", async () => {
    const memos = makeMemos();
    await memos.init();
    const { node } = await memos.store("Alpha deployment runbook", {
      namespace: "project:alpha",
    });

    const explanation = await memos.explain({
      query: "deployment runbook",
      memoryId: node.id,
      namespace: "project:beta",
    });
    expect(explanation.focus).toBeDefined();
    expect(explanation.focus!.found).toBe(true);
    expect(explanation.focus!.retrieved).toBe(false);
    const namespaceCheck = explanation.focus!.checks.find(
      (check) => check.name === "namespace",
    )!;
    expect(namespaceCheck.pass).toBe(false);
    expect(explanation.focus!.reasons.join(" ")).toContain("namespace");
    await memos.close();
  });

  test("focus reports historical memories as ineligible for default search", async () => {
    const memos = makeMemos();
    await memos.init();
    const { node } = await memos.store("Old office address is Berlin");
    await memos.supersede(node.id);

    const explanation = await memos.explain({
      query: "office address",
      memoryId: node.id,
    });
    expect(explanation.focus!.retrieved).toBe(false);
    const lifecycle = explanation.focus!.checks.find(
      (check) => check.name === "lifecycle",
    )!;
    expect(lifecycle.pass).toBe(false);
    await memos.close();
  });

  test("focus reports a missing id without throwing", async () => {
    const memos = makeMemos();
    await memos.init();
    const explanation = await memos.explain({
      query: "anything",
      memoryId: "does-not-exist",
    });
    expect(explanation.focus!.found).toBe(false);
    expect(explanation.focus!.checks[0]!.pass).toBe(false);
    await memos.close();
  });
});

describe("health", () => {
  test("reports contradictions, history, and negative recall outcomes", async () => {
    const memos = makeMemos();
    await memos.init();
    const old = await memos.store("The office is in Berlin");
    const newer = await memos.store("The office is in Lisbon");
    await memos.setValidity(newer.node.id, null, Date.now() - 1_000);

    const storage = (memos as unknown as { storage: SQLiteStorage }).storage;
    await storage.addContradiction(old.node.id, newer.node.id, "unresolved");
    await memos.recordRecallFeedback({
      query: "office",
      used: [old.node.id],
      outcome: "failure",
    });

    const report = await memos.health();
    expect(report.metrics.historicalNodes).toBeGreaterThanOrEqual(1);
    expect(report.metrics.unresolvedContradictions).toBe(1);
    expect(report.metrics.feedbackBatches).toBe(1);
    expect(report.metrics.usefulRecallRate).toBe(0);
    expect(
      report.findings.some((f) => f.id === "contradictions-unresolved"),
    ).toBe(true);
    expect(report.score).toBeLessThan(100);
    await memos.close();
  });

  test("grades an empty store A and suggests recording outcomes", async () => {
    const memos = makeMemos();
    await memos.init();
    const report = await memos.health();
    expect(report.grade).toBe("A");
    expect(report.metrics.totalNodes).toBe(0);
    expect(report.findings.some((f) => f.id === "healthy")).toBe(true);
    await memos.close();
  });
});
