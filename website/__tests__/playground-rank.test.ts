import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankMemories, type RankableMemory } from "../lib/playground/rank";

const demo = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../data/memory-demo.json"),
    "utf8",
  ),
) as { memories: RankableMemory[] };

const memories: RankableMemory[] = [
  ...demo.memories,
  {
    id: "custom-pnpm",
    content: "User prefers pnpm over npm for new projects.",
    type: "preference",
    tags: ["tooling", "pnpm"],
    source: "user_input",
    trustScore: 0.9,
  },
];

describe("rankMemories", () => {
  it("ranks the memory that answers the query first", () => {
    const results = rankMemories(
      memories,
      "Which package manager does the user prefer?",
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].memory.id).toBe("custom-pnpm");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("matches word variants through Porter stemming", () => {
    const results = rankMemories(memories, "What theme does the user prefer?");
    expect(results[0].memory.content).toContain("Solarized Dark");
  });

  it("does not rank unrelated memories on trust score alone", () => {
    expect(rankMemories(memories, "What is the weather in Paris?")).toEqual([]);
    const unrelated = memories.map((memory) => ({
      ...memory,
      trustScore: 1,
    }));
    expect(
      rankMemories(unrelated, "zzqx unrelated gibberish query"),
    ).toEqual([]);
  });

  it("filters stopwords whose stems change form", () => {
    const stopwordHeavy: RankableMemory = {
      id: "stopword-heavy",
      content: "This does not answer anything about the actual question.",
      type: "fact",
      tags: [],
      source: "user_input",
      trustScore: 1,
    };
    const results = rankMemories(
      [...memories, stopwordHeavy],
      "How does this work?",
    );
    expect(results.map((result) => result.memory.id)).not.toContain(
      "stopword-heavy",
    );
  });

  it("returns an empty list for an empty or stopword-only query", () => {
    expect(rankMemories(memories, "")).toEqual([]);
    expect(rankMemories(memories, "the and of")).toEqual([]);
  });

  it("respects the result limit", () => {
    const results = rankMemories(
      memories,
      "What does the user prefer?",
      2,
    );
    expect(results.length).toBeLessThanOrEqual(2);
  });
});
