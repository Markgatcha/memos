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
 *   npx tsx scripts/bench-longmemeval.ts --topk=20 --retrieve-only \
 *     --fts-operator=OR --contextual --keyword-weight=0.5 --semantic-weight=0.5
 *   npx tsx scripts/bench-longmemeval.ts --no-embeddings --topk=20 \
 *     --retrieve-only --fts-operator=OR   # lexical ceiling, fast
 *   npx tsx scripts/bench-longmemeval.ts --topk=20 --max-questions=30
 *
 * Long runs:
 *   --db=<path> keeps the SQLite store and skips questions whose namespace is
 *   already fully populated, so an interrupted 500-question run resumes
 *   instead of re-embedding everything. --session-chunk-messages=N splits
 *   sessions into overlapping windows that aggregate back to the same
 *   sessionId (chunked ingestion). --ingest-concurrency controls setup
 *   parallelism. --fast-ingest writes sessions through importRecord (skips
 *   extractive summary/entity/write-pipeline work; retrieval-equivalent on
 *   the measured 100-question sample). --no-embeddings measures the BM25-only ceiling.
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
import { isPreferenceQuestion } from "../src/preferences.ts";
import type { MemoryPool } from "../src/types.ts";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseProviderArgs,
  parseRetrievalArgs,
  retrievalConfig,
  buildProvider,
  assertNoFallback,
  benchMetadata,
  type BenchProviderArgs,
} from "./lib/bench-common.ts";
import type { EmbeddingRuntimeInfo } from "../src/types.ts";
import {
  aggregateMetrics,
  dedupeRankedIds,
  evaluateQueryAtK,
  type EvalQueryResult,
  type MetricsAtK,
  type MetricsReport,
} from "./lib/bench-metrics.ts";
import {
  resolveLlmConfig,
  answerFromContext,
  judgeCorrect,
  expandQuery,
  newUsage,
  llmProvenance,
} from "./lib/bench-llm.ts";
import {
  bootstrapAccuracyCI,
  formatIntervalPct,
  sampleSizeWarning,
} from "./lib/bench-stats.ts";

// ─── LLM helpers (optional end-to-end mode) ──────────────────────────────────
//
// These now route through scripts/lib/bench-llm.ts. The previous inline
// version had three problems that made its output uncitable:
//
//   1. The header comment advertised one model ("kimi-k2.5") while the code
//      called another ("agnes-2.0-flash") — and neither was written to the
//      results file, so a saved score carried no provenance.
//   2. `temperature: 0.7` made runs non-reproducible; a 1-point delta between
//      two runs was indistinguishable from sampling noise.
//   3. No token accounting, so cost-per-correct-answer was unknowable.
//
// The legacy endpoint/model defaults are preserved below so existing
// invocations behave the same. For any number you intend to publish, set
// OPENAI_BASE_URL / BENCH_ANSWER_MODEL / BENCH_JUDGE_MODEL explicitly —
// they are recorded verbatim in the results file.

const B_AI_API_KEY = process.env.OPENAI_API_KEY || "";
const LEGACY_BASE_URL = "https://router.bynara.id/v1";

const LLM_CFG = resolveLlmConfig();
if (!process.env.OPENAI_BASE_URL) LLM_CFG.baseUrl = LEGACY_BASE_URL;
if (!process.env.BENCH_ANSWER_MODEL) LLM_CFG.answerModel = "agnes-2.0-flash";
LLM_CFG.judgeModel = process.env.BENCH_JUDGE_MODEL || LLM_CFG.answerModel;

/** Accumulated for the whole run and written into the results file. */
const LLM_USAGE = newUsage();

export type BenchArm = "memory" | "full-context" | "no-memory";

function parseArm(args: string[]): BenchArm {
  const raw = args.find((a) => a.startsWith("--arm="))?.split("=")[1];
  if (raw === "full-context" || raw === "no-memory" || raw === "memory") {
    return raw;
  }
  if (raw !== undefined && raw !== "") {
    console.error(
      `[bench-longmemeval] Unknown --arm=${raw}; falling back to "memory". ` +
        `Valid: memory | full-context | no-memory`,
    );
  }
  return "memory";
}

async function answerQuestion(
  question: string,
  memories: Array<{ content: string; timestamp: string; source?: string }>,
  arm: BenchArm = "memory",
): Promise<string> {
  return answerFromContext(LLM_CFG, question, memories, LLM_USAGE, arm);
}

async function judgeAnswer(
  question: string,
  groundTruth: string,
  predicted: string,
): Promise<number> {
  return judgeCorrect(LLM_CFG, question, groundTruth, predicted, LLM_USAGE);
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
/**
 * Deterministic key expansion for long-session ingestion (LongMemEval's
 * "fact-augmented key" idea without an LLM). Picks the sentences most
 * likely to carry a retrievable fact — numeric/date statements,
 * first-person ownership/preference statements, and high-content-word
 * sentences — and returns them as the node's summary. The summary is
 * FTS-indexed and prepended to the embedded text, so those facts get a
 * second, concentrated vote in both legs.
 */
const KEY_EXPANSION_STOP = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "been",
  "before",
  "being",
  "could",
  "does",
  "doing",
  "from",
  "have",
  "here",
  "into",
  "just",
  "like",
  "more",
  "much",
  "only",
  "other",
  "really",
  "should",
  "some",
  "such",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "think",
  "this",
  "those",
  "very",
  "want",
  "well",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "your",
]);

