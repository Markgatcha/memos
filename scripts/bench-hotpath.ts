/**
 * Hot-path benchmark for MemOS retrieval internals.
 *
 * Measures the two dominant costs of every search()/contextPack() call:
 *   1. querySimilarEmbeddings — cosine scoring over all stored embeddings
 *      (currently O(N) with full node hydration per row).
 *   2. queryNodes FTS path — keyword leg (statement prep + row mapping).
 *
 * Also measures contextPack() end-to-end and reports the pack size in
 * estimated tokens (the token-efficiency surface).
 *
 * Usage: npx tsx scripts/bench-hotpath.ts [--nodes=2000] [--iters=30]
 * Writes scripts/bench-hotpath-results.json for before/after comparison.
 */

import { writeFileSync, existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemOS } from "../src/memory.js";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types.js";

// ---------------------------------------------------------------------------
// Deterministic embedding provider (same shape the quality bench uses).
// Real cosine geometry: seeded pseudo-random unit vectors per token bag, so
// similarity behaves like a real embedding model without a model download.
// ---------------------------------------------------------------------------

function hashToken(tok: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class SeededHashProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  private cache = new Map<string, EmbeddingVector>();

  async embed(text: string): Promise<EmbeddingVector> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const vec = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const tok of tokens) {
      // Spread each token across a few dims with signed weights.
      for (let k = 0; k < 3; k++) {
        const idx = hashToken(tok, k) % this.dimensions;
        vec[idx] += hashToken(tok, k + 100) % 2 === 0 ? 1 : -1;
      }
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    const out = vec.map((v) => v / norm);
    this.cache.set(text, out);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Synthetic corpus: N nodes of realistic conversation-memory facts.
// ---------------------------------------------------------------------------

const TOPICS = [
  "prefers dark mode in every editor and terminal",
  "uses TypeScript with strict mode for all projects",
  "morning routine starts with coffee and a short walk",
  "favorite book is Project Hail Mary by Andy Weir",
  "runs a homelab with Proxmox and three nodes",
  "listens to lo-fi playlists while coding",
  "keeps a paper notebook for weekly planning",
  "prefers train travel over short flights",
  "uses Neovim with LazyVim distribution",
  "drinks oat milk lattes, no sugar",
  "studies Japanese 20 minutes every day",
  "watches sci-fi movies on weekends",
  "grows basil and mint on the balcony",
  "cycles to work when the weather is dry",
  "keeps dependencies updated every Monday",
];

function buildContent(i: number): string {
  const topic = TOPICS[i % TOPICS.length];
  return `User fact [entry ${i}]: ${topic}. Recorded during session ${Math.floor(i / 15) + 1}.`;
}

function buildQuery(i: number): string {
  // Paraphrased probe for the topic of node i (shares some vocabulary).
  const topicWords = TOPICS[i % TOPICS.length].split(" ");
  const probe = topicWords.slice(0, 4).join(" ");
  return `What are the user's preferences about ${probe}?`;
}

// ---------------------------------------------------------------------------

interface BenchResult {
  config: { nodes: number; iters: number; dimensions: number };
  embedQueryMs: number;
  querySimilarEmbeddings: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    opsPerSec: number;
  };
  queryNodesFts: {
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    opsPerSec: number;
  };
  hybridSearch: { meanMs: number; p50Ms: number; p95Ms: number };
  contextPack: { meanMs: number; p50Ms: number; p95Ms: number };
  contextPackTokens: { mean: number; budget: number };
  searchToonChars: { mean: number };
}

function pct(sorted: number[], p: number): number {
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)]!;
}

