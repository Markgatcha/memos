#!/usr/bin/env npx tsx
/**
 * ─── LOCOMO Dataset Benchmark for MemOS ─────────────────────────────────────
 *
 * Runs the actual LOCOMO benchmark dataset (snap-research/locomo) against
 * MemOS and evaluates results using an LLM judge (agnes-2.0-flash via bynara).
 * This is the same methodology used by Mem0, Zep, and Memobase.
 *
 * The benchmark:
 * 1. Loads conversations from the LOCOMO dataset (locomo10.json)
 * 2. Stores each utterance as a memory in MemOS (with speaker + timestamp)
 * 3. For each QA pair, searches MemOS for relevant memories
 * 4. Uses agnes-2.0-flash to answer the question from retrieved context
 * 5. Uses agnes-2.0-flash as judge to score answer correctness (1=yes, 0=no)
 * 6. Reports LLM Judge Score per category and overall
 *
 * Comparison to published scores (from mem0.ai/research, May 2026):
 *   Mem0:        92.5% overall | 94.6% single-hop | 95.4% multi-hop | 82.3% open-domain | 92.5% temporal
 *   Zep:         58.44% overall (corrected from Zep's original claim of 84%)
 *
 * Usage:
 *   npx tsx scripts/bench-locomo.ts --topk 10 --convs 2
 *   npx tsx scripts/bench-locomo.ts --topk 10 --convs 10
 *
 * Prerequisites:
 *   - Dataset at scripts/dataset/locomo/data/locomo10.json
 *   - Set OPENAI_API_KEY env var (b.ai, bluesminds, or bynara API key)
 *   - No special packages needed (uses native fetch and MemOS)
 *   - Model: agnes-2.0-flash (set BENCH_ANSWER_MODEL to override)
 *
 * Results written to: scripts/bench-locomo-results.json
 */

import { MemOS } from "../src/memory.ts";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";

// ─── API setup ──────────────────────────────────────────────────────────────────
// We use bynara's API (https://router.bynara.id/v1/chat/completions) to answer
// questions from retrieved memory context and judge whether the answer matches
// ground truth. This is the same LLM-judge methodology used by the original
// LOCOMO benchmark papers (Mem0, Zep, Memobase all use GPT-4 as judge).
//
// Available free-tier models on bynara router:
//   - agnes-2.0-flash   (free, works without deposit)
//   - agnes-2.5-flash   (free, higher quality)
//   - gpt-5.4, gpt-5.5  (require deposit/top-up)
//   - gpt-5.6-luna      (require deposit/top-up)
//
// Note: b.ai's API key requires deposit for kimi-k2.5.
// The bluesminds.com key works for gpt-5-mini but has a 600 req/day limit.
// The bynara router with agnes-2.0-flash is the most reliable free option.
// Set your API key via OPENAI_API_KEY environment variable.
const B_AI_API_KEY = process.env.OPENAI_API_KEY || "";
const B_AI_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://router.bynara.id/v1";
const ANSWER_MODEL = process.env.BENCH_ANSWER_MODEL || "agnes-2.0-flash";
const JUDGE_MODEL = process.env.BENCH_JUDGE_MODEL || "agnes-2.0-flash";

/**
 * Call the bynara chat completions API using raw fetch.
 * agnes-2.0-flash works with temperature=0.7 and returns content directly.
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
        "Please set it before running the LLM-judge benchmark, " +
        "or use --no-api for retrieval-only testing. " +
        "Example: OPENAI_API_KEY=your-key npx tsx scripts/bench-locomo.ts --max-questions=5",
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
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const errMsg = errText.substring(0, 200);

      // Rate limited — wait and retry
      if (resp.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 2000; // 2s, 4s, 8s
        console.error(
          `[bench-LoCoMo] Rate limited, retrying in ${delay}ms... (${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data = (await resp.json()) as any;
    // Kimi-k2.5 returns reasoning in reasoning_content; content may be empty
    const choice = data.choices?.[0]?.message;
    return (choice?.content || choice?.reasoning_content || "").trim();
  }

  throw new Error("Max retries exceeded");
}

/**
 * Answer a question using the retrieved memory context.
 * Uses kimi-k2.5 to extract the answer from retrieved memory context.
 * Includes timestamps so temporal questions can be answered correctly.
 */
