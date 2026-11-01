import { MemOS } from "../src/memory";
import { buildSelfEvalCases, runRetrievalEval } from "../src/eval";

describe("in-product retrieval eval", () => {
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

  test("self mode retrieves recent memories from their own fragments", async () => {
    await memos.store("The deploy window is Friday at 14:00 UTC.");
    await memos.store("The user prefers dark mode in editors.");
    await memos.store("The project uses TypeScript and SQLite.");

    const cases = await buildSelfEvalCases(memos, { limit: 3 });
    expect(cases).toHaveLength(3);

    const report = await runRetrievalEval(memos, cases, {
      k: 3,
      mode: "self",
    });
    expect(report.cases).toBe(3);
    expect(report.hitAtK).toBeGreaterThan(0);
    expect(report.mrr).toBeGreaterThan(0);
    expect(report.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("corpus mode scores labelled queries and reports token cost", async () => {
    const deploy = await memos.store(
      "The deploy window is Friday at 14:00 UTC.",
    );
    const report = await runRetrievalEval(
      memos,
      [
        {
          query: "when is the deploy window?",
          relevantIds: [deploy.node.id],
        },
      ],
      { k: 3, mode: "corpus" },
    );
    expect(report.mode).toBe("corpus");
    expect(report.cases).toBe(1);
    expect(report.hitAtK).toBe(1);
    expect(report.tokensPerHit).not.toBeNull();
    expect(report.tokensPerHit!).toBeGreaterThan(0);
  });

  test("fromSessions only samples memories with session metadata", async () => {
    await memos.store("A session fact about the deploy window.", {
      metadata: { sessionId: "session_1" },
    });
    await memos.store("A plain fact without a session.");
    const cases = await buildSelfEvalCases(memos, {
      limit: 10,
      fromSessions: true,
    });
    expect(cases).toHaveLength(1);
  });
});
