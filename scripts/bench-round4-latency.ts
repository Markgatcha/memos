/**
 * Round 4 latency benchmark: measures search latency (p50/p95) and
 * embedding-call counts to prove the query-embedding LRU cache and
 * embed-once multistream threading.
 *
 * - Repeated identical query: second search should hit the cache (0 new
 *   embedding calls for the query).
 * - Multistream search: one query embedding shared across streams (1 call
 *   total, not 3).
 */
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class CountingProvider implements EmbeddingProvider {
  public readonly id = "count";
  public readonly model = "count-v1";
  public readonly dimensions = 4;
  public calls = 0;

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls++;
    // Deterministic pseudo-embedding from text hash.
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    const v: number[] = [];
    for (let i = 0; i < 4; i++) {
      v.push(((h >> (i * 8)) & 0xff) / 255);
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const provider = new CountingProvider();
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { synchronous: true },
  });
  await memos.init();

  // Seed 50 memories across pools.
  for (let i = 0; i < 50; i++) {
    const pool = i % 3 === 0 ? "event" : i % 3 === 1 ? "note" : "procedure";
    await memos.store(`Memory number ${i} about kubernetes and deployments`, {
      pool: pool as "event" | "note" | "procedure",
    });
  }
  await memos.flushEmbeddings();
  const seedCalls = provider.calls;
  console.log(`Seed embedding calls: ${seedCalls}`);

  // Warm up.
  await memos.search("kubernetes deployments");

  // Benchmark: 20 searches, alternating two queries (cache hits on repeat).
  const latencies: number[] = [];
  provider.calls = 0;
  const queries = ["kubernetes deployments", "docker containers"];
  for (let i = 0; i < 20; i++) {
    const q = queries[i % 2];
    const start = performance.now();
    await memos.search(q);
    latencies.push(performance.now() - start);
  }
  latencies.sort((a, b) => a - b);
  console.log(`\nSearch latency (20 searches, 2 alternating queries):`);
  console.log(`  p50: ${percentile(latencies, 50).toFixed(2)}ms`);
  console.log(`  p95: ${percentile(latencies, 95).toFixed(2)}ms`);
  console.log(
    `  Embedding calls for 20 searches: ${provider.calls} (query cache: ` +
      `${provider.calls === 0 ? "all hits" : "misses present"})`,
  );

  // Multistream: one query embedding shared across streams (fresh query,
  // so the cache cannot hide the threading).
  provider.calls = 0;
  await memos.search("fresh multistream query xyz", {
    multiStream: true,
  } as never);
  console.log(
    `\nMultistream search embedding calls (fresh query): ${provider.calls} (expect 1, not 3)`,
  );

  await memos.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
