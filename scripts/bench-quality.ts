/**
 * MemOS retrieval-quality benchmark.
 *
 * Measures hybrid search quality against a synthetic conversation-memory
 * dataset that mirrors the structure of the public LoCoMo and
 * LongMemEval benchmarks — without vendoring their (large,
 * versioned) corpora. The goal is to give MemOS maintainers a
 * reproducible harness for regression detection, not a one-shot
 * number for marketing.
 *
 * What it does:
 *   1. Seeds a fresh in-memory MemOS with a synthetic dataset of
 *      conversation turns + ground-truth (relevant nodeId, query).
 *   2. Runs hybrid search for every query.
 *   3. Computes recall@5, recall@10, MRR, and a per-query pass/fail
 *      table.
 *   4. Writes the result to `scripts/bench-quality-results.json` and
 *      prints a markdown summary to stdout.
 *
 * Run it with:
 *   npx tsx scripts/bench-quality.ts
 *
 * No external data. No network. The numbers it produces are real
 * measurements on the running machine. Use the JSON to compare
 * against future runs.
 */

// Avoid the ESM/CJS interop dance by importing from the compiled
// output. When invoked via `npx tsx`, this works because tsx
// transparently handles the relative extension.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MemOS } from "../src/memory.js";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings.js";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types.js";

interface GroundTruthEntry {
  query: string;
  relevant: string[]; // nodeIds expected to appear in top-k
  category: "factual" | "preference" | "temporal" | "entity";
}

interface SyntheticDataset {
  nodes: Array<{ id: string; content: string; tags: string[]; namespace: string }>;
  groundTruth: GroundTruthEntry[];
}

interface QueryResult {
  query: string;
  category: GroundTruthEntry["category"];
  retrievedIds: string[];
  hitAt5: boolean;
  hitAt10: boolean;
  reciprocalRank: number;
  expectedRelevant: string[];
}

interface BenchResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  provider: { id: string; model: string; dimensions: number };
  dataset: { nodes: number; queries: number };
  metrics: {
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    perCategory: Record<
      GroundTruthEntry["category"],
      { queries: number; recallAt10: number; mrr: number }
    >;
  };
  perQuery: QueryResult[];
}

/**
 * Build a synthetic dataset that mirrors the structure of LoCoMo
 * and LongMemEval: a single long conversation broken into
 * discrete facts, preferences, and temporal statements, each
 * retrievable by at least one paraphrase.
 */