async function answerQuestion(
  question: string,
  memories: Array<{ content: string; timestamp: string }>,
  speakerA: string,
  speakerB: string,
): Promise<string> {
  const memoryContext = memories
    .map((m, i) => `${i + 1}. [${m.timestamp}] ${m.content}`)
    .join("\n");

  const prompt = `You are an intelligent memory assistant. Given the following conversation memories from two speakers, answer the question concisely.

Speakers: ${speakerA} and ${speakerB}

Memories (timestamped utterances from both speakers):
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
 * Uses kimi-k2.5 as an LLM judge (score 1=yes, 0=no).
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

Does the predicted answer correctly answer the question and match the ground truth? Consider semantic equivalence, not exact string matching.
Score: 1 if the predicted answer is correct (matches or is a valid paraphrase of the ground truth), 0 if incorrect.
Only output a single digit: 1 or 0.`;

  try {
    const text = await callBAI(
      JUDGE_MODEL,
      [{ role: "user", content: prompt }],
      256,
    );
    // Extract just the digit
    const match = text.match(/[01]/);
    return match ? parseInt(match[0], 10) : 0;
  } catch (e: any) {
    console.error(
      `[bench-LoCoMo] Judge error: ${e.message?.substring(0, 100)}`,
    );
    return 0;
  }
}

interface LocoConversation {
  conversation: {
    speaker_a: string;
    speaker_b: string;
    [key: string]: any;
  };
  qa: Array<{
    question: string;
    answer: string;
    evidence: string[];
    category: number;
    adversarial_answer?: string;
  }>;
  sample_id: string;
}

interface LocoBenchmarkResult {
  provider: string;
  timestamp: string;
  conversations: number;
  questions: number;
  topK: number;
  useEmbeddings: boolean;
  categories: {
    singleHop: { recall: number; precision: number; count: number };
    multiHop: { recall: number; precision: number; count: number };
    temporal: { recall: number; precision: number; count: number };
    openDomain: { recall: number; precision: number; count: number };
  };
  aggregate: {
    llmJudgeScore: number;
    p50Latency: number;
    totalLatency: number;
    totalTokens: number;
  };
  results: Array<{
    question: string;
    answer: string;
    predicted: string;
    category: number;
    llmScore: number;
    latency: number;
    topResults: string[];
  }>;
}

/**
 * Parse the LOCOMO dataset structure.
 *
 * LOCOMO has 10 conversations, each with:
 *   - conversation: timestamped utterances between speaker_a and speaker_b
 *   - qa: questions with answers, evidence references, and categories
 *
 * Categories:
 *   1 = single-hop (direct fact lookup)
 *   2 = temporal (time-based reasoning)
 *   3 = multi-hop (requires combining multiple facts)
 *   4 = open-domain (general knowledge)
 *   5 = adversarial (tricky/confusing questions)
 */
function loadLocomoData(path: string): LocoConversation[] {
  if (!existsSync(path)) {
    console.error(`Dataset not found at ${path}`);
    console.error("Download it with:");
    console.error(
      "  git clone --depth 1 https://github.com/snap-research/locomo.git scripts/dataset/locomo",
    );
    process.exit(1);
  }
  const raw = readFileSync(path, "utf-8");
  return JSON.parse(raw) as LocoConversation[];
}

/**
 * Extract all utterances from a LOCOMO conversation and store them as
 * MemOS memories. Each utterance becomes a memory with metadata
 * containing the speaker, timestamp, and source document reference.
 */
