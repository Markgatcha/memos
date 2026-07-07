/**
 * Benchmark: TOON format for search results.
 *
 * Measures token count and serialization time for the same set of
 * ScoredMemory results in both JSON and TOON formats.
 *
 * Run with: npx tsx scripts/bench-search-toon.ts
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { ScoredMemory } from "../src/types";

// Lightweight token estimator (4 chars per token).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeScored(id: string, content: string, score: number, tags: string[]): ScoredMemory {
  return {
    node: {
      id,
      content,
      summary: content.slice(0, 50),
      type: "fact",
      metadata: { confidence: 0.9, category: "general" },
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
    scores: { keyword: 0.8, semantic: 0.9, hybrid: 0.85 },
  };
}

function toToon(results: ScoredMemory[]): string {
  const lines: string[] = [];
  lines.push("# memos.search.v1");
  lines.push("# toon:pipe-delimited");
  lines.push("# fields: id|score|trust|source|updatedAt|tags|content");
  for (const r of results) {
    const safeContent = r.node.content.replace(/\|/g, "¦").replace(/\n/g, " ");
    const safeTags = r.node.tags.join(";");
    lines.push(
      `${r.node.id}|${r.score.toFixed(3)}|${r.node.source}|${r.node.source}|${new Date(r.node.updatedAt).toISOString()}|${safeTags}|${safeContent}`,
    );
  }
  return lines.join("\n");
}

async function bench() {
  // Generate a realistic set of 20 search results.
  const results: ScoredMemory[] = [];
  for (let i = 0; i < 20; i++) {
    results.push(
      makeScored(
        `mem_${i}`,
        `This is a realistic memory entry with some content about topic number ${i}. It contains a mix of entity references, dates, and contextual details that an agent might need to recall.`.repeat(2),
        1 - i * 0.04,
        ["preference", "ui", "work"],
      ),
    );
  }

  // JSON format (current)
  const json = JSON.stringify(results);
  const jsonTokens = estimateTokens(json);
  const jsonTime = measureTime(() => JSON.stringify(results));

  // TOON format (new)
  const toon = toToon(results);
  const toonTokens = estimateTokens(toon);
  const toonTime = measureTime(() => toToon(results));

  // Results
  console.log("=== Search Result Format Benchmark (20 results) ===\n");
  console.log(`JSON  size: ${json.length} chars, ~${jsonTokens} tokens`);
  console.log(`TOON  size: ${toon.length} chars, ~${toonTokens} tokens`);
  console.log(`\nToken reduction: ${((1 - toonTokens / jsonTokens) * 100).toFixed(1)}%`);
  console.log(`Size reduction:  ${((1 - toon.length / json.length) * 100).toFixed(1)}%`);
  console.log(`\nJSON  serialization: ${jsonTime.toFixed(3)}ms`);
  console.log(`TOON  serialization: ${toonTime.toFixed(3)}ms`);
  console.log(`\nTOON sample (first 3 lines):\n${toon.split("\n").slice(0, 3).join("\n")}`);
}

function measureTime(fn: () => string): number {
  const start = performance.now();
  for (let i = 0; i < 100; i++) fn();
  return (performance.now() - start) / 100;
}

bench().catch(console.error);
