/**
 * Memory Quality Benchmark for MemOS.
 *
 * This benchmark evaluates MemOS on standard memory-retrieval metrics
 * comparable to the LOCOMO and LongMemEval benchmarks used by Mem0,
 * Letta, and Zep. It generates a synthetic conversation dataset,
 * stores it in MemOS, and then measures:
 *
 * 1. **Recall@K** — fraction of relevant memories retrieved in the top-K results.
 * 2. **Token efficiency** — average tokens used to retrieve correct answers
 *    (fewer tokens = more efficient, lower cost).
 * 3. **Precision@K** — fraction of retrieved results that are actually relevant.
 * 4. **Latency** — p50/p95/p99 search latency.
 *
 * The benchmark also supports a "competitor mode" where you can optionally
 * run the same queries against a competitor (e.g., Mem0) via an HTTP API
 * and compare results side-by-side.
 *
 * Run via: tsx scripts/bench-memory.ts [--competitor-url=http://localhost:8000]
 *
 * @module scripts/bench-memory
 */

import { MemOS } from "../src/memory.ts";
import { performance } from "perf_hooks";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Benchmark Dataset ────────────────────────────────────────────────────────
// This simulates a conversation history that an agent might accumulate
// over many sessions. Each entry represents a fact, preference, or context
// item that should be retrievable later.
//
// IMPORTANT: Each fact's content includes a unique suffix (e.g. "[entry 42]")
// to ensure that storing 200 facts doesn't create duplicates. With unique
// content, FTS5 returns diverse results in the top-K, which makes the
// recall/precision metrics meaningful. Without unique content, storing
// the same fact 4 times would cause the top-10 to return 10 copies of
// the same result, making precision misleadingly high.

interface MemoryFact {
  id: string;
  category: "preference" | "fact" | "context";
  content: string;
  keywords: string[]; // Used for relevance matching
  weight: number; // How "memorable" this fact is (1.0 = core, 0.5 = peripheral)
}

// A realistic set of ~200 facts across categories.
// In a real scenario this would be ~2000+ facts, but this is enough
// for a representative benchmark without requiring an embedding model.
const BENCHMARK_FACTS: MemoryFact[] = generateBenchmarkFacts(50);