export function keyExpansionSummary(
  session: Array<{ role: string; content: string }>,
  maxSentences = 5,
  maxChars = 900,
): string {
  const sentences: string[] = [];
  for (const message of session) {
    const parts = String(message.content ?? "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 24);
    sentences.push(...parts);
  }
  if (sentences.length === 0) return "";
  const freq = new Map<string, number>();
  for (const sentence of sentences) {
    for (const word of sentence.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length < 4 || KEY_EXPANSION_STOP.has(word)) continue;
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }
  const scored = sentences.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    let score = 0;
    if (/\d/.test(sentence)) score += 3;
    if (
      /\b(my|mine|i own|i have|i've|i'm|i am|i used to|i played|i bought|i sold|i work|i live|favorite|prefer)\b/.test(
        lower,
      )
    ) {
      score += 3;
    }
    const words = new Set(
      lower
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !KEY_EXPANSION_STOP.has(w)),
    );
    let wordScore = 0;
    for (const word of words) wordScore += freq.get(word) ?? 0;
    score += wordScore / Math.max(4, words.size);
    return { sentence, index, score };
  });
  const chosen = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((x) => x.sentence);
  return chosen.join(" ").slice(0, maxChars);
}

async function storeSessions(
  memos: MemOS,
  q: LongMemEvalQuestion,
  options: {
    concurrency?: number;
    chunkMessages?: number;
    keyExpansion?: boolean;
    fastIngest?: boolean;
    nodeGranularity?: "session" | "turn" | "fact";
    /** Capture explicit preference statements as separate memories. */
    preferences?: boolean;
    /**
     * Node ids already present in the namespace. Only meaningful with
     * fast-ingest, whose ids are deterministic: a resumed namespace must not
     * re-write existing ids (the insert is a primary-key collision).
     */
    skipNodeIds?: Set<string>;
  } = {},
): Promise<number> {
  let memoryCount = 0;
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const chunkMessages = Math.max(0, options.chunkMessages ?? 0);
  const keyExpansion = options.keyExpansion === true;
  const fastIngest = options.fastIngest === true;
  const writes: Array<() => Promise<unknown>> = [];

  for (const [position, session] of q.haystack_sessions.entries()) {
    if (!Array.isArray(session) || session.length === 0) continue;

    const sessionDate = q.haystack_dates[position] ?? "";
    const parsed = Date.parse(String(sessionDate));
    const sessionNow = Number.isFinite(parsed) ? parsed : undefined;
    const sessionId = q.haystack_session_ids[position] ?? `session_${position}`;

    if (options.preferences) {
      // Preferences are stored as their own short memories: a question like
      // "what would I enjoy?" has no lexical overlap with the session text.
      const sessionText = session
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n");
      writes.push(() =>
        memos.capturePreferences(sessionText, {
          namespace: `longmemeval_${q.question_id}`,
          sourceId: sessionId,
        }),
      );
    }

    if (options.nodeGranularity === "fact") {
      // Fact arm: extract candidates, then store each as its own node with
      // the parent sessionId. Retrieval still scores session IDs, so the
      // comparison against the session/turn arms is apples-to-apples.
      const conversation = session.map((message) => ({
        role: (message.role === "assistant"
          ? "assistant"
          : message.role === "system"
            ? "system"
            : "user") as "user" | "assistant" | "system",
        content: message.content,
      }));
      const extracted = await memos.extractFacts(conversation, {
        autoStore: false,
        dedupe: false,
      });
      for (const [factIndex, fact] of extracted.facts.entries()) {
        if (fact.confidence < 0.5) continue;
        await memos.store(fact.content, {
          namespace: `longmemeval_${q.question_id}`,
          ...(sessionNow !== undefined
            ? { now: sessionNow + factIndex * 1000 }
            : {}),
          summary: "",
          type: fact.type,
          contradictionScan: false,
          eventUpdate: false,
          quarantineScreen: false,
          metadata: {
            qid: q.question_id,
            type: "haystack_fact",
            benchmark: "longmemeval",
            instanceId: `longmemeval_${q.question_id}`,
            sessionId,
            timestamp: sessionDate,
            questionDate: q.question_date,
            position,
            factIndex,
            factConfidence: fact.confidence,
          },
        });
        memoryCount += 1;
      }
      continue;
    }

    // With chunkMessages=0 the whole session is one node (the historical
    // protocol). Otherwise split into overlapping windows so a long session
    // with several topics does not get averaged into one vector; every chunk
    // carries the same sessionId, and retrieval aggregates back to sessions.
    const windows: Array<{ start: number; end: number }> = [];
    if (chunkMessages === 0) {
      windows.push({ start: 0, end: session.length });
    } else {
      const step = Math.max(1, chunkMessages);
      for (let start = 0; start < session.length; start += step) {
        windows.push({
          start,
          end: Math.min(session.length, start + chunkMessages),
        });
        if (start + chunkMessages >= session.length) break;
      }
    }

    for (const [chunkIndex, window] of windows.entries()) {
      const content = session
        .slice(window.start, window.end)
        .map((msg) => `${msg.role}: ${msg.content}`)
        .join("\n");
      // Distinct, chronological event times per chunk.
      const now =
        sessionNow !== undefined ? sessionNow + chunkIndex * 1000 : undefined;
      const summary = keyExpansion
        ? keyExpansionSummary(session.slice(window.start, window.end))
        : undefined;

      // Deterministic id for fast-ingest, so a resumed namespace can tell
      // which sessions are already stored and skip exactly those.
      const nodeId = `lme_${q.question_id}_${position}_${chunkIndex}`;
      if (options.skipNodeIds?.has(nodeId)) continue;

      writes.push(() =>
        fastIngest
          ? memos.importRecord({
              id: nodeId,
              content,
              // Bulk benchmarking does not need extractive summaries for
              // FTS (content is indexed) and an empty summary halves the
              // embedding text. Retrieval is scored on content, not summary.
              summary: "",
              type: "fact",
              createdAt: now ?? Date.now() + position,
              updatedAt: now ?? Date.now() + position,
              namespace: `longmemeval_${q.question_id}`,
              contradictionScan: false,
              harness: "longmemeval",
              metadata: {
                qid: q.question_id,
                type: "haystack_session",
                benchmark: "longmemeval",
                instanceId: `longmemeval_${q.question_id}`,
                sessionId,
                timestamp: sessionDate,
                questionDate: q.question_date,
                position,
                chunkIndex,
                chunkCount: windows.length,
              },
            })
          : memos.store(content, {
              namespace: `longmemeval_${q.question_id}`,
              ...(now !== undefined ? { now } : {}),
              ...(summary ? { summary } : {}),
              // Bulk setup: the per-write contradiction vector scan cannot change
              // a retrieval-only score and dominates ingestion on 50-session
              // namespaces.
              contradictionScan: false,
              eventUpdate: false,
              // The haystack is a trusted benchmark corpus. The write-gate
              // classifier flags ~150 ordinary chat sessions as prompt-injection
              // shaped and excludes them from recall, which silently deletes
              // evidence. Benchmarks must measure retrieval over the full corpus.
              quarantineScreen: false,
              metadata: {
                qid: q.question_id,
                type: "haystack_session",
                benchmark: "longmemeval",
                instanceId: `longmemeval_${q.question_id}`,
                sessionId,
                timestamp: sessionDate,
                questionDate: q.question_date,
                position,
                chunkIndex,
                chunkCount: windows.length,
              },
            }),
      );
      memoryCount++;
    }
  }

  for (let i = 0; i < writes.length; i += concurrency) {
    await Promise.all(writes.slice(i, i + concurrency).map((write) => write()));
  }

  return memoryCount;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Reciprocal-rank fusion of session-ID lists from multiple queries.
 * Distinct query decompositions surface different evidence sessions;
 * RRF merges them without letting any single variant dominate.
 */
function fuseSessionLists(lists: string[][], rrfK = 60): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      const rank = seen.size;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rrfK + rank));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

