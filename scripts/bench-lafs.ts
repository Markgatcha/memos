/**
 * LAFS harness — recall/latency frontier for budgeted retrieval.
 *
 * Runs the committed golden corpus (scripts/eval/corpus.json) at several
 * `budget.maxMs` values and reports, per budget: recall@5, MRR, p50/p95
 * wall-clock latency, mean receipt tokens, tier distribution, and which
 * points sit on the Pareto frontier.
 *
 * Why this exists: LongMemEval-V2 ranks systems by accuracy against
 * latency, not accuracy alone. A single "recall@5" number hides whether it
 * took 2ms or 200ms. This harness makes the trade-off explicit and
 * reproducible.
 *
 * Usage:
 *   node --import tsx scripts/bench-lafs.ts
 *   node --import tsx scripts/bench-lafs.ts --budgets 5,25,50,100,250,0
 *   node --import tsx scripts/bench-lafs.ts --json --out scripts/eval/lafs-results.json
 *
 * Budget 0 means "no budget" (full pipeline). Latency is measured around
 * the whole search call, including embedding and fusion.
 *
 * @module scripts/bench-lafs
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { createEmbeddingProvider } from "../src/embeddings";
import type { EmbeddingConfig } from "../src/types";

const SCRIPT_DIR = resolve(import.meta.dirname ?? ".");
const DEFAULT_CORPUS = join(SCRIPT_DIR, "eval", "corpus.json");
const DEFAULT_BUDGETS = [5, 25, 50, 100, 250, 500, 0];
const TOP_K = 5;

interface CorpusFact {
  id: string;
  content: string;
  pool?: "event" | "note" | "procedure";
  tags?: string[];
}

interface CorpusQuery {
  query: string;
  expects: string[];
}

interface Corpus {
  facts: CorpusFact[];
  queries: CorpusQuery[];
}

interface BudgetRow {
  budgetMs: number | null;
  recallAt5: number;
  mrr: number;
  hitAt1: number;
  p50Ms: number;
  p95Ms: number;
  meanPipelineMs: number;
  meanTokens: number;
  degradedPct: number;
  tiers: Record<string, number>;
  queries: number;
  onFrontier: boolean;
}

interface LafsReport {
  provenance: {
    timestamp: string;
    gitSha: string | null;
    embedder: string;
    corpus: string;
    repeat: number;
  };
  queries: number;
  facts: number;
  rows: BudgetRow[];
  frontierArea: number;
  pareto: Array<{ budgetMs: number | null; recallAt5: number; p50Ms: number }>;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

async function run(
  budgets: number[],
  corpusPath: string,
  repeat: number,
): Promise<LafsReport> {
  const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const provider = createEmbeddingProvider({
    provider: "local-hash",
  } as EmbeddingConfig);

  const workDir = mkdtempSync(join(tmpdir(), "memos-lafs-"));
  const memos = new MemOS({
    storage: new SQLiteStorage(join(workDir, "lafs.db"), true),
    experimental: { semanticSearch: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { synchronous: true },
  });

  try {
    await memos.init();
    const idByContent = new Map<string, string>();
    for (const fact of corpus.facts) {
      const { node } = await memos.store(fact.content, {
        ...(fact.pool ? { pool: fact.pool } : {}),
        ...(fact.tags ? { tags: fact.tags } : {}),
      });
      idByContent.set(fact.content, node.id);
    }
    await memos.flushEmbeddings();

    // Warm every leg once so the first measured call is not paying for
    // lazy vector-cache population or statement preparation.
    for (const q of corpus.queries) {
      await memos.search({ query: q.query, limit: TOP_K });
    }

    const expectedByQuery = corpus.queries.map((q) =>
      q.expects
        .map((factId) => {
          const fact = corpus.facts.find((f) => f.id === factId);
          return fact ? idByContent.get(fact.content) : undefined;
        })
        .filter((id): id is string => Boolean(id)),
    );

    const samples = new Map<
      number,
      Array<{
        recall: number;
        mrr: number;
        hitAt1: number;
        wallMs: number;
        pipelineMs: number;
        tokens: number;
        degraded: boolean;
        tier: number;
      }>
    >();
    for (const budget of budgets) samples.set(budget, []);

    // Rotate budget order per query and repetition so cache warmth is
    // spread evenly instead of favouring whichever budget runs last.
    // `budget: {}` (not omitted) matters for the "no budget" row: a budget
    // object bypasses the query cache, so repeats measure retrieval rather
    // than a cached result array.
    for (let rep = 0; rep < repeat; rep += 1) {
      for (let qi = 0; qi < corpus.queries.length; qi += 1) {
        const q = corpus.queries[qi]!;
        const expectedIds = expectedByQuery[qi]!;
        for (let offset = 0; offset < budgets.length; offset += 1) {
          const budget = budgets[(qi + offset + rep) % budgets.length]!;
          const started = performance.now();
          const { results, receipt } = await memos.searchWithReceipt({
            query: q.query,
            limit: TOP_K,
            budget: budget > 0 ? { maxMs: budget } : {},
          });
          const wallMs = performance.now() - started;
          const rankOfFirst = results.findIndex((r) =>
            expectedIds.includes(r.node.id),
          );
          const found = results.filter((r) =>
            expectedIds.includes(r.node.id),
          ).length;
          samples.get(budget)!.push({
            recall: expectedIds.length > 0 ? found / expectedIds.length : 1,
            mrr: rankOfFirst === -1 ? 0 : 1 / (rankOfFirst + 1),
            hitAt1: rankOfFirst === 0 ? 1 : 0,
            wallMs,
            pipelineMs: receipt.elapsedMs,
            tokens: receipt.estimatedTokens,
            degraded: receipt.degraded,
            tier: receipt.tier,
          });
        }
      }
    }

    const rows: BudgetRow[] = budgets.map((budget) => {
      const list = samples.get(budget)!;
      const tiers: Record<string, number> = {};
      for (const sample of list) {
        const key = String(sample.tier);
        tiers[key] = (tiers[key] ?? 0) + 1;
      }
      const mean = (pick: (s: (typeof list)[number]) => number): number =>
        list.reduce((sum, s) => sum + pick(s), 0) / (list.length || 1);
      return {
        budgetMs: budget > 0 ? budget : null,
        recallAt5: round(
          mean((s) => s.recall),
          4,
        ),
        mrr: round(
          mean((s) => s.mrr),
          4,
        ),
        hitAt1: round(
          mean((s) => s.hitAt1),
          4,
        ),
        p50Ms: round(
          percentile(
            list.map((s) => s.wallMs),
            50,
          ),
        ),
        p95Ms: round(
          percentile(
            list.map((s) => s.wallMs),
            95,
          ),
        ),
        meanPipelineMs: round(mean((s) => s.pipelineMs)),
        meanTokens: round(
          mean((s) => s.tokens),
          1,
        ),
        degradedPct: round(mean((s) => (s.degraded ? 1 : 0)) * 100, 1),
        tiers,
        queries: list.length,
        onFrontier: false,
      };
    });

    // Pareto frontier over (latency, recall): keep points not dominated by
    // another point with >= recall and <= p50.
    for (const row of rows) {
      row.onFrontier = !rows.some(
        (other) =>
          other !== row &&
          other.recallAt5 >= row.recallAt5 &&
          other.p50Ms <= row.p50Ms &&
          (other.recallAt5 > row.recallAt5 || other.p50Ms < row.p50Ms),
      );
    }
    const frontier = rows
      .filter((row) => row.onFrontier)
      .sort((a, b) => a.p50Ms - b.p50Ms);

    // Normalized area under the frontier in log-latency space. This is a
    // harness convenience, not the official LongMemEval-V2 LAFS number.
    let frontierArea = 0;
    if (frontier.length >= 2) {
      const xs = frontier.map((row) => Math.log10(1 + row.p50Ms));
      const span = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0);
      if (span > 0) {
        for (let i = 1; i < frontier.length; i += 1) {
          const dx = xs[i]! - xs[i - 1]!;
          const y0 = frontier[i - 1]!.recallAt5;
          const y1 = frontier[i]!.recallAt5;
          frontierArea += dx * ((y0 + y1) / 2);
        }
        frontierArea /= span;
      }
    } else {
      frontierArea = frontier[0]?.recallAt5 ?? 0;
    }

    return {
      provenance: {
        timestamp: new Date().toISOString(),
        gitSha: gitSha(),
        embedder: provider.model,
        corpus: corpusPath,
        repeat,
      },
      queries: corpus.queries.length,
      facts: corpus.facts.length,
      rows,
      frontierArea: round(frontierArea, 4),
      pareto: frontier.map((row) => ({
        budgetMs: row.budgetMs,
        recallAt5: row.recallAt5,
        p50Ms: row.p50Ms,
      })),
    };
  } finally {
    await memos.close().catch(() => {});
    rmSync(workDir, { recursive: true, force: true });
  }
}

function formatReport(report: LafsReport): string {
  const lines: string[] = [
    `LAFS harness — ${report.queries} queries / ${report.facts} facts · ${report.provenance.embedder} · ${report.provenance.repeat}× · ${report.provenance.gitSha ?? "no-git"}`,
    "",
    "| budget | tier(s) | recall@5 | mrr | hit@1 | p50 ms | p95 ms | pipe p50 | tokens | degraded | frontier |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |",
  ];
  for (const row of report.rows) {
    const tierText = Object.entries(row.tiers)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([tier, count]) => `${tier}×${count}`)
      .join(", ");
    lines.push(
      `| ${row.budgetMs === null ? "none" : `${row.budgetMs}ms`} | ${tierText} | ${row.recallAt5.toFixed(4)} | ${row.mrr.toFixed(4)} | ${row.hitAt1.toFixed(3)} | ${row.p50Ms} | ${row.p95Ms} | ${row.meanPipelineMs} | ${row.meanTokens} | ${row.degradedPct}% | ${row.onFrontier ? "yes" : ""} |`,
    );
  }
  lines.push(
    "",
    `Frontier area (AUF, log-latency): ${report.frontierArea.toFixed(4)}`,
  );
  lines.push(
    "Notes: budget 0 = unbudgeted. Latency is wall-clock around searchWithReceipt, medians over repeated runs.",
  );
  lines.push(
    "AUF is this harness's summary of the frontier, not the official LongMemEval-V2 LAFS metric.",
  );
  return lines.join("\n");
}

function parseArgs(argv: string[]): {
  budgets: number[];
  corpus: string;
  json: boolean;
  out?: string;
  repeat: number;
} {
  const budgetsArg = argv
    .find((arg) => arg.startsWith("--budgets="))
    ?.split("=")[1];
  const budgets = budgetsArg
    ? budgetsArg
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value) && value >= 0)
    : DEFAULT_BUDGETS;
  const corpusArg = argv
    .find((arg) => arg.startsWith("--corpus="))
    ?.split("=")[1];
  const outArg = argv.find((arg) => arg.startsWith("--out="))?.split("=")[1];
  const repeatArg = argv
    .find((arg) => arg.startsWith("--repeat="))
    ?.split("=")[1];
  const parsedRepeat = repeatArg ? Number.parseInt(repeatArg, 10) : 3;
  const repeat =
    Number.isFinite(parsedRepeat) && parsedRepeat > 0
      ? Math.min(20, parsedRepeat)
      : 3;
  return {
    budgets: budgets.length > 0 ? budgets : DEFAULT_BUDGETS,
    corpus: corpusArg ? resolve(corpusArg) : DEFAULT_CORPUS,
    json: argv.includes("--json"),
    out: outArg ? resolve(outArg) : undefined,
    repeat,
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: node --import tsx scripts/bench-lafs.ts [--budgets=5,25,50,100,250,0] [--repeat=3] [--corpus=<path>] [--json] [--out=<path>]",
    );
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const report = await run(args.budgets, args.corpus, args.repeat);
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(
    args.json ? JSON.stringify(report, null, 2) : formatReport(report),
  );
}

await main();
