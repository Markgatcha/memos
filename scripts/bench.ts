/**
 * Performance benchmark for MemOS.
 *
 * Tests: insert 1K / 10K / 100K nodes with random content generated inline.
 * Measures p50/p95/p99 latency in ms for: store, retrieveById, FTS5 search,
 * getNeighbours (graph traversal).
 *
 * Run via: tsx scripts/bench.ts
 *
 * @module scripts/bench
 */

import { MemOS } from "../src/memory";
import { generateId } from "../src/graph";
import { performance } from "perf_hooks";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Inline lorem-ipsum-style content generator
// ---------------------------------------------------------------------------

const WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "ex",
  "ea",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "in",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "non",
  "proident",
  "sunt",
  "culpa",
  "qui",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "id",
  "est",
  "laborum",
  "user",
  "prefers",
  "dark",
  "mode",
  "settings",
  "application",
  "theme",
  "configuration",
  "project",
  "uses",
  "typescript",
  "language",
  "programming",
  "database",
  "sqlite",
  "storage",
  "persistent",
  "memory",
  "agent",
  "context",
  "conversation",
  "important",
  "preference",
  "system",
  "api",
  "endpoint",
  "service",
  "deploy",
  "cloud",
  "server",
];

function generateContent(wordCount: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
  }
  // Capitalise first letter, add period
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
}

// ---------------------------------------------------------------------------
// Percentile computation
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function measure(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchResult {
  nodeCount: number;
  operation: string;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  samples: number;
}

async function runBenchmark(nodeCount: number): Promise<BenchResult[]> {
  const dbPath = join(__dirname, `.bench-${nodeCount}.db`);
  const results: BenchResult[] = [];

  // Clean up
  const fs = await import("fs");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const memos = new MemOS({ dbPath, wal: true, autoLinkThreshold: 0 });
  await memos.init();

  // Pre-generate content
  const contents: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    contents.push(generateContent(8 + Math.floor(Math.random() * 15)));
  }

  // --- Store benchmark ---
  const storeTimes: number[] = [];
  const storedIds: string[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const t = measure(() => {
      const { node } = memos["_storage"] ? { node: null } : { node: null };
    });
    // We need to call memos.store which is async, so we do it properly
  }

  // Actually store nodes and measure time
  console.log(`  Storing ${nodeCount} nodes...`);
  for (let i = 0; i < nodeCount; i++) {
    const start = performance.now();
    const { node } = await memos.store(contents[i]);
    storeTimes.push(performance.now() - start);
    storedIds.push(node.id);
  }

  const storeSorted = [...storeTimes].sort((a, b) => a - b);
  results.push({
    nodeCount,
    operation: "store",
    p50: +percentile(storeSorted, 50).toFixed(3),
    p95: +percentile(storeSorted, 95).toFixed(3),
    p99: +percentile(storeSorted, 99).toFixed(3),
    mean: +(storeTimes.reduce((a, b) => a + b, 0) / storeTimes.length).toFixed(
      3,
    ),
    samples: storeTimes.length,
  });

  // --- RetrieveById benchmark (sample 1000 random IDs) ---
  console.log(`  Retrieving ${Math.min(1000, nodeCount)} nodes by ID...`);
  const retrieveTimes: number[] = [];
  const sampleCount = Math.min(1000, nodeCount);
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.floor(Math.random() * storedIds.length);
    const id = storedIds[idx];
    const start = performance.now();
    await memos.retrieve(id);
    retrieveTimes.push(performance.now() - start);
  }

  const retrieveSorted = [...retrieveTimes].sort((a, b) => a - b);
  results.push({
    nodeCount,
    operation: "retrieveById",
    p50: +percentile(retrieveSorted, 50).toFixed(3),
    p95: +percentile(retrieveSorted, 95).toFixed(3),
    p99: +percentile(retrieveSorted, 99).toFixed(3),
    mean: +(
      retrieveTimes.reduce((a, b) => a + b, 0) / retrieveTimes.length
    ).toFixed(3),
    samples: retrieveTimes.length,
  });

  // --- FTS5 search benchmark (sample 100 queries) ---
  console.log(`  Running 100 FTS5 searches...`);
  const searchTerms = [
    "dark mode",
    "typescript",
    "database",
    "memory",
    "agent",
    "configuration",
    "project",
    "api",
  ];
  const searchTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const term = searchTerms[i % searchTerms.length];
    const start = performance.now();
    await memos.search({ query: term, limit: 10 });
    searchTimes.push(performance.now() - start);
  }

  const searchSorted = [...searchTimes].sort((a, b) => a - b);
  results.push({
    nodeCount,
    operation: "search",
    p50: +percentile(searchSorted, 50).toFixed(3),
    p95: +percentile(searchSorted, 95).toFixed(3),
    p99: +percentile(searchSorted, 99).toFixed(3),
    mean: +(
      searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length
    ).toFixed(3),
    samples: searchTimes.length,
  });

  // --- getNeighbours benchmark (sample 100 random IDs) ---
  // First create some edges
  console.log(`  Creating edges for neighbour benchmark...`);
  const edgeCount = Math.min(nodeCount - 1, 500);
  for (let i = 0; i < edgeCount; i++) {
    const src = storedIds[i % storedIds.length];
    const dst = storedIds[(i + 1) % storedIds.length];
    if (src !== dst) {
      await memos.link(src, dst, "relates_to", 0.5);
    }
  }

  console.log(`  Running 100 getNeighbours...`);
  const neighbourTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const idx = Math.floor(Math.random() * Math.min(nodeCount, 500));
    const id = storedIds[idx];
    const start = performance.now();
    await memos.getNeighbours(id);
    neighbourTimes.push(performance.now() - start);
  }

  const neighbourSorted = [...neighbourTimes].sort((a, b) => a - b);
  results.push({
    nodeCount,
    operation: "getNeighbours",
    p50: +percentile(neighbourSorted, 50).toFixed(3),
    p95: +percentile(neighbourSorted, 95).toFixed(3),
    p99: +percentile(neighbourSorted, 99).toFixed(3),
    mean: +(
      neighbourTimes.reduce((a, b) => a + b, 0) / neighbourTimes.length
    ).toFixed(3),
    samples: neighbourTimes.length,
  });

  await memos.close();

  // Cleanup
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("MemOS Performance Benchmark\n");

  const allResults: BenchResult[] = [];
  const nodeCounts = [1000, 10000, 100000];

  for (const count of nodeCounts) {
    console.log(`\n--- ${count} nodes ---`);
    const results = await runBenchmark(count);
    allResults.push(...results);
  }

  // Print table
  console.log("\n\n=== Benchmark Results ===\n");
  console.log(
    "Nodes".padEnd(10) +
      "Operation".padEnd(20) +
      "p50 (ms)".padEnd(12) +
      "p95 (ms)".padEnd(12) +
      "p99 (ms)".padEnd(12) +
      "Mean (ms)".padEnd(12) +
      "Samples",
  );
  console.log("-".repeat(80));

  for (const r of allResults) {
    console.log(
      String(r.nodeCount).padEnd(10) +
        r.operation.padEnd(20) +
        String(r.p50).padEnd(12) +
        String(r.p95).padEnd(12) +
        String(r.p99).padEnd(12) +
        String(r.mean).padEnd(12) +
        String(r.samples),
    );
  }

  // Write JSON
  const outPath = join(__dirname, "bench-results.json");
  writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults written to ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
