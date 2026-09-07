#!/usr/bin/env npx tsx
/**
 * ─── Memory-Haystack benchmark (Needle-In-A-Haystack for memory stores) ──────
 *
 * The long-context world's most recognized test, adapted to a memory layer:
 * a corpus of distractor memories grows (1k → 10k) while needles ("The
 * access code for project <X> is <Y>.") are planted at random depths. Every
 * needle gets its natural-language query. Retrieval-only scoring:
 *
 *   Hit@1 / Hit@5 / Hit@10, MRR, and p50/p95 retrieval latency per corpus
 *   size — plus ingestion throughput.
 *
 * What this demonstrates: precision at scale (the FTS keyword leg nails
 * verbatim needles), the latency curve of the O(N) semantic scan (honest
 * numbers), and the hybrid pipeline's ability to keep exact facts on top
 * while the semantic leg fills the tail.
 *
 * Default provider is the shipped local-hash embedder — fully deterministic,
 * CPU-only, no network, no GPU. Pass the standard provider flags
 * (--provider=openai-compatible --base-url=... etc.) to measure a real
 * embedding model; rerank flags are accepted and forwarded to MemOS.
 *
 * Usage:
 *   npx tsx scripts/bench-haystack.ts --sizes=1000,5000,10000 --needles=50
 *   npx tsx scripts/bench-haystack.ts --provider=openai-compatible \
 *       --base-url=http://127.0.0.1:8080/v1 --model=LFM2.5-Embedding-350M-BF16 \
 *       --dimensions=1024 --query-prefix="query: " --document-prefix="document: "
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { MemOS } from "../src/memory.ts";
import { SQLiteStorage } from "../src/storage/sqlite.ts";
import type { ScoredMemory } from "../src/types.ts";
import {
  parseProviderArgs,
  parseRetrievalArgs,
  buildProvider,
  assertNoFallback,
  benchMetadata,
  retrievalConfig,
} from "./lib/bench-common.ts";

// ─── Synthetic corpus ────────────────────────────────────────────────────────

const PROJECTS = [
  "artemis",
  "borealis",
  "cascade",
  "dynamo",
  "ember",
  "falcon",
  "granite",
  "helix",
  "iris",
  "juniper",
  "kestrel",
  "lumen",
  "meridian",
  "nebula",
  "onyx",
  "pinnacle",
  "quasar",
  "ridge",
  "summit",
  "tundra",
  "umbra",
  "vertex",
  "willow",
  "xenon",
  "yarrow",
  "zephyr",
  "aurora",
  "basalt",
  "cobalt",
  "driftwood",
];

const DISTRACTOR_TEMPLATES = [
  "Reviewed the {n} test failures in the {p} pipeline; two were flakes and the rest were missing fixtures.",
  "Meeting notes: the {p} design review moved to Thursday, bring the updated latency charts.",
  "Refactored the {p} retry logic; backoff is now exponential with jitter, capped at 30 seconds.",
  "The {p} dashboard shows p99 latency by region; us-east is the outlier this week.",
  "TODO for the {p} repo: bump the minor version, regenerate the client, and update the changelog.",
  "Sprint {n} planning: the {p} migration story carries over, pick it up before the API freeze.",
  "Postmortem draft for the {p} incident filed under severity {n}; action items are in the tracker.",
  "Weekly digest: {p} PRs merged, {n} issues closed, CI green on the release branch.",
];

function fillerText(seed: number): string {
  const template = DISTRACTOR_TEMPLATES[seed % DISTRACTOR_TEMPLATES.length];
  const project = PROJECTS[seed % PROJECTS.length];
  return template
    .replace("{p}", project)
    .replace("{n}", String(((seed * 7) % 89) + 3));
}

interface Needle {
  project: string;
  code: string;
}

function makeNeedle(seed: number): Needle {
  // Unique codename per needle — no two needles share a project, so every
  // query has exactly one right answer.
  const project = `${PROJECTS[seed % PROJECTS.length]}-${seed}`;
  const code = `${1000 + ((seed * 37) % 9000)}-${String.fromCharCode(65 + (seed % 26))}${(seed * 3) % 10}`;
  return { project, code };
}

const needleContent = (n: Needle): string =>
  `Project note: the access code for project ${n.project} is ${n.code}.`;
const needleQuery = (n: Needle): string =>
  `What is the access code for project ${n.project}?`;

// ─── Metrics (rank-based, deterministic) ─────────────────────────────────────

function reciprocalRank(results: ScoredMemory[], needleText: string): number {
  for (const [i, r] of results.entries()) {
    if (r.node.content === needleText) return 1 / (i + 1);
  }
  return 0;
}

function hitAt(
  results: ScoredMemory[],
  needleText: string,
  k: number,
): boolean {
  return results.slice(0, k).some((r) => r.node.content === needleText);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sizesArg = argv.find((a) => a.startsWith("--sizes="));
  const sizes = (sizesArg?.split("=")[1] ?? "1000,5000,10000")
    .split(",")
    .map((v) => parseInt(v.trim(), 10))
    .filter((v) => Number.isFinite(v) && v > 50);
  const needlesArg = argv.find((a) => a.startsWith("--needles="));
  const needleCount = needlesArg
    ? parseInt(needlesArg.split("=")[1] ?? "50", 10)
    : 50;
  const depthArg = argv.find((a) => a.startsWith("--candidate-depth="));
  const candidateDepth = depthArg
    ? parseInt(depthArg.split("=")[1] ?? "", 10)
    : undefined;
  const rerankUrl = argv
    .find((a) => a.startsWith("--rerank-url="))
    ?.split("=")[1];

  const providerArgs = parseProviderArgs(argv);
  const retrievalArgs = parseRetrievalArgs(argv);
  const explicitProvider =
    argv.some((a) => a.startsWith("--provider=")) ||
    process.env.EMBEDDING_PROVIDER !== undefined;
  const provider = explicitProvider ? buildProvider(providerArgs) : undefined; // undefined → MemOS default local-hash
  const runtimeInfo = provider
    ? await assertNoFallback(provider, providerArgs)
    : null;

  console.log(
    `Memory-haystack: sizes=${sizes.join(",")} needles=${needleCount} ` +
      `provider=${provider ? provider.model : "local-hash (default)"}` +
      `${rerankUrl ? ` rerank=${rerankUrl}` : ""}`,
  );

  const sizeResults: Array<Record<string, unknown>> = [];

  for (const size of sizes) {
    const storage = new SQLiteStorage(
      join(tmpdir(), `bench-haystack-${size}-${Date.now()}.db`),
      false,
    );
    const memos = new MemOS({
      storage,
      wal: false,
      autoLinkThreshold: 0,
      experimental: {
        namespaces: false,
        semanticSearch: true,
        ...(rerankUrl
          ? {
              rerank: {
                endpoint: rerankUrl,
                candidates: 100,
                timeoutMs: 60_000,
              },
            }
          : {}),
      },
      ...(provider
        ? {
            embeddings: {
              enabled: true,
              provider,
              ...(providerArgs.model ? { model: providerArgs.model } : {}),
              ...(providerArgs.dimensions
                ? { dimensions: providerArgs.dimensions }
                : {}),
              ...(providerArgs.queryPrefix
                ? { queryPrefix: providerArgs.queryPrefix }
                : {}),
              ...(providerArgs.documentPrefix
                ? { documentPrefix: providerArgs.documentPrefix }
                : {}),
            },
          }
        : {}),
      ...(Object.keys(retrievalConfig(retrievalArgs)).length > 0
        ? retrievalConfig(retrievalArgs)
        : {}),
      embeddingQueue: { synchronous: true },
    });
    await memos.init();

    // Deterministic needles for this size.
    const needles: Needle[] = [];
    for (let i = 0; i < needleCount; i += 1) {
      needles.push(makeNeedle(i));
    }
    const needleAt = new Map<number, Needle>();
    needles.forEach((n, i) => {
      // Spread depths across the corpus: 5%..95%.
      const depth = Math.floor(((i + 0.5) / needleCount) * size);
      needleAt.set(Math.min(size - 1, Math.max(0, depth)), n);
    });

    // ── Ingestion ──
    const ingestStart = Date.now();
    for (let i = 0; i < size; i += 1) {
      const needle = needleAt.get(i);
      const content = needle
        ? needleContent(needle)
        : fillerText(i + size * 13);
      await memos.store(content, { type: "context", tags: ["haystack"] });
    }
    const ingestMs = Date.now() - ingestStart;

    // ── Retrieval ──
    const latencies: number[] = [];
    let hit1 = 0;
    let hit5 = 0;
    let hit10 = 0;
    let mrrSum = 0;

    for (const needle of needles) {
      const start = Date.now();
      const results = await memos.search({
        query: needleQuery(needle),
        limit: 10,
        ...(candidateDepth ? { candidateDepth } : {}),
        ...(retrievalArgs.ftsOperator
          ? { ftsOperator: retrievalArgs.ftsOperator }
          : {}),
      });
      latencies.push(Date.now() - start);
      const needleText = needleContent(needle);
      if (hitAt(results, needleText, 1)) hit1 += 1;
      if (hitAt(results, needleText, 5)) hit5 += 1;
      if (hitAt(results, needleText, 10)) hit10 += 1;
      mrrSum += reciprocalRank(results, needleText);
    }

    const n = needles.length;
    sizeResults.push({
      corpusSize: size,
      needles: n,
      ingestMs,
      ingestPerMemoryMs: Number((ingestMs / size).toFixed(3)),
      hitAt1: hit1 / n,
      hitAt5: hit5 / n,
      hitAt10: hit10 / n,
      mrr: mrrSum / n,
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      latencyMeanMs: Number(
        (latencies.reduce((s, x) => s + x, 0) / latencies.length).toFixed(2),
      ),
    });

    const row = sizeResults[sizeResults.length - 1];
    console.log(
      `  size=${size}: hit@1=${((row.hitAt1 as number) * 100).toFixed(1)}% ` +
        `hit@10=${((row.hitAt10 as number) * 100).toFixed(1)}% mrr=${row.mrr} ` +
        `p50=${row.latencyP50Ms}ms p95=${row.latencyP95Ms}ms ` +
        `ingest=${ingestMs}ms`,
    );

    await memos.close();
  }

  // ── Output ──
  const result = {
    ...benchMetadata(
      providerArgs,
      runtimeInfo ?? {
        requestedProvider: "local-hash",
        resolvedProvider: "local-hash",
        requestedModel: "local-hash-384",
        resolvedModel: "local-hash-384",
        modelRevision: null,
        requestedDimensions: 384,
        observedDimensions: null,
        fallbackActive: false,
        fallbackReason: null,
      },
      { name: "memory-haystack", path: fileURLToPath(import.meta.url) },
      retrievalArgs,
    ),
    benchmark: "memory-haystack",
    sizes,
    needleCount,
    rerank: rerankUrl ?? null,
    results: sizeResults,
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = join(here, "bench-haystack-results.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