function stats(samples: number[]): {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSec?: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    meanMs: mean,
    p50Ms: pct(sorted, 50),
    p95Ms: pct(sorted, 95),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: number) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? parseInt(a.split("=")[1]!, 10) : def;
  };
  const N = getArg("nodes", 2000);
  const ITERS = getArg("iters", 30);

  const dir = mkdtempSync(join(tmpdir(), "memos-bench-"));
  const dbPath = join(dir, "bench.db");
  const memos = new MemOS({
    dbPath,
    embeddings: { provider: "hash", model: "bench-seeded-384" },
    embeddingQueue: { concurrency: 8, maxQueueSize: 50_000 },
    experimental: { semanticSearch: true, namespaces: true },
  });
  // Swap in the seeded provider so vectors have real cosine geometry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (memos as any).embeddingProvider = new SeededHashProvider();

  await memos.init();

  process.stdout.write(`Seeding ${N} nodes...\n`);
  const seedStart = performance.now();
  for (let i = 0; i < N; i++) {
    await memos.store(buildContent(i), {
      namespace: "bench",
      tags: [`t${i % 7}`],
    });
    if (i % 500 === 0) await memos.flushEmbeddings();
  }
  await memos.flushEmbeddings();
  const seedMs = performance.now() - seedStart;

  const queries = Array.from({ length: 20 }, (_, i) => buildQuery(i));

  // Warmup
  for (const q of queries.slice(0, 5)) {
    await memos.search({ query: q, namespace: "bench", limit: 15 });
  }

  const provider = new SeededHashProvider();

  // ── 1. Embedding leg: querySimilarEmbeddings (via semanticSearch) ──────
  const embSamples: number[] = [];
  for (let it = 0; it < ITERS; it++) {
    const q = queries[it % queries.length]!;
    const t0 = performance.now();
    await memos.semanticSearch(q, 15, 0.1, { namespace: "bench" });
    embSamples.push(performance.now() - t0);
  }

  // ── 2. Keyword leg: queryNodes FTS (via storage directly) ─────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const storage = (memos as any).storage;
  const ftsSamples: number[] = [];
  for (let it = 0; it < ITERS; it++) {
    const q = queries[it % queries.length]!;
    const t0 = performance.now();
    await storage.queryNodes({
      query: q,
      namespace: "bench",
      limit: 80,
      offset: 0,
    });
    ftsSamples.push(performance.now() - t0);
  }

  // ── 3. Full hybrid search (what search() actually runs) ───────────────
  const hybridSamples: number[] = [];
  for (let it = 0; it < ITERS; it++) {
    const q = queries[it % queries.length]!;
    const t0 = performance.now();
    await memos.search({ query: q, namespace: "bench", limit: 15 });
    hybridSamples.push(performance.now() - t0);
  }

  // ── 4. contextPack end-to-end + token footprint ───────────────────────
  const packSamples: number[] = [];
  const tokenSamples: number[] = [];
  const toonCharSamples: number[] = [];
  for (let it = 0; it < ITERS; it++) {
    const q = queries[it % queries.length]!;
    const t0 = performance.now();
    const pack = (await memos.contextPack({
      query: q,
      namespace: "bench",
      tokenBudget: 1024,
      format: "toon-compact",
    })) as string;
    packSamples.push(performance.now() - t0);
    toonCharSamples.push(pack.length);
    // GPT-style estimate: chars/4 on the serialized pack.
    tokenSamples.push(Math.ceil(pack.length / 4));
  }

  const result: BenchResult = {
    config: { nodes: N, iters: ITERS, dimensions: 384 },
    embedQueryMs: 0, // filled below (single embed call, cached provider)
    querySimilarEmbeddings: stats(
      embSamples,
    ) as BenchResult["querySimilarEmbeddings"],
    queryNodesFts: stats(ftsSamples) as BenchResult["queryNodesFts"],
    hybridSearch: stats(hybridSamples),
    contextPack: stats(packSamples),
    contextPackTokens: {
      mean: tokenSamples.reduce((s, v) => s + v, 0) / tokenSamples.length,
      budget: 1024,
    },
    searchToonChars: {
      mean: toonCharSamples.reduce((s, v) => s + v, 0) / toonCharSamples.length,
    },
  };
  result.querySimilarEmbeddings.opsPerSec =
    1000 / result.querySimilarEmbeddings.meanMs;
  result.queryNodesFts.opsPerSec = 1000 / result.queryNodesFts.meanMs;
  result.embedQueryMs =
    (await timed(() => provider.embed(queries[0]!))) * 0 +
    (await (async () => {
      const t0 = performance.now();
      await provider.embed(queries[0]!);
      return performance.now() - t0;
    })());

  console.log("\n=== MemOS hot-path benchmark ===");
  console.log(`Nodes: ${N} | iters: ${ITERS} | seed: ${seedMs.toFixed(0)}ms`);
  console.table([
    {
      path: "semanticSearch (embeddings leg)",
      ...result.querySimilarEmbeddings,
      opsPerSec: result.querySimilarEmbeddings.opsPerSec.toFixed(0),
    },
    {
      path: "queryNodes FTS (keyword leg)",
      ...result.queryNodesFts,
      opsPerSec: result.queryNodesFts.opsPerSec.toFixed(0),
    },
    {
      path: "hybridSearch (full search)",
      meanMs: +result.hybridSearch.meanMs.toFixed(2),
      p50Ms: +result.hybridSearch.p50Ms.toFixed(2),
      p95Ms: +result.hybridSearch.p95Ms.toFixed(2),
    },
    {
      path: "contextPack (toon-compact)",
      meanMs: +result.contextPack.meanMs.toFixed(2),
      p50Ms: +result.contextPack.p50Ms.toFixed(2),
      p95Ms: +result.contextPack.p95Ms.toFixed(2),
    },
  ]);
  console.log(
    `contextPack tokens (mean, est): ${result.contextPackTokens.mean.toFixed(0)} / budget ${result.contextPackTokens.budget}`,
  );
  console.log(
    `searchToon chars (mean): ${result.searchToonChars.mean.toFixed(0)}`,
  );

  writeFileSync(
    join("scripts", "bench-hotpath-results.json"),
    JSON.stringify({ ...result, seededAt: new Date().toISOString() }, null, 2),
  );
  console.log("Wrote scripts/bench-hotpath-results.json");

  await memos.close();
  if (existsSync(dbPath)) unlinkSync(dbPath);
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
