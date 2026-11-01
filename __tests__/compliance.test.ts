import { MemOS } from "../src/memory";
import { renderAuditMarkdown } from "../src/compliance";

describe("audit report", () => {
  let memos: MemOS;

  beforeEach(async () => {
    memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: false },
    });
    await memos.init();
  });

  afterEach(async () => {
    await memos.close();
  });

  test("verifies the chain and includes deletion certificates", async () => {
    const kept = await memos.store("The deploy window is Friday.");
    const deleted = await memos.store("A temporary fact that will be deleted.");
    await memos.forget(deleted.node.id);

    const report = await memos.auditReport();
    expect(report.schema).toBe("memos.audit.v1");
    expect(report.ok).toBe(true);
    expect(report.tamper.entriesChecked).toBeGreaterThan(0);
    expect(report.tamper.externallyAnchored).toBe(false);
    expect(report.counts.totalNodes).toBe(1);
    expect(report.deletions).toHaveLength(1);
    expect(report.deletions[0]?.nodeId).toBe(deleted.node.id);
    expect(report.counts.byProvenance.user).toBe(1);
    expect(kept.node.id).toBeTruthy();
    expect(report.recommendations.join(" ")).toContain("tip hash");
  });

  test("an externally recorded tip makes truncation detectable", async () => {
    await memos.store("A durable fact.");
    const first = await memos.auditReport();
    const tip = first.tamper.tipHash!;
    const anchored = await memos.auditReport({ expectTip: tip });
    expect(anchored.tamper.externallyAnchored).toBe(true);

    const wrong = await memos.auditReport({ expectTip: "deadbeef" });
    expect(wrong.tamper.externallyAnchored).toBe(false);
    expect(wrong.recommendations.join(" ")).toContain("does not match");
  });

  test("renders a readable markdown artifact", async () => {
    await memos.store("A durable fact.");
    const report = await memos.auditReport();
    const markdown = renderAuditMarkdown(report);
    expect(markdown).toContain("# MemOS audit — OK");
    expect(markdown).toContain("## Store");
    expect(markdown).toContain("provenance:");
    expect(markdown).toContain("## Recommendations");
  });
});
