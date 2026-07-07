/**
 * Before benchmark: measure SQLite prepare() overhead.
 *
 * Run with: npx tsx scripts/bench-prepare-cache-before.ts
 */

import { MemOS } from "../src/memory";

async function bench() {
  const memos = new MemOS({ dbPath: ".bench-prepare-cache.db", wal: false });
  await memos.init();

  // Store some data first
  for (let i = 0; i < 50; i++) {
    await memos.store(`Memory number ${i} with some content for search testing.`);
  }

  // Measure 100 search calls
  const queries = ["memory", "content", "search", "number", "testing"];
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    const q = queries[i % queries.length]!;
    await memos.search({ query: q, limit: 10 });
  }
  const elapsed = performance.now() - start;

  console.log("=== SQLite Prepare Cache BEFORE Benchmark ===\n");
  console.log(`100 search calls: ${elapsed.toFixed(2)}ms`);
  console.log(`Average per call: ${(elapsed / 100).toFixed(2)}ms`);
  console.log(`Calls/sec: ${(100 / (elapsed / 1000)).toFixed(0)}`);

  await memos.close();
  await import("node:fs").then((fs) => fs.rmSync(".bench-prepare-cache.db", { force: true }));
}

bench();
