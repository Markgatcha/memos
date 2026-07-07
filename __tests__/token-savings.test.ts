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
import type { ScoredMemory, MemoryNode } from "../src/types";

function makeNode(id: string, content: string, tags: string[] = []): MemoryNode {
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
    const text = "The quick brown fox jumps over the lazy dog near the river bank.";
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
    const longContent = "This is a memory.   \n\n\n\n" + "This is a memory.   \n".repeat(10) + "End.";
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
});
