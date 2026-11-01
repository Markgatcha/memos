import { MemOS } from "../src/memory";
import { normalizeQuery } from "../src/procedure-promotion";

describe("procedure promotion", () => {
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

  test("requires repeated successes before a candidate appears", async () => {
    const first = await memos.store("Deploy uses the blue/green procedure.", {
      type: "fact",
      tags: ["deploy"],
    });
    await memos.recordRecallFeedback({
      query: "how do we deploy?",
      used: [first.node.id],
      outcome: "success",
    });

    const dryRun = await memos.promoteProcedures();
    expect(dryRun.candidates).toHaveLength(0);
  });

  test("promotes a repeated successful pattern, then skips the duplicate", async () => {
    const first = await memos.store("Deploy uses the blue/green procedure.", {
      type: "fact",
      tags: ["deploy"],
    });
    for (let i = 0; i < 2; i += 1) {
      await memos.recordRecallFeedback({
        query: "how do we deploy?",
        used: [first.node.id],
        outcome: "success",
      });
    }

    const dryRun = await memos.promoteProcedures();
    expect(dryRun.candidates).toHaveLength(1);
    expect(dryRun.created).toHaveLength(0);
    expect(dryRun.candidates[0]?.evidence[0]).toContain("blue/green");
    expect(dryRun.candidates[0]?.lesson).toContain("how do we deploy?");

    const applied = await memos.promoteProcedures({ apply: true });
    expect(applied.created).toHaveLength(1);

    const again = await memos.promoteProcedures({ apply: true });
    expect(again.skipped).toBe(1);
    expect(again.created).toHaveLength(0);

    const lessons = await memos.listProceduralLessons();
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.tags).toContain("auto-promoted");
  });

  test("excludes patterns with too many failures", async () => {
    const first = await memos.store("Deploy uses the blue/green procedure.");
    await memos.recordRecallFeedback({
      query: "how do we deploy?",
      used: [first.node.id],
      outcome: "success",
    });
    await memos.recordRecallFeedback({
      query: "how do we deploy?",
      used: [first.node.id],
      outcome: "failure",
    });
    await memos.recordRecallFeedback({
      query: "how do we deploy?",
      used: [first.node.id],
      outcome: "success",
    });
    const result = await memos.promoteProcedures();
    expect(result.candidates).toHaveLength(0);
  });

  test("normalizes punctuation and filler for grouping", () => {
    expect(normalizeQuery("How do we DEPLOY?!")).toBe("how deploy");
  });
});
