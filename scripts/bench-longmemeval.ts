#!/usr/bin/env npx tsx
/**
 * ─── LongMemEval Benchmark for MemOS ──────────────────────────────────────────
 *
 * Runs the LongMemEval benchmark (xiaowu0162/longmemeval) against MemOS.
 *
 * Two modes:
 *   --retrieve-only (no API key): scores retrieval by DIRECT session-ID
 *     comparison — retrieved memories' `sessionId` metadata vs the official
 *     `answer_session_ids`. Deterministic metrics (Hit@K, Evidence Recall@K,
 *     All-Evidence Recall@K, Precision@K, MRR, nDCG@K) via the shared
 *     metrics module. No LLM anywhere.
 *   default (requires OPENAI_API_KEY): retrieves evidence, answers with an
 *     LLM, and judges with an LLM (the same methodology Mem0/Zep publish).
 *     Clearly labeled LLM-judge numbers — never compare them to
 *     retrieval-only scores.
 *
 * Ingestion fix (v2): every haystack session is stored with its OWN
 * `haystack_dates[i]` timestamp, `sessionId`, chronological position,
 * and the question date — NOT the question date as the session
 * timestamp (the v1 bug that made every session appear to occur at
 * question time and destroyed temporal ordering).
 *
 * Results are written to scripts/bench-longmemeval-results.json — a
 * SEPARATE file from the LoCoMo results (they previously overwrote each
 * other).
 *
 * Usage:
 *   npx tsx scripts/bench-longmemeval.ts --topk=10 --max-questions=30 --retrieve-only
 *   npx tsx scripts/bench-longmemeval.ts --topk=10 --max-questions=30
 *
 * Provider flags: see scripts/lib/bench-common.ts (parseProviderArgs).
 *
 * Prerequisites:
 *   git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git scripts/dataset/longmemeval
 *   (then place longmemeval_s.json under scripts/dataset/longmemeval/)
 *   LLM mode: set OPENAI_API_KEY (+ optional OPENAI_BASE_URL,
 *   BENCH_ANSWER_MODEL, BENCH_JUDGE_MODEL).
 */

import { MemOS } from "../src/memory.ts";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseProviderArgs,
  buildProvider,
  assertNoFallback,
  benchMetadata,
  type BenchProviderArgs,
} from "./lib/bench-common.ts";
import type { EmbeddingRuntimeInfo } from "../src/types.ts";
import {
  aggregateMetrics,
  dedupeRankedIds,
  type EvalQueryResult,
  type MetricsReport,
} from "./lib/bench-metrics.ts";

// ─── LLM helpers (optional end-to-end mode) ──────────────────────────────────

const B_AI_API_KEY = process.env.OPENAI_API_KEY || "";
const B_AI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://router.bynara.id/v1";
const ANSWER_MODEL = process.env.BENCH_ANSWER_MODEL || "agnes-2.0-flash";
const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || "agnes-2.0-flash";

async function callLLM(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 256,
  maxRetries: number = 3,
): Promise<string> {
  if (!B_AI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. " +
        "For retrieval-only scoring (no API), pass --retrieve-only.",
    );
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(`${B_AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${B_AI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: maxTokens,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const errMsg = errText.substring(0, 200);
      if (
        (resp.status === 429 || resp.status === 402 || resp.status === 403) &&
        attempt < maxRetries
      ) {
        const delay = Math.pow(2, attempt) * 2000;
        console.error(
          `[bench-longmemeval] API error ${resp.status}, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
      }>;
    };
    const choice = data.choices?.[0]?.message;
    return (choice?.content || choice?.reasoning_content || "").trim();
  }

  throw new Error("Max retries exceeded");
}

async function answerQuestion(
  question: string,
  memories: Array<{ content: string; timestamp: string }>,
): Promise<string> {
  const memoryContext = memories
    .map((m, i) => `${i + 1}. [${m.timestamp}] ${m.content}`)
    .join("\n");

  const prompt = `You are an intelligent memory assistant. Given the following conversation memories, answer the question concisely.

Memories:
${memoryContext}

Question: ${question}

Answer (be concise, 1-5 words if possible):`;

  try {
    return await callLLM(
      ANSWER_MODEL,
      [{ role: "user", content: prompt }],
      256,
    );
  } catch (e) {
    console.error(
      `[bench-longmemeval] Answer error: ${String(e).substring(0, 100)}`,
    );
    return "";
  }
}

