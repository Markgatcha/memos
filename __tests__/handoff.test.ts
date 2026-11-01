import { MemOS } from "../src/memory";

describe("cross-harness handoff", () => {
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

  test("assembles profile, context, lessons, and health into a brief", async () => {
    await memos.store("The user prefers dark mode in editors.", {
      type: "preference",
    });
    await memos.store("The deploy window is Friday at 14:00 UTC.", {
      type: "fact",
      tags: ["deploy"],
    });
    await memos.memorizeProcedural("Run the retrieval eval before shipping.", {
      context: "release",
    });

    const brief = await memos.handoff({
      task: "when is the deploy window?",
      format: "json",
      toHarness: "codex",
      fromHarness: "claude-code",
      tokenBudget: 600,
    });
    expect(typeof brief).not.toBe("string");
    if (typeof brief === "string") throw new Error("expected JSON brief");

    expect(brief.schema).toBe("memos.handoff.v1");
    expect(brief.task).toBe("when is the deploy window?");
    expect(brief.toHarness).toBe("codex");
    expect(brief.fromHarness).toBe("claude-code");
    expect(
      brief.profile.static.some((item) => item.content.includes("dark mode")),
    ).toBe(true);
    expect(brief.context.query).toBe("when is the deploy window?");
    expect(
      brief.lessons.some((lesson) => lesson.lesson.includes("retrieval eval")),
    ).toBe(true);
    expect(brief.markdown).toContain("# Handoff: when is the deploy window?");
    expect(brief.markdown).toContain("[mem:");
    expect(brief.health?.embeddingStatus).toBe("disabled");
  });

  test("markdown is the default format", async () => {
    await memos.store("The deploy window is Friday at 14:00 UTC.", {
      type: "fact",
    });
    const markdown = await memos.handoff({ task: "deploy window" });
    expect(typeof markdown).toBe("string");
    expect(markdown).toContain("## Relevant memories");
    expect(markdown).toContain("Friday");
  });

  test("rejects an empty task", async () => {
    await expect(memos.handoff({ task: "   " })).rejects.toThrow(
      /non-empty task/,
    );
  });
});
