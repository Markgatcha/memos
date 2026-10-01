#!/usr/bin/env npx tsx
/**
 * LongMemEval retrieve-only A/B: baseline vs local cross-encoder rerank.
 *
 * Ingests ONCE, then runs the same 500 questions twice against the same DB:
 *   Pass A — fused hybrid ranking (no rerank; the honest baseline)
 *   Pass B — MEMOS_RERANK_LOCAL=1 (local MiniLM cross-encoder over top-50)
 *
 * Same MemOS config, same storeSessions ingestion, same search params as
 * scripts/bench-longmemeval.ts --retrieve-only. The ONLY difference between
 * passes is the rerank stage, so the delta is attributable to reranking.
 *
 * Usage:
 *   TMPDIR=~/workspace/tmp npx tsx scripts/bench-longmemeval-rerank-compare.ts \
 *     --topk=10 --max-questions=500
 */

import { MemOS } from "../src/memory.ts";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseProviderArgs,
  buildProvider,
  assertNoFallback,
  benchMetadata,
} from "./lib/bench-common.ts";
import {
  aggregateMetrics,
  dedupeRankedIds,
  type EvalQueryResult,
} from "./lib/bench-metrics.ts";
import { readFileSync } from "fs";

interface LongMemEvalQuestion {
  question_id: string;
  question: string;
  question_type: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_sessions: string[][][];
  haystack_session_ids: string[];
  haystack_dates: string[];
}

async function storeSessions(
  memos: MemOS,
  q: LongMemEvalQuestion,
): Promise<number> {
  let memoryCount = 0;
  for (const [position, session] of q.haystack_sessions.entries()) {
    if (!Array.isArray(session) || session.length === 0) continue;
    const content = session
      .map((msg: any) => `${msg.role}: ${msg.content}`)
      .join("\n");
    await memos.store(content, {
      namespace: `longmemeval_${q.question_id}`,
      metadata: {
        qid: q.question_id,
        type: "haystack_session",
        benchmark: "longmemeval",
        instanceId: `longmemeval_${q.question_id}`,
        sessionId: q.haystack_session_ids[position] ?? `session_${position}`,
        timestamp: q.haystack_dates[position] ?? "",
        questionDate: q.question_date,
        position,
      },
    });
    memoryCount++;
  }
  return memoryCount;
}

