/**
 * Before benchmark: measure prepare() overhead with varied (non-cached) queries.
 */

import { MemOS } from "../src/memory";

async function bench() {
  const memos = new MemOS({ dbPath: ".bench-prepare-cache2.db", wal: false });
  await memos.init();

  // Store 50 items
  for (let i = 0; i < 50; i++) {
    await memos.store(`Memory number ${i} with searchable content about topic ${i % 10}.`);
  }

  // Measure 100 search calls with VARIED queries (hits the prepare cache differently)
  const queries = Array.from({ length: 100 }, (_, i) => `topic ${i % 10}`);
  const start = performance.now();
  for (let i = 0; i < 100; i++) {
    await memos.search({ query: queries[i], limit: 10 });
  }
  const elapsed = performance.now() - start;

  console.log("=== Prepare Cache BEFORE Benchmark (varied queries) ===\n");
  console.log(`100 search calls: ${elapsed.toFixed(2)}ms`);
  console.log(`Average per call: ${(elapsed / 100).toFixed(2)}ms`);

  await memos.close();
  await import("node:fs").then((fs) => fs.rmSync(".bench-prepare-cache2.db", { force: true }));
}

bench();
