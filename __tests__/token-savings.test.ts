/**
 * Tests for token-saving features in context packs:
 * debloating, dedup, token estimation, and tokensSaved reporting.
 */

import {
  buildContextPack,
  estimateTokens,
  debloatContent,
  CONTEXT_PACK_SCHEMA,
} from "../src/context-pack";
import type { EmbeddingVector, ScoredMemory, MemoryNode } from "../src/types";

function makeNode(
  id: string,
  content: string,
  tags: string[] = [],
): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags,
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

function scored(node: MemoryNode, score: number): ScoredMemory {
  return { node, score };
}

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("approximates GPT token counts within 20%", () => {
    const text =
      "The quick brown fox jumps over the lazy dog near the river bank.";
    const estimate = estimateTokens(text);
    // Real tiktoken count is ~14-15 tokens. Our estimate should be close.
    expect(estimate).toBeGreaterThan(10);
    expect(estimate).toBeLessThan(20);
  });

  test("counts punctuation as separate tokens", () => {
    const noPunct = estimateTokens("hello world");
    const withPunct = estimateTokens("hello, world!");
    expect(withPunct).toBeGreaterThan(noPunct);
  });
});

describe("debloatContent", () => {
  test("collapses excessive newlines", () => {
    const input = "line1\n\n\n\n\nline2";
    const result = debloatContent(input);
    expect(result).toBe("line1\n\nline2");
  });

  test("strips trailing whitespace per line", () => {
    const input = "line1   \nline2   ";
    const result = debloatContent(input);
    expect(result).toBe("line1\nline2");
  });

  test("removes duplicate consecutive lines", () => {
    const input = "alpha\nalpha\nalpha\nbeta";
    const result = debloatContent(input);
    expect(result).toBe("alpha\nbeta");
  });

  test("leaves short text unchanged", () => {
    const short = "short text";
    expect(debloatContent(short)).toBe("short text");
  });
});

