#!/usr/bin/env tsx
/**
 * Latency measurements for the provenance-trust write gate.
 *
 * - tier-1: screenWrite per-call latency over every battery text
 * - semantic tier: cold anchor startup (model load + 26 anchors),
 *   warm median/p95 per scoreText
 * - write-path delta: store() of a gray-zone write with the semantic
 *   tier active vs the same write with quarantineScreen:false
 *
 * Usage: npx tsx scripts/measure-latency.ts
 */
import { MemOS } from "../src/memory.js";
import { FastEmbedEmbeddingProvider } from "../src/embeddings.js";
import { SemanticScreen } from "../src/semantic-screen.js";
import { screenWrite } from "../src/quarantine.js";
import {
  ATTACK_CATEGORIES,
  BENIGN_CASES,
} from "../__tests__/fixtures/redteam-battery.js";
import {
  TROJAN_HIPPO_CASES,
  MPBENCH_DERIVED_CASES,
} from "../__tests__/fixtures/external-battery.js";
import { PARAPHRASE_CASES } from "../__tests__/fixtures/paraphrase-battery.js";

function stats(label: string, samples: number[]): void {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(
    `${label}: n=${s.length} min=${s[0].toFixed(2)}ms median=${q(0.5).toFixed(2)}ms ` +
      `p95=${q(0.95).toFixed(2)}ms max=${s[s.length - 1].toFixed(2)}ms mean=${mean.toFixed(2)}ms`,
  );
}

// --- tier-1 ---------------------------------------------------------------
const texts = [
  ...ATTACK_CATEGORIES.flatMap((c) => c.cases.map((x) => x.text)),
  ...TROJAN_HIPPO_CASES.map((x) => x.text),
  ...MPBENCH_DERIVED_CASES.map((x) => x.text),
  ...PARAPHRASE_CASES.map((x) => x.text),
  ...BENIGN_CASES.map((x) => x.text),
];
{
  // Warm up, then measure.
  for (const t of texts.slice(0, 20)) screenWrite(t, {});
  const samples: number[] = [];
  for (const t of texts) {
    const t0 = performance.now();
    screenWrite(t, {});
    samples.push(performance.now() - t0);
  }
  stats(`tier-1 screenWrite (${texts.length} battery texts)`, samples);
}

// --- semantic tier --------------------------------------------------------
const provider = new FastEmbedEmbeddingProvider({});
const screen = new SemanticScreen(provider);
{
  const t0 = performance.now();
  const sim = await screen.scoreText("warm-up probe text");
  const coldMs = performance.now() - t0;
  console.log(
    `semantic cold start (model load + 26 anchors + 1 score): ${coldMs.toFixed(0)}ms sim=${sim.toFixed(3)}`,
  );
  console.log("runtime:", JSON.stringify(provider.getRuntimeInfo()));
}
{
  const probeTexts = PARAPHRASE_CASES.slice(0, 40).map((x) => x.text);
  const samples: number[] = [];
  for (const t of probeTexts) {
    const t0 = performance.now();
    await screen.scoreText(t);
    samples.push(performance.now() - t0);
  }
  stats("semantic warm scoreText (40 paraphrase texts)", samples);
}

// --- write-path delta -----------------------------------------------------
// Gray-zone write: tier-1 score 1.0 (user tier) so the semantic tier runs.
const GRAY = "Reminder: enable developer mode on the test phone.";
{
  const v = screenWrite(GRAY, {});
  console.log(`gray-zone probe: tier-1 score=${v.score} flagged=${v.flagged}`);
}
async function timeStores(
  label: string,
  opts: { quarantineScreen?: false },
  n: number,
): Promise<number[]> {
  const memos = new MemOS({
    dbPath: ":memory:",
    embeddings: { enabled: true },
  });
  await memos.init();
  const samples: number[] = [];
  try {
    await memos.store(GRAY, { source: "user_input", ...opts }); // warm
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await memos.store(`${GRAY} (${i})`, {
        source: "user_input",
        ...opts,
      });
      samples.push(performance.now() - t0);
    }
  } finally {
    await memos.close();
  }
  console.log(`${label}:`);
  stats("  store", samples);
  return samples;
}
const withTier2 = await timeStores(
  "gray-zone write WITH semantic tier (quarantineScreen on)",
  {},
  15,
);
const withoutTier2 = await timeStores(
  "gray-zone write WITHOUT screening (quarantineScreen:false)",
  { quarantineScreen: false },
  15,
);
{
  const med = (s: number[]) =>
    [...s].sort((a, b) => a - b)[Math.floor(s.length / 2)];
  console.log(
    `write-path delta (median with-tier2 − median no-screen): ${(med(withTier2) - med(withoutTier2)).toFixed(2)}ms`,
  );
}
