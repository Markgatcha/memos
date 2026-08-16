#!/usr/bin/env npx tsx
/**
 * ─── LongMemEval Benchmark for MemOS ──────────────────────────────────────────
 *
 * Runs the LongMemEval benchmark (xiaowu0162/longmemeval) against MemOS.
 * Uses the same LLM-judge methodology as Mem0, Zep, and Memobase.
 *
 * The benchmark:
 * 1. Loads questions from the LongMemEval-S dataset (500 questions)
 * 2. Stores haystack sessions as MemOS memories (namespaced per question)
 * 3. For each question, searches MemOS for relevant memories
 * 4. Uses LLM to answer the question from retrieved context
 * 5. Uses LLM as judge to score answer correctness (1=yes, 0=no)
 * 6. Reports LLM Judge Score by question type and overall
 *
 * For retrieval-only testing (no API key), use bench-locomo-noapi.ts which
 * also supports LongMemEval data — or set BENCH_NO_API=1 here.
 *
 * Usage:
 *   npx tsx scripts/bench-longmemeval.ts --topk 10 --max-questions=30
 *
 * Prerequisites:
 *   - Download the LongMemEval-S dataset:
 *     git clone --depth 1 https://github.com/xiaowu0162/LongMemEval.git scripts/dataset/longmemeval
 *     (the -S variant is 500 Qs; full corpus is 266MB and not vendored in git)
 *   - Set OPENAI_API_KEY env var (b.ai, bluesminds, or bynara API key)
 *   - Model: agnes-2.0-flash (set BENCH_ANSWER_MODEL to override)
 *
 * Results written to: scripts/bench-locomo-results.json
 */

import { MemOS } from "../src/memory.ts";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

// ─── API setup ──────────────────────────────────────────────────────────────────
// Set your API key via the OPENAI_API_KEY environment variable.
// The default endpoint is the bynara router (https://router.bynara.id/v1).
// Override with OPENAI_BASE_URL if using a different provider.
const B_AI_API_KEY = process.env.OPENAI_API_KEY || "";
const B_AI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://router.bynara.id/v1";
const ANSWER_MODEL = process.env.BENCH_ANSWER_MODEL || "agnes-2.0-flash";
const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || "agnes-2.0-flash";

/**
 * Call the bynara chat completions API using raw fetch.
 * Includes retry logic for rate limiting (429) and payment errors (402).
 */
