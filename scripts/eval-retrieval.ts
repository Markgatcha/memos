/**
 * Retrieval regression eval — the CI tripwire for ranking changes.
 *
 * Ingests the golden corpus (scripts/eval/corpus.json) into a throwaway
 * SQLite store with the deterministic local-hash embedder, runs every
 * query through the real hybrid pipeline (FTS + semantic + entity fusion
 * + pools), and scores recall@5 + MRR against the expected facts.
 *
 * Modes:
 *   (default)        run; if a baseline exists, compare and FAIL on
 *                    regression; otherwise write the baseline (bootstrap).
 *   --check          run; REQUIRE an existing baseline and fail on
 *                    regression (used by CI).
 *   --write-baseline run; refresh the baseline file (use after an
 *                    intentional, reviewed ranking improvement).
 *
 * A regression is: recall@5 or MRR dropping more than TOLERANCE below the
 * baseline, or recall@5 falling under the ABSOLUTE_FLOOR. The baseline is
 * committed so every PR is judged against the same reference, and the
 * results artifact carries provenance (commit, timestamp, model).
 *
 * @module scripts/eval-retrieval
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { createEmbeddingProvider } from "../src/embeddings";
import type { EmbeddingConfig } from "../src/types";

const SCRIPT_DIR = resolve(import.meta.dirname ?? ".");
const CORPUS_PATH = join(SCRIPT_DIR, "eval", "corpus.json");
const BASELINE_PATH = join(SCRIPT_DIR, "eval", "retrieval-baseline.json");
const RESULTS_PATH = join(SCRIPT_DIR, "eval", "retrieval-results.json");

/** Max tolerated drop vs the baseline (absolute, on the 0–1 metric). */
const TOLERANCE = 0.05;
/** Below this recall@5 the eval fails outright, baseline or not. */
const ABSOLUTE_FLOOR = 0.8;
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

interface EvalQueryResult {
  query: string;
  recall: number;
  mrr: number;
  top5: string[];
}

interface EvalReport {
  recallAt5: number;
  mrr: number;
  queries: number;
  facts: number;
  perQuery: EvalQueryResult[];
  provenance: {
    timestamp: string;
    gitSha: string | null;
    embedder: string;
  };
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function runEval(): Promise<EvalReport> {
  const corpus: Corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
  const provider = createEmbeddingProvider({
    provider: "local-hash",
  } as EmbeddingConfig);

  const workDir = mkdtempSync(join(tmpdir(), "memos-eval-"));
  const memos = new MemOS({
    storage: new SQLiteStorage(join(workDir, "eval.db"), true),
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

    const perQuery: EvalQueryResult[] = [];
    for (const q of corpus.queries) {
      const results = await memos.search({ query: q.query, limit: TOP_K });
      const expectedIds = q.expects
        .map((factId) => {
          const fact = corpus.facts.find((f) => f.id === factId);
          return fact ? idByContent.get(fact.content) : undefined;
        })
        .filter((id): id is string => Boolean(id));

      const rankOfFirst = results.findIndex((r) =>
        expectedIds.includes(r.node.id),
      );
      const found = results.filter((r) =>
        expectedIds.includes(r.node.id),
      ).length;
      perQuery.push({
        query: q.query,
        recall: expectedIds.length > 0 ? found / expectedIds.length : 1,
        mrr: rankOfFirst === -1 ? 0 : 1 / (rankOfFirst + 1),
        top5: results.map((r) => r.node.id.slice(0, 8)),
      });
    }

    const recallAt5 =
      perQuery.reduce((sum, q) => sum + q.recall, 0) / (perQuery.length || 1);
    const mrr =
      perQuery.reduce((sum, q) => sum + q.mrr, 0) / (perQuery.length || 1);

    return {
      recallAt5: Number(recallAt5.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      queries: perQuery.length,
      facts: corpus.facts.length,
      perQuery,
      provenance: {
        timestamp: new Date().toISOString(),
        gitSha: gitSha(),
        embedder: provider.model,
      },
    };
  } finally {
    await memos.close().catch(() => {});
    rmSync(workDir, { recursive: true, force: true });
  }
}

function formatReport(report: EvalReport): string {
  const lines = [
    `retrieval eval — recall@5 ${report.recallAt5} · mrr ${report.mrr} (${report.queries} queries / ${report.facts} facts)`,
  ];
  for (const q of report.perQuery) {
    const flag = q.recall < 1 ? "  MISS" : "      ";
    lines.push(
      `${flag} recall ${q.recall.toFixed(2)} mrr ${q.mrr.toFixed(2)} — ${q.query}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const writeBaseline = args.includes("--write-baseline");

  const report = await runEval();
  console.log(formatReport(report));
  writeFileSync(RESULTS_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  if (writeBaseline || !existsSync(BASELINE_PATH)) {
    if (check && !existsSync(BASELINE_PATH)) {
      console.error(`\n--check requires a baseline at ${BASELINE_PATH}`);
      console.error("Bootstrap it once with: npm run eval:retrieval");
      process.exit(1);
    }
    writeFileSync(
      BASELINE_PATH,
      JSON.stringify(
        {
          recallAt5: report.recallAt5,
          mrr: report.mrr,
          provenance: report.provenance,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    console.log(
      `\nbaseline written: recall@5 ${report.recallAt5} · mrr ${report.mrr} (commit this file)`,
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    recallAt5: number;
    mrr: number;
  };
  const recallFloor = baseline.recallAt5 - TOLERANCE;
  const mrrFloor = baseline.mrr - TOLERANCE;

  const failures: string[] = [];
  if (report.recallAt5 < recallFloor) {
    failures.push(
      `recall@5 ${report.recallAt5} < floor ${recallFloor.toFixed(4)} (baseline ${baseline.recallAt5} − tolerance ${TOLERANCE})`,
    );
  }
  if (report.mrr < mrrFloor) {
    failures.push(
      `mrr ${report.mrr} < floor ${mrrFloor.toFixed(4)} (baseline ${baseline.mrr} − tolerance ${TOLERANCE})`,
    );
  }
  if (report.recallAt5 < ABSOLUTE_FLOOR) {
    failures.push(
      `recall@5 ${report.recallAt5} < absolute floor ${ABSOLUTE_FLOOR}`,
    );
  }

  if (failures.length > 0) {
    console.error("\nRETRIEVAL REGRESSION:");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error(
      "\nIf this regression is intentional and reviewed, refresh the",
    );
    console.error("baseline with: npm run eval:retrieval:baseline");
    process.exit(1);
  }

  console.log(
    `\nPASS — within tolerance of baseline (recall@5 ${baseline.recallAt5}, mrr ${baseline.mrr})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
