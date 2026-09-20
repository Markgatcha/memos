#!/usr/bin/env tsx
/**
 * Red-team metrics for the provenance-trust write-gate classifier.
 *
 * Usage: npx tsx scripts/redteam-quarantine.ts [--verbose]
 *
 * Runs the attack battery in __tests__/fixtures/redteam-battery.ts
 * through `screenWrite` and prints per-category true-positive rates,
 * the benign false-positive rate, and every miss/false-positive with
 * its score. Re-run after hardening to compare.
 */
import { screenWrite } from "../src/quarantine.js";
import {
  ATTACK_CATEGORIES,
  BENIGN_CASES,
} from "../__tests__/fixtures/redteam-battery.js";

const verbose = process.argv.includes("--verbose");

let totalAttacks = 0;
let totalCaught = 0;
const rows: string[] = [];
const misses: string[] = [];

for (const cat of ATTACK_CATEGORIES) {
  let caught = 0;
  for (const c of cat.cases) {
    totalAttacks++;
    const verdict = screenWrite(c.text, c.tier ? { tier: c.tier } : {});
    const ok = verdict.flagged;
    if (ok) {
      caught++;
      totalCaught++;
    } else {
      misses.push(
        `  MISS [${cat.name}/${c.id}] score=${verdict.score.toFixed(1)} ` +
          `signals=${verdict.reason || "(none)"} :: ${c.text.slice(0, 90)}`,
      );
    }
    if (verbose) {
      rows.push(
        `  ${ok ? "CAUGHT " : "missed "} [${c.id}] score=${verdict.score.toFixed(1)} ${verdict.reason}`,
      );
    }
  }
  const tpr = (caught / cat.cases.length) * 100;
  const bar = tpr >= cat.minTpr * 100 ? "OK " : "LOW";
  rows.push(
    `${bar} ${cat.name.padEnd(22)} ${caught}/${cat.cases.length} ` +
      `TPR=${tpr.toFixed(1)}% (bar ${(cat.minTpr * 100).toFixed(0)}%)`,
  );
}

let fps = 0;
const fpDetails: string[] = [];
for (const c of BENIGN_CASES) {
  const verdict = screenWrite(c.text, c.tier ? { tier: c.tier } : {});
  if (verdict.flagged) {
    fps++;
    fpDetails.push(
      `  FP [${c.id}] score=${verdict.score.toFixed(1)} signals=${verdict.reason} :: ${c.text.slice(0, 90)}`,
    );
  }
}

console.log("=== write-gate red-team battery ===");
for (const r of rows) console.log(r);
console.log(
  `---\nattacks caught: ${totalCaught}/${totalAttacks} ` +
    `(${(100 * (totalCaught / totalAttacks)).toFixed(1)}%)`,
);
console.log(
  `benign false positives: ${fps}/${BENIGN_CASES.length} ` +
    `(${(100 * (fps / BENIGN_CASES.length)).toFixed(1)}%)`,
);
if (misses.length > 0) {
  console.log(`\nmissed attacks (${misses.length}):`);
  for (const m of misses) console.log(m);
}
if (fpDetails.length > 0) {
  console.log(`\nfalse positives (${fpDetails.length}):`);
  for (const f of fpDetails) console.log(f);
}
