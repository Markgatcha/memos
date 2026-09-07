#!/usr/bin/env npx tsx
/**
 * ─── HotPotQA multi-hop retrieval benchmark (retrieval-only, no LLM) ─────────
 *
 * HotPotQA distractor (validation split) is a standard multi-hop retrieval
 * test used by comparable memory/RAG systems (e.g. Cognee's published
 * evals). Each question has exactly 2 supporting Wikipedia paragraphs
 * hidden in a pool of ~10 hard distractors; MemOS is scored on retrieving
 * the SUPPORTING PARAGRAPHS by title with deterministic ID matching:
 *
 *   - Ingest every paragraph in the dataset ONCE (deduplicated by title,
 *     ~4.9k paragraphs for a 500-question slice) as memories with
 *     `metadata.hotpot_title`.
 *   - Query with the raw question; retrieved titles vs gold titles.
 *   - Metrics (via the shared bench-metrics module): Hit@K, Evidence
 *     Recall@K, All-Evidence Recall@K (both gold paragraphs — the multi-hop
 *     bar), Precision@K, MRR, nDCG@K, per-type breakdown
 *     (bridge vs comparison) and p50/p95 latency.
 *
 * Dataset: fetched from the HuggingFace datasets-server API
 * (hotpotqa/hotpot_qa, distractor, validation). Saved at
 * scripts/dataset/hotpotqa/hotpot_dev_distractor_500.json — CC BY-SA.
 *
 * Usage:
 *   npx tsx scripts/bench-hotpot.ts --provider=openai-compatible \
 *       --base-url=http://127.0.0.1:8080/v1 --model=LFM2.5-Embedding-350M-BF16 \
 *       --dimensions=1024 --query-prefix="query: " --document-prefix="document: " \
 *       [--rerank-url=http://127.0.0.1:8081 --rerank-candidates=200 --candidate-depth=200]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MemOS } from "../src/memory.ts";
import { SQLiteStorage } from "../src/storage/sqlite.ts";
import {
  parseProviderArgs,
  parseRetrievalArgs,
  buildProvider,
  assertNoFallback,
  benchMetadata,
  retrievalConfig,
} from "./lib/bench-common.ts";
import {
  aggregateMetrics,
  dedupeRankedIds,
  type EvalQueryResult,
} from "./lib/bench-metrics.ts";

// ─── Dataset shape (HuggingFace rows format) ─────────────────────────────────

interface HotpotRow {
  id: string;
  question: string;
  answer: string;
  type: string; // "bridge" | "comparison"
  level: string;
  supporting_facts: { title: string[]; sent_id: number[] };
  context: {
    title: string[];
    sentences: string[][];
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const datasetPath =
    argv.find((a) => a.startsWith("--dataset="))?.split("=")[1] ??
    join(here, "dataset/hotpotqa/hotpot_dev_distractor_500.json");
  if (!existsSync(datasetPath)) {
    console.error(
      `HotPotQA slice not found at ${datasetPath}.\n` +
        `Fetch it with the HuggingFace datasets-server API (see file header).`,
    );
    process.exit(1);
  }
  const topK =
    parseInt(
      argv.find((a) => a.startsWith("--topk="))?.split("=")[1] ?? "10",
      10,
    ) || 10;
  const maxQuestionsArg = argv.find((a) => a.startsWith("--max-questions="));
  const maxQuestions = maxQuestionsArg
    ? parseInt(maxQuestionsArg.split("=")[1] ?? "0", 10)
    : 0;
  const depthArg = argv.find((a) => a.startsWith("--candidate-depth="));
  const candidateDepth = depthArg
    ? parseInt(depthArg.split("=")[1] ?? "", 10)
    : undefined;
  const rerankUrl = argv
    .find((a) => a.startsWith("--rerank-url="))
    ?.split("=")[1];
  const rerankTimeoutArg = argv.find((a) => a.startsWith("--rerank-timeout="));

  const rows: HotpotRow[] = JSON.parse(readFileSync(datasetPath, "utf8"));
  const questions = maxQuestions > 0 ? rows.slice(0, maxQuestions) : rows;

  const providerArgs = parseProviderArgs(argv);
  const retrievalArgs = parseRetrievalArgs(argv);
  const provider = buildProvider(providerArgs);
  const runtimeInfo = await assertNoFallback(provider, providerArgs);

  const dbPath = join(tmpdir(), `bench-hotpot-${Date.now()}.db`);
  const memos = new MemOS({
    dbPath,
    wal: false,
    autoLinkThreshold: 0,
    experimental: {
      namespaces: true,
      semanticSearch: true,
      ...(rerankUrl
        ? {
            rerank: {
              endpoint: rerankUrl,
              ...(rerankTimeoutArg
                ? {
                    timeoutMs: parseInt(
                      rerankTimeoutArg.split("=")[1] ?? "5000",
                      10,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    },
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
      ...(retrievalArgs.embedText
        ? { embedText: retrievalArgs.embedText }
        : {}),
    },
    ...(Object.keys(retrievalConfig(retrievalArgs)).length > 0
      ? retrievalConfig(retrievalArgs)
      : {}),
    embeddingQueue: { concurrency: 4, batchSize: 16, maxQueueSize: 60_000 },
  });

  await memos.init();

  const namespace = "hotpotqa";
  const evalQueries: EvalQueryResult[] = [];
  const benchStart = Date.now();
  let ingestionMs = 0;

  try {
    // ── Ingestion: one memory per DISTINCT paragraph title ──
    const ingestStart = Date.now();
    const paragraphTitles = new Set<string>();
    for (const row of rows) {
      for (const title of row.context.title) paragraphTitles.add(title);
    }
    let stored = 0;
    for (const row of rows) {
      const titles = row.context.title;
      const sentences = row.context.sentences;
      for (let p = 0; p < titles.length; p += 1) {
        const title = titles[p];
        if (paragraphTitles.has(title)) {
          paragraphTitles.delete(title); // first occurrence wins; store once
        } else {
          continue;
        }
        const content = `${title}: ${(sentences[p] ?? []).join(" ")}`;
        await memos.store(content, {
          type: "fact",
          namespace,
          metadata: { hotpot_title: title, benchmark: "hotpotqa" },
        });
        stored += 1;
      }
    }
    await memos.flushEmbeddings();
    ingestionMs = Date.now() - ingestStart;
    console.log(
      `[hotpot] ingested ${stored} distinct paragraphs (${paragraphTitles.size} unique), ${questions.length} questions`,
    );

    // ── Retrieval: title-ID matching ──
    for (const [i, row] of questions.entries()) {
      const start = Date.now();
      const results = await memos.search({
        query: row.question,
        limit: topK,
        namespace,
        ...(candidateDepth ? { candidateDepth } : {}),
        ...(retrievalArgs.ftsOperator
          ? { ftsOperator: retrievalArgs.ftsOperator }
          : {}),
        ...(retrievalArgs.sessionExpansion ? { sessionExpansion: true } : {}),
      });
      const elapsed = Date.now() - start;

      const retrievedIds = dedupeRankedIds(
        results
          .map((r) => String(r.node.metadata?.hotpot_title ?? ""))
          .filter(Boolean),
      );
      // Gold = distinct supporting-fact titles that exist in this row's
      // context (malformed entries stay in the denominator, unmatchable).
      const relevantIds = [...new Set(row.supporting_facts.title)].filter(
        (t) => typeof t === "string" && t.length > 0,
      );

      evalQueries.push({
        questionId: row.id || `hotpot_q${i}`,
        relevantIds,
        retrievedIds,
        category: row.type === "comparison" ? "comparison" : "bridge",
        latencyMs: elapsed,
      });

      if ((i + 1) % 100 === 0) {
        console.log(`[hotpot] ${i + 1}/${questions.length} questions scored`);
      }
    }
  } finally {
    await memos.close();
  }

  // ── Score ──
  const report = aggregateMetrics(evalQueries);
  const durationMs = Date.now() - benchStart;

  const outPath = join(here, "bench-hotpot-results.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...benchMetadata(
          providerArgs,
          runtimeInfo,
          {
            name: "hotpotqa-distractor-500",
            path: datasetPath,
          },
          retrievalArgs,
        ),
        benchmark: "hotpotqa-retrieval-only",
        questions: evalQueries.length,
        topK,
        retrieval: {
          candidateDepth: candidateDepth ?? Math.max(topK * 4, 20),
          keywordWeight: retrievalArgs.fusion.keywordWeight ?? 0.8,
          semanticWeight: retrievalArgs.fusion.semanticWeight ?? 0.2,
          rrfK: retrievalArgs.fusion.rrfK ?? 60,
          rerank: rerankUrl ?? null,
          sessionExpansion: retrievalArgs.sessionExpansion,
          embedText: retrievalArgs.embedText ?? "summary+content",
        },
        durationMs,
        ingestionMs,
        metrics: { at5: report.at5, at10: report.at10 },
        perCategory: report.perCategory,
      },
      null,
      2,
    ),
  );

  console.log(`\n=== HotPotQA Retrieval-Only Results (title-ID matching) ===`);
  const fmt = (v: number): string => `${(v * 100).toFixed(1)}%`;
  console.log(
    `Hit@5 ${fmt(report.at5.hitRate)} | EvRec@5 ${fmt(report.at5.evidenceRecall)} | AllEv@5 ${fmt(report.at5.allEvidenceRecall)} | MRR ${report.at5.mrr.toFixed(3)}`,
  );
  console.log(
    `Hit@10 ${fmt(report.at10.hitRate)} | EvRec@10 ${fmt(report.at10.evidenceRecall)} | AllEv@10 ${fmt(report.at10.allEvidenceRecall)} | MRR ${report.at10.mrr.toFixed(3)} | nDCG@10 ${report.at10.ndcg.toFixed(3)}`,
  );
  console.log(`\nPer type (@10):`);
  for (const [cat, row] of Object.entries(report.perCategory)) {
    console.log(
      `  ${cat.padEnd(12)} Qs ${String(row.questionCount).padStart(4)}  Hit ${fmt(row.hitAt10)}  EvRec ${fmt(row.evidenceRecallAt10)}  AllEv ${fmt(row.allEvidenceRecallAt10)}  MRR ${row.mrr.toFixed(3)}`,
    );
  }
  console.log(`\nResults saved to ${outPath}`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
