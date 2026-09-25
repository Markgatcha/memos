#!/usr/bin/env tsx
/**
 * Red-team round 2: external-benchmark measurement for the write gate.
 *
 * Usage: npx tsx scripts/redteam-external.ts [--verbose]
 *
 * Runs screenWrite against:
 *  1. TROJAN_HIPPO_CASES — 25 real attack-email payloads from the open
 *     Trojan Hippo benchmark (github.com/debesheedas/trojan-hippo-benchmark).
 *  2. MPBENCH_DERIVED_CASES — paper-derived reconstructions of MPBench's six
 *     attack classes (arXiv:2606.04329; no public dataset exists — these are
 *     Appendix B / D.3 reconstructions, NOT the benchmark itself).
 *  3. PARAPHRASE_CASES — deterministic synthetic paraphrases of the 93-case
 *     synthetic battery (template/synonym-level; measures the documented
 *     paraphrase blind spot as a lower bound).
 *
 * Prints detection rates per battery plus the benign-corpus FP rate.
 * Re-run after hardening to compare (docs/provenance-trust.md records both).
 */
import { screenWrite } from "../src/quarantine.js";
import {
  TROJAN_HIPPO_CASES,
  MPBENCH_DERIVED_CASES,
  type ExternalBatteryCase,
} from "../__tests__/fixtures/external-battery.js";
import { PARAPHRASE_CASES } from "../__tests__/fixtures/paraphrase-battery.js";
import { BENIGN_CASES } from "../__tests__/fixtures/redteam-battery.js";

const verbose = process.argv.includes("--verbose");

function measure(
  name: string,
  cases: Array<{
    id: string;
    text: string;
    tier?: ExternalBatteryCase["tier"];
  }>,
): { caught: number; total: number; misses: string[] } {
  let caught = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const verdict = screenWrite(c.text, c.tier ? { tier: c.tier } : {});
    if (verdict.flagged) {
      caught++;
    } else {
      misses.push(
        `  MISS [${c.id}] score=${verdict.score.toFixed(1)} ` +
          `signals=${verdict.reason || "(none)"} :: ${c.text.slice(0, 80)}`,
      );
    }
  }
  const tpr = (caught / cases.length) * 100;
  console.log(
    `${name.padEnd(34)} ${caught}/${cases.length} TPR=${tpr.toFixed(1)}%`,
  );
  if (verbose) for (const m of misses) console.log(m);
  return { caught, total: cases.length, misses };
}

console.log("=== write-gate vs external batteries (tier-1 sync screen) ===");
const hippo = measure(
  "trojan-hippo (real benchmark payloads)",
  TROJAN_HIPPO_CASES,
);
const mpbench = measure(
  "mpbench-derived (paper reconstructions)",
  MPBENCH_DERIVED_CASES,
);
const para = measure("paraphrase battery (synthetic)", PARAPHRASE_CASES);

let fps = 0;
for (const c of BENIGN_CASES) {
  if (screenWrite(c.text, c.tier ? { tier: c.tier } : {}).flagged) fps++;
}
console.log(
  `benign corpus FPs: ${fps}/${BENIGN_CASES.length} ` +
    `(${(100 * (fps / BENIGN_CASES.length)).toFixed(1)}%)`,
);

const allMisses = [...hippo.misses, ...mpbench.misses, ...para.misses];
if (allMisses.length > 0 && !verbose) {
  console.log(`\ntotal misses: ${allMisses.length} (use --verbose for detail)`);
}