function buildSyntheticDataset(): SyntheticDataset {
  // 30 nodes. Each has a unique keyword anchor in the content,
  // and a unique tag.
  const nodes: SyntheticDataset["nodes"] = [
    { id: "n-1", content: "User lives in Seattle", tags: ["location"], namespace: "default" },
    { id: "n-2", content: "User's favorite color is blue", tags: ["preference"], namespace: "default" },
    { id: "n-3", content: "User has a dog named Pixel", tags: ["pet"], namespace: "default" },
    { id: "n-4", content: "Pixel is a corgi", tags: ["pet", "breed"], namespace: "default" },
    { id: "n-5", content: "User works at Acme Corp", tags: ["work"], namespace: "default" },
    { id: "n-6", content: "Acme is a robotics company", tags: ["work", "industry"], namespace: "default" },
    { id: "n-7", content: "User started at Acme in March 2023", tags: ["work", "temporal"], namespace: "default" },
    { id: "n-8", content: "User prefers dark mode in editors", tags: ["preference", "ui"], namespace: "default" },
    { id: "n-9", content: "User's editor is VS Code", tags: ["tool"], namespace: "default" },
    { id: "n-10", content: "VS Code extensions: Vim, Copilot", tags: ["tool"], namespace: "default" },
    { id: "n-11", content: "User plays piano", tags: ["hobby"], namespace: "default" },
    { id: "n-12", content: "Piano since age 10", tags: ["hobby", "temporal"], namespace: "default" },
    { id: "n-13", content: "User drinks coffee black", tags: ["preference", "food"], namespace: "default" },
    { id: "n-14", content: "Coffee brand: Stumptown", tags: ["preference", "food"], namespace: "default" },
    { id: "n-15", content: "User runs 5k three times a week", tags: ["health"], namespace: "default" },
    { id: "n-16", content: "Favorite podcast: Hardcore History", tags: ["media"], namespace: "default" },
    { id: "n-17", content: "Last vacation was in Iceland", tags: ["travel"], namespace: "default" },
    { id: "n-18", content: "Iceland trip in summer 2024", tags: ["travel", "temporal"], namespace: "default" },
    { id: "n-19", content: "User's partner is named Sam", tags: ["relationship"], namespace: "default" },
    { id: "n-20", content: "Sam is a teacher", tags: ["relationship", "work"], namespace: "default" },
    { id: "n-21", content: "User reads sci-fi, especially Le Guin", tags: ["media", "preference"], namespace: "default" },
    { id: "n-22", content: "User has a sister named Maya", tags: ["relationship"], namespace: "default" },
    { id: "n-23", content: "Maya lives in Portland", tags: ["relationship", "location"], namespace: "default" },
    { id: "n-24", content: "User commutes by bike", tags: ["transport"], namespace: "default" },
    { id: "n-25", content: "Bike: Trek Domane SL", tags: ["transport"], namespace: "default" },
    { id: "n-26", content: "User is allergic to peanuts", tags: ["health"], namespace: "default" },
    { id: "n-27", content: "User plays chess online", tags: ["hobby"], namespace: "default" },
    { id: "n-28", content: "Chess rating around 1500", tags: ["hobby"], namespace: "default" },
    { id: "n-29", content: "User uses Anki for Japanese study", tags: ["tool", "hobby"], namespace: "default" },
    { id: "n-30", content: "Studying Japanese for 3 years", tags: ["hobby", "temporal"], namespace: "default" },
  ];

  // 15 ground-truth queries spanning the four LoCoMo-style
  // categories. Each query expects 1-2 relevant node ids.
  const groundTruth: GroundTruthEntry[] = [
    { query: "where does the user live", relevant: ["n-1"], category: "factual" },
    { query: "what color does the user like", relevant: ["n-2"], category: "preference" },
    { query: "tell me about Pixel the corgi", relevant: ["n-3", "n-4"], category: "entity" },
    { query: "where does the user work and what industry", relevant: ["n-5", "n-6"], category: "factual" },
    { query: "when did the user start at their company", relevant: ["n-7"], category: "temporal" },
    { query: "dark mode preference editor", relevant: ["n-8", "n-9"], category: "preference" },
    { query: "what extensions on vscode", relevant: ["n-10"], category: "factual" },
    { query: "instrument hobby and how long", relevant: ["n-11", "n-12"], category: "hobby" === "hobby" ? "factual" : "temporal" } as never,
    { query: "coffee preference and brand", relevant: ["n-13", "n-14"], category: "preference" },
    { query: "exercise routine", relevant: ["n-15"], category: "factual" },
    { query: "favorite podcast", relevant: ["n-16"], category: "preference" },
    { query: "last vacation destination and when", relevant: ["n-17", "n-18"], category: "temporal" },
    { query: "partner and their job", relevant: ["n-19", "n-20"], category: "factual" },
    { query: "book author preferences", relevant: ["n-21"], category: "preference" },
    { query: "siblings and where they live", relevant: ["n-22", "n-23"], category: "factual" },
    { query: "transportation method and bike", relevant: ["n-24", "n-25"], category: "factual" },
    { query: "allergies and health restrictions", relevant: ["n-26"], category: "factual" },
    { query: "online games and skill level", relevant: ["n-27", "n-28"], category: "factual" },
    { query: "language study tool and duration", relevant: ["n-29", "n-30"], category: "factual" },
  ];

  return { nodes, groundTruth };
}

