/**
 * Answer audit tests:
 * - Claim splitting (bullets, sentences, question/fragment filtering)
 * - Lexical support scoring
 * - Supported / partial / unsupported / contradicted verdicts
 * - `[mem:...]` citation resolution
 * - End-to-end `memos.auditAnswer()` with query-selected candidates
 */

import { MemOS } from "../src/memory.js";
import {
  auditAnswerText,
  claimSupportScore,
  formatAnswerAudit,
  hasNegation,
  splitAnswerClaims,
} from "../src/answer-audit.js";
import type { AuditMemory } from "../src/answer-audit.js";

const MEMORIES: AuditMemory[] = [
  {
    id: "abcd1234-0000-0000-0000-000000000001",
    content: "Production deployments require two SRE approvals.",
  },
  {
    id: "ef567890-0000-0000-0000-000000000002",
    content: "Rollback restores the previous release artifact.",
  },
];

describe("splitAnswerClaims", () => {
  test("splits sentences and bullets, drops questions and fragments", () => {
    const claims = splitAnswerClaims(
      "Deployments require two approvals. Why does that matter?\n- Rollback restores the previous release.\n- Too short\n\nDone.",
    );
    expect(claims).toContain("Deployments require two approvals");
    expect(claims).toContain("Rollback restores the previous release");
    expect(claims).not.toContain("Why does that matter?");
    expect(claims).not.toContain("Too short");
    expect(claims).not.toContain("Done");
  });

  test("deduplicates repeated claims", () => {
    const claims = splitAnswerClaims(
      "Deploys need approval. Deploys need approval.",
    );
    expect(claims).toHaveLength(1);
  });
});

describe("claimSupportScore", () => {
  test("scores overlapping claims high and unrelated claims low", () => {
    expect(
      claimSupportScore(
        "Deployments require two SRE approvals",
        "Production deployments require two SRE approvals.",
      ),
    ).toBeGreaterThan(0.9);
    expect(
      claimSupportScore(
        "The office is in Lisbon",
        "Deployments require approvals.",
      ),
    ).toBeLessThan(0.2);
  });

  test("exact phrase containment scores 1", () => {
    expect(
      claimSupportScore(
        "two SRE approvals",
        "Deployments require two SRE approvals.",
      ),
    ).toBe(1);
  });
});

describe("auditAnswerText", () => {
  test("separates supported and unsupported claims", () => {
    const report = auditAnswerText(
      "Deployments require two SRE approvals.\nRollback restores the previous release artifact.\nIt also deploys on Fridays.",
      MEMORIES,
    );
    expect(report.counts.supported).toBe(2);
    expect(report.counts.unsupported).toBe(1);
    expect(report.coverage).toBeCloseTo(2 / 3, 3);
  });

  test("flags opposite negation as contradicted", () => {
    const report = auditAnswerText(
      "Deployments do not require two SRE approvals.",
      MEMORIES,
    );
    expect(report.claims[0]?.status).toBe("contradicted");
    expect(report.counts.contradicted).toBe(1);
  });

  test("resolves [mem:...] citations", () => {
    const report = auditAnswerText(
      "Deployments require two approvals [mem:abcd].",
      MEMORIES,
    );
    expect(report.citationsResolved).toBe(1);
    expect(report.citationsUnresolved).toBe(0);
    expect(report.claims[0]?.citations).toEqual([MEMORIES[0]!.id]);
    expect(report.claims[0]?.status).toBe("supported");
  });

  test("counts unresolved citations", () => {
    const report = auditAnswerText(
      "Deployments require two approvals [mem:ffff].",
      MEMORIES,
    );
    expect(report.citationsUnresolved).toBe(1);
  });

  test("hasNegation recognises common forms", () => {
    expect(hasNegation("Deploys do not need approval")).toBe(true);
    expect(hasNegation("Deploys never need approval")).toBe(true);
    expect(hasNegation("Deploys need approval")).toBe(false);
  });

  test("formats a report", () => {
    const text = formatAnswerAudit(
      auditAnswerText("Deployments require two SRE approvals.", MEMORIES),
    );
    expect(text).toContain("Answer audit: 1 claim(s)");
    expect(text).toContain("Coverage:");
  });
});

describe("MemOS.auditAnswer", () => {
  test("audits against query-selected candidates", async () => {
    const memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    await memos.store("Production deployments require two SRE approvals");
    await memos.store("Rollback restores the previous release artifact");
    await memos.store("The office coffee machine is on the third floor");

    const report = await memos.auditAnswer(
      "Deployments require two SRE approvals.\nRollback restores the previous release artifact.",
      { query: "deployment approvals rollback" },
    );

    expect(report.claims.length).toBe(2);
    expect(report.counts.supported).toBe(2);
    expect(report.coverage).toBe(1);

    await memos.close();
  });
});