async function callBAI(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 256,
  maxRetries: number = 3,
): Promise<string> {
  if (!B_AI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. " +
        "Please set it before running the LLM-judge benchmark. " +
        "Example: OPENAI_API_KEY=your-key npx tsx scripts/bench-longmemeval.ts --max-questions=10",
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

      // Rate limited or payment required — wait and retry
      if (
        (resp.status === 429 || resp.status === 402 || resp.status === 403) &&
        attempt < maxRetries
      ) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.error(
          `[bench-LoCoMo] API error ${resp.status}, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data = (await resp.json()) as any;
    const choice = data.choices?.[0]?.message;
    return (choice?.content || choice?.reasoning_content || "").trim();
  }

  throw new Error("Max retries exceeded");
}

/**
 * Answer a question using the retrieved memory context.
 * Uses the LLM answerer model to extract the answer from retrieved memory context.
 */
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
    return await callBAI(
      ANSWER_MODEL,
      [{ role: "user", content: prompt }],
      256,
    );
  } catch (e: any) {
    console.error(
      `[bench-LoCoMo] Answer error: ${e.message?.substring(0, 100)}`,
    );
    return "";
  }
}

/**
 * Judge whether a predicted answer matches the ground truth.
 * Uses LLM as judge (score 1=yes, 0=no).
 */
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
    const text = await callBAI(
      JUDGE_MODEL,
      [{ role: "user", content: prompt }],
      256,
    );
    const match = text.match(/[01]/);
    return match ? parseInt(match[0], 10) : 0;
  } catch (e: any) {
    console.error(
      `[bench-LoCoMo] Judge error: ${e.message?.substring(0, 100)}`,
    );
    return 0;
  }
}

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

interface LongMemEvalResult {
  provider: string;
  timestamp: string;
  questions: number;
  topK: number;
  useEmbeddings: boolean;
  categories: Record<string, { score: number; count: number }>;
  overallScore: number;
  p50Latency: number;
  results: Array<{
    question: string;
    answer: string;
    predicted: string;
    category: string;
    llmScore: number;
    latency: number;
    topResults: string[];
  }>;
}

function categoryName(type: string): string {
  return type;
}

/**
 * Load LongMemEval dataset.
 */
function loadLongMemEval(path: string): LongMemEvalQuestion[] {
  if (!existsSync(path)) {
    throw new Error(
      `LongMemEval dataset not found at ${path}. Please download it first.`,
    );
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return Array.isArray(data) ? data : Object.values(data);
}

/**
 * Store LongMemEval haystack sessions as MemOS memories.
 * Each session is stored as a single memory with all messages concatenated.
 */
async function storeSessions(
  memos: MemOS,
  q: LongMemEvalQuestion,
  questionId: string,
): Promise<number> {
  let memoryCount = 0;

  // Store each haystack session as a memory
  for (const session of q.haystack_sessions) {
    if (!Array.isArray(session) || session.length === 0) continue;

    // Concatenate all messages in the session
    const content = session
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");

    await memos.store(content, {
      namespace: `longmemeval_${questionId}`,
      metadata: {
        qid: questionId,
        type: "haystack_session",
        question_date: q.question_date,
      },
    });
    memoryCount++;
  }

  return memoryCount;
}

/**
 * Run the LongMemEval benchmark.
 */
async function runLongMemEvalBenchmark(opts: {
  topK: number;
  useEmbeddings: boolean;
  maxQuestions?: number;
  delayMs?: number;
  noApi?: boolean;
}): Promise<LongMemEvalResult> {
  // Load dataset
  const datasetPath = "scripts/dataset/longmemeval/longmemeval_s.json";
  const questions = loadLongMemEval(datasetPath);

  // Limit questions if specified
  const limited = opts.maxQuestions
    ? questions.slice(0, opts.maxQuestions)
    : questions;

  console.log(
    `[bench-LoCoMo] Loaded ${limited.length}/${questions.length} LongMemEval questions`,
  );

  // Create MemOS instance
  const dbPath = `/tmp/bench-longmemeval-${Date.now()}.db`;
  const memos = new MemOS({
    dbPath,
    wal: false,
    autoLinkThreshold: 0,
    experimental: { namespaces: true },
    ...(opts.useEmbeddings
      ? {
          embeddings: {
            enabled: true,
            provider: "fastembed",
            model: "Xenova/gemma-300m-e5-it-v1",
            dimensions: 768,
          },
          embeddingQueue: {
            concurrency: 1,
            batchSize: 32,
            maxQueueSize: 60000,
          },
          experimental: { semanticSearch: true, namespaces: true },
        }
      : {}),
  });

  await memos.init();

  // ─── Phase 1: Store sessions ────────────────────────────────────────────────
  const storeStart = Date.now();
  let totalMemories = 0;
  for (let i = 0; i < limited.length; i++) {
    const count = await storeSessions(
      memos,
      limited[i],
      limited[i].question_id,
    );
    totalMemories += count;
    if ((i + 1) % 50 === 0) {
      console.log(
        `  Stored ${i + 1}/${limited.length} questions, ${totalMemories} memories`,
      );
    }
    // Flush embeddings periodically to avoid queue overflow
    if (opts.useEmbeddings && (i + 1) % 10 === 0) {
      await memos.flushEmbeddings();
    }
  }
  if (opts.useEmbeddings) {
    await memos.flushEmbeddings();
  }
  const storeTime = Date.now() - storeStart;
  console.log(
    `[bench-LoCoMo] Stored ${totalMemories} memories in ${storeTime}ms`,
  );

  // ─── Phase 2: Run QA pairs ──────────────────────────────────────────────────
  console.log("[bench-LoCoMo] Running QA retrieval + LLM answer + judge...");

  const perQueryResults: LongMemEvalResult["results"] = [];
  const categoryStats: Record<string, { scores: number[]; latency: number[] }> =
    {};
  const latencies: number[] = [];
  let totalTokens = 0;

  for (let i = 0; i < limited.length; i++) {
    const q = limited[i];
    const namespace = `longmemeval_${q.question_id}`;
    const query = q.question;
    const startTime = Date.now();

    // Search MemOS
    const results = await memos.search({
      query,
      limit: opts.topK,
      namespace,
    });

    const searchTime = Date.now() - startTime;

    // Get memory contents with timestamps
    const memoryObjs = results.map((r) => ({
      content: r.node.content || "",
      timestamp:
        r.node.metadata?.question_date ||
        r.node.metadata?.timestamp ||
        "unknown",
    }));

    // Answer + judge
    let predicted = "";
    let llmScore = 0;

    if (!opts.noApi) {
      predicted = await answerQuestion(query, memoryObjs);
      llmScore = await judgeAnswer(query, q.answer, predicted);
    }

    const elapsed = Date.now() - startTime;
    latencies.push(elapsed);
    totalTokens += (query.length + predicted.length + q.answer.length) / 4;

    if (!categoryStats[q.question_type]) {
      categoryStats[q.question_type] = { scores: [], latency: [] };
    }
    categoryStats[q.question_type].scores.push(llmScore);
    categoryStats[q.question_type].latency.push(elapsed);

    perQueryResults.push({
      question: query,
      answer: q.answer,
      predicted,
      category: q.question_type,
      llmScore,
      latency: elapsed,
      topResults: results
        .slice(0, 3)
        .map((r) => r.node.content?.substring(0, 80) || ""),
    });

    if ((i + 1) % 10 === 0) {
      console.log(`  Processed ${i + 1}/${limited.length} questions`);
    }

    // Rate limiting
    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
  }

  await memos.close();
  if (existsSync(dbPath)) unlinkSync(dbPath);

  // ─── Phase 3: Aggregate ─────────────────────────────────────────────────────
  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const p50 = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 0;
  };

  const categories: Record<string, { score: number; count: number }> = {};
  let totalScore = 0;
  let totalQ = 0;

  for (const [cat, stats] of Object.entries(categoryStats)) {
    const score = avg(stats.scores);
    categories[cat] = { score, count: stats.scores.length };
    totalScore += score * stats.scores.length;
    totalQ += stats.scores.length;
  }

  const overallScore = totalQ > 0 ? totalScore / totalQ : 0;
  const overallLatency = avg(latencies);

  const report: LongMemEvalResult = {
    provider: "MemOS",
    timestamp: new Date().toISOString(),
    questions: perQueryResults.length,
    topK: opts.topK,
    useEmbeddings: opts.useEmbeddings,
    categories,
    overallScore,
    p50Latency: p50(latencies),
    results: perQueryResults,
  };

  return report;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const topK = parseInt(
    args.find((a) => a.startsWith("--topk="))?.split("=")[1] || "10",
    10,
  );
  const maxQuestionsArg = args.find((a) => a.startsWith("--max-questions="))
    ? parseInt(
        args.find((a) => a.startsWith("--max-questions="))!.split("=")[1],
        10,
      )
    : undefined;
  const noApi = args.includes("--no-api");
  const useEmbeddings = !args.includes("--no-embeddings");
  const delayMs = args.find((a) => a.startsWith("--delay="))
    ? parseInt(args.find((a) => a.startsWith("--delay="))!.split("=")[1], 10)
    : 0;

  console.log("MemOS LongMemEval Benchmark");
  console.log(`  Dataset: LongMemEval-S (xiaowu0162/longmemeval)`);
  console.log(
    `  Top-K: ${topK} | Embeddings: ${useEmbeddings}${noApi ? " | No API (retrieval only)" : ""}${maxQuestionsArg ? ` | Max Qs: ${maxQuestionsArg}` : ""} | Delay: ${delayMs}ms`,
  );
  console.log();

  const report = await runLongMemEvalBenchmark({
    topK,
    useEmbeddings,
    maxQuestions: maxQuestionsArg,
    delayMs,
    noApi,
  });

  // ─── Output ───────────────────────────────────────────────────────────────────
  console.log("\n=== Results ===\n");
  console.log("Category                  LLM Judge Score  Count");
  console.log("------------------------------------------------------");

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  for (const [cat, stats] of Object.entries(report.categories)) {
    const pct = Math.round(stats.score * 100);
    const name = cat.padEnd(25);
    console.log(
      `${name} ${pct.toString().padStart(3)}%           ${stats.count}`,
    );
  }
  console.log("------------------------------------------------------");
  const overallPct = Math.round(report.overallScore * 100);
  console.log(
    `Overall                   ${overallPct}%           ${report.questions}`,
  );
  console.log(
    `p50 latency: ${report.p50Latency}ms | Total: ${Math.round(report.latencies || 0)}ms`,
  );

  console.log("\n--- Competitor Reference Scores (LongMemEval-S) ---");
  console.log("Mem0:          94.4% overall");
  console.log("Zep (independent test): 63.8%");
  if (!noApi) {
    console.log("\n--- Summary ---");
    if (report.overallScore >= 0.638) {
      console.log(`✅ MemOS beats Zep's independent LongMemEval score (63.8%)`);
    } else {
      console.log(
        `⚠️  MemOS scores ${overallPct}% — Zep scored 63.8% in an independent test, Mem0 published 94.4%`,
      );
    }
  }

  const outputPath = "scripts/bench-locomo-results.json";
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nResults saved to ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
