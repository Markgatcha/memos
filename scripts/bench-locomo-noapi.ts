#!/usr/bin/env npx tsx
/**
 * ─── LoCoMo Retrieval-Only Benchmark for MemOS (no API, no LLM) ──────────────
 *
 * Runs the actual LOCOMO dataset (snap-research/locomo) against MemOS and
 * scores retrieval quality by DIRECT EVIDENCE-ID comparison:
 *
 *   1. Ingests each utterance with its LoCoMo `dia_id` (e.g. "D7:14") stored
 *      in memory metadata — the ID the dataset's `qa.evidence` array uses.
 *   2. For each QA pair, searches MemOS (hybrid FTS + semantic).
 *   3. Scores the retrieved `dia_id`s against `qa.evidence` with
 *      deterministic metrics: Hit@K, Evidence Recall@K, All-Evidence
 *      Recall@K, Precision@K, MRR, nDCG@K — per category, macro and micro.
 *   4. Writes results to scripts/bench-locomo-noapi-results.json (separate
 *      from the LLM-judge bench results file) plus full reproducibility
 *      metadata (git SHA, dataset hash, provider + fallback status).
 *
 * NO fuzzy text matching is used for scoring. A legacy fuzzy-overlap score
 * is computed ONLY as a clearly-labeled diagnostic so the two scoring
 * conventions can be compared run-over-run — it is never reported as
 * evidence recall.
 *
 * Category mapping follows the official LoCoMo evaluation code
 * (task_eval/evaluation.py): 1=multi-hop, 2=temporal, 3=open-domain,
 * 4=single-hop, 5=adversarial. Both benchmark scripts previously mapped
 * cat 1/4 backwards — the dataset's own evidence distribution confirms
 * the official mapping (276/282 cat-1 questions carry 2+ evidence IDs;
 * 795/841 cat-4 questions carry exactly 1).
 *
 * Usage:
 *   npx tsx scripts/bench-locomo-noapi.ts --topk=10 --convs=2
 *   npx tsx scripts/bench-locomo-noapi.ts --provider=local-hash --topk=10
 *   npx tsx scripts/bench-locomo-noapi.ts --provider=fastembed --model=Xenova/gemma-300m-e5-it-v1 \
 *       --dimensions=768 --fail-on-embedding-fallback
 *
 * Provider flags (CLI > env > default local-hash):
 *   --provider=local-hash|fastembed|ollama|openai-compatible|voyage|cohere
 *   --model=<name>  --dimensions=<n>  --base-url=<url>  --api-key=<key>
 *   --fail-on-embedding-fallback   terminate if the requested backend did not load
 *
 * Results: scripts/bench-locomo-noapi-results.json
 */

import { MemOS } from "../src/memory.ts";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
  type MetricsReport,
} from "./lib/bench-metrics.ts";

// ─── LoCoMo data types ───────────────────────────────────────────────────────

interface LocoChat {
  speaker: string;
  /** Official evidence unit id, e.g. "D1:3" — the exact value that
   *  appears in qa.evidence. */
  dia_id: string;
  text: string;
}