async function judgeAnswer(
  question: string,
  groundTruth: string,
  predicted: string,
): Promise<number> {
  const prompt = `You are an impartial judge evaluating whether an AI system correctly answered a question based on retrieved memories.

Question: ${question}

Ground truth answer: ${groundTruth}

Predicted answer: ${predicted}

Does the predicted answer correctly answer the question and match the ground truth? Consider semantic equivalence, not exact string matching. If the predicted answer is empty, return 0.
Score: 1 if the predicted answer is correct (matches or is a valid paraphrase of the ground truth), 0 if incorrect.
Only output a single digit: 1 or 0.`;

  try {
    const text = await callLLM(
      JUDGE_MODEL,
      [{ role: "user", content: prompt }],
      256,
    );
    const match = text.match(/[01]/);
    return match ? parseInt(match[0] ?? "0", 10) : 0;
  } catch (e) {
    console.error(
      `[bench-longmemeval] Judge error: ${String(e).substring(0, 100)}`,
    );
    return 0;
  }
}

// ─── Dataset types ────────────────────────────────────────────────────────────

interface LongMemEvalQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
  answer_session_ids: string[];
}

function loadLongMemEval(path: string): LongMemEvalQuestion[] {
  if (!existsSync(path)) {
    throw new Error(
      `LongMemEval dataset not found at ${path}. Download it first:\n` +
        `  git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git scripts/dataset/longmemeval`,
    );
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(data) ? data : Object.values(data);
}

/**
 * Store LongMemEval haystack sessions as MemOS memories.
 *
 * Every session carries its OWN metadata:
 *   - sessionId  — the official haystack_session_ids[i] (used for
 *     evidence-ID scoring against answer_session_ids)
 *   - timestamp  — the session's OWN haystack_dates[i] date (NOT the
 *     question date — that destroyed temporal ordering before)
 *   - questionDate, chronological position, benchmark instance id
 */
async function storeSessions(
  memos: MemOS,
  q: LongMemEvalQuestion,
): Promise<number> {
  let memoryCount = 0;

  for (const [position, session] of q.haystack_sessions.entries()) {
    if (!Array.isArray(session) || session.length === 0) continue;

    const content = session
      .map((msg) => `${msg.role}: ${msg.content}`)
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Two-stage reranking + candidate-depth ablation flags.
  const depthArg = args.find((a) => a.startsWith("--candidate-depth="));
  const candidateDepth = depthArg
    ? parseInt(depthArg.split("=")[1] ?? "", 10)
    : undefined;
  const rerankUrl = args
    .find((a) => a.startsWith("--rerank-url="))
    ?.split("=")[1];
  const rerankModelArg = args.find((a) => a.startsWith("--rerank-model="));
  const topK =
    parseInt(
      args.find((a) => a.startsWith("--topk="))?.split("=")[1] ?? "10",
      10,
    ) || 10;
  const maxQuestionsArg = args.find((a) => a.startsWith("--max-questions="));
  const maxQuestions = maxQuestionsArg
    ? parseInt(maxQuestionsArg.split("=")[1] ?? "0", 10)
    : undefined;
  const retrieveOnly = args.includes("--retrieve-only") || !B_AI_API_KEY;
  const delayMs = args.find((a) => a.startsWith("--delay="))
    ? parseInt(
        args.find((a) => a.startsWith("--delay="))!.split("=")[1] ?? "0",
        10,
      )
    : 0;

  const providerArgs: BenchProviderArgs = parseProviderArgs(args);
  const datasetPath =
    args.find((a) => a.startsWith("--dataset="))?.split("=")[1] ??
    "scripts/dataset/longmemeval/longmemeval_s.json";

  const questions = loadLongMemEval(datasetPath);
  const limited = maxQuestions ? questions.slice(0, maxQuestions) : questions;

  console.log(
    `[bench-longmemeval] Loaded ${limited.length}/${questions.length} questions | mode: ${retrieveOnly ? "retrieval-only (deterministic session-ID scoring)" : "LLM answer + judge"}`,
  );

  const provider = buildProvider(providerArgs);
  const runtimeInfo = await assertNoFallback(provider, providerArgs);

  const dbPath = join(tmpdir(), `bench-longmemeval-${Date.now()}.db`);
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
              ...(rerankModelArg
                ? { model: rerankModelArg.split("=")[1] }
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
    },
    embeddingQueue: { concurrency: 4, batchSize: 16, maxQueueSize: 60000 },
  });

  await memos.init();

  // ─── Phase 1: Store sessions (per-question namespace) ───────────────────
  const storeStart = Date.now();
  let totalMemories = 0;
  for (const [i, q] of limited.entries()) {
    totalMemories += await storeSessions(memos, q);
    if ((i + 1) % 10 === 0) {
      await memos.flushEmbeddings();
      console.log(
        `  Stored ${i + 1}/${limited.length} questions, ${totalMemories} memories`,
      );
    }
  }
  await memos.flushEmbeddings();
  const ingestionMs = Date.now() - storeStart;
  console.log(
    `[bench-longmemeval] Stored ${totalMemories} memories in ${ingestionMs}ms`,
  );

  // ─── Phase 2: Retrieval (+ optional LLM answer/judge) ──────────────────
  const benchStart = Date.now();
  const evalQueries: EvalQueryResult[] = [];
  const llmScores: Array<{
    questionId: string;
    category: string;
    score: number;
  }> = [];

  for (const [i, q] of limited.entries()) {
    const namespace = `longmemeval_${q.question_id}`;
    const startTime = Date.now();
    const results = await memos.search({
      query: q.question,
      limit: topK,
      namespace,
      ...(candidateDepth ? { candidateDepth } : {}),
    });
    const elapsed = Date.now() - startTime;

    // Direct session-ID comparison (deterministic, always computed —
    // independent of whether the LLM path also runs).
    const retrievedIds = dedupeRankedIds(
      results
        .map((r) => String(r.node.metadata?.sessionId ?? ""))
        .filter(Boolean),
    );
    evalQueries.push({
      questionId: q.question_id,
      relevantIds: (q.answer_session_ids ?? []).filter(
        (s) => typeof s === "string" && s.length > 0,
      ),
      retrievedIds,
      category: q.question_type,
      latencyMs: elapsed,
    });

    if (!retrieveOnly) {
      const memoryObjs = results.map((r) => ({
        content: r.node.content ?? "",
        timestamp: String(r.node.metadata?.timestamp ?? "unknown"),
      }));
      const predicted = await answerQuestion(q.question, memoryObjs);
      const score = await judgeAnswer(q.question, q.answer, predicted);
      llmScores.push({
        questionId: q.question_id,
        category: q.question_type,
        score,
      });

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }

    if ((i + 1) % 10 === 0) {
      console.log(`  Processed ${i + 1}/${limited.length} questions`);
    }
  }

  await memos.close();
  if (existsSync(dbPath)) unlinkSync(dbPath);
  for (const ext of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${ext}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  // ─── Phase 3: Score & report ────────────────────────────────────────────
  const report = aggregateMetrics(evalQueries);
  const durationMs = Date.now() - benchStart;
  printReport(report, {
    retrieveOnly,
    topK,
    durationMs,
    ingestionMs,
    providerArgs,
    runtimeInfo,
    llmScores,
    questions: limited.length,
  });

  // SEPARATE results file from the LoCoMo benchmarks.
  const outPath = "scripts/bench-longmemeval-results.json";
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...benchMetadata(providerArgs, runtimeInfo, {
          name: "longmemeval_s",
          path: datasetPath,
        }),
        benchmark: retrieveOnly
          ? "longmemeval-retrieval-only"
          : "longmemeval-llm-judge",
        mode: retrieveOnly ? "retrieval-only" : "llm-answer-judge",
        questions: evalQueries.length,
        topK,
        retrieval: {
          candidateDepth: candidateDepth ?? Math.max(topK * 4, 20),
          keywordWeight: 0.8,
          semanticWeight: 0.2,
          rrfK: 60,
          rerank: rerankUrl ?? null,
        },
        durationMs,
        ingestionMs,
        metrics: { at5: report.at5, at10: report.at10 },
        perCategory: report.perCategory,
        perQuestion: report.perQuestion.map((q) => ({
          questionId: q.questionId,
          category: q.category,
          relevantIds: q.relevantIds,
          retrievedIds: q.retrievedIds.slice(0, topK),
          relevantRetrievedAt5: q.relevantRetrievedAt5,
          relevantRetrievedAt10: q.relevantRetrievedAt10,
          latencyMs: q.latencyMs,
        })),
        ...(retrieveOnly
          ? {}
          : {
              llmJudge: {
                note: "LLM-judge scores are a SEPARATE end-to-end metric; never mix with retrieval metrics.",
                overall:
                  llmScores.length > 0
                    ? llmScores.reduce((s, x) => s + x.score, 0) /
                      llmScores.length
                    : 0,
                perQuestion: llmScores,
              },
            }),
      },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to ${outPath}`);
}

function printReport(
  report: MetricsReport,
  ctx: {
    retrieveOnly: boolean;
    topK: number;
    durationMs: number;
    ingestionMs: number;
    providerArgs: BenchProviderArgs;
    runtimeInfo: EmbeddingRuntimeInfo;
    llmScores: Array<{ questionId: string; category: string; score: number }>;
    questions: number;
  },
): void {
  const fmt = (x: number): string => (x * 100).toFixed(1).padStart(5) + "%";
  const num = (x: number): string => x.toFixed(3);

  console.log("\n=== LongMemEval Results ===");
  console.log(
    `Mode: ${ctx.retrieveOnly ? "retrieval-only (session-ID evidence matching)" : "LLM answer + judge"}`,
  );
  console.log(
    `Provider: ${ctx.providerArgs.provider} → ${ctx.runtimeInfo.resolvedProvider}` +
      ` | fallback: ${ctx.runtimeInfo.fallbackActive ? "YES ⚠" : "no"}`,
  );
  console.log(
    `Questions: ${ctx.questions} | Top-K: ${ctx.topK} | Duration: ${ctx.durationMs}ms (ingestion ${ctx.ingestionMs}ms)`,
  );
  console.log(`Latency p50/p95: ${report.latency.p50}/${report.latency.p95}ms`);

  if (ctx.retrieveOnly || report.at10.questionCount > 0) {
    console.log("\nRetrieval metrics (deterministic, session-ID matching):");
    console.log("Metric                       @5        @10");
    console.log("─────────────────────────────────────────────────");
    console.log(
      `Hit rate                     ${fmt(report.at5.hitRate)}  ${fmt(report.at10.hitRate)}`,
    );
    console.log(
      `Evidence recall (per-Q avg)  ${fmt(report.at5.evidenceRecall)}  ${fmt(report.at10.evidenceRecall)}`,
    );
    console.log(
      `Evidence recall (micro)      ${fmt(report.at5.evidenceRecallMicro)}  ${fmt(report.at10.evidenceRecallMicro)}`,
    );
    console.log(
      `All-evidence recall          ${fmt(report.at5.allEvidenceRecall)}  ${fmt(report.at10.allEvidenceRecall)}`,
    );
    console.log(
      `Precision                    ${fmt(report.at5.precision)}  ${fmt(report.at10.precision)}`,
    );
    console.log(
      `MRR                          ${num(report.at5.mrr)}    ${num(report.at10.mrr)}`,
    );
    console.log(
      `nDCG                         ${num(report.at5.ndcg)}    ${num(report.at10.ndcg)}`,
    );
  }

  if (!ctx.retrieveOnly && ctx.llmScores.length > 0) {
    const overall =
      ctx.llmScores.reduce((s, x) => s + x.score, 0) / ctx.llmScores.length;
    console.log(
      `\nLLM-judge score: ${fmt(overall)} (end-to-end QA; NOT comparable to retrieval metrics or to other vendors' retrieval numbers)`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