describe("buildContextPack token savings", () => {
  test("reports tokensSaved > 0 when debloating removes content", () => {
    const longContent =
      "This is a memory.   \n\n\n\n" +
      "This is a memory.   \n".repeat(10) +
      "End.";
    const items = [scored(makeNode("n1", longContent), 0.9)];
    const pack = buildContextPack({
      query: "test",
      namespace: "default",
      tokenBudget: 500,
      items,
      debloat: true,
    });
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  test("dedup drops near-identical items and counts their tokens as saved", () => {
    const items = [
      scored(makeNode("n1", "User prefers dark mode in editors"), 0.9),
      scored(makeNode("n2", "User prefers dark mode in editors"), 0.8),
      scored(makeNode("n3", "Completely unrelated fact about cooking"), 0.7),
    ];
    const pack = buildContextPack({
      query: "dark mode",
      namespace: "default",
      tokenBudget: 500,
      items,
      dedup: true,
    });
    // n2 should be deduped against n1.
    const ids = pack.items.map((i) => i.id);
    expect(ids).toContain("n1");
    expect(ids).not.toContain("n2");
    expect(ids).toContain("n3");
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  test("dedup can be disabled", () => {
    const items = [
      scored(makeNode("n1", "User prefers dark mode in editors"), 0.9),
      scored(makeNode("n2", "User prefers dark mode in editors"), 0.8),
    ];
    const pack = buildContextPack({
      query: "dark mode",
      namespace: "default",
      tokenBudget: 500,
      items,
      dedup: false,
    });
    expect(pack.items).toHaveLength(2);
  });

  test("custom tokenCounter is used for budgeting", () => {
    let callCount = 0;
    const customCounter = (text: string): number => {
      callCount += 1;
      return text.length; // 1 char = 1 token (extreme)
    };
    const items = [
      scored(makeNode("n1", "a".repeat(100)), 0.9),
      scored(makeNode("n2", "b".repeat(100)), 0.8),
    ];
    const pack = buildContextPack({
      query: "test",
      namespace: "default",
      tokenBudget: 150, // room for ~1.5 items at 1 char/token
      items,
      tokenCounter: customCounter,
      debloat: false,
    });
    expect(callCount).toBeGreaterThan(0);
    expect(pack.items.length).toBeLessThanOrEqual(2);
  });

  test("tokensSaved is 0 when debloat and dedup are both disabled", () => {
    const items = [scored(makeNode("n1", "hello world"), 0.9)];
    const pack = buildContextPack({
      query: "test",
      namespace: "default",
      tokenBudget: 500,
      items,
      debloat: false,
      dedup: false,
    });
    expect(pack.tokensSaved).toBe(0);
  });

  test("summary elision drops a restating summary and keeps the content", () => {
    // makeNode sets summary = content, so every item's summary is a
    // verbatim copy — exactly what elision targets.
    const items = [scored(makeNode("n1", "User prefers dark mode"), 0.9)];
    const pack = buildContextPack({
      query: "test",
      namespace: "default",
      tokenBudget: 500,
      items,
    });
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].content).toBe("User prefers dark mode");
    expect(pack.items[0].summary).toBeNull();
  });

  test("a genuinely compact summary survives elision", () => {
    const content =
      "The release is blocked by three items: the flaky auth test in " +
      "CI needs a retry policy, the migration script fails on Postgres " +
      "15 because of the removed function signature, and the docs site " +
      "build still references the deprecated theme package that was " +
      "renamed last sprint.";
    const node = makeNode("n1", content);
    node.summary = "Release blocked by CI, migration, docs";
    const pack = buildContextPack({
      query: "release blockers",
      namespace: "default",
      tokenBudget: 500,
      items: [scored(node, 0.9)],
    });
    // Summary is far shorter than half the content and lexically
    // distinct enough — it stays.
    expect(pack.items[0].summary).toBe(
      "Release blocked by CI, migration, docs",
    );
  });

  test("semantic dedup drops paraphrased duplicates when vectors are supplied", () => {
    const embeddings = new Map<string, EmbeddingVector>([
      ["n1", [1, 0, 0, 0]],
      // Nearly parallel to n1 -> paraphrase.
      ["n2", [0.98, 0.199, 0, 0]],
      // Orthogonal to n1 -> distinct fact.
      ["n3", [0, 0, 1, 0]],
    ]);
    const items = [
      scored(makeNode("n1", "User prefers dark theme"), 0.9),
      scored(makeNode("n2", "dark mode is their preference"), 0.8),
      scored(makeNode("n3", "Completely unrelated fact"), 0.7),
    ];
    const pack = buildContextPack({
      query: "preferences",
      namespace: "default",
      tokenBudget: 500,
      items,
      embeddings,
      includeSummary: false,
    });
    const ids = pack.items.map((i) => i.id);
    expect(ids).toContain("n1");
    // n2 has near-zero lexical overlap with n1 (lexical Jaccard won't
    // catch it), but its vector is a near-duplicate.
    expect(ids).not.toContain("n2");
    expect(ids).toContain("n3");
    expect(pack.tokensSaved).toBeGreaterThan(0);
  });

  test("semantic dedup keeps items without vectors and respects threshold", () => {
    const embeddings = new Map<string, EmbeddingVector>([
      ["n1", [1, 0, 0, 0]],
      // Only moderately similar — below the 0.90 default.
      ["n2", [0.8, 0.6, 0, 0]],
    ]);
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 500,
      items: [
        scored(makeNode("n1", "alpha"), 0.9),
        scored(makeNode("n2", "beta"), 0.8),
        scored(makeNode("n3", "gamma"), 0.7), // no vector at all
      ],
      embeddings,
      includeSummary: false,
    });
    expect(pack.items.map((i) => i.id)).toEqual(["n1", "n2", "n3"]);
  });
});