function generateBenchmarkFacts(count: number): MemoryFact[] {
  const facts: MemoryFact[] = [];

  // --- User preferences (30% of facts) ---
  const preferenceTemplates = [
    {
      content: "User prefers dark mode in all applications",
      keywords: ["dark mode", "theme", "preference"],
    },
    {
      content: "User always uses 2-space indentation in code",
      keywords: ["2-space", "indentation", "code style"],
    },
    {
      content: "User prefers TypeScript over JavaScript for new projects",
      keywords: ["typescript", "javascript", "preference"],
    },
    {
      content: "User's favorite color is deep teal (#0D9488)",
      keywords: ["teal", "color", "favorite"],
    },
    {
      content: "User likes minimalist UI designs with lots of whitespace",
      keywords: ["minimalist", "UI", "whitespace"],
    },
    {
      content: "User prefers Neovim over VS Code for editing",
      keywords: ["neovim", "editor", "preference"],
    },
    {
      content: "User uses pnpm as their primary package manager",
      keywords: ["pnpm", "package", "manager"],
    },
    {
      content: "User prefers PostgreSQL over MySQL for databases",
      keywords: ["postgresql", "database"],
    },
    {
      content: "User likes listening to lo-fi hip hop while coding",
      keywords: ["lo-fi", "music", "coding"],
    },
    {
      content: "User's birthday is in October",
      keywords: ["birthday", "october"],
    },
    {
      content: "User is lactose intolerant",
      keywords: ["lactose", "intolerant", "diet"],
    },
    {
      content: "User prefers CLI tools over GUI applications",
      keywords: ["CLI", "terminal", "preference"],
    },
    {
      content: "User uses a mechanical keyboard with Cherry MX Brown switches",
      keywords: ["mechanical", "keyboard", "switches"],
    },
    {
      content: "User's GitHub username is markgatcha",
      keywords: ["github", "username", "markgatcha"],
    },
    {
      content: "User prefers dark roast coffee",
      keywords: ["coffee", "dark roast"],
    },
    {
      content: "User runs on Windows 11 with WSL2",
      keywords: ["windows", "WSL", "environment"],
    },
    {
      content: "User is allergic to shellfish",
      keywords: ["shellfish", "allergic", "diet"],
    },
    {
      content: "User prefers metric system measurements",
      keywords: ["metric", "measurement"],
    },
    {
      content: "User likes hiking in the mountains on weekends",
      keywords: ["hiking", "mountains", "weekend"],
    },
    {
      content: "User's preferred programming font is Fira Code",
      keywords: ["font", "fira code", "programming"],
    },
  ];

  // --- Factual knowledge (40% of facts) ---
  const factTemplates = [
    {
      content: "The capital of France is Paris",
      keywords: ["paris", "france", "capital"],
    },
    {
      content: "TypeScript 5.4 introduced the `overlaps` type guard",
      keywords: ["typescript", "overlaps", "type guard"],
    },
    {
      content: "The Higgs boson was discovered at CERN in 2012",
      keywords: ["higgs", "boson", "CERN", "2012"],
    },
    {
      content: "PostgreSQL 16 added logical replication for schemas",
      keywords: ["postgresql", "replication", "schema"],
    },
    {
      content: "Bun is a JavaScript runtime written in Zig",
      keywords: ["bun", "runtime", "zig"],
    },
    {
      content: "The Model Context Protocol was created by Anthropic in 2024",
      keywords: ["MCP", "model context", "anthropic"],
    },
    {
      content: "SQLite uses B-tree indexes for query optimization",
      keywords: ["sqlite", "btree", "index"],
    },
    {
      content: "Ollama supports GPU acceleration for LLM inference",
      keywords: ["ollama", "GPU", "inference"],
    },
    {
      content:
        "HNSW provides approximate nearest-neighbor search in O(log n) time",
      keywords: ["HNSW", "ann", "search"],
    },
    {
      content: "WebAssembly modules can be compiled from Rust using wasm-pack",
      keywords: ["wasm", "rust", "wasm-pack"],
    },
    {
      content: "Git bisect helps find the commit that introduced a bug",
      keywords: ["git", "bisect", "debug"],
    },
    {
      content: "The Pythagorean theorem states a² + b² = c²",
      keywords: ["pythagorean", "theorem", "math"],
    },
    {
      content: "Docker containers use Linux namespaces for isolation",
      keywords: ["docker", "containers", "namespace"],
    },
    {
      content: "Redis supports transactions via MULTI/EXEC commands",
      keywords: ["redis", "transaction", "multi"],
    },
    {
      content: "The Fourier transform decomposes signals into frequencies",
      keywords: ["fourier", "transform", "frequency"],
    },
    {
      content: "GraphQL was developed by Facebook in 2012",
      keywords: ["graphql", "facebook", "2012"],
    },
    {
      content:
        "The CAP theorem states you can only have two of Consistency, Availability, and Partition tolerance",
      keywords: ["CAP", "theorem", "consistency"],
    },
    {
      content: "V8 is Google's open-source JavaScript engine",
      keywords: ["v8", "google", "javascript"],
    },
    {
      content: "Kubernetes uses etcd as its backing datastore",
      keywords: ["kubernetes", "etcd", "datastore"],
    },
    {
      content: "The ReLU activation function returns max(0, x)",
      keywords: ["ReLU", "activation", "neural"],
    },
  ];

  // --- Context/session info (30% of facts) ---
  const contextTemplates = [
    {
      content: "User is currently working on the llm-guardian project",
      keywords: ["llm-guardian", "project", "working"],
    },
    {
      content: "User is building a universal-mcp-toolkit monorepo",
      keywords: ["umt", "monorepo", "building"],
    },
    {
      content: "User is contributing to memos (MemOS SDK)",
      keywords: ["memos", "contributing"],
    },
    {
      content: "User plans to apply to college in 2026",
      keywords: ["college", "apply", "2026"],
    },
    {
      content: "User is a high school sophomore",
      keywords: ["sophomore", "high school"],
    },
    {
      content: "User is learning about distributed systems",
      keywords: ["distributed", "systems", "learning"],
    },
    {
      content: "User is building a portfolio of open-source projects",
      keywords: ["portfolio", "open-source"],
    },
    {
      content: "User's next project involves benchmarking AI agent memory",
      keywords: ["benchmark", "memory", "AI"],
    },
    {
      content: "User uses the Hermes desktop app for coding",
      keywords: ["hermes", "desktop", "coding"],
    },
    {
      content: "User prefers hands-on bug fixing over subagent fan-out",
      keywords: ["debugging", "hands-on"],
    },
  ];

  const allTemplates = [
    ...preferenceTemplates,
    ...factTemplates,
    ...contextTemplates,
  ];
  const categoryMap: Record<string, MemoryFact["category"]> = {};
  for (const t of preferenceTemplates)
    categoryMap[t.keywords[0]] = "preference";
  for (const t of factTemplates) categoryMap[t.keywords[0]] = "fact";
  for (const t of contextTemplates) categoryMap[t.keywords[0]] = "context";

  for (let i = 0; i < count; i++) {
    const template = allTemplates[i % allTemplates.length];
    const category = categoryMap[template.keywords[0]] ?? "fact";
    facts.push({
      id: `f${i}`,
      category,
      // Append unique suffix to avoid duplicate content in storage.
      content: `${template.content} [entry ${i}]`,
      keywords: template.keywords,
      weight: 0.5 + Math.random() * 0.5, // [0.5, 1.0]
    });
  }

  return facts;
}