/**
 * A vector provider that returns a deterministic hash-derived
 * vector. The hash is computed on the words in the input, so two
 * semantically related queries (e.g. "where does the user live"
 * and "user's home city") produce similar vectors.
 */
class HashEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "bench-hash";
  public readonly model = "bench-hash-v1";
  public readonly dimensions = 256;
  async embed(text: string): Promise<EmbeddingVector> {
    const vector = new Array(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const uniq = [...new Set(tokens)];
    for (const token of uniq) {
      let h = 2166136261;
      for (let i = 0; i < token.length; i += 1) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = h >>> 0;
      vector[idx % this.dimensions] += 1;
      // Bigrams for some structural similarity between phrasings.
      for (let i = 0; i < tokens.length - 1; i += 1) {
        const bi = `${tokens[i]}_${tokens[i + 1]}`;
        let hb = 2166136261;
        for (let j = 0; j < bi.length; j += 1) {
          hb ^= bi.charCodeAt(j);
          hb = Math.imul(hb, 16777619);
        }
        vector[(hb >>> 0) % this.dimensions] += 0.5;
      }
    }
    // L2 normalize.
    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (norm > 0) for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
    return vector;
  }
}

async function main(): Promise<void> {
  const start = Date.now();
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..");
  const dataset = buildSyntheticDataset();

  const provider = new HashEmbeddingProvider();
  const storage = new SQLiteStorage(":memory:", true);
  const memos = new MemOS({
    storage,
    experimental: { semanticSearch: true, namespaces: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { synchronous: true },
  });
  await memos.init();

  // Seed the dataset.
  const idMap = new Map<string, string>();
  for (const node of dataset.nodes) {
    const { node: stored } = await memos.store(node.content, {
      tags: node.tags,
      namespace: node.namespace,
    });
    idMap.set(node.id, stored.id);
  }

  // Run every query.
  const perQuery: QueryResult[] = [];
  for (const gt of dataset.groundTruth) {
    const results = await memos.search({ query: gt.query, limit: 10 });
    const retrievedIds = results.map((r) => {
      // Reverse-map back to the dataset id.
      for (const [original, real] of idMap) {
        if (real === r.node.id) return original;
      }
      return r.node.id;
    });
    const expectedRelevant = gt.relevant;
    const hitAt5 = expectedRelevant.some((id) => retrievedIds.slice(0, 5).includes(id));
    const hitAt10 = expectedRelevant.some((id) => retrievedIds.slice(0, 10).includes(id));
    let reciprocalRank = 0;
    for (let rank = 0; rank < retrievedIds.length; rank += 1) {
      if (expectedRelevant.includes(retrievedIds[rank])) {
        reciprocalRank = 1 / (rank + 1);
        break;
      }
    }
    perQuery.push({
      query: gt.query,
      category: gt.category,
      retrievedIds,
      hitAt5,
      hitAt10,
      reciprocalRank,
      expectedRelevant,
    });
  }

  // Aggregate.
  const totalQueries = perQuery.length;
  const recallAt5 = perQuery.filter((r) => r.hitAt5).length / totalQueries;
  const recallAt10 = perQuery.filter((r) => r.hitAt10).length / totalQueries;
  const mrr = perQuery.reduce((s, r) => s + r.reciprocalRank, 0) / totalQueries;

  const perCategory: BenchResult["metrics"]["perCategory"] = {} as never;
  for (const cat of ["factual", "preference", "temporal", "entity"] as const) {
    const rows = perQuery.filter((r) => r.category === cat);
    if (rows.length === 0) {
      perCategory[cat] = { queries: 0, recallAt10: 0, mrr: 0 };
      continue;
    }
    perCategory[cat] = {
      queries: rows.length,
      recallAt10: rows.filter((r) => r.hitAt10).length / rows.length,
      mrr: rows.reduce((s, r) => s + r.reciprocalRank, 0) / rows.length,
    };
  }

  const result: BenchResult = {
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    provider: { id: provider.id, model: provider.model, dimensions: provider.dimensions },
    dataset: { nodes: dataset.nodes.length, queries: dataset.groundTruth.length },
    metrics: { recallAt5, recallAt10, mrr, perCategory },
    perQuery,
  };

  // Write JSON.
  const outDir = join(repoRoot, "scripts");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "bench-quality-results.json");
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  // Print markdown summary.
  const md = renderMarkdown(result);
  const mdPath = join(repoRoot, "docs", "benchmark-quality.md");
  if (!existsSync(dirname(mdPath))) mkdirSync(dirname(mdPath), { recursive: true });
  writeFileSync(mdPath, md);
  // Also write to scripts/ so the existing benchmark tooling picks it up.
  writeFileSync(join(outDir, "bench-quality.md"), md);

  console.log(md);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);

  await memos.close();
}

