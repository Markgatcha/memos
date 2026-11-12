/**
 * Query planner tests:
 * - Intent classification for the five LongMemEval-style abilities
 * - Strategy switches (multi-hop, wider candidates, recency, abstention)
 * - Integration with `searchWithReceipt` (intent recorded, planner can be off)
 */

import { MemOS } from "../src/memory.js";
import { formatQueryPlan, planQuery } from "../src/query-planner.js";

describe("planQuery", () => {
  test("general queries use the default strategy", () => {
    const plan = planQuery("deployment runbook");
    expect(plan.intent).toBe("general");
    expect(plan.confidence).toBe(0);
    expect(plan.multiHop).toBe(false);
    expect(plan.widenCandidates).toBe(false);
  });

  test("temporal questions are routed to temporal", () => {
    const plan = planQuery("When did we last deploy the billing service?");
    expect(plan.intent).toBe("temporal");
    expect(plan.signals).toEqual(expect.arrayContaining(["when", "last"]));
  });

  test("aggregation widens candidates", () => {
    const plan = planQuery("How many deployments happened across sessions?");
    expect(plan.intent).toBe("aggregation");
    expect(plan.widenCandidates).toBe(true);
    expect(plan.multiHop).toBe(true);
  });

  test("knowledge-update prefers recent memories", () => {
    const plan = planQuery("What is the current deploy policy?");
    expect(plan.intent).toBe("knowledge-update");
    expect(plan.recencyBias).toBe(true);
  });

  test("multi-session questions enable multi-hop", () => {
    const plan = planQuery(
      "Compare the two deployment approaches we discussed previously",
    );
    expect(plan.intent).toBe("multi-session");
    expect(plan.multiHop).toBe(true);
  });

  test("abstention-shaped questions set the hint", () => {
    const plan = planQuery("Do you know my favorite editor?");
    expect(plan.intent).toBe("abstention");
    expect(plan.abstentionHint).toBe(true);
  });

  test("formatQueryPlan renders intent and strategy", () => {
    const text = formatQueryPlan(planQuery("How many deploys in total?"));
    expect(text).toContain("Intent: aggregation");
    expect(text).toContain("wider candidates");
  });
});

describe("planner integration", () => {
  test("searchWithReceipt records the intent", async () => {
    const memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    await memos.store("Production deployments require two approvals");

    const { receipt } = await memos.searchWithReceipt({
      query: "When did we deploy?",
      budget: {},
    });
    expect(receipt.intent).toBe("temporal");

    await memos.close();
  });

  test("planner:false leaves the intent unset", async () => {
    const memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    await memos.store("Production deployments require two approvals");

    const { receipt } = await memos.searchWithReceipt({
      query: "When did we deploy?",
      budget: {},
      planner: false,
    });
    expect(receipt.intent).toBeUndefined();

    await memos.close();
  });

  test("instance helper exposes the same plan", async () => {
    const memos = new MemOS({ dbPath: ":memory:" });
    await memos.init();
    expect(memos.planQuery("How many deploys?").intent).toBe("aggregation");
    await memos.close();
  });
});
