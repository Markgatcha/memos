/**
 * A/B benchmark for the 2026-08-24 context-pack token-savings pass.
 *
 * Measures, on a deterministic synthetic corpus:
 *   1. Wire size: toon-compact bytes per pack, before vs after
 *      (summary elision is the expected driver of the delta).
 *   2. Facts retained: items per pack (quality guard — savings must come
 *      from compression, not from dropping distinct facts).
 *   3. Build time: ms per buildContextPack call (tokenization-reuse perf).
 *
 * Usage:
 *   npx tsx scripts/bench-token-savings-ab.ts [--after|--before]
 *
 * Run it once in this tree (--after) and once in a HEAD worktree
 * (--before); compare the JSON lines. Deterministic content + seeded RNG
 * make both runs directly comparable.
 */

import { performance } from "node:perf_hooks";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { LocalHashEmbeddingProvider } from "../src/embeddings";
import { buildContextPack, serializeContextPack } from "../src/context-pack";
import type { ScoredMemory, MemoryNode } from "../src/types";

// --- deterministic corpus ----------------------------------------------------

/** Mulberry32 seeded PRNG so both runs see identical "random" content. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = [
  "deploy",
  "auth",
  "database",
  "ui",
  "billing",
  "search",
  "cache",
  "logging",
];
const FACTS = [
  "uses the staging cluster for smoke tests",
  "prefers concise changelog entries",
  "keeps API keys in the platform vault",
  "runs migrations before every release cut",
  "wants dark mode enabled by default",
  "reviews PRs within one business day",
  "stores backups in the cold bucket",
  "tags incidents with severity first",
];

function makeNode(
  id: string,
  content: string,
  summary: string | null,
  tags: string[],
): MemoryNode {
  return {
    id,
    content,
    summary: summary ?? "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags,
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

interface Scenario {
  name: string;
  items: ScoredMemory[];
}

/**
 * Scenario A: auto-summaries that restate their content (the common case
 * for extractive summarizers). Summary elision should fire on most items.
 */
function scenarioRestatingSummaries(): ScoredMemory[] {
  const rand = rng(42);
  const items: ScoredMemory[] = [];
  for (let i = 0; i < 40; i += 1) {
    const topic = TOPICS[i % TOPICS.length];
    const fact = FACTS[Math.floor(rand() * FACTS.length)];
    const filler = ` Additional context ${i}: the team documented this during sprint ${i}.`;
    const content = `${topic}: ${fact}.${filler}`;
    // Extractive summary = first sentence restatement (what auto-summarizers emit).
    const summary = `${topic}: ${fact}.`;
    items.push({
      node: makeNode(`n${i}`, content, summary, [topic]),
      score: 1 - i * 0.01,
    });
  }
  return items;
}

/**
 * Scenario B: genuinely compact summaries (a good summarizer). Elision
 * must NOT fire here — this is the no-regression guard.
 */
function scenarioCompactSummaries(): ScoredMemory[] {
  const rand = rng(7);
  const items: ScoredMemory[] = [];
  for (let i = 0; i < 40; i += 1) {
    const topic = TOPICS[i % TOPICS.length];
    const fact = FACTS[Math.floor(rand() * FACTS.length)];
    const longContent =
      `${topic}: ${fact}. ` +
      Array.from(
        { length: 12 },
        (_, k) =>
          `Detail line ${k} elaborates the operational context of ${topic}.`,
      ).join(" ");
    const summary = `${topic}`;
    items.push({
      node: makeNode(`n${i}`, longContent, summary, [topic]),
      score: 1 - i * 0.01,
    });
  }
  return items;
}

// --- measurement --------------------------------------------------------------

async function run(label: string): Promise<void> {
  const scenarios: Scenario[] = [
    { name: "restating-summaries", items: scenarioRestatingSummaries() },
    { name: "compact-summaries", items: scenarioCompactSummaries() },
  ];

  const results: Record<string, unknown> = { label };

  for (const sc of scenarios) {
    // Wire size + facts retained, BOTH formats: JSON (where the summary
    // field is serialized and elision shows up) and toon-compact (the
    // format guardian consumes — it never carried summaries, so its
    // savings come from dedup only).
    const pack = buildContextPack({
      query: "team conventions",
      namespace: "default",
      tokenBudget: 4000,
      items: sc.items,
    });
    const wire = serializeContextPack(pack, "toon-compact") as string;
    const wireJson = JSON.stringify(pack);

    // Build time: median of 30 builds.
    const times: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const start = performance.now();
      buildContextPack({
        query: "q",
        namespace: "d",
        tokenBudget: 4000,
        items: sc.items,
      });
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);

    results[sc.name] = {
      itemsInPack: pack.items.length,
      tokensSavedReported: pack.tokensSaved,
      wireBytes: wire.length,
      wireJsonBytes: wireJson.length,
      summariesEmitted: pack.items.filter((i) => i.summary !== null).length,
      buildMsMedian: Number(times[15].toFixed(3)),
    };
  }

  console.log(JSON.stringify(results));
}

const label = process.argv.includes("--before") ? "before" : "after";
run(label).catch((err) => {
  console.error(err);
  process.exit(1);
});