async function runPass(
  memos: MemOS,
  questions: LongMemEvalQuestion[],
  topK: number,
  candidateDepth: number | undefined,
  label: string,
): Promise<EvalQueryResult[]> {
  const out: EvalQueryResult[] = [];
  for (const [i, q] of questions.entries()) {
    const namespace = `longmemeval_${q.question_id}`;
    const startTime = Date.now();
    const results = await memos.search({
      query: q.question,
      limit: topK,
      namespace,
      ...(candidateDepth ? { candidateDepth } : {}),
    });
    const elapsed = Date.now() - startTime;
    const retrievedIds = dedupeRankedIds(
      results
        .map((r) => String((r.node.metadata as any)?.sessionId ?? ""))
        .filter(Boolean),
    );
    out.push({
      questionId: q.question_id,
      relevantIds: (q.answer_session_ids ?? []).filter(
        (s) => typeof s === "string" && s.length > 0,
      ),
      retrievedIds,
      category: q.question_type,
      latencyMs: elapsed,
    });
    if ((i + 1) % 50 === 0) {
      console.log(`  [${label}] ${i + 1}/${questions.length} questions`);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const topK = Number(
    args.find((a) => a.startsWith("--topk="))?.split("=")[1] ?? 10,
  );
  const maxQ = Number(
    args.find((a) => a.startsWith("--max-questions="))?.split("=")[1] ?? 500,
  );
  const candidateDepthArg = args.find((a) =>
    a.startsWith("--candidate-depth="),
  );
  const candidateDepth = candidateDepthArg
    ? Number(candidateDepthArg.split("=")[1])
    : undefined;

  const providerArgs = parseProviderArgs(args);
  const provider = buildProvider(providerArgs);
  const runtimeInfo = await assertNoFallback(provider, providerArgs);

  const datasetPath =
    args.find((a) => a.startsWith("--dataset="))?.split("=")[1] ??
    "scripts/dataset/longmemeval/longmemeval_s.json";
  const all: LongMemEvalQuestion[] = JSON.parse(
    readFileSync(datasetPath, "utf8"),
  );
  const limited = all.slice(0, maxQ);
  console.log(
    `[rerank-compare] Loaded ${limited.length}/${all.length} questions`,
  );

  const dbPath = join(tmpdir(), `bench-longmemeval-cmp-${Date.now()}.db`);
  const memos = new MemOS({
    dbPath,
    wal: false,
    autoLinkThreshold: 0,
    experimental: { namespaces: true, semanticSearch: true },
    embeddings: {
      enabled: true,
      provider,
      ...(providerArgs.model ? { model: providerArgs.model } : {}),
      ...(providerArgs.dimensions
        ? { dimensions: providerArgs.dimensions }
        : {}),
    },
    embeddingQueue: { concurrency: 4, batchSize: 16, maxQueueSize: 60000 },
  });
  await memos.init();

  // ─── Ingest once ───
  const storeStart = Date.now();
  let totalMemories = 0;
  for (const [i, q] of limited.entries()) {
    totalMemories += await storeSessions(memos, q);
    if ((i + 1) % 50 === 0) {
      await memos.flushEmbeddings();
      console.log(
        `  Stored ${i + 1}/${limited.length} questions, ${totalMemories} memories`,
      );
    }
  }
  await memos.flushEmbeddings();
  console.log(
    `[rerank-compare] Stored ${totalMemories} memories in ${Date.now() - storeStart}ms`,
  );

  // ─── Pass A: baseline (no rerank) ───
  delete process.env.MEMOS_RERANK_LOCAL;
  console.log("[rerank-compare] Pass A: fused ranking (no rerank)");
  const passA = await runPass(memos, limited, topK, candidateDepth, "A");

  // ─── Pass B: local cross-encoder rerank ───
  process.env.MEMOS_RERANK_LOCAL = "1";
  console.log("[rerank-compare] Pass B: local cross-encoder rerank");
  const passB = await runPass(memos, limited, topK, candidateDepth, "B");
  delete process.env.MEMOS_RERANK_LOCAL;

  await memos.close();

  const reportA = aggregateMetrics(passA);
  const reportB = aggregateMetrics(passB);

  const summary = (label: string, r: typeof reportA) => {
    const lines = [`--- ${label} ---`];
    for (const k of ["at5", "at10"] as const) {
      const m = r[k];
      lines.push(
        `${k}: hit=${m.hitRate.toFixed(4)} evRec=${m.evidenceRecall.toFixed(4)} ` +
          `allEvRec=${m.allEvidenceRecall.toFixed(4)} mrr=${m.mrr.toFixed(4)} ndcg=${m.ndcg.toFixed(4)}`,
      );
    }
    const lat = r.latency;
    lines.push(
      `latency ms: p50=${lat.p50.toFixed(0)} p95=${lat.p95.toFixed(0)} mean=${lat.mean.toFixed(0)}`,
    );
    return lines.join("\n");
  };
  console.log(summary("PASS A (baseline, no rerank)", reportA));
  console.log(summary("PASS B (local rerank)", reportB));

  const outPath = "scripts/bench-longmemeval-rerank-compare.json";
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...benchMetadata(providerArgs, runtimeInfo, {
          name: "longmemeval_s",
          path: datasetPath,
        }),
        benchmark: "longmemeval-rerank-compare",
        mode: "retrieval-only",
        questions: limited.length,
        topK,
        candidateDepth: candidateDepth ?? Math.max(topK * 4, 20),
        rerankModel: "Xenova/ms-marco-MiniLM-L-6-v2 (q8, local)",
        passA: {
          report: reportA,
          perQuestion: passA,
        },
        passB: {
          report: reportB,
          perQuestion: passB,
        },
      },
      null,
      1,
    ),
  );
  console.log(`[rerank-compare] wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