async function main() {
  const args = process.argv.slice(2);
  const retrievalArgs = parseRetrievalArgs(args);
  const retrievalCfg = retrievalConfig(retrievalArgs);
  const ingestConcurrency = Math.max(
    1,
    parseInt(
      args.find((a) => a.startsWith("--ingest-concurrency="))?.split("=")[1] ??
        "8",
      10,
    ) || 8,
  );
  const fastIngest = args.includes("--fast-ingest");
  // Partial-hit neighbour guard (on by default; see the function's docs for
  // the measurement). `--no-neighbour-guard` reproduces the raw ranking.
  const neighbourGuard = !args.includes("--no-neighbour-guard");
  // Batched query pre-embedding (on by default; latency only, never recall).
  const queryPrewarm = !args.includes("--no-query-prewarm");
  // Node granularity is the honest-arm switch:
  //   session = one node per haystack session (the historical protocol)
  //   turn    = one node per message (chunkMessages=1)
  //   fact    = one node per extracted fact
  // Session-level Hit@K is the easy arm because each retrieved item is a
  // whole conversation. Turn/fact arms are closer to how memory is actually
  // written, and they make precision/token metrics meaningful.
  const granularityArg = args
    .find((a) => a.startsWith("--node-granularity="))
    ?.split("=")[1];
  const nodeGranularity: "session" | "turn" | "fact" =
    granularityArg === "turn" || granularityArg === "fact"
      ? granularityArg
      : "session";
  if (
    granularityArg &&
    granularityArg !== "session" &&
    granularityArg !== "turn" &&
    granularityArg !== "fact"
  ) {
    console.warn(
      `[bench-longmemeval] unknown --node-granularity=${granularityArg}; using session.`,
    );
  }
  if (
    nodeGranularity === "fact" &&
    args.some((a) => a.startsWith("--session-chunk-messages="))
  ) {
    console.warn(
      "[bench-longmemeval] --node-granularity=fact ignores --session-chunk-messages.",
    );
  }
  const chunkMessages =
    nodeGranularity === "turn"
      ? 1
      : Math.max(
          0,
          parseInt(
            args
              .find((a) => a.startsWith("--session-chunk-messages="))
              ?.split("=")[1] ?? "0",
            10,
          ) || 0,
        );
  const keyExpansion = args.includes("--key-expansion");
  const llmQueryExpansion =
    args.includes("--llm-query-expansion") && Boolean(B_AI_API_KEY);
  if (args.includes("--llm-query-expansion") && !B_AI_API_KEY) {
    console.warn(
      "[bench-longmemeval] --llm-query-expansion needs OPENAI_API_KEY; using the original query only.",
    );
  }

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
  // Comparison arm for end-to-end scoring. "memory" is the system under test;
  // the other two are baselines that must be measured with the SAME answer
  // model and judge, otherwise the delta is meaningless.
  const arm = parseArm(args);
  // Hybrid ablation. Omit → all pools (memories + raw sessions, the hybrid
  // configuration). `--pool=note,procedure` → distilled memories only, which
  // is the like-for-like comparison against a memories-only search mode.
  const poolArg = args.find((a) => a.startsWith("--pool="))?.split("=")[1];
  const pools = poolArg
    ? (poolArg
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean) as MemoryPool[])
    : undefined;
  // Full-context baseline can be huge; cap it so a run stays affordable.
  const fullContextChars = Number(
    args.find((a) => a.startsWith("--full-context-chars="))?.split("=")[1] ??
      "200000",
  );
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
  const sampleMode =
    (args.find((a) => a.startsWith("--sample="))?.split("=")[1] as
      "stratified" | "prefix" | undefined) ?? "stratified";
  const typeFilter = args.find((a) => a.startsWith("--types="))?.split("=")[1];
  const allowedTypes = typeFilter
    ? new Set(typeFilter.split(",").map((value) => value.trim()))
    : null;
  const pool = allowedTypes
    ? questions.filter((question) => allowedTypes.has(question.question_type))
    : questions;
  const limited = sampleQuestions(pool, maxQuestions, sampleMode);
  const preferences = args.includes("--preferences");

  console.log(
    `[bench-longmemeval] Loaded ${limited.length}/${questions.length} questions | mode: ${retrieveOnly ? "retrieval-only (deterministic session-ID scoring)" : "LLM answer + judge"}`,
  );
  if (!retrieveOnly) {
    console.log(
      `[bench-longmemeval] arm=${arm} | answer=${LLM_CFG.answerModel} | judge=${LLM_CFG.judgeModel} | temp=${LLM_CFG.temperature}` +
        ` | pools=${pools ? pools.join("+") : "all (hybrid)"}`,
    );
  }
  const sizeWarning = sampleSizeWarning(limited.length);
  if (sizeWarning) console.warn(`[bench-longmemeval] ⚠ ${sizeWarning}`);

  const embeddingsOff = args.includes("--no-embeddings");
  const dbPathArg = args.find((a) => a.startsWith("--db="))?.split("=")[1];
  const keepDb = dbPathArg !== undefined;
  const provider = embeddingsOff ? null : buildProvider(providerArgs);
  const runtimeInfo: EmbeddingRuntimeInfo = embeddingsOff
    ? {
        requestedProvider: "none",
        resolvedProvider: "none",
        requestedModel: "none",
        resolvedModel: "none",
        modelRevision: null,
        requestedDimensions: 0,
        observedDimensions: null,
        fallbackActive: false,
        fallbackReason: null,
      }
    : await assertNoFallback(provider!, providerArgs);
  const dbPath =
    dbPathArg ?? join(tmpdir(), `bench-longmemeval-${Date.now()}.db`);
  console.log(`[bench-longmemeval] db=${dbPath} keep=${keepDb}`);
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
      ...(retrievalCfg.experimental ?? {}),
    },
    embeddings: embeddingsOff
      ? { enabled: false }
      : {
          enabled: true,
          provider: provider!,
          ...(providerArgs.model ? { model: providerArgs.model } : {}),
          ...(providerArgs.dimensions
            ? { dimensions: providerArgs.dimensions }
            : {}),
          ...(retrievalCfg.embeddings ?? {}),
        },
    ...(retrievalCfg.fusion ? { fusion: retrievalCfg.fusion } : {}),
    ...(retrievalCfg.retrieval ? { retrieval: retrievalCfg.retrieval } : {}),
    embeddingQueue: { concurrency: 4, batchSize: 16, maxQueueSize: 60000 },
  });

  await memos.init();

  // ─── Phase 1: Store sessions (per-question namespace) ───────────────────
  const storeStart = Date.now();
  let totalMemories = 0;
  const storage = (
    memos as unknown as {
      storage: {
        queryNodes(filter: {
          namespace: string;
          limit: number;
        }): Promise<unknown[]>;
      };
    }
  ).storage;
  const expectedNodes = (q: LongMemEvalQuestion): number => {
    let count = 0;
    for (const session of q.haystack_sessions) {
      if (!Array.isArray(session) || session.length === 0) continue;
      count +=
        chunkMessages === 0 ? 1 : Math.ceil(session.length / chunkMessages);
    }
    return count;
  };
  for (const [i, q] of limited.entries()) {
    const namespace = `longmemeval_${q.question_id}`;
    const expected = expectedNodes(q);
    if (keepDb && nodeGranularity !== "fact") {
      const existing = await storage.queryNodes({
        namespace,
        limit: expected + 1,
      });
      // `queryNodes` does not filter on embedding presence, so `existing` is
      // "rows written", not "rows searchable". That distinction matters: a
      // crash lands after the rows are written and before the embedding
      // queue persists their vectors, and the previous code then treated the
      // namespace as done (skipping it) even though none of it had vectors.
      // Re-embedding a fully-written namespace is idempotent, and cheap
      // relative to a re-run, so do it whenever rows exist but the in-memory
      // graph has nothing embedded for them.
      if (existing.length >= expected && !embeddingsOff) {
        await memos.backfillNamespaceEmbeddings(namespace);
      }
      if (existing.length >= expected) {
        totalMemories += expected;
        continue;
      }
      if (existing.length > 0) {
        // Why this branch must not simply re-write: fast-ingest writes
        // DETERMINISTIC node ids (`lme_<qid>_<position>_<chunk>`), so
        // re-storing a half-written namespace re-inserts ids that already
        // exist and aborts the whole run with
        // SQLITE_CONSTRAINT_PRIMARYKEY on nodes.id. Finish it instead:
        // re-embed what is there, then write only the missing sessions.
        //
        // The ids must come from a direct node listing, NOT from
        // `queryNodes`: that path goes through scored retrieval, applies
        // default limits/filters, and is free to return rows that are not
        // what the resume needs. A wrong/partial set here silently
        // re-writes an existing id and kills the run.
        const present = new Set(await memos.listNamespaceNodeIds(namespace));
        console.log(
          `  [resume] ${q.question_id}: ${existing.length}/${expected} rows, ${present.size} ids known; completing in place`,
        );
        if (!embeddingsOff) {
          await memos.backfillNamespaceEmbeddings(namespace);
        }
        totalMemories += await storeSessions(memos, q, {
          concurrency: ingestConcurrency,
          chunkMessages,
          keyExpansion,
          fastIngest,
          nodeGranularity,
          preferences,
          skipNodeIds: fastIngest ? present : undefined,
        });
        continue;
      }
    }
    totalMemories += await storeSessions(memos, q, {
      concurrency: ingestConcurrency,
      chunkMessages,
      keyExpansion,
      fastIngest,
      nodeGranularity,
      preferences,
    });
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
    tokens: number;
  }> = [];

  const retrievalLimit =
    chunkMessages > 0 || nodeGranularity === "fact" ? topK * 6 : topK;

  // Pre-embed every question in batched provider calls. Each search() embeds
  // its query otherwise; a local embedder answers a batch at roughly the cost
  // of one request (measured 2.3x end-to-end on retrieval), and cached vectors
  // are byte-identical, so this is latency-only.
  if (queryPrewarm && !embeddingsOff) {
    const prewarmStart = Date.now();
    const { embedded } = await memos.prewarmQueryEmbeddings(
      limited.map((q) => q.question),
    );
    console.log(
      `[bench-longmemeval] Pre-embedded ${embedded} queries in ${Date.now() - prewarmStart}ms`,
    );
  }

  for (const [i, q] of limited.entries()) {
    const namespace = `longmemeval_${q.question_id}`;
    const startTime = Date.now();
    const results = await memos.search({
      query: q.question,
      limit: retrievalLimit,
      namespace,
      ...(candidateDepth ? { candidateDepth } : {}),
      ...(pools ? { pool: pools } : {}),
      ...(retrievalArgs.ftsOperator
        ? { ftsOperator: retrievalArgs.ftsOperator }
        : {}),
      sessionExpansion: retrievalArgs.sessionExpansion ?? false,
      // Chronological neighbour expansion is a shipped product feature
      // (`SearchFilter.sessionNeighbours`), so the benchmark exercises the
      // real retrieval path rather than a harness-only post-pass.
      sessionNeighbours: neighbourGuard ? { radius: 2 } : false,
      // Anchor relative time expressions against the question's own clock.
      relativeTimeBoost: !args.includes("--no-relative-time"),
      validAt: Number.isFinite(Date.parse(String(q.question_date)))
        ? Date.parse(String(q.question_date))
        : undefined,
    });
    const sessionIds = (rows: typeof results) =>
      dedupeRankedIds(
        rows
          .map((r) => String(r.node.metadata?.sessionId ?? ""))
          .filter(Boolean),
      );
    const lists = [sessionIds(results)];
    if (llmQueryExpansion) {
      const variants = await expandQuery(q.question, LLM_CFG, LLM_USAGE);
      for (const variant of variants) {
        const variantResults = await memos.search({
          query: variant,
          limit: retrievalLimit,
          namespace,
          ...(candidateDepth ? { candidateDepth } : {}),
          ...(pools ? { pool: pools } : {}),
          ...(retrievalArgs.ftsOperator
            ? { ftsOperator: retrievalArgs.ftsOperator }
            : {}),
          sessionExpansion: retrievalArgs.sessionExpansion ?? false,
        });
        lists.push(sessionIds(variantResults));
      }
    }
    const elapsed = Date.now() - startTime;

    // Direct session-ID comparison (deterministic, always computed —
    // independent of whether the LLM path also runs). Multi-query
    // decomposition is fused by reciprocal rank.
    //
    // No post-processing happens here: neighbour expansion and relative-time
    // anchoring are applied inside `memos.search()` as shipped features, so
    // the number below describes what a user of the library actually gets.
    const retrievedIds =
      lists.length > 1 ? fuseSessionLists(lists) : (lists[0] ?? []);
    const relevantIds = (q.answer_session_ids ?? []).filter(
      (s) => typeof s === "string" && s.length > 0,
    );
    evalQueries.push({
      questionId: q.question_id,
      relevantIds,
      retrievedIds,
      category: q.question_type,
      latencyMs: elapsed,
    });

    if (!retrieveOnly) {
      const tokensBefore = LLM_USAGE.totalTokens;
      let answerInput: Array<{
        content: string;
        timestamp: string;
        source?: string;
      }>;

      if (arm === "memory") {
        answerInput = results.map((r) => ({
          content: r.node.content ?? "",
          timestamp: String(r.node.metadata?.timestamp ?? "unknown"),
          source: String(r.node.pool ?? "memory"),
        }));
        if (preferences && isPreferenceQuestion(q.question)) {
          const prefHits = await memos.searchPreferences(q.question, {
            namespace: `longmemeval_${q.question_id}`,
            limit: 5,
          });
          if (prefHits.length > 0) {
            answerInput = [
              ...prefHits.map((hit) => ({
                content: hit.node.content,
                timestamp: "preference",
                source: "preference",
              })),
              ...answerInput,
            ];
          }
        }
      } else if (arm === "full-context") {
        // Upper-bound baseline: every haystack session with no retrieval at
        // all. This is the number a memory layer has to beat to justify its
        // existence, and it is the arm most vendors quietly omit.
        const parts: string[] = [];
        let used = 0;
        for (const session of q.haystack_sessions) {
          if (!Array.isArray(session) || session.length === 0) continue;
          const text = session.map((m) => `${m.role}: ${m.content}`).join("\n");
          if (used + text.length > fullContextChars) break;
          used += text.length;
          parts.push(text);
        }
        answerInput = [
          {
            content: parts.join("\n\n"),
            timestamp: String(q.question_date ?? "unknown"),
            source: "raw-session",
          },
        ];
      } else {
        // Floor: no context. Separates "the memory system found it" from
        // "the answer model already knew it".
        answerInput = [];
      }

      const predicted = await answerQuestion(q.question, answerInput, arm);
      const score = await judgeAnswer(q.question, q.answer, predicted);
      llmScores.push({
        questionId: q.question_id,
        category: q.question_type,
        score,
        tokens: LLM_USAGE.totalTokens - tokensBefore,
      });

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }

    if ((i + 1) % 10 === 0) {
      console.log(`  Processed ${i + 1}/${limited.length} questions`);
    }
  }

  await memos.close();
  if (!keepDb) {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    for (const ext of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${ext}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
  }

  // ─── Phase 3: Score & report ────────────────────────────────────────────
  const report = aggregateMetrics(evalQueries);
  const atK = metricsAtK(evalQueries, topK);
  const perCategoryAtK = categoryMetricsAtK(evalQueries, topK);
  const durationMs = Date.now() - benchStart;
  const e2e = retrieveOnly ? null : buildE2ESummary(llmScores);
  const correctAnswers = llmScores.filter((row) => row.score >= 1).length;
  const answerJudgeTokens = llmScores.reduce((sum, row) => sum + row.tokens, 0);
  const tokensPerCorrectAnswer =
    correctAnswers > 0 ? answerJudgeTokens / correctAnswers : null;
  printReport(report, {
    e2e,
    atK,
    retrieveOnly,
    topK,
    durationMs,
    ingestionMs,
    providerArgs,
    runtimeInfo,
    llmScores,
    questions: limited.length,
    arm,
  });

  // SEPARATE results file from the LoCoMo benchmarks.
  const outPath =
    args.find((a) => a.startsWith("--out="))?.split("=")[1] ??
    "scripts/bench-longmemeval-results.json";
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
        questionSample: maxQuestions ? sampleMode : "full",
        categoryMix: countBy(limited.map((q) => q.question_type)),
        // Written unconditionally so a short smoke run can never be mistaken
        // for a publishable full run. A results file that silently claims
        // coverage it does not have is worse than no results file.
        sampleSizeWarning: sampleSizeWarning(evalQueries.length),
        topK,
        arm: retrieveOnly ? null : arm,
        pools: pools ?? null,
        retrieval: {
          candidateDepth: candidateDepth ?? Math.max(topK * 4, 20),
          keywordWeight: retrievalArgs.fusion.keywordWeight ?? 0.8,
          semanticWeight: retrievalArgs.fusion.semanticWeight ?? 0.2,
          rrfK: retrievalArgs.fusion.rrfK ?? 60,
          rerank: rerankUrl ?? null,
          contextual: retrievalArgs.contextual ?? false,
          embedText: retrievalArgs.embedText ?? "summary+content",
          sessionExpansion: retrievalArgs.sessionExpansion,
          // Provenance for the two post-ranking stages. A result file that
          // does not say whether the neighbour guard ran is ambiguous: it
          // changes all-evidence recall but not hit@K.
          neighbourGuard,
          queryPrewarm: queryPrewarm && !embeddingsOff,
          ingestConcurrency,
          nodeGranularity,
          sessionChunkMessages: chunkMessages,
          keyExpansion,
          llmQueryExpansion,
        },
        durationMs,
        ingestionMs,
        metrics: { at5: report.at5, at10: report.at10, atK, atKDepth: topK },
        perCategory: report.perCategory,
        perCategoryAtK,
        perQuestion: report.perQuestion.map((q) => ({
          questionId: q.questionId,
          category: q.category,
          relevantIds: q.relevantIds,
          retrievedIds: q.retrievedIds.slice(0, topK),
          relevantRetrievedAt5: q.relevantRetrievedAt5,
          relevantRetrievedAt10: q.relevantRetrievedAt10,
          latencyMs: q.latencyMs,
        })),
        ...(llmQueryExpansion
          ? {
              queryExpansion: {
                ...llmProvenance(LLM_CFG),
                usage: { ...LLM_USAGE },
              },
            }
          : {}),
        ...(retrieveOnly
          ? {}
          : {
              llmJudge: {
                note: "LLM-judge scores are a SEPARATE end-to-end metric; never mix with retrieval metrics.",
                overall: e2e ? e2e.overall.point : 0,
                overallCI: e2e ? [e2e.overall.low, e2e.overall.high] : null,
                perCategoryCI: e2e ? e2e.perCategory : {},
                sampleSizeWarning: e2e ? e2e.sampleSizeWarning : null,
                ...llmProvenance(LLM_CFG),
                usage: { ...LLM_USAGE },
                efficiency: {
                  correctAnswers,
                  answerJudgeTokens,
                  tokensPerCorrectAnswer,
                },
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

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

/**
 * Choose which questions a partial run covers.
 *
 * LongMemEval ships SORTED BY CATEGORY: questions 0–69 are all
 * `single-session-user`, 70–169 `multi-session`, and so on. A prefix slice is
 * therefore a biased sample — `--max-questions=25` yields 100%
 * single-session-user, the easiest category in the benchmark. That is how a
 * 92% number ended up in a results file: it was not a small sample of the
 * benchmark, it was a different, easier benchmark.
 *
 * `stratified` (default) allocates proportionally across all six categories
 * using largest-remainder, then picks evenly-spaced items within each
 * category. Deterministic — the same `--max-questions` always selects the same
 * subset, so runs stay comparable.
 */
function sampleQuestions(
  questions: LongMemEvalQuestion[],
  max: number | undefined,
  mode: "stratified" | "prefix",
): LongMemEvalQuestion[] {
  if (max === undefined || max <= 0 || max >= questions.length) {
    return questions;
  }
  if (mode === "prefix") return questions.slice(0, max);

  const byCat = new Map<string, LongMemEvalQuestion[]>();
  for (const q of questions) {
    const arr = byCat.get(q.question_type) ?? [];
    arr.push(q);
    byCat.set(q.question_type, arr);
  }
  const cats = [...byCat.keys()].sort((a, b) => a.localeCompare(b));

  // Proportional allocation (largest remainder), capped per category.
  const total = questions.length;
  const counts = cats.map((c) =>
    Math.floor(((byCat.get(c)?.length ?? 0) / total) * max),
  );
  let assigned = counts.reduce((s, x) => s + x, 0);
  const order = cats
    .map((c, i) => ({ i, size: byCat.get(c)?.length ?? 0 }))
    .sort((a, b) => b.size - a.size || a.i - b.i);
  let cursor = 0;
  let guard = 0;
  while (assigned < max && guard < 10000) {
    let progressed = false;
    for (const { i, size } of order) {
      if (assigned >= max) break;
      if ((counts[i] ?? 0) < size) {
        counts[i] = (counts[i] ?? 0) + 1;
        assigned++;
        progressed = true;
      }
    }
    cursor++;
    if (!progressed) break;
    guard++;
  }
  void cursor;

  const out: LongMemEvalQuestion[] = [];
  for (let i = 0; i < cats.length; i++) {
    const arr = byCat.get(cats[i] ?? "") ?? [];
    const take = counts[i] ?? 0;
    if (take <= 0 || arr.length === 0) continue;
    const step = arr.length / take;
    for (let j = 0; j < take; j++) {
      const item = arr[Math.floor(j * step)];
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * Aggregate retrieval metrics at an arbitrary K. `aggregateMetrics` only
 * reports @5/@10, which is right for LoCoMo but wrong for LongMemEval:
 * Supermemory's published number is Recall@20, so the comparison must be
 * at the same depth. Zeros for empty-relevance questions are excluded
 * exactly like `aggregateMetrics` does.
 */
function metricsAtK(queries: EvalQueryResult[], k: number): MetricsAtK {
  const scoreable = queries.filter((q) => q.relevantIds.length > 0);
  if (scoreable.length === 0) {
    return {
      hitRate: 0,
      evidenceRecall: 0,
      evidenceRecallMicro: 0,
      allEvidenceRecall: 0,
      precision: 0,
      precisionMicro: 0,
      mrr: 0,
      ndcg: 0,
      questionCount: 0,
    };
  }
  let hit = 0;
  let ev = 0;
  let allEv = 0;
  let prec = 0;
  let mrr = 0;
  let ndcg = 0;
  let relevantInTop = 0;
  let relevantTotal = 0;
  let scoredDepth = 0;
  for (const q of scoreable) {
    const r = evaluateQueryAtK(
      q.relevantIds,
      dedupeRankedIds(q.retrievedIds),
      k,
    );
    hit += r.hitRate;
    ev += r.evidenceRecall;
    allEv += r.allEvidenceRecall;
    prec += r.precision;
    mrr += r.mrr;
    ndcg += r.ndcg;
    relevantInTop += r.relevantInTop;
    relevantTotal += q.relevantIds.length;
    scoredDepth += r.scoredDepth;
  }
  const n = scoreable.length;
  return {
    hitRate: hit / n,
    evidenceRecall: ev / n,
    evidenceRecallMicro: relevantTotal > 0 ? relevantInTop / relevantTotal : 0,
    allEvidenceRecall: allEv / n,
    precision: prec / n,
    precisionMicro: scoredDepth > 0 ? relevantInTop / scoredDepth : 0,
    mrr: mrr / n,
    ndcg: ndcg / n,
    questionCount: n,
  };
}

function categoryMetricsAtK(
  queries: EvalQueryResult[],
  k: number,
): Record<string, MetricsAtK> {
  const categories = [
    ...new Set(
      queries.filter((q) => q.relevantIds.length > 0).map((q) => q.category),
    ),
  ].sort();
  const out: Record<string, MetricsAtK> = {};
  for (const category of categories) {
    out[category] = metricsAtK(
      queries.filter((q) => q.category === category),
      k,
    );
  }
  return out;
}

function printAtK(report: MetricsAtK, k: number): void {
  const fmt = (x: number): string => (x * 100).toFixed(1).padStart(5) + "%";
  console.log(`\nMetrics @${k} (the Supermemory-comparable depth):`);
  console.log(`Hit rate                    ${fmt(report.hitRate)}`);
  console.log(`Evidence recall (per-Q)     ${fmt(report.evidenceRecall)}`);
  console.log(`All-evidence recall         ${fmt(report.allEvidenceRecall)}`);
  console.log(`Precision                   ${fmt(report.precision)}`);
  console.log(`MRR                         ${report.mrr.toFixed(3)}`);
  console.log(`nDCG                        ${report.ndcg.toFixed(3)}`);
}

function printReport(
  report: MetricsReport,
  ctx: {
    retrieveOnly: boolean;
    atK: MetricsAtK;
    topK: number;
    durationMs: number;
    ingestionMs: number;
    providerArgs: BenchProviderArgs;
    runtimeInfo: EmbeddingRuntimeInfo;
    llmScores: Array<{
      questionId: string;
      category: string;
      score: number;
      tokens?: number;
    }>;
    questions: number;
    e2e: E2ESummary | null;
    arm: BenchArm;
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
  printAtK(ctx.atK, ctx.topK);
  // Name the two recall definitions explicitly. "Hit@K" (any evidence session
  // found) and "all-evidence@K" (every annotated session found) differ by
  // several points and only the second one decides whether an answer is
  // possible, so a report that prints one bare "recall" invites the exact
  // comparison error this harness exists to prevent.
  console.log(
    `\nK=${ctx.topK} definitions: Hit@K = at least ONE evidence session retrieved ` +
      `(${fmt(ctx.atK.hitRate).trim()}); all-evidence@K = EVERY labelled evidence session ` +
      `retrieved, i.e. recall_all (${fmt(ctx.atK.allEvidenceRecall).trim()}).`,
  );

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

  if (!ctx.retrieveOnly && ctx.e2e && ctx.llmScores.length > 0) {
    const e2e = ctx.e2e;
    console.log(
      `\nLLM-judge end-to-end accuracy (arm=${ctx.arm}, answer=${LLM_CFG.answerModel}, judge=${LLM_CFG.judgeModel}):`,
    );
    console.log(`  Overall        ${formatIntervalPct(e2e.overall)}`);
    console.log("  ─────────────────────────────────────────────────");
    for (const [cat, iv] of Object.entries(e2e.perCategory)) {
      const flag = iv.n < 30 ? "  ⚠ small n" : "";
      console.log(
        `  ${cat.padEnd(28)}${formatIntervalPct(iv).padStart(22)}  (n=${iv.n})${flag}`,
      );
    }
    console.log(
      `\n  Tokens: ${LLM_USAGE.totalTokens} total across ${LLM_USAGE.calls} calls (${LLM_USAGE.errors} errors)`,
    );
    const correct = ctx.llmScores.filter((row) => row.score >= 1).length;
    const answerJudgeTokens = ctx.llmScores.reduce(
      (sum, row) => sum + (row.tokens ?? 0),
      0,
    );
    if (correct > 0 && answerJudgeTokens > 0) {
      console.log(
        `  Tokens per correct answer: ${Math.round(answerJudgeTokens / correct)} ` +
          `(${answerJudgeTokens} answer+judge tokens / ${correct} correct)`,
      );
    }
    if (e2e.sampleSizeWarning) {
      console.warn(`\n  ⚠ ${e2e.sampleSizeWarning}`);
    }
    console.log(
      "\n  End-to-end accuracy is NOT comparable to retrieval metrics, and only\n" +
        "  comparable to another vendor's number when the answer model, judge\n" +
        "  model and question set are identical. Run --arm=full-context and\n" +
        "  --arm=no-memory to get the baselines that make this number mean something.",
    );
  }
}

interface E2ESummary {
  overall: ReturnType<typeof bootstrapAccuracyCI>;
  perCategory: Record<string, ReturnType<typeof bootstrapAccuracyCI>>;
  sampleSizeWarning: string | null;
}

/**
 * Bootstrap every end-to-end number, overall and per category.
 *
 * Per-category intervals matter more than the headline: LongMemEval's six
 * categories have wildly different n (30 for single-session-preference, 133
 * for multi-session), so a per-category table without n is actively
 * misleading.
 */
function buildE2ESummary(
  scores: Array<{ questionId: string; category: string; score: number }>,
): E2ESummary {
  const all = scores.map((s) => s.score);
  const byCat = new Map<string, number[]>();
  for (const s of scores) {
    const arr = byCat.get(s.category) ?? [];
    arr.push(s.score);
    byCat.set(s.category, arr);
  }
  const perCategory: E2ESummary["perCategory"] = {};
  for (const [cat, arr] of [...byCat.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    perCategory[cat] = bootstrapAccuracyCI(arr);
  }
  return {
    overall: bootstrapAccuracyCI(all),
    perCategory,
    sampleSizeWarning: sampleSizeWarning(all.length),
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