async function storeConversation(
  memos: MemOS,
  conv: LocoConversation,
  convIdx: number,
): Promise<number> {
  const { conversation } = conv;
  const { speaker_a, speaker_b } = conversation;

  // The conversation object has keys like "session_0", "session_1", etc.
  // Each session contains timestamped chats between speakers.
  const sessionKeys = Object.keys(conversation).filter(
    (k) => k !== "speaker_a" && k !== "speaker_b" && !k.endsWith("_date_time"),
  );

  let memoryCount = 0;
  for (const sessionKey of sessionKeys) {
    const date_time_key = sessionKey + "_date_time";
    const timestamp = conversation[date_time_key] || "";
    const chats = conversation[sessionKey];
    if (!Array.isArray(chats)) continue;

    for (const chat of chats) {
      const speaker = chat.speaker === speaker_a ? speaker_a : speaker_b;
      const text = chat.text;
      const content = `${speaker}: ${text}`;

      // Store with metadata for traceability
      await memos.store(content, {
        namespace: `locomo_conv_${convIdx}`,
        metadata: {
          speaker,
          timestamp,
          source: `D${convIdx}:${sessionKey}`,
        },
      });

      memoryCount++;
    }
  }

  return memoryCount;
}

/**
 * Map LOCOMO category numbers to human-readable names.
 * Based on analysis of actual LOCOMO question content:
 * - Cat 1: "What did Caroline research?" → Single-hop (direct fact recall)
 * - Cat 2: "When did Caroline go to the LGBTQ support group?" → Temporal
 * - Cat 3: "Would Caroline likely have Dr. Seuss books?" → Open-domain (hypothetical)
 * - Cat 4: "What did the charity race raise awareness for?" → Multi-hop (cross-session)
 * - Cat 5: "What did Caroline realize after her charity race?" → Adversarial
 */
function categoryName(cat: number): string {
  const names: Record<number, string> = {
    1: "single_hop",
    2: "temporal",
    3: "open_domain",
    4: "multi_hop",
    5: "adversarial",
  };
  return names[cat] || `unknown_${cat}`;
}

/**
 * Run the LOCOMO benchmark against MemOS.
 */
