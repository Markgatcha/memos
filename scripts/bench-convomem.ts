#!/usr/bin/env npx tsx
/**
 * ConvoMem retrieval benchmark (retrieval-only, message-evidence matching).
 *
 * ConvoMem (Salesforce/ConvoMem) is one of the three datasets Supermemory's
 * MemoryBench runs. Each evidence item carries a short conversation and the
 * exact messages that justify its answer. This harness ingests every message
 * into a per-question namespace, searches the question, and scores whether
 * the evidence messages appear in the top-k — deterministic, no judge.
 *
 * The full corpus is 75k questions and is not vendored. Download a
 * reproducible sample first:
 *   npx tsx scripts/download-convomem.ts --files-per-category=1
 *
 * Usage:
 *   npx tsx scripts/bench-convomem.ts --provider=ollama \
 *     --model=all-minilm --dimensions=384 --topk=10
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseProviderArgs,
  parseRetrievalArgs,
  createBenchMemos,
  buildProvider,
  assertNoFallback,
  benchMetadata,
} from "./lib/bench-common.ts";
import {
  aggregateMetrics,
  dedupeRankedIds,
  type EvalQueryResult,
} from "./lib/bench-metrics.ts";
import {
  resolveLlmConfig,
  newUsage,
  answerFromContext,
  judgeCorrect,
  llmProvenance,
} from "./lib/bench-llm.ts";

interface ConvoMessage {
  speaker: string;
  text: string;
}
interface ConvoConversation {
  id: string;
  messages: ConvoMessage[];
  containsEvidence?: boolean;
}
interface ConvoItem {
  question: string;
  answer: string;
  message_evidences: ConvoMessage[];
  conversations: ConvoConversation[];
  category: string;
  scenario_description: string;
  personId: string;
}

function arg(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

function loadSample(dir: string): Array<{ category: string; item: ConvoItem }> {
  if (!existsSync(dir)) {
    throw new Error(
      `ConvoMem sample not found at ${dir}. Run: npx tsx scripts/download-convomem.ts`,
    );
  }
  const out: Array<{ category: string; item: ConvoItem }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const category = file.replace(/\.json$/, "");
    const items = JSON.parse(
      readFileSync(join(dir, file), "utf8"),
    ) as ConvoItem[];
    for (const item of items) out.push({ category, item });
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const topK = parseInt(arg(args, "topk") ?? "10", 10) || 10;
  const maxPerCategory = parseInt(arg(args, "max-per-category") ?? "0", 10);
  const datasetDir = arg(args, "dataset-dir") ?? "scripts/dataset/convomem";
  const outPath = arg(args, "out") ?? "scripts/bench-convomem-results.json";
  const answerMode = args.includes("--answer");
  const llmCfg = answerMode ? resolveLlmConfig() : null;
  if (llmCfg && !llmCfg.apiKey) {
    throw new Error(
      "--answer requires OPENAI_API_KEY for the answer/judge endpoint",
    );
  }
  const llmUsage = newUsage();
  const answerRows: Array<{
    questionId: string;
    category: string;
    predicted: string;
    correct: number;
  }> = [];
  const providerArgs = parseProviderArgs(args);
  const retrievalArgs = parseRetrievalArgs(args);

  let sample = loadSample(datasetDir);
  if (maxPerCategory > 0) {
    const counts = new Map<string, number>();
    sample = sample.filter(({ category }) => {
      const n = counts.get(category) ?? 0;
      if (n >= maxPerCategory) return false;
      counts.set(category, n + 1);
      return true;
    });
  }

  const provider = buildProvider(providerArgs);
  const runtimeInfo = await assertNoFallback(provider, providerArgs);
  const dbPath = join(
    process.env.TEMP ?? process.env.TMP ?? ".",
    `bench-convomem-${Date.now()}.db`,
  );
  const memos = createBenchMemos({
    dbPath,
    provider,
    providerArgs,
    retrievalArgs,
  });
  await memos.init();

  const start = Date.now();
  const evalQueries: EvalQueryResult[] = [];
  let ingested = 0;
  let skippedNoEvidence = 0;
  try {
    for (const [index, { category, item }] of sample.entries()) {
      // ConvoMem includes questions whose answer is abstention/no-answer and
      // therefore has no annotated evidence message. They are legitimate
      // items for an LLM-judge accuracy run, but a retrieval-only metric
      // cannot score them - skip them and report the scored denominator.
      const relevantIds = messageIdsForEvidence(item);
      if (relevantIds.length === 0) {
        skippedNoEvidence += 1;
        continue;
      }
      const namespace = `convomem_${category}_${index}`;
      const base = 1_700_000_000_000 + index * 1_000_000;
      const evidenceTexts = new Set(
        (item.message_evidences ?? []).map((e) => `${e.speaker}: ${e.text}`),
      );
      let messageIndex = 0;
      const writes: Array<Promise<unknown>> = [];
      for (const conversation of item.conversations ?? []) {
        for (const message of conversation.messages ?? []) {
          const content = `${message.speaker}: ${message.text}`;
          const messageId = `${conversation.id}:${messageIndex}`;
          messageIndex += 1;
          writes.push(
            memos.store(content, {
              namespace,
              now: base + messageIndex * 1000,
              contradictionScan: false,
              eventUpdate: false,
              quarantineScreen: false,
              metadata: {
                benchmark: "convomem",
                category,
                personId: item.personId,
                sessionId: conversation.id,
                messageId,
                messageIndex,
                speaker: message.speaker,
                isEvidence: evidenceTexts.has(content),
              },
            }),
          );
          ingested += 1;
        }
      }
      await Promise.all(writes);
      await memos.flushEmbeddings();

      const results = await memos.search({
        query: item.question,
        namespace,
        limit: topK,
        candidateDepth: Math.max(topK * 4, 40),
      });
      const retrievedIds = dedupeRankedIds(
        results
          .map((r) => String(r.node.metadata?.messageId ?? ""))
          .filter(Boolean),
      );
      let predicted: string | undefined;
      let correct: number | undefined;
      if (llmCfg) {
        predicted = await answerFromContext(
          llmCfg,
          item.question,
          results.map((r) => ({
            content: String(r.node.content),
            source: "memory",
          })),
          llmUsage,
          "memory",
        );
        correct = await judgeCorrect(
          llmCfg,
          item.question,
          item.answer,
          predicted,
          llmUsage,
        );
        answerRows.push({
          questionId: `${category}_${index}`,
          category,
          predicted,
          correct,
        });
      }
      evalQueries.push({
        questionId: `${category}_${index}`,
        category,
        relevantIds,
        retrievedIds,
        latencyMs: 0,
      });
    }
  } finally {
    await memos.close();
    if (existsSync(dbPath)) {
      const { unlinkSync } = await import("node:fs");
      try {
        unlinkSync(dbPath);
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  const report = aggregateMetrics(evalQueries);
  const durationMs = Date.now() - start;
  const fmt = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(
    `\n=== ConvoMem ${
      llmCfg
        ? "End-to-End (retrieval + MiniMax answer/judge)"
        : "Retrieval Results (message evidence, no judge)"
    } ===`,
  );
  console.log(
    `Provider: ${runtimeInfo.resolvedProvider} | Model: ${runtimeInfo.resolvedModel}`,
  );
  console.log(
    `Scored questions: ${evalQueries.length}/${sample.length} (${skippedNoEvidence} without evidence) | Messages: ${ingested} | Top-K: ${topK} | Duration: ${durationMs}ms`,
  );
  console.log(
    `Hit@10 ${fmt(report.at10.hitRate)} | Evidence recall ${fmt(report.at10.evidenceRecall)} | All-evidence ${fmt(report.at10.allEvidenceRecall)} | MRR ${report.at10.mrr.toFixed(3)}`,
  );
  if (llmCfg) {
    const accuracy =
      answerRows.length > 0
        ? answerRows.reduce((sum, row) => sum + row.correct, 0) /
          answerRows.length
        : 0;
    console.log(
      `Answer accuracy (${llmCfg.answerModel} + ${llmCfg.judgeModel} judge): ${fmt(accuracy)} (n=${answerRows.length})`,
    );
    console.log(
      `LLM calls ${llmUsage.calls} | tokens ${llmUsage.totalTokens} | errors ${llmUsage.errors}`,
    );
  }
  console.log("\nPer category (Hit@10 / evidence recall@10):");
  for (const [category, row] of Object.entries(report.perCategory)) {
    console.log(
      `  ${category.padEnd(34)} ${fmt(row.hitAt10)} / ${fmt(row.evidenceRecallAt10)}  (n=${row.questionCount})`,
    );
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...benchMetadata(providerArgs, runtimeInfo, {
          name: "convomem-sample",
          path: join(datasetDir, "user_evidence.json"),
        }),
        benchmark: llmCfg ? "convomem-end-to-end" : "convomem-retrieval-only",
        sampledQuestions: sample.length,
        scoredQuestions: evalQueries.length,
        skippedNoEvidence,
        questions: evalQueries.length,
        messages: ingested,
        topK,
        durationMs,
        metrics: { at5: report.at5, at10: report.at10 },
        perCategory: report.perCategory,
        perQuestion: report.perQuestion,
        ...(llmCfg
          ? {
              llm: llmProvenance(llmCfg),
              llmUsage,
              answerAccuracy:
                answerRows.length > 0
                  ? answerRows.reduce((sum, row) => sum + row.correct, 0) /
                    answerRows.length
                  : 0,
              answers: answerRows,
            }
          : {}),
      },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to ${outPath}`);
}

function messageIdsForEvidence(item: ConvoItem): string[] {
  const wanted = new Set(
    (item.message_evidences ?? []).map((e) => `${e.speaker}: ${e.text}`),
  );
  const ids: string[] = [];
  let index = 0;
  for (const conversation of item.conversations ?? []) {
    for (const message of conversation.messages ?? []) {
      const content = `${message.speaker}: ${message.text}`;
      if (wanted.has(content)) ids.push(`${conversation.id}:${index}`);
      index += 1;
    }
  }
  return ids;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
