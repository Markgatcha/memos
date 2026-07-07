/**
 * After benchmark: run real search() calls and measure TOON vs JSON.
 */

import { MemOS } from "../src/memory";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function bench() {
  const memos = new MemOS({ dbPath: ".bench-search-toon.db", wal: false });
  await memos.init();

  // Store 20 memories
  for (let i = 0; i < 20; i++) {
    await memos.store(
      `User preference number ${i}: This is a realistic memory entry with some content about topic number ${i}. It contains a mix of entity references, dates, and contextual details that an agent might need to recall.`,
      { importance: 0.7, tags: ["preference", "ui", "work"] },
    );
  }

  // Before: JSON search results
  const jsonResults = await memos.search("preference");
  const json = JSON.stringify(jsonResults);
  const jsonTokens = estimateTokens(json);

  // After: TOON search results
  const toon = await memos.searchToon("preference");
  const toonTokens = estimateTokens(toon);

  console.log("=== Real Search Benchmark (20 results) ===\n");
  console.log(`JSON  size: ${json.length} chars, ~${jsonTokens} tokens`);
  console.log(`TOON  size: ${toon.length} chars, ~${toonTokens} tokens`);
  console.log(`\nToken reduction: ${((1 - toonTokens / jsonTokens) * 100).toFixed(1)}%`);
  console.log(`Size reduction:  ${((1 - toon.length / json.length) * 100).toFixed(1)}%`);

  await memos.close();
  // Clean up
  await import("node:fs").then((fs) => {
    fs.rmSync(".bench-search-toon.db", { force: true });
  });
}

bench().catch(console.error);