async function runLocomoBenchmark(opts: {
  topK: number;
  useEmbeddings: boolean;
  maxConversations?: number;
  maxQuestions?: number;
  delayMs?: number;
}): Promise<LocoBenchmarkResult> {
  const datasetPath = "scripts/dataset/locomo/data/locomo10.json";
  const conversations = loadLocomoData(datasetPath);
  const limited = opts.maxConversations
    ? conversations.slice(0, opts.maxConversations)
    : conversations;

  console.log(
    `[bench-LoCoMo] Loaded ${limited.length}/${conversations.length} conversations`,
  );

  // Create a fresh MemOS instance with embeddings
  const dbPath = `/tmp/bench-locomo-${Date.now()}.db`;
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
          embeddingQueue: { concurrency: 1, batchSize: 32 },
          experimental: { semanticSearch: true, namespaces: true },
        }
      : {}),
  });

  await memos.init();

  // ─── Phase 1: Store all conversations ───────────────────────────────────────
  console.log("[bench-LoCoMo] Storing conversations...");
  const storeStart = Date.now();
  let totalMemories = 0;
  for (let i = 0; i < limited.length; i++) {
    const count = await storeConversation(memos, limited[i], i);
    totalMemories += count;
    console.log(
      `  Conv ${i}: ${limited[i].qa.length} questions, ${count} memories stored`,
    );
  }
  if (opts.useEmbeddings) {
    await memos.flushEmbeddings();
  }
  const storeTime = Date.now() - storeStart;
  console.log(
    `[bench-LoCoMo] Stored ${totalMemories} memories in ${storeTime}ms`,
  );

  // ─── Phase 2: Run all QA pairs with LLM answer + judge ───────────────────────
  console.log("[bench-LoCoMo] Running QA retrieval + LLM answer + judge...");

  const perQueryResults: LocoBenchmarkResult["results"] = [];
  const categoryStats: Record<number, { scores: number[]; latency: number[] }> =
    {};
  const latencies: number[] = [];
  let totalTokens = 0;

  for (let convIdx = 0; convIdx < limited.length; convIdx++) {
    const conv = limited[convIdx];
    const namespace = `locomo_conv_${convIdx}`;

    for (const qa of conv.qa) {
      const query = qa.question;
      const startTime = Date.now();

      // Search MemOS for relevant memories
      const results = await memos.search({
        query,
        limit: opts.topK,
        namespace,
      });

      const searchTime = Date.now() - startTime;

      // Use retrieved memories to answer the question with kimi-k2.5
      // Include timestamps from metadata so temporal questions can be resolved
      const memoryObjs = results.map((r) => ({
        content: r.node.content || "",
        timestamp:
          r.node.metadata?.timestamp || r.node.metadata?.ts || "unknown",
      }));
      const predicted = await answerQuestion(
        query,
        memoryObjs,
        conv.conversation.speaker_a,
        conv.conversation.speaker_b,
      );

      // Judge the predicted answer against ground truth
      const llmScore = await judgeAnswer(query, qa.answer, predicted);

      const elapsed = Date.now() - startTime;
      latencies.push(elapsed);
      totalTokens += (query.length + predicted.length + qa.answer.length) / 4;

      if (!categoryStats[qa.category]) {
        categoryStats[qa.category] = { scores: [], latency: [] };
      }
      categoryStats[qa.category].scores.push(llmScore);
      categoryStats[qa.category].latency.push(elapsed);

      perQueryResults.push({
        question: query,
        answer: qa.answer,
        predicted,
        category: qa.category,
        llmScore,
        latency: elapsed,
        topResults: results
          .slice(0, 3)
          .map((r) => r.node.content?.substring(0, 80) || ""),
      });

      console.log(
        `  [${categoryName(qa.category)}] Q: ${query.substring(0, 50)}... ` +
          `→ ${llmScore === 1 ? "✓" : "✗"} (${elapsed}ms)`,
      );

      // Rate limiting and max-questions limit
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      if (opts.maxQuestions && perQueryResults.length >= opts.maxQuestions) {
        console.log(
          `  Reached max questions limit (${opts.maxQuestions}), stopping.`,
        );
        break;
      }
    }
    if (opts.maxQuestions && perQueryResults.length >= opts.maxQuestions) {
      break;
    }
  }

  // ─── Phase 3: Aggregate ─────────────────────────────────────────────────────
  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 0;
  const totalLatency = latencies.reduce((a, b) => a + b, 0);

  const catResult = (cat: number) => {
    const s = categoryStats[cat];
    return s
      ? {
          recall: avg(s.scores),
          precision: avg(s.scores),
          count: s.scores.length,
        }
      : { recall: 0, precision: 0, count: 0 };
  };

  await memos.close();
  if (existsSync(dbPath)) unlinkSync(dbPath);

  const overallScore = avg(perQueryResults.map((r) => r.llmScore));

  return {
    provider: "MemOS",
    timestamp: new Date().toISOString(),
    conversations: limited.length,
    questions: perQueryResults.length,
    topK: opts.topK,
    useEmbeddings: opts.useEmbeddings,
    categories: {
      singleHop: catResult(1),
      multiHop: catResult(4),
      temporal: catResult(2),
      openDomain: catResult(3),
    },
    aggregate: {
      llmJudgeScore: overallScore,
      p50Latency: p50,
      totalLatency,
      totalTokens,
    },
    results: perQueryResults,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const topK = parseInt(
    args.find((a) => a.startsWith("--topk="))?.split("=")[1] || "15",
    10,
  );
  const useEmbeddings = !args.includes("--no-embeddings");
  const maxConvos = args.find((a) => a.startsWith("--convs="))
    ? parseInt(args.find((a) => a.startsWith("--convs="))!.split("=")[1], 10)
    : undefined;
  const maxQuestions = args.find((a) => a.startsWith("--max-questions="))
    ? parseInt(
        args.find((a) => a.startsWith("--max-questions="))!.split("=")[1],
        10,
      )
    : undefined;
  const delayMs = parseInt(
    args.find((a) => a.startsWith("--delay="))?.split("=")[1] || "100",
    10,
  );

  const useEmbedding = !args.includes("--no-embeddings");
  console.log("MemOS LoCoMo Benchmark");
  console.log(`  Dataset: LOCOMO (snap-research/locomo)`);
  console.log(
    `  Top-K: ${topK} | Embeddings: ${useEmbedding}${maxConvos ? ` | Convos: ${maxConvos}` : ""}${maxQuestions ? ` | Max Qs: ${maxQuestions}` : ""} | Delay: ${delayMs}ms`,
  );
  console.log();

  const report = await runLocomoBenchmark({
    topK,
    useEmbeddings: useEmbedding,
    maxConversations: maxConvos,
    maxQuestions,
    delayMs,
  });

  // Print results table
  console.log("\\n=== Results ===\\n");
  console.log("Category           LLM Judge Score  Count");
  console.log("------------------------------------------------------");
  console.log(
    `Single-hop        ${report.categories.singleHop.recall.toFixed(4)}         ${report.categories.singleHop.count}`,
  );
  console.log(
    `Multi-hop         ${report.categories.multiHop.recall.toFixed(4)}         ${report.categories.multiHop.count}`,
  );
  console.log(
    `Temporal          ${report.categories.temporal.recall.toFixed(4)}         ${report.categories.temporal.count}`,
  );
  console.log(
    `Open-domain       ${report.categories.openDomain.recall.toFixed(4)}         ${report.categories.openDomain.count}`,
  );
  console.log("------------------------------------------------------");
  console.log(
    `Overall           ${report.aggregate.llmJudgeScore.toFixed(4)}         ${report.questions}`,
  );
  console.log(
    `p50 latency: ${report.aggregate.p50Latency}ms | Total: ${report.aggregate.totalLatency}ms | Est. tokens: ${report.aggregate.totalTokens.toFixed(0)}`,
  );

  // Competitor references (from mem0.ai/research, May 2026)
  console.log(
    "\\n--- Competitor Reference Scores (LoCoMo LLM-Judge, mem0.ai/research) ---",
  );
  console.log(
    "Mem0:          92.5% overall | 94.6% single-hop | 95.4% multi-hop | 82.3% open-dom-temporal | 92.5% temporal",
  );
  console.log(
    "Zep:           58.44% overall (corrected from original claim of 84%)",
  );
  console.log("Letta:         58.10% overall");
  console.log(
    "\\nNote: Mem0 scores are LLM-Judge (GPT-4o). Retrieval recall will differ.",
  );

  // Write results
  const outPath = "scripts/bench-locomo-results.json";
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nResults written to ${outPath}`);

  // Summary
  console.log("\n--- Summary ---");
  const pct = Math.round(report.aggregate.llmJudgeScore * 100);
  // Mem0 published 92.5% on LOCOMO (from mem0.ai/research, May 2026)
  if (report.aggregate.llmJudgeScore >= 0.925) {
    console.log(
      `✅ MemOS beats Mem0's published LOCOMO score (${pct}% vs 92.5%)`,
    );
  } else if (report.aggregate.llmJudgeScore >= 0.584) {
    console.log(`✅ MemOS beats Zep (${pct}% vs 58.44%, independent test)`);
    console.log("   Note: Mem0 published 92.5% on mem0.ai/research");
  } else {
    console.log(
      `⚠️  MemOS scores ${pct}% — Mem0 published 92.5%, Zep: 58.44% (from mem0.ai/research)`,
    );
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
