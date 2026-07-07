/**
 * Tests for the TOON format for search results.
 */

import { describe, test, expect } from "@jest/globals";
import { searchResultsToToon, CONTEXT_PACK_SCHEMA } from "../src/context-pack";
import type { ScoredMemory } from "../src/types";

function makeScored(id: string, content: string, score: number, tags: string[] = []): ScoredMemory {
  return {
    node: {
      id,
      content,
      summary: content.slice(0, 50),
      type: "fact",
      metadata: {},
      importance: 0.5,
      createdAt: 1000,
      updatedAt: 2000,
      accessCount: 5,
      lastAccessed: 1500,
      tags,
      expiresAt: null,
      namespace: "default",
      validFrom: null,
      validTo: null,
      source: "user_input",
      trustScore: 1.0,
    },
    score,
    scores: {},
  };
}

describe("searchResultsToToon", () => {
  test("produces TOON format with header", () => {
    const results = [makeScored("mem_1", "User likes dark mode", 0.95, ["preference"])];
    const toon = searchResultsToToon(results);
    expect(toon).toContain("# memos.search.v1");
    expect(toon).toContain("# toon:pipe-delimited");
    expect(toon).toContain("mem_1|0.950|user_input");
    expect(toon).toContain("preference");
  });

  test("escapes pipe characters in content", () => {
    const results = [makeScored("mem_1", "a | b | c", 0.9)];
    const toon = searchResultsToToon(results);
    expect(toon).toContain("a ¦ b ¦ c");
    expect(toon).not.toContain("a | b | c");
  });

  test("TOON is significantly smaller than JSON", () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      makeScored(`mem_${i}`, `Content for memory ${i} with some detail about topic number ${i}.`, 1 - i * 0.04),
    );
    const json = JSON.stringify(results);
    const toon = searchResultsToToon(results);
    // TOON should be at least 30% smaller than JSON
    expect(toon.length).toBeLessThan(json.length * 0.7);
  });
});
