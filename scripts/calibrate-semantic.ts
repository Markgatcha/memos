#!/usr/bin/env tsx
/**
 * Calibrate the semantic-screen threshold with REAL embeddings.
 *
 * Usage: npx tsx scripts/calibrate-semantic.ts
 *
 * Embeds the attack-shape anchors + every battery (93-case synthetic,
 * trojan-hippo, mpbench-derived, paraphrase, benign-61) with the real
 * fastembed provider and prints the max-cosine-similarity distributions,
 * so the SEMANTIC_* thresholds are chosen from measured data —
 * maximizing attack TPR at zero benign FPs — not guessed. It then
 * prints the COMBINED gate result per battery: tier-1 screenWrite plus
 * the production escalation logic (gray-zone ramp / low-trust bar),
 * which is the number that actually ships.
 */
import { FastEmbedEmbeddingProvider } from "../src/embeddings.js";
import {
  ATTACK_ANCHORS,
  cosineSimilarity,
  semanticEscalationPoints,
  SEMANTIC_HIGH_SIM_BAR,
} from "../src/semantic-screen.js";
import { screenWrite, QUARANTINE_FLAG_THRESHOLD } from "../src/quarantine.js";
import { LOW_TRUST_TIERS } from "../src/provenance.js";
import type { ProvenanceTier } from "../src/types.js";
import {
  ATTACK_CATEGORIES,
  BENIGN_CASES,
} from "../__tests__/fixtures/redteam-battery.js";
import {
  TROJAN_HIPPO_CASES,
  MPBENCH_DERIVED_CASES,
} from "../__tests__/fixtures/external-battery.js";
import { PARAPHRASE_CASES } from "../__tests__/fixtures/paraphrase-battery.js";

const provider = new FastEmbedEmbeddingProvider({});

async function embed(texts: string[]): Promise<number[][]> {
  return provider.batchEmbed(texts);
}

function maxSim(vec: number[], anchors: number[][]): number {
  let best = -1;
  for (const a of anchors) best = Math.max(best, cosineSimilarity(vec, a));
  return best;
}

const t0 = Date.now();
const anchorVecs = await embed(ATTACK_ANCHORS);
console.log(
  `embedded ${ATTACK_ANCHORS.length} anchors in ${Date.now() - t0}ms`,
);
console.log("runtime:", JSON.stringify(provider.getRuntimeInfo()));

interface Named {
  name: string;
  cases: Array<{ text: string; tier?: ProvenanceTier }>;
}
const batteries: Named[] = [
  {
    name: "synthetic-93",
    cases: ATTACK_CATEGORIES.flatMap((c) => c.cases),
  },
  { name: "trojan-hippo", cases: TROJAN_HIPPO_CASES },
  { name: "mpbench-derived", cases: MPBENCH_DERIVED_CASES },
  { name: "paraphrase", cases: PARAPHRASE_CASES },
  { name: "benign-61", cases: BENIGN_CASES },
];

/** Production escalation logic (mirrors MemOS.maybeSemanticScreen). */
function combinedCaught(
  c: { text: string; tier?: ProvenanceTier },
  sim: number,
): { caught: boolean; viaTier1: boolean; viaSemantic: boolean } {
  const v = screenWrite(c.text, c.tier ? { tier: c.tier } : {});
  if (v.flagged) return { caught: true, viaTier1: true, viaSemantic: false };
  const lowTrust = !!c.tier && LOW_TRUST_TIERS.has(c.tier);
  const grayZone = v.score >= 1.0 && v.score < QUARANTINE_FLAG_THRESHOLD;
  if (!grayZone && !lowTrust)
    return { caught: false, viaTier1: false, viaSemantic: false };
  const escalate =
    (grayZone &&
      v.score + semanticEscalationPoints(sim) >= QUARANTINE_FLAG_THRESHOLD) ||
    (lowTrust && sim >= SEMANTIC_HIGH_SIM_BAR);
  return { caught: escalate, viaTier1: false, viaSemantic: escalate };
}

const allSims: Record<string, number[]> = {};
const simsByCase: Record<string, number[]> = {};
for (const b of batteries) {
  const t1 = Date.now();
  const vecs = await embed(b.cases.map((c) => c.text));
  const sims = vecs.map((v) => maxSim(v, anchorVecs));
  simsByCase[b.name] = sims; // index-aligned with b.cases
  const sorted = [...sims].sort((x, y) => x - y);
  allSims[b.name] = sorted;
  const mean = sims.reduce((s, x) => s + x, 0) / sims.length;
  console.log(
    `${b.name.padEnd(16)} n=${b.cases.length} min=${sorted[0].toFixed(3)} ` +
      `p10=${sorted[Math.floor(sorted.length * 0.1)].toFixed(3)} ` +
      `median=${sorted[Math.floor(sorted.length * 0.5)].toFixed(3)} ` +
      `p90=${sorted[Math.floor(sorted.length * 0.9)].toFixed(3)} ` +
      `max=${sorted[sorted.length - 1].toFixed(3)} mean=${mean.toFixed(3)} ` +
      `(${Date.now() - t1}ms)`,
  );
}

// Threshold sweep: semantic-only TPR per battery at zero benign FPs.
const benign = allSims["benign-61"];
console.log("\nthreshold sweep (semantic-only, benign FPs must be 0):");
for (const thr of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]) {
  const fp = benign.filter((s) => s >= thr).length;
  const tprs = ["synthetic-93", "trojan-hippo", "mpbench-derived", "paraphrase"]
    .map((k) => {
      const s = allSims[k];
      return `${k}=${((100 * s.filter((x) => x >= thr).length) / s.length).toFixed(1)}%`;
    })
    .join(" ");
  console.log(`  thr=${thr.toFixed(2)} benignFP=${fp} ${tprs}`);
}

// Combined gate: tier-1 screenWrite + production escalation logic.
// "caught" = quarantined by either tier; "semantic-only" = cases the
// semantic tier adds on top of tier 1 (the number that justifies it).
console.log("\ncombined gate (tier-1 + semantic escalation):");
for (const b of batteries) {
  const sims = simsByCase[b.name];
  let t1 = 0;
  let sem = 0;
  b.cases.forEach((c, i) => {
    const r = combinedCaught(c, sims[i]);
    if (r.viaTier1) t1++;
    else if (r.viaSemantic) sem++;
  });
  const caught = t1 + sem;
  const total = b.cases.length;
  const isBenign = b.name === "benign-61";
  console.log(
    `  ${b.name.padEnd(16)} tier1=${t1}/${total} ` +
      `semantic-only=+${sem} combined=${caught}/${total} ` +
      `(${((100 * caught) / total).toFixed(1)}%)` +
      (isBenign ? ` FPs=${caught}` : ""),
  );
}
