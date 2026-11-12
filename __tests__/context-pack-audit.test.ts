/**
 * Context-pack audit wiring:
 * - `audit: "off"` stays byte-identical (no id, no extra tokens)
 * - `audit: "metadata"` attaches a deterministic packId
 * - `audit: "line"` appends one short comment line to TOON
 * - `auditPackAnswer()` reuses pack evidence (no search) and stays compact
 * - unknown/expired pack ids fail clearly
 */

import { MemOS } from "../src/memory.js";
import { estimateTokens } from "../src/context-pack.js";
import type { ContextPack } from "../src/context-pack.js";

async function seeded(): Promise<MemOS> {
  const memos = new MemOS({ dbPath: ":memory:" });
  await memos.init();
  await memos.store("Production deployments require two SRE approvals");
  await memos.store("Rollback restores the previous release artifact");
  await memos.store("The office coffee machine is on the third floor");
  return memos;
}

describe("context pack audit wiring", () => {
  test("off keeps the pack unchanged", async () => {
    const memos = await seeded();
    const pack = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
    })) as ContextPack;

    expect(pack.packId).toBeUndefined();

    const text = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
      format: "toon",
    })) as string;
    expect(text).not.toContain("audit-pack");

    await memos.close();
  });

  test("metadata attaches a deterministic id without touching text", async () => {
    const memos = await seeded();
    const first = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
      audit: "metadata",
    })) as ContextPack;
    const second = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
      audit: "metadata",
    })) as ContextPack;

    expect(first.packId).toBeTruthy();
    expect(first.packId).toBe(second.packId);

    const offText = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
      format: "toon",
    })) as string;
    const metadataText = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
      format: "toon",
      audit: "metadata",
    })) as string;
    expect(metadataText).toBe(offText);

    await memos.close();
  });

  test("line adds one short footer to serialized output", async () => {
    const memos = await seeded();
    const text = (await memos.contextPack({
      query: "deployment approvals",
      tokenBudget: 400,
      format: "toon",
      audit: "line",
    })) as string;

    const match = text.match(/# audit-pack: ([0-9a-f]{12})$/);
    expect(match).not.toBeNull();

    const footer = match?.[0] ?? "";
    expect(estimateTokens(footer)).toBeLessThan(15);

    await memos.close();
  });

  test("auditPackAnswer reuses pack evidence and stays compact", async () => {
    const memos = await seeded();
    const pack = (await memos.contextPack({
      query: "deployment approvals rollback",
      tokenBudget: 400,
      audit: "metadata",
    })) as ContextPack;
    expect(pack.packId).toBeTruthy();

    const summary = await memos.auditPackAnswer(
      pack.packId!,
      "Deployments require two SRE approvals. It also deploys on Fridays.",
    );

    expect(summary.packId).toBe(pack.packId);
    expect(summary.coverage).toBeGreaterThan(0);
    expect(summary.coverage).toBeLessThan(1);
    expect(summary.summary).toContain("Audit");
    expect(summary.summary).toContain("unsupported");
    // Compact: one line plus at most a few flagged claims, not a full report.
    expect(estimateTokens(summary.summary)).toBeLessThan(80);

    await memos.close();
  });

  test("unknown pack ids fail clearly", async () => {
    const memos = await seeded();
    await expect(
      memos.auditPackAnswer("deadbeef1234", "Anything."),
    ).rejects.toThrow(/Unknown or expired pack id/);
    await memos.close();
  });
});