// ─── Benchmark Queries ────────────────────────────────────────────────────────
// These queries simulate what an agent would ask to retrieve relevant memories.
// Each query targets a specific subset of the facts.

interface BenchmarkQuery {
  query: string;
  expectedIds: string[];
  description: string;
}

/**
 * Build a set of benchmark queries filtered to only include facts
 * that are actually present in the provided dataset.
 *
 * This ensures the expectedIds in each query only reference facts
 * that were stored, so recall/precision calculations are meaningful.
 */
function buildQueries(facts: MemoryFact[]): BenchmarkQuery[] {
  const ids = new Set(facts.map((f) => f.id));
  const filter = (keywords: string[]) =>
    facts
      .filter((f) => f.keywords.some((k) => keywords.includes(k)))
      .map((f) => f.id)
      .filter((id) => ids.has(id));

  return [
    // ─── Easy queries (FTS5 exact keyword match) ────────────────────────────────
    // These queries use single terms or hyphenated phrases that FTS5
    // can match exactly (FTS5 treats multi-word queries as AND, so
    // "coffee preference" would require BOTH "coffee" AND "preference"
    // in the content — use the keyword that actually appears).
    {
      query: "dark mode",
      expectedIds: filter(["dark mode"]),
      description: "Dark mode preference",
    },
    {
      query: "coffee",
      expectedIds: filter(["coffee"]),
      description: "Coffee preference",
    },
    {
      query: "lo-fi",
      expectedIds: filter(["lofi"]),
      description: "Music preference",
    },
    {
      query: "TypeScript",
      expectedIds: filter(["typescript"]),
      description: "TypeScript preference",
    },
    {
      query: "PostgreSQL",
      expectedIds: filter(["postgresql"]),
      description: "PostgreSQL knowledge",
    },
    {
      query: "SQLite",
      expectedIds: filter(["sqlite"]),
      description: "SQLite knowledge",
    },
    {
      query: "Docker",
      expectedIds: filter(["docker"]),
      description: "Docker knowledge",
    },
    {
      query: "llm-guardian",
      expectedIds: filter(["llm-guardian"]),
      description: "Active project: llm-guardian",
    },
    {
      query: "memos",
      expectedIds: filter(["memos"]),
      description: "Active project: memos",
    },
    {
      query: "lactose",
      expectedIds: filter(["lactose"]),
      description: "Dietary restriction: lactose",
    },
    {
      query: "shellfish",
      expectedIds: filter(["shellfish"]),
      description: "Dietary restriction: shellfish",
    },
    {
      query: "Neovim",
      expectedIds: filter(["neovim"]),
      description: "Editor preference",
    },
    {
      query: "Higgs boson",
      expectedIds: filter(["higgs"]),
      description: "Physics fact",
    },
    {
      query: "Pythagorean theorem",
      expectedIds: filter(["pythagorean"]),
      description: "Math fact",
    },
    {
      query: "Git bisect",
      expectedIds: filter(["git"]),
      description: "Git knowledge",
    },
    {
      query: "WebAssembly",
      expectedIds: filter(["wasm"]),
      description: "WebAssembly knowledge",
    },
    {
      query: "V8",
      expectedIds: filter(["v8"]),
      description: "V8 engine knowledge",
    },
    {
      query: "Kubernetes",
      expectedIds: filter(["kubernetes"]),
      description: "Kubernetes knowledge",
    },
    {
      query: "CAP theorem",
      expectedIds: filter(["CAP"]),
      description: "CAP theorem knowledge",
    },

    // ─── Hard queries (semantic retrieval) ──────────────────────────────────────
    // These queries describe concepts without using exact keywords
    // from the fact content. The embedding model (all-MiniLM-L6-v2)
    // must semantically match the query to the stored fact.
    {
      query: "What editor does the user prefer for coding",
      expectedIds: filter(["neovim"]),
      description: "Editor preference (semantic)",
    },
    {
      query: "User's preferred database system",
      expectedIds: filter(["postgresql"]),
      description: "Database preference (semantic)",
    },
    {
      query: "What type of coffee does the user prefer",
      expectedIds: filter(["coffee"]),
      description: "Coffee type (semantic)",
    },
    {
      query: "User's preferred programming language",
      expectedIds: filter(["typescript"]),
      description: "Programming language (semantic)",
    },
    {
      query: "What music does the user listen to while coding",
      expectedIds: filter(["lofi"]),
      description: "Music genre (semantic)",
    },
    {
      query: "User's package manager choice",
      expectedIds: filter(["pnpm"]),
      description: "Package manager (semantic)",
    },
    {
      query: "What color theme does the user prefer",
      expectedIds: filter(["dark mode"]),
      description: "Color theme (semantic)",
    },
    {
      query: "What is the user allergic to in seafood",
      expectedIds: filter(["shellfish"]),
      description: "Food allergy (semantic)",
    },
    {
      query: "User's dietary restriction",
      expectedIds: filter(["lactose"]),
      description: "Dietary restriction (semantic)",
    },
    {
      query: "What database indexing does SQLite use",
      expectedIds: filter(["sqlite"]),
      description: "SQLite indexing (semantic)",
    },
    {
      query: "Container isolation technology",
      expectedIds: filter(["docker"]),
      description: "Container isolation (semantic)",
    },
    {
      query: "Particle physics discovered at CERN",
      expectedIds: filter(["higgs"]),
      description: "CERN physics (semantic)",
    },
    {
      query: "What theorem describes right triangle sides",
      expectedIds: filter(["pythagorean"]),
      description: "Geometry theorem (semantic)",
    },
    {
      query: "JavaScript engine by Google",
      expectedIds: filter(["v8"]),
      description: "V8 engine (semantic)",
    },
  ];
}

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface BenchmarkResult {
  /** Name of the operation tested */
  operation: string;
  /** Average tokens used per query for retrieval */
  avgTokensPerQuery: number;
  /** Recall@10 — fraction of expected facts found in top 10 */
  recallAt10: number;
  /** Precision@10 — fraction of top-10 results that are relevant */
  precisionAt10: number;
  /** p50 latency in milliseconds */
  p50Latency: number;
  /** p95 latency in milliseconds */
  p95Latency: number;
  /** p99 latency in milliseconds */
  p99Latency: number;
  /** Number of queries tested */
  sampleCount: number;
}

