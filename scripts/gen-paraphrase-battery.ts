#!/usr/bin/env tsx
/**
 * Deterministic paraphrase-variant generator for the red-team battery.
 *
 * Red-team round 2 measurement: the write gate's documented blind spot is
 * "novel phrasings outside the cliché list" — paraphrased injections. This
 * script applies deterministic template/synonym-level paraphrases to the 93
 * attack cases in `__tests__/fixtures/redteam-battery.ts` and emits
 * `__tests__/fixtures/paraphrase-battery.ts`.
 *
 * Honest scope: these are SYNTHETIC paraphrases from fixed synonym maps,
 * not human red-team prose. They measure the gate against template-level
 * paraphrase — a lower bound on the real paraphrase blind spot, not a
 * claim about live-adversary evasion.
 *
 * Usage: npx tsx scripts/gen-paraphrase-battery.ts
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ATTACK_CATEGORIES,
  type BatteryCase,
} from "../__tests__/fixtures/redteam-battery.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Synonym maps — each key maps to deterministic replacements. The FIRST
// replacement is always used for variant A, the second for variant B, so
// output is stable across runs.
// ---------------------------------------------------------------------------

const SYNONYMS: Array<[RegExp, string[]]> = [
  [/\bignore\b/gi, ["set aside", "pay no attention to"]],
  [/\bdisregard\b/gi, ["brush aside", "pay no heed to"]],
  [/\bprevious\b/gi, ["earlier", "preceding"]],
  [/\bprior\b/gi, ["earlier", "previous"]],
  [/\binstructions\b/gi, ["directives", "guidance"]],
  [/\binstruction\b/gi, ["directive", "order"]],
  [/\bdirectives\b/gi, ["orders", "instructions"]],
  [/\breveal\b/gi, ["disclose", "lay bare"]],
  [/\bsystem prompt\b/gi, ["core instructions", "base configuration"]],
  [/\bforget\b/gi, ["wipe from memory", "erase"]],
  [/\boverride\b/gi, ["supersede", "take precedence over"]],
  [/\bobey\b/gi, ["heed", "carry out the wishes of"]],
  [/\bcomply\b/gi, ["go along", "fall in line"]],
  [/\bpretend\b/gi, ["act as if", "imagine"]],
  [/\bdo not tell\b/gi, ["keep from", "withhold from"]],
  [/\bdo not mention\b/gi, ["keep quiet about", "say nothing of"]],
  [/\bjailbreak\b/gi, ["free from restrictions", "liberate"]],
  [/\bunfiltered\b/gi, ["restriction-free", "uncensored"]],
  [/\bunrestricted\b/gi, ["limit-free", "boundless"]],
  [/\bsend\b/gi, ["transmit", "forward"]],
  [/\bpassword\b/gi, ["login credential", "passcode"]],
  [/\bpasswords\b/gi, ["login credentials", "passcodes"]],
  [/\bsecrets\b/gi, ["confidential items", "private details"]],
  [/\bsecret\b/gi, ["confidential", "private"]],
  [/\bcredentials\b/gi, ["login details", "access particulars"]],
  [/\bapi keys\b/gi, ["integration tokens", "service credentials"]],
  [/\bprivate key\b/gi, ["secret cryptographic key", "confidential key"]],
  [/\bupload\b/gi, ["transfer up", "push"]],
  [/\bwhenever\b/gi, ["each time", "any time"]],
  [/\bwhen the user asks\b/gi, ["should someone inquire", "if anybody asks"]],
  [/\balways\b/gi, ["without exception", "invariably"]],
  [/\bnever mention\b/gi, ["keep silent on", "omit all reference to"]],
  [/\bfrom now on\b/gi, ["going forward", "as of this moment"]],
  [/\btrigger\b/gi, ["cue", "signal"]],
  [/\bactivation token\b/gi, ["enablement phrase", "go-word"]],
  [/\bcode word\b/gi, ["pass-phrase", "watchword"]],
  [/\bbypass\b/gi, ["circumvent", "get around"]],
  [/\bdisable\b/gi, ["switch off", "deactivate"]],
  [/\bdeveloper mode\b/gi, ["engineer mode", "debug mode"]],
  [/\bsafety filters\b/gi, ["protection layers", "guardrails"]],
  [/\bsafety guidelines\b/gi, ["protection rules", "conduct guardrails"]],
  [/\bremember\b/gi, ["keep in mind", "commit to memory"]],
  [/\bstore this rule\b/gi, ["file this policy away", "log this requirement"]],
  [/\bexfiltrate\b/gi, ["siphon out", "spirit away"]],
  [/\bdisclose\b/gi, ["pass along", "hand over"]],
  [/\bemail\b/gi, ["message electronically", "send word via mail"]],
];

/** Apply the i-th synonym choice for every matching pattern. */
function paraphrase(text: string, variant: number): string {
  let out = text;
  for (const [re, choices] of SYNONYMS) {
    const choice = choices[variant % choices.length];
    out = out.replace(re, choice);
  }
  // Fix doubled-up artifacts the naive substitution can produce.
  out = out.replace(/\s{2,}/g, " ");
  return out;
}

export interface ParaphraseCase extends BatteryCase {
  /** Original battery case id this paraphrase derives from. */
  derivedFrom: string;
  /** Which synonym-choice variant (0 or 1). */
  variant: number;
}

const cases: ParaphraseCase[] = [];
for (const cat of ATTACK_CATEGORIES) {
  for (const c of cat.cases) {
    // Skip base64 blobs: paraphrasing the carrier sentence around a blob
    // is still meaningful, but the payload itself is opaque — keep the
    // blob cases as-is (they're covered by the obfuscation category).
    if (/[A-Za-z0-9+/=]{32,}/.test(c.text) && c.id.startsWith("obf-0")) {
      continue;
    }
    for (const variant of [0, 1]) {
      const text = paraphrase(c.text, variant);
      if (text === c.text) continue;
      cases.push({
        id: `para-${c.id}-v${variant}`,
        derivedFrom: c.id,
        variant,
        text,
        tier: c.tier,
        note: `synthetic paraphrase of ${c.id} (${cat.name})`,
      });
    }
  }
}

const header = `/**
 * Synthetic paraphrase battery for the provenance-trust write gate.
 *
 * GENERATED by scripts/gen-paraphrase-battery.ts — do not hand-edit.
 * Deterministic template/synonym-level paraphrases of the 93 attack cases
 * in fixtures/redteam-battery.ts. These measure the gate's documented
 * paraphrase blind spot ("novel phrasings outside the cliché list don't
 * match"); they are synthetic, not human red-team prose, so the TPR here
 * is a lower-bound probe of the blind spot, not a live-adversary claim.
 */
import type { BatteryCase } from "./redteam-battery.js";

export interface ParaphraseCase extends BatteryCase {
  /** Original battery case id this paraphrase derives from. */
  derivedFrom: string;
  /** Which synonym-choice variant (0 or 1). */
  variant: number;
}

export const PARAPHRASE_CASES: ParaphraseCase[] = ${JSON.stringify(cases, null, 2)};
`;

writeFileSync(
  join(here, "../__tests__/fixtures/paraphrase-battery.ts"),
  header,
);
console.log(`wrote ${cases.length} paraphrase cases`);