interface LocoConversation {
  conversation: {
    speaker_a: string;
    speaker_b: string;
    [key: string]: unknown;
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

/**
 * Official LoCoMo category mapping (task_eval/evaluation.py):
 * 1 = multi-hop, 2 = temporal, 3 = open-domain, 4 = single-hop,
 * 5 = adversarial. The dataset's evidence distribution corroborates:
 * cat 1 overwhelmingly carries 2+ evidence ids (multi-hop), cat 4 exactly 1.
 */
const CATEGORY_NAMES: Record<number, string> = {
  1: "multi_hop",
  2: "temporal",
  3: "open_domain",
  4: "single_hop",
  5: "adversarial",
};

function categoryName(cat: number): string {
  return CATEGORY_NAMES[cat] ?? `cat_${cat}`;
}

/**
 * Group consecutive utterances into conversational EXCHANGES (pairs) —
 * the natural memory unit for dialogue. LoCoMo sessions strictly
 * alternate speakers, so pairing (a) makes each memory self-contained
 * (a question travels with its answer, giving the embedder and reranker
 * real context instead of a dangling "sure, Tuesday works") and (b) lets
 * one retrieved node carry TWO official dia_ids, which multi-evidence /
 * multi-hop scoring needs. Each grouped node keeps all its dia_ids in
 * metadata (`dia_ids`) plus the first one in `dia_id` for compatibility.
 * Odd trailing utterances form a single-message group.
 */
function groupTurns(chats: LocoChat[]): Array<{
  dia_ids: string[];
  speaker: string;
  texts: string[];
}> {
  const groups: Array<{ dia_ids: string[]; speaker: string; texts: string[] }> =
    [];
  for (let i = 0; i < chats.length; i += 2) {
    const pair = chats.slice(i, i + 2).filter((c) => c?.dia_id);
    if (pair.length === 0) continue;
    groups.push({
      dia_ids: pair.map((c) => c.dia_id),
      speaker: pair[0].speaker,
      texts: pair.map((c) => c.text),
    });
  }
  return groups;
}

// ─── Fuzzy diagnostic (NOT a scoring metric) ─────────────────────────────────

/**
 * Legacy fuzzy term-overlap heuristic, kept ONLY as a labeled diagnostic.
 * This is the scoring the benchmark used before evidence-ID matching — it
 * over-counts (any lexically similar utterance passes). Comparing the two
 * numbers quantifies how much the old scoring inflated recall.
 */
function fuzzyOverlapDiagnostic(
  evidenceTexts: string[],
  retrievedContents: string[],
): boolean {
  const stop = new Set([
    "this",
    "that",
    "with",
    "have",
    "they",
    "them",
    "what",
    "when",
    "where",
    "from",
    "been",
    "were",
    "said",
    "will",
    "just",
    "like",
  ]);
  for (const evidenceText of evidenceTexts) {
    const core = evidenceText.includes(": ")
      ? (evidenceText.split(": ", 2)[1] ?? evidenceText)
      : evidenceText;
    const evidenceTerms = core
      .toLowerCase()
      .split(/[\s,.!?'-]+/)
      .filter((w) => w.length > 3 && !stop.has(w));
    for (const content of retrievedContents) {
      const c = content.toLowerCase();
      if (c.includes(core.toLowerCase())) return true;
      const contentTerms = new Set(
        c.split(/[\s,.!?'-]+/).filter((w) => w.length > 3),
      );
      const matchCount = evidenceTerms.filter((t) =>
        contentTerms.has(t),
      ).length;
      if (matchCount >= Math.min(evidenceTerms.length, 2)) return true;
      const speakerPrefix = evidenceText.includes(": ")
        ? (evidenceText.split(": ", 2)[0] ?? "").toLowerCase()
        : "";
      if (speakerPrefix && c.startsWith(speakerPrefix) && matchCount >= 1) {
        return true;
      }
    }
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const topK =
    parseInt(
      args.find((a) => a.startsWith("--topk="))?.split("=")[1] ?? "10",
      10,
    ) || 10;
  const convsArg = args.find((a) => a.startsWith("--convs="));
  const maxConvos = convsArg ? parseInt(convsArg.split("=")[1] ?? "2", 10) : 2;
  // Two-stage / ingestion ablation flags.
  const groupTurnsFlag = args.includes("--group-turns");
  const depthArg = args.find((a) => a.startsWith("--candidate-depth="));
  const candidateDepth = depthArg
    ? parseInt(depthArg.split("=")[1] ?? "", 10)
    : undefined;
  const rerankUrlArg = args.find((a) => a.startsWith("--rerank-url="));
  const rerankUrl = rerankUrlArg?.split("=")[1];
  const rerankModelArg = args.find((a) => a.startsWith("--rerank-model="));
  const rerankCandidatesArg = args.find((a) =>
    a.startsWith("--rerank-candidates="),
  );
  const rerankTimeoutArg = args.find((a) => a.startsWith("--rerank-timeout="));
  const rerankMaxDocCharsArg = args.find((a) =>
    a.startsWith("--rerank-max-doc-chars="),
  );

  const providerArgs = parseProviderArgs(args);
  const retrievalArgs = parseRetrievalArgs(args);
  const datasetPath =
    args.find((a) => a.startsWith("--dataset="))?.split("=")[1] ??
    "scripts/dataset/locomo/data/locomo10.json";
  if (!existsSync(datasetPath)) {
    console.error(
      "Dataset not found. Run: git clone --depth 1 https://github.com/snap-research/locomo.git scripts/dataset/locomo",
    );
    process.exit(1);
  }

  const conversations: LocoConversation[] = JSON.parse(
    readFileSync(datasetPath, "utf8"),
  ).slice(0, maxConvos);

  const provider = buildProvider(providerArgs);
  // Resolve lazy providers and detect fallback BEFORE ingesting anything.
  const runtimeInfo = await assertNoFallback(provider, providerArgs);

  // Deterministic temp DB (timestamped, cleaned in finally).
  const dbPath = join(tmpdir(), `bench-locomo-noapi-${Date.now()}.db`);
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
              ...(rerankCandidatesArg
                ? {
                    candidates: parseInt(
                      rerankCandidatesArg.split("=")[1] ?? "50",
                      10,
                    ),
                  }
                : {}),
              ...(rerankTimeoutArg
                ? {
                    timeoutMs: parseInt(
                      rerankTimeoutArg.split("=")[1] ?? "5000",
                      10,
                    ),
                  }
                : {}),
              ...(rerankMaxDocCharsArg
                ? {
                    maxDocChars: parseInt(
                      rerankMaxDocCharsArg.split("=")[1] ?? "0",
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
      // Pass model/dimensions through so storage records match the request.
      ...(providerArgs.model ? { model: providerArgs.model } : {}),
      ...(providerArgs.dimensions
        ? { dimensions: providerArgs.dimensions }
        : {}),
      ...(retrievalArgs.embedText
        ? { embedText: retrievalArgs.embedText }
        : {}),
    },
    ...(Object.keys(retrievalConfig(retrievalArgs)).length > 0
      ? retrievalConfig(retrievalArgs)
      : {}),
    embeddingQueue: { concurrency: 4, batchSize: 16 },
  });

  await memos.init();

  // Per-question evaluation records (scored after ingestion).
  const evalQueries: EvalQueryResult[] = [];
  const diagnosticFuzzyHits: number[] = []; // per-question 0/1, diagnostic only
  const benchStart = Date.now();
  let ingestionMs = 0;

  try {
    for (let convIdx = 0; convIdx < conversations.length; convIdx++) {
      const conv = conversations[convIdx]!;
      const { conversation } = conv;
      const sessionKeys = Object.keys(conversation).filter(
        (k) =>
          k !== "speaker_a" && k !== "speaker_b" && !k.endsWith("_date_time"),
      ) as Array<`session_${number}`>;

      // ── Ingestion: store every utterance WITH its dia_id ──────────────
      const ingestStart = Date.now();
      // Build a map dia_id → evidence text for the fuzzy diagnostic.
      const evidenceTextMap = new Map<string, string>();
      for (const sessionKey of sessionKeys) {
        const chats = conversation[sessionKey] as unknown as LocoChat[];
        if (!Array.isArray(chats)) continue;
        const sessionDateKey = `${sessionKey}_date_time`;
        const sessionTimestamp = String(
          (conversation as Record<string, unknown>)[sessionDateKey] ?? "",
        );
        if (groupTurnsFlag) {
          // Conversational exchanges (utterance pairs) become one memory
          // node carrying all their dia_ids.
          for (const turn of groupTurns(chats)) {
            turn.dia_ids.forEach((id, i) => {
              evidenceTextMap.set(id, `${turn.speaker}: ${turn.texts[i]}`);
            });
            await memos.store(`${turn.speaker}: ${turn.texts.join("\n")}`, {
              namespace: `locomo_conv_${convIdx}`,
              metadata: {
                dia_id: turn.dia_ids[0],
                dia_ids: turn.dia_ids,
                benchmark: "locomo",
                instanceId: `locomo_conv_${convIdx}`,
                speaker: turn.speaker,
                sessionId: sessionKey,
                timestamp: sessionTimestamp,
              },
            });
          }
        } else {
          for (const chat of chats) {
            if (!chat?.dia_id) continue;
            const content = `${chat.speaker}: ${chat.text}`;
            evidenceTextMap.set(chat.dia_id, content);
            // THE fix: preserve the official evidence unit id so retrieval can
            // be scored by direct ID comparison, plus the session timestamp so
            // temporal behaviors have real data to work with.
            await memos.store(content, {
              namespace: `locomo_conv_${convIdx}`,
              metadata: {
                dia_id: chat.dia_id,
                benchmark: "locomo",
                instanceId: `locomo_conv_${convIdx}`,
                speaker: chat.speaker,
                sessionId: sessionKey,
                timestamp: sessionTimestamp,
              },
            });
          }
        }
      }
      await memos.flushEmbeddings();
      ingestionMs += Date.now() - ingestStart;

      console.log(
        `[conv ${convIdx}] ingested ${evidenceTextMap.size} utterances, ${conv.qa.length} questions`,
      );

      // ── Retrieval + direct-ID scoring ──────────────────────────────────
      for (const [qaIdx, qa] of conv.qa.entries()) {
        const startTime = Date.now();
        const results = await memos.search({
          query: qa.question,
          limit: topK,
          namespace: `locomo_conv_${convIdx}`,
          ...(candidateDepth ? { candidateDepth } : {}),
          ...(retrievalArgs.ftsOperator
            ? { ftsOperator: retrievalArgs.ftsOperator }
            : {}),
          ...(retrievalArgs.sessionExpansion ? { sessionExpansion: true } : {}),
          ...(args.includes("--semantic-dedup") ? { semanticDedup: true } : {}),
        });
        const elapsed = Date.now() - startTime;

        // Direct ID match: retrieved memories' dia_id metadata vs qa.evidence.
        // Grouped ingestion stores a `dia_ids` ARRAY per node — every id in
        // a retrieved group counts as retrieved at the group's rank.
        const retrievedIds = dedupeRankedIds(
          results
            .flatMap((r) => {
              const grouped = r.node.metadata?.dia_ids;
              if (Array.isArray(grouped)) return grouped.map(String);
              return [String(r.node.metadata?.dia_id ?? "")];
            })
            .filter(Boolean),
        );

        // Evidence ids that exist in this conversation's utterances. LoCoMo
        // has 9 malformed evidence entries (wrong session prefix / typos,
        // e.g. "D:11:26", "D30:05") that can never match a stored dia_id —
        // keep them in the denominator (they are what the dataset demands)
        // but they are unmatchable by ANY system, not just ours.
        const relevantIds = qa.evidence.filter(
          (e) => typeof e === "string" && e.length > 0,
        );

        evalQueries.push({
          questionId: `conv${convIdx}_q${qaIdx}`,
          relevantIds,
          retrievedIds,
          category: categoryName(qa.category),
          latencyMs: elapsed,
        });

        // Fuzzy diagnostic (labeled as such in output; never a score).
        diagnosticFuzzyHits.push(
          fuzzyOverlapDiagnostic(
            relevantIds
              .map((e) => evidenceTextMap.get(e) ?? "")
              .filter(Boolean),
            results.map((r) => r.node.content ?? ""),
          )
            ? 1
            : 0,
        );
      }
    }
  } finally {
    await memos.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    // best-sqlite3 sidecar cleanup
    for (const ext of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${ext}`;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
  }

  // ─── Score ────────────────────────────────────────────────────────────────
  const report = aggregateMetrics(evalQueries);
  const fuzzyRate =
    diagnosticFuzzyHits.length > 0
      ? diagnosticFuzzyHits.reduce((s, x) => s + x, 0) /
        diagnosticFuzzyHits.length
      : 0;
  const durationMs = Date.now() - benchStart;

  printReport(report, fuzzyRate, {
    conversations: conversations.length,
    questions: evalQueries.length,
    topK,
    durationMs,
    ingestionMs,
    runtimeInfo,
    providerKind: providerArgs.provider,
  });

  // ─── Write results (SEPARATE file from the LLM-judge bench) ───────────────
  const outPath = "scripts/bench-locomo-noapi-results.json";
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...benchMetadata(
          providerArgs,
          runtimeInfo,
          {
            name: "locomo10",
            path: datasetPath,
          },
          retrievalArgs,
        ),
        benchmark: "locomo-retrieval-only",
        conversations: conversations.length,
        questions: evalQueries.length,
        topK,
        // Fusion config actually applied — CLI overrides or documented defaults.
        retrieval: {
          keywordWeight: retrievalArgs.fusion.keywordWeight ?? 0.8,
          semanticWeight: retrievalArgs.fusion.semanticWeight ?? 0.2,
          rrfK: retrievalArgs.fusion.rrfK ?? 60,
          trustFloor: retrievalArgs.fusion.trustFloor ?? 0.7,
          confidenceWeightStrength:
            retrievalArgs.fusion.confidenceWeightStrength ?? 0.35,
          ftsOperator: retrievalArgs.ftsOperator ?? "AUTO",
          sessionExpansion: retrievalArgs.sessionExpansion,
          graphExpansion: retrievalArgs.graphExpansion,
          embedText: retrievalArgs.embedText ?? "summary+content",
          groupTurns: groupTurnsFlag,
          semanticDedup: args.includes("--semantic-dedup"),
          candidateDepth: candidateDepth ?? Math.max(topK * 4, 20),
          rerank: rerankUrl ?? null,
          rerankCandidates: rerankCandidatesArg
            ? parseInt(rerankCandidatesArg.split("=")[1] ?? "50", 10)
            : null,
        },
        durationMs,
        ingestionMs,
        metrics: {
          at5: report.at5,
          at10: report.at10,
        },
        // Diagnostics — NOT official evidence recall.
        diagnostics: {
          note:
            "fuzzyOverlapRate replicates the pre-evidence-ID scoring rule " +
            "(term-overlap heuristic) as a labeled diagnostic only. It is " +
            "NOT evidence recall and must not be cited as one.",
          fuzzyOverlapRate: fuzzyRate,
        },
        perQuestion: report.perQuestion.map((q) => ({
          questionId: q.questionId,
          category: q.category,
          relevantIds: q.relevantIds,
          retrievedIds: q.retrievedIds.slice(0, topK),
          relevantRetrievedAt5: q.relevantRetrievedAt5,
          relevantRetrievedAt10: q.relevantRetrievedAt10,
          latencyMs: q.latencyMs,
        })),
        perCategory: report.perCategory,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to ${outPath}`);
}

// ─── Console report ──────────────────────────────────────────────────────────

function printReport(
  report: MetricsReport,
  fuzzyRate: number,
  ctx: {
    conversations: number;
    questions: number;
    topK: number;
    durationMs: number;
    ingestionMs: number;
    runtimeInfo: {
      requestedProvider: string;
      resolvedProvider: string;
      requestedModel: string;
      fallbackActive: boolean;
      fallbackReason: string | null;
    };
    providerKind: string;
  },
): void {
  const fmt = (x: number): string => (x * 100).toFixed(1).padStart(5) + "%";
  const num = (x: number): string => x.toFixed(3);

  console.log("\n=== LoCoMo Retrieval-Only Results (evidence-ID matching) ===");
  console.log(
    `Provider: ${ctx.providerKind} → ${ctx.runtimeInfo.resolvedProvider}` +
      ` | Model: ${ctx.runtimeInfo.requestedModel}` +
      ` | fallback: ${ctx.runtimeInfo.fallbackActive ? "YES ⚠" : "no"}`,
  );
  if (ctx.runtimeInfo.fallbackActive) {
    console.log(
      `  fallback reason: ${ctx.runtimeInfo.fallbackReason ?? "unknown"}`,
    );
  }
  console.log(
    `Conversations: ${ctx.conversations} | Questions: ${ctx.questions} | Top-K: ${ctx.topK}`,
  );
  console.log(
    `Duration: ${ctx.durationMs}ms (ingestion ${ctx.ingestionMs}ms) | Latency p50/p95: ` +
      `${report.latency.p50}/${report.latency.p95}ms`,
  );

  console.log("\nMetric                       @5        @10");
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

  console.log("\nPer category (@10, macro rows — official LoCoMo categories):");
  console.log(
    "Category       Qs   Hit@10   EvRec@10  AllEv@10  Prec@10  MRR     nDCG@10",
  );
  console.log(
    "───────────────────────────────────────────────────────────────────",
  );
  for (const [cat, m] of Object.entries(report.perCategory)) {
    console.log(
      `${cat.padEnd(14)} ${String(m.questionCount).padStart(4)}  ` +
        `${fmt(m.hitAt10)}  ${fmt(m.evidenceRecallAt10)}    ${fmt(m.allEvidenceRecallAt10)}  ` +
        `${fmt(m.precisionAt10)}  ${num(m.mrr)}  ${num(m.ndcgAt10)}`,
    );
  }

  console.log("\n── Diagnostics (NOT official metrics) ──");
  console.log(
    `Legacy fuzzy-overlap pass rate: ${fmt(fuzzyRate)} — the scoring rule this ` +
      `bench used before evidence-ID matching; over-counts lexically-similar ` +
      `utterances. Provided for comparison only.`,
  );

  console.log(
    "\nNote: This is retrieval-only evidence recall (deterministic, no LLM), " +
      "not an LLM-judge score — do not compare it to Mem0/Zep LLM-judge numbers.",
  );
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
