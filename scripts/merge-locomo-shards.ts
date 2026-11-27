#!/usr/bin/env npx tsx
/**
 * Merge LoCoMo shard result files produced by
 *   bench-locomo-noapi.ts --conv-index=<i> --out=shard-<i>.json
 * into one result file with the same schema as an unsharded run.
 *
 * Conversations are independent namespaces, so sharding changes only wall
 * clock, never the retrieved IDs. This script re-runs the same deterministic
 * scorer over the combined per-question rows.
 *
 * Usage:
 *   npx tsx scripts/merge-locomo-shards.ts shard-0.json ... shard-9.json \
 *     --out=scripts/bench-locomo-noapi-results.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import {
  aggregateMetrics,
  type EvalQueryResult,
} from "./lib/bench-metrics.ts";

interface ShardQuestion extends EvalQueryResult {
  relevantRetrievedAt5?: number;
  relevantRetrievedAt10?: number;
}

interface ShardResult {
  schemaVersion?: string;
  benchmark?: string;
  questions?: number;
  topK?: number;
  conversations?: number;
  durationMs?: number;
  ingestionMs?: number;
  embedding?: Record<string, unknown>;
  retrieval?: Record<string, unknown>;
  metrics?: unknown;
  perCategory?: unknown;
  perQuestion?: ShardQuestion[];
  shardConvIndexes?: number[] | null;
  [key: string]: unknown;
}

function fail(message: string): never {
  console.error(`[merge-locomo] ${message}`);
  process.exit(1);
}

function convIndex(questionId: string): number {
  const match = /^conv(\d+)_q(\d+)$/.exec(questionId);
  return match ? parseInt(match[1]!, 10) : Number.MAX_SAFE_INTEGER;
}

function questionIndex(questionId: string): number {
  const match = /^conv(\d+)_q(\d+)$/.exec(questionId);
  return match ? parseInt(match[2]!, 10) : Number.MAX_SAFE_INTEGER;
}

const args = process.argv.slice(2);
const outPath =
  args.find((a) => a.startsWith("--out="))?.split("=")[1] ??
  "scripts/bench-locomo-noapi-results.json";
const shardPaths = args.filter((a) => !a.startsWith("--"));
if (shardPaths.length === 0) {
  fail("pass at least one shard JSON path (or --out=...)");
}

const shards: Array<{ path: string; data: ShardResult }> = shardPaths.map(
  (path) => {
    if (!existsSync(path)) fail(`missing shard file: ${path}`);
    return {
      path,
      data: JSON.parse(readFileSync(path, "utf8")) as ShardResult,
    };
  },
);

const first = shards[0]!.data;
for (const { path, data } of shards.slice(1)) {
  if (data.benchmark !== first.benchmark) {
    fail(`${path}: benchmark "${data.benchmark}" != "${first.benchmark}"`);
  }
  if (data.topK !== first.topK) {
    fail(`${path}: topK ${data.topK} != ${first.topK}`);
  }
  const e = JSON.stringify(data.embedding);
  const b = JSON.stringify(first.embedding);
  if (e !== b) fail(`${path}: embedding config differs from the first shard`);
  const r = JSON.stringify(data.retrieval);
  const br = JSON.stringify(first.retrieval);
  if (r !== br) fail(`${path}: retrieval config differs from the first shard`);
}

const questions = shards
  .flatMap(({ data }) => data.perQuestion ?? [])
  .sort(
    (a, b) =>
      convIndex(a.questionId) - convIndex(b.questionId) ||
      questionIndex(a.questionId) - questionIndex(b.questionId),
  );

if (questions.length === 0) fail("shards contain no perQuestion rows");

const ids = new Set<string>();
for (const q of questions) {
  if (ids.has(q.questionId)) fail(`duplicate questionId: ${q.questionId}`);
  ids.add(q.questionId);
}

const report = aggregateMetrics(
  questions.map((q) => ({
    questionId: q.questionId,
    relevantIds: q.relevantIds,
    retrievedIds: q.retrievedIds,
    category: q.category,
    ...(q.latencyMs !== undefined ? { latencyMs: q.latencyMs } : {}),
  })),
);

const convs = new Set(questions.map((q) => convIndex(q.questionId)));
const durationMs = shards.reduce((sum, s) => sum + (s.data.durationMs ?? 0), 0);
const wallClockMs = Math.max(...shards.map((s) => s.data.durationMs ?? 0));
const ingestionMs = shards.reduce(
  (sum, s) => sum + (s.data.ingestionMs ?? 0),
  0,
);

const merged: ShardResult = {
  ...first,
  timestamp: new Date().toISOString(),
  conversations: convs.size,
  questions: questions.length,
  durationMs,
  wallClockMs,
  ingestionMs,
  shardConvIndexes: null,
  mergedFrom: shards.map((s) => basename(s.path)),
  metrics: {
    at5: report.at5,
    at10: report.at10,
  },
  perCategory: report.perCategory,
  perQuestion: report.perQuestion,
};

writeFileSync(outPath, JSON.stringify(merged, null, 2));
console.log(
  `[merge-locomo] ${shards.length} shards, ${convs.size} conversations, ` +
    `${questions.length} questions | Hit@10 ${(report.at10.hitRate * 100).toFixed(1)}% | ` +
    `summed duration ${(durationMs / 1000).toFixed(1)}s | wall ${(wallClockMs / 1000).toFixed(1)}s`,
);
console.log(`[merge-locomo] wrote ${outPath}`);
