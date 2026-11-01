/** Preference capture: extraction, intent detection, and storage. */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { extractPreferences, isPreferenceQuestion } from "../src/preferences";

function makeMemos(): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { namespaces: true },
    embeddings: { enabled: false },
    embeddingQueue: { synchronous: true },
  });
}

describe("extractPreferences", () => {
  test("captures likes and dislikes in third person", () => {
    const text =
      "I really love hiking in the rain. I hate loud restaurants. " +
      "We prefer window seats.";
    const prefs = extractPreferences(text);
    const statements = prefs.map((p) => p.statement);
    expect(statements).toContain("User prefers hiking in the rain");
    expect(statements).toContain("User dislikes loud restaurants");
    expect(statements).toContain("User prefers window seats");
  });

  test("captures favorites and interests", () => {
    const text =
      "My favourite color is deep blue. I'm interested in photography.";
    const statements = extractPreferences(text).map((p) => p.statement);
    expect(statements).toContain("User's favorite: color is deep blue");
    expect(statements).toContain("User prefers photography");
  });

  test("deduplicates repeated statements", () => {
    const text = "I love tea. I love tea. I love tea.";
    expect(extractPreferences(text)).toHaveLength(1);
  });

  test("ignores third-person and hypothetical text", () => {
    expect(extractPreferences("She loves hiking.")).toHaveLength(0);
    expect(
      extractPreferences("The manual describes preferences."),
    ).toHaveLength(0);
  });
});

describe("isPreferenceQuestion", () => {
  test("detects recommendation and taste questions", () => {
    expect(isPreferenceQuestion("What would I enjoy doing this weekend?")).toBe(
      true,
    );
    expect(isPreferenceQuestion("Can you recommend a restaurant for me?")).toBe(
      true,
    );
    expect(isPreferenceQuestion("What is my favorite color?")).toBe(true);
    expect(isPreferenceQuestion("What is the factory reset code?")).toBe(false);
  });
});

describe("capturePreferences", () => {
  test("stores preferences separately and finds them without keyword overlap", async () => {
    const memos = makeMemos();
    await memos.init();
    try {
      const nodes = await memos.capturePreferences(
        "I love hiking in the rain and I hate crowded malls.",
        { namespace: "prefs", sourceId: "s1" },
      );
      expect(nodes).toHaveLength(2);
      expect(nodes.every((node) => node.type === "preference")).toBe(true);
      expect(nodes.every((node) => node.tags.includes("preference"))).toBe(
        true,
      );

      // The question shares no content words with the stored statement.
      const hits = await memos.searchPreferences("what would I enjoy?", {
        namespace: "prefs",
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.map((hit) => hit.node.content).join(" ")).toContain("hiking");
    } finally {
      await memos.close();
    }
  });
});