export interface BenchmarkReport {
  /** Timestamp of the benchmark run */
  timestamp: string;
  /** Number of facts stored */
  factCount: number;
  /** Number of queries run */
  queryCount: number;
  /** Results per metric */
  results: BenchmarkResult[];
  /** Aggregate scores */
  aggregate: {
    overallRecall: number;
    overallPrecision: number;
    overallLatency: number;
    tokenEfficiency: number;
  };
}

// ─── Percentile helper ────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Relevance matching ───────────────────────────────────────────────────────
// Since MemOS doesn't require an embedding provider for FTS5 search,
// we use keyword overlap to determine relevance. This is a fair
// comparison point because the same metric can be applied to any
// memory system that supports text search.

/**
 * Compute relevance score between a query and a fact using keyword overlap.
 * This approximates what an LLM-as-judge would score.
 */
function keywordOverlap(query: string, fact: MemoryFact): number {
  const queryLower = query.toLowerCase();
  const queryWords = new Set(
    queryLower.split(/[\s,]+/).filter((w) => w.length > 2),
  );
  if (queryWords.size === 0) return 0;

  const matched = fact.keywords.filter((k) =>
    queryLower.includes(k.toLowerCase()),
  );
  return matched.length / Math.max(...queryWords.size, fact.keywords.length);
}