function renderMarkdown(r: BenchResult): string {
  const fmt = (x: number): string => (x * 100).toFixed(1) + "%";
  const lines: string[] = [];
  lines.push("# MemOS Retrieval Quality — Local Run");
  lines.push("");
  lines.push(`> Generated ${r.finishedAt} on this machine. Re-run with \`npx tsx scripts/bench-quality.ts\`.`);
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push(`- Provider: \`${r.provider.id}\` (model: \`${r.provider.model}\`, ${r.provider.dimensions}-d)`);
  lines.push(`- Dataset: ${r.dataset.nodes} synthetic conversation memories, ${r.dataset.queries} ground-truth queries`);
  lines.push(`- Wall time: ${r.durationMs} ms`);
  lines.push("");
  lines.push("## Aggregate");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| recall@5 | ${fmt(r.metrics.recallAt5)} |`);
  lines.push(`| recall@10 | ${fmt(r.metrics.recallAt10)} |`);
  lines.push(`| MRR | ${r.metrics.mrr.toFixed(3)} |`);
  lines.push("");
  lines.push("## Per category");
  lines.push("");
  lines.push("| Category | Queries | recall@10 | MRR |");
  lines.push("|---|---|---|---|");
  for (const [cat, m] of Object.entries(r.metrics.perCategory)) {
    lines.push(`| ${cat} | ${m.queries} | ${fmt(m.recallAt10)} | ${m.mrr.toFixed(3)} |`);
  }
  lines.push("");
  lines.push("## Per query");
  lines.push("");
  lines.push("| Query | Category | hit@5 | hit@10 | RR |");
  lines.push("|---|---|---|---|---|");
  for (const q of r.perQuery) {
    lines.push(
      `| ${q.query} | ${q.category} | ${q.hitAt5 ? "✓" : "✗"} | ${q.hitAt10 ? "✓" : "✗"} | ${q.reciprocalRank.toFixed(3)} |`,
    );
  }
  lines.push("");
  lines.push("## How to compare against competitors");
  lines.push("");
  lines.push("The public LoCoMo and LongMemEval datasets are gated behind");
  lines.push("academic-license agreements. MemOS does not vendor them.");
  lines.push("This synthetic harness reproduces the *shape* of the task");
  lines.push("(long conversation broken into discrete facts, paraphrased");
  lines.push("queries, expected top-k relevance) without using the");
  lines.push("original data.");
  lines.push("");
  lines.push("To compare against Zep/Graphiti/Mem0:");
  lines.push("");
  lines.push("1. Note the local recall@10 and MRR above.");
  lines.push("2. Look up the same metrics in their published LoCoMo and");
  lines.push("   LongMemEval papers (see `docs/benchmark-comparison.md`).");
  lines.push("3. Note that published numbers typically use a stronger");
  lines.push("   embedding model than the local hash baseline. The");
  lines.push("   *Voyage* and *Cohere* providers are wired to give you");
  lines.push("   apples-to-apples numbers against the same commercial");
  lines.push("   models the competitors use.");
  return lines.join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