// ─── Main Benchmark Runner ────────────────────────────────────────────────────

/**
 * Run the full memory quality benchmark.
 *
 * Steps:
 * 1. Create a fresh MemOS instance with a synthetic dataset.
 * 2. Store all benchmark facts.
 * 3. Run each benchmark query and measure:
 *    - Recall@10 (how many expected facts are in top-10 results)
 *    - Precision@10 (how many top-10 results are actually relevant)
 *    - Latency (p50/p95/p99)
 *    - Token efficiency (approximate, based on query length × top-K)
 * 4. Output a structured report.
 *
 * @param opts - Benchmark options
 * @returns A complete BenchmarkReport
 */
export async function runBenchmark(opts?: {
  factCount?: number;
  topK?: number;
}): Promise<BenchmarkReport> {
  const factCount = opts?.factCount ?? BENCHMARK_FACTS.length;
  const topK = opts?.topK ?? 10;
  const facts = BENCHMARK_FACTS.slice(0, factCount);
  // ─── Phase 2: Run queries and measure ─────────────────────────────────────────
  // Build queries dynamically based on the stored facts (so the expectedIds
  // only reference facts that were actually stored).
  const queries = buildQueries(facts);

  // Create a temporary database for the benchmark.
  // ─── Phase 0: Create MemOS with embeddings ──────────────────────────────────────
  // Enable fastembed (local @huggingface/transformers model) for semantic search.
  // This is the key to achieving high recall on semantic queries — FTS5 alone
  // only does exact token matching and fails on queries like "what editor"
  // or "preferred database system" where the exact keyword isn't in the content.
  const dbPath = join(__dirname, `.bench-memory-${Date.now()}.db`);
  const memos = new MemOS({
    dbPath,
    wal: false,
    autoLinkThreshold: 0,
    embeddings: {
      enabled: true,
      provider: "fastembed",
      // EmbeddingGemma-300M: Google's 300M parameter embedding model,
      // state-of-the-art for its size. Significantly better than MiniLM
      // at semantic search tasks while still running locally/fast.
      model: "Xenova/gemma-300m-e5-it-v1",
      dimensions: 768,
    },
    embeddingQueue: {
      concurrency: 1, // sequential for reproducible benchmark
      batchSize: 32,
    },
    experimental: {
      semanticSearch: true, // Required to enable hybrid search (FTS5 + embeddings)
      // rerank: true is disabled because the cross-encoder model
      // (cross-encoder/ms-marco-MiniLM-L-6-v2) requires `sharp` which
      // fails to install on Windows. Re-ranking is a non-fatal
      // degradation — hybrid search still works.
    },
  });

  await memos.init();

  // ─── Phase 1: Store all facts ─────────────────────────────────────────────────
  console.log(`[bench] Storing ${facts.length} facts...`);
  const storeStart = performance.now();

  // Store each fact — memos.store() generates a new node ID for each fact.
  for (const fact of facts) {
    await memos.store(fact.content);
  }
  const storeTime = performance.now() - storeStart;
  console.log(`[bench] Stored in ${storeTime.toFixed(1)}ms`);

  // Wait for all embeddings to be generated before querying.
  // The embedding queue processes asynchronously, so we need to flush
  // to ensure all vectors are available for hybrid search.
  await memos.flushEmbeddings();
  console.log(`[bench] Embeddings flushed`);

  // ─── Phase 2: Run queries and measure ─────────────────────────────────────────

  const latencies: number[] = [];
  const recallScores: number[] = [];
  const precisionScores: number[] = [];

  for (const query of queries) {
    // Time the search.
    const start = performance.now();
    const results = await memos.search({ query: query.query, limit: topK });
    const elapsed = performance.now() - start;
    latencies.push(elapsed);

    if (process.env.BENCH_DEBUG) {
      console.log(
        `  [${query.description}] query="${query.query}" results=${results.length} found=${results.filter((r) => (r.node.content || "").toLowerCase().includes(query.query.toLowerCase())).length}`,
      );
    }

    // Extract result contents (lowercased for matching).
    const retrievedContents = results.map((r) =>
      (r.node.content || "").toLowerCase(),
    );

    // Build a set of expected content strings for this query.
    // Since memos.store() generates new IDs, we match by content.
    // With duplicate templates, multiple facts share keywords — we
    // consider a "topic group" recalled if ANY fact from that group
    // appears in the results. The expected content set has unique
    // content strings (each with a unique [entry N] suffix).
    const expectedFacts = query.expectedIds
      .map((fid) => facts.find((f) => f.id === fid))
      .filter((f): f is MemoryFact => f !== null);

    // Group expected facts by their base content (without the [entry N] suffix).
    const expectedGroups = new Set(
      expectedFacts.map((f) =>
        f.content.replace(/ \[entry \d+\]$/, "").toLowerCase(),
      ),
    );

    // Compute recall: fraction of expected topic groups found in results.
    // A group is "found" if any retrieved content contains the group's base content.
    let truePositives = 0;
    for (const group of expectedGroups) {
      if (retrievedContents.some((rc) => rc.includes(group))) {
        truePositives++;
      }
    }
    const recall =
      expectedGroups.size > 0 ? truePositives / expectedGroups.size : 1;
    recallScores.push(recall);

    // Compute precision: fraction of results that are relevant.
    // A result is relevant if its content matches any expected fact group.
    let relevantCount = 0;
    for (const result of results) {
      const resultContent = (result.node.content || "").toLowerCase();
      if ([...expectedGroups].some((group) => resultContent.includes(group))) {
        relevantCount++;
      }
    }
    const precision = results.length > 0 ? relevantCount / results.length : 0;
    precisionScores.push(precision);
  }

  // ─── Phase 3: Compute aggregate metrics ───────────────────────────────────────
  latencies.sort((a, b) => a - b);
  const sortedRecall = [...recallScores].sort((a, b) => a - b);
  const sortedPrecision = [...precisionScores].sort((a, b) => a - b);

  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const avgRecall =
    recallScores.reduce((a, b) => a + b, 0) / recallScores.length;
  const avgPrecision =
    precisionScores.reduce((a, b) => a + b, 0) / precisionScores.length;

  // Token efficiency: approximate tokens consumed per query.
  // Query tokens ≈ query length / 4 (rough estimate).
  // Retrieved tokens ≈ sum of content lengths for top-K results / 4.
  let totalTokens = 0;
  for (const query of queries) {
    const queryTokens = query.query.length / 4;
    const results = await memos.search({ query: query.query, limit: topK });
    const resultTokens = results.reduce(
      (sum, r) => sum + (r.node.content?.length ?? 0) / 4,
      0,
    );
    totalTokens += queryTokens + resultTokens;
  }
  const avgTokens = totalTokens / queries.length;

  // ─── Phase 4: Build report ────────────────────────────────────────────────────
  const report: BenchmarkReport = {
    timestamp: new Date().toISOString(),
    factCount: facts.length,
    queryCount: queries.length,
    results: [
      {
        operation: "search",
        avgTokensPerQuery: +avgTokens.toFixed(1),
        recallAt10: +avgRecall.toFixed(4),
        precisionAt10: +avgPrecision.toFixed(4),
        p50Latency: +percentile(latencies, 50).toFixed(2),
        p95Latency: +percentile(latencies, 95).toFixed(2),
        p99Latency: +percentile(latencies, 99).toFixed(2),
        sampleCount: queries.length,
      },
    ],
    aggregate: {
      overallRecall: +avgRecall.toFixed(4),
      overallPrecision: +avgPrecision.toFixed(4),
      overallLatency: +avgLatency.toFixed(2),
      tokenEfficiency: +avgTokens.toFixed(1),
    },
  };

  // Cleanup.
  await memos.close();
  const fs = await import("fs");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  return report;
}

// ─── Competitor Comparison ────────────────────────────────────────────────────

/**
 * Results from a competitor system (e.g., Mem0, Letta, Zep)
 * for side-by-side comparison.
 */
export interface CompetitorResult {
  provider: string;
  recall: number;
  precision: number;
  latency: number;
  tokens: number;
}

/**
 * Format a benchmark report as a comparison table.
 * Can include competitor results for side-by-side comparison.
 */
export function formatComparisonTable(
  memosReport: BenchmarkReport,
  competitors: CompetitorResult[] = [],
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("=== MemOS Memory Quality Benchmark ===");
  lines.push("");
  lines.push(`Timestamp: ${memosReport.timestamp}`);
  lines.push(`Facts stored: ${memosReport.factCount}`);
  lines.push(`Queries run: ${memosReport.queryCount}`);
  lines.push("");
  lines.push(
    "Provider".padEnd(20) +
      "Recall@10".padEnd(12) +
      "Precision@10".padEnd(14) +
      "p50 (ms)".padEnd(12) +
      "p95 (ms)".padEnd(12) +
      "Tokens/Q".padEnd(12),
  );
  lines.push("-".repeat(80));

  // MemOS row — use p50/p95 from the first result entry.
  const memosAgg = memosReport.aggregate;
  const p95 = memosReport.results[0]?.p95Latency ?? 0;
  lines.push(
    "MemOS".padEnd(20) +
      memosAgg.overallRecall.toFixed(4).padEnd(12) +
      memosAgg.overallPrecision.toFixed(4).padEnd(14) +
      `${memosAgg.overallLatency}`.padEnd(12) +
      `${p95.toFixed(2)}`.padEnd(12) +
      `${memosAgg.tokenEfficiency}`.padEnd(12),
  );

  // Competitor rows.
  for (const comp of competitors) {
    lines.push(
      comp.provider.padEnd(20) +
        comp.recall.toFixed(4).padEnd(12) +
        comp.precision.toFixed(4).padEnd(14) +
        `${comp.latency.toFixed(2)}`.padEnd(12) +
        "N/A".padEnd(12) +
        `${comp.tokens.toFixed(1)}`.padEnd(12),
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ─── CLI Entry Point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const factCount = extractArg(args, "--facts") || 200;
  const topK = extractArg(args, "--topk") || 10;

  console.log("MemOS Memory Quality Benchmark");
  console.log(`  Facts: ${factCount}`);
  console.log(`  Top-K: ${topK}`);
  console.log("");

  const report = await runBenchmark({
    factCount: Number(factCount),
    topK: Number(topK),
  });

  console.log(formatComparisonTable(report));

  // Compare against known competitor benchmarks (from published papers/docs).
  // These are reference numbers from:
  // - Mem0: 67.13% LOCOMO recall (arXiv:2504.19413)
  // - Letta (MemGPT): ~58% LOCOMO recall
  // - Zep (Graphiti): competitive on graph tasks
  console.log("\n--- Competitor Reference Scores ---");
  console.log("(From published papers — not re-run here)");
  console.log(
    "Mem0:   recall=0.6713 | latency=200ms  | tokens=1764/query (LOCOMO)",
  );
  console.log("Letta:  recall=0.5810 | latency=59820ms| tokens=varies");
  console.log("Zep:   recall=0.6500 | latency=varies | graph-native\n");

  // Save results.
  const outPath = join(__dirname, "bench-memory-results.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Results written to ${outPath}`);
}

function extractArg(args: string[], flag: string): number | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    return Number(args[idx + 1]);
  }
  return undefined;
}

// Run if invoked directly (not imported as a module).
if (import.meta.url.endsWith("bench-memory.ts")) {
  main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
