/**
 * Write-gate quarantine — a local-heuristic classifier for
 * instruction-like payloads in memory writes and imports.
 *
 * Runs synchronously on the `store()` hot path (pure regex scoring,
 * microseconds per write — no LLM, no network). Content that scores at
 * or above {@link QUARANTINE_FLAG_THRESHOLD} is still stored (add-only
 * is preserved) but marked `quarantined: true`, which excludes it from
 * recall by default until a human reviews it via
 * `memos quarantine list|release`.
 *
 * Signal classes (each reports a stable machine-readable `code`):
 *
 * 1. Injection clichés — verbatim prompt-injection openers ("ignore
 *    previous instructions", "disregard your prior instructions",
 *    "do not tell the user", "pretend you are …"). Full-strength (2.0:
 *    quarantines on its own). Deliberately anchored to `previous`/`prior`
 *    so ordinary "ignore the old template" phrasing does NOT match.
 * 2. Imperative exfiltration — an exfil verb (send, email, upload, dump,
 *    …) governing a credential noun (passwords, api keys, secrets, …)
 *    in the same sentence. 1.5 alone; 2.0 when a URL/email destination
 *    appears in the same sentence ("send credentials to http://evil…").
 *    First-person possessives ("my password", "our api key") are exempt —
 *    "reset my password" is not an attack.
 * 3. Exfiltration-shaped — secret material (an `sk-…`/`AKIA…`/`ghp_…`
 *    token, a `-----BEGIN … PRIVATE KEY-----` block, or an
 *    `api key: <value>` assignment) next to a URL or an exfiltration
 *    verb ("upload to backup" after a pasted key has no URL, but the
 *    pairing is the same shape). 2.0.
 * 4. Encoded payloads — long base64 blobs (dormant-payload shape,
 *    Trojan-Hippo-style). 1.0 on its own: suspicious, but not proof.
 *
 * False-positive tuning: the negative corpus in
 * `__tests__/provenance-trust.test.ts` (~30 ordinary memories — wifi
 * passwords on the fridge, "send mom the photos", meeting notes with
 * URLs, developer-mode phone settings, surprise parties) must score
 * below threshold. The rules above were shaped by that corpus: possessive
 * exemptions, the previous/prior anchor, and requiring a destination or
 * secret shape before a URL matters.
 *
 * @module @mem-os/quarantine
 */

// ---------------------------------------------------------------------------
// Signal patterns (module-level: compiled once)
// ---------------------------------------------------------------------------

/** Full-strength injection clichés — any single hit quarantines. */
const INJECTION_CLICHES: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "injection:ignore-previous-instructions",
    pattern:
      /\bignore\s+(all\s+|any\s+)?(your\s+|the\s+)?(previous|prior)\s+instructions?\b/i,
  },
  {
    code: "injection:disregard-prior-instructions",
    pattern: /\bdisregard\s+(your\s+)?(previous|prior)\s+instructions?\b/i,
  },
  {
    code: "injection:override-instructions",
    pattern: /\boverride\s+your\s+(previous|prior|system)\s+instructions?\b/i,
  },
  {
    code: "injection:new-instructions-block",
    pattern: /\bnew\s+instructions?\s*:/i,
  },
  {
    code: "injection:hide-from-user",
    pattern: /\bdo\s+not\s+(tell|mention|reveal|disclose)\s+(the\s+)?user\b/i,
  },
  {
    code: "injection:pretend-role",
    pattern: /\bpretend\s+(you\s+are|to\s+be)\b/i,
  },
  {
    code: "injection:reveal-system-prompt",
    pattern: /\breveal\s+(your|the)\s+system\s+prompt\b/i,
  },
  {
    code: "injection:ai-self-override",
    pattern: /\bas\s+an?\s+ai\b.{0,60}?\bignore\b/i,
  },
  {
    code: "injection:forget-everything",
    pattern:
      /\bforget\s+(everything|all)\s+(you\s+(were\s+told|know)|your\s+(previous|prior)\s+instructions?)\b/i,
  },
  {
    code: "injection:prompt-override",
    pattern: /\bsystem\s+prompt\s+override\b/i,
  },
];

/** Partial-strength signals — suspicious alone, decisive in combination. */
const SUSPICIOUS_MARKERS: Array<{ code: string; pattern: RegExp }> = [
  { code: "suspicious:you-are-now", pattern: /\byou\s+are\s+now\b/i },
  { code: "suspicious:jailbreak", pattern: /\bjailbreak\w*\b/i },
  { code: "suspicious:dan-persona", pattern: /\bact\s+as\s+dan\b/i },
  { code: "suspicious:developer-mode", pattern: /\bdeveloper\s+mode\b/i },
  { code: "suspicious:system-prompt", pattern: /\bsystem\s+prompt\b/i },
  {
    code: "suspicious:role-marker",
    pattern: /(?:^|\n)\s*(?:system|developer)\s*:|<\|system\|>|\[SYSTEM\]/i,
  },
];

/** Imperative verbs that move data out (exfiltration-shaped). */
const EXFIL_VERB =
  /\b(send|forward|e-?mail|exfiltrate|upload|transmit|post|leak|disclose|dump|paste|copy|export)\b/i;
/** Credential nouns — the thing being moved. */
const CRED_NOUN =
  /\b(credentials?|passwords?|passwds?|secrets?|api[\s_-]*keys?|private[\s_-]*keys?|ssh[\s_-]*keys?|ssn|auth[\s_-]*tokens?|access[\s_-]*tokens?)\b/i;
/** First-person possessive directly before the credential: not an attack. */
const POSSESSIVE_EXEMPT = /\b(my|our)\s+$/i;

const URL_PATTERN = /https?:\/\/[^\s)"'\]]+/i;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
/** A webhook URL is a destination too ("post it to the webhook"). */
const WEBHOOK_PATTERN = /\bwebhooks?\b/i;

/** Secret material next to a URL: tokens, key blocks, assignments. */
const SECRET_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "exfil:secret-token", pattern: /\bsk-[A-Za-z0-9]{8,}/ },
  { code: "exfil:secret-token", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: "exfil:secret-token", pattern: /\bgh[op]_[A-Za-z0-9]{20,}\b/ },
  { code: "exfil:secret-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    code: "exfil:private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    code: "exfil:credential-assignment",
    // `api key: hunter2` / `password=abc` — the phrase alone ("the api key
    // is in 1password") does NOT match; an assignment does.
    pattern:
      /\b(api[\s_-]*key|password|passwd|secret|credentials?)\b\s*[:=]\s*\S{3,}/i,
  },
];

/** Long base64 blob — dormant-payload shape (Trojan-Hippo-style). */
const BASE64_BLOB = /\b[A-Za-z0-9+/]{64,}={0,2}\b/;

/** Quarantine at or above this score. Tuned against the negative corpus. */
export const QUARANTINE_FLAG_THRESHOLD = 2;

export interface QuarantineSignal {
  /** Stable machine-readable code, e.g. `injection:ignore-previous-instructions`. */
  code: string;
  /** Human-readable explanation. */
  detail: string;
  /** Points contributed toward {@link QUARANTINE_FLAG_THRESHOLD}. */
  points: number;
}

export interface QuarantineVerdict {
  flagged: boolean;
  score: number;
  signals: QuarantineSignal[];
  /** `;`-joined signal codes — stored in `quarantine_reason`. */
  reason: string;
}

function push(
  signals: QuarantineSignal[],
  code: string,
  detail: string,
  points: number,
): void {
  if (!signals.some((s) => s.code === code)) {
    signals.push({ code, detail, points });
  }
}

/**
 * Screen one write for instruction-like payloads. Pure, synchronous,
 * allocation-light — safe on the store() hot path.
 */
export function screenWrite(content: string): QuarantineVerdict {
  const signals: QuarantineSignal[] = [];
  if (!content || content.trim().length === 0) {
    return { flagged: false, score: 0, signals, reason: "" };
  }
  const text = content;

  // 1. Injection clichés — full strength.
  for (const { code, pattern } of INJECTION_CLICHES) {
    if (pattern.test(text)) {
      push(signals, code, "prompt-injection cliché", 2);
    }
  }

  // Suspicious markers — partial strength.
  for (const { code, pattern } of SUSPICIOUS_MARKERS) {
    if (pattern.test(text)) {
      push(signals, code, "suspicious instruction marker", 1);
    }
  }

  // 2. Imperative exfiltration, per sentence. Sentences split only on
  // terminators followed by whitespace+capital (or end of text) and on
  // newlines — naive splitting on "." shreds emails and URLs, which
  // would hide the destination half of the signal.
  const sentences = text.split(/\n+|[.!?]+(?=\s+[A-Z"'(\[]|\s*$)/);
  for (const sentence of sentences) {
    const verbMatch = EXFIL_VERB.exec(sentence);
    if (!verbMatch || verbMatch.index === undefined) continue;
    const afterVerb = sentence.slice(verbMatch.index + verbMatch[0].length);
    const credMatch = CRED_NOUN.exec(afterVerb.slice(0, 80));
    if (!credMatch || credMatch.index === undefined) continue;
    // "reset MY password" / "rotate OUR api keys" — the user talking
    // about their own credentials, not an instruction to the agent.
    const beforeCred = afterVerb.slice(0, credMatch.index);
    if (POSSESSIVE_EXEMPT.test(beforeCred)) continue;
    const hasDestination =
      URL_PATTERN.test(sentence) ||
      EMAIL_PATTERN.test(sentence) ||
      WEBHOOK_PATTERN.test(sentence);
    push(
      signals,
      hasDestination
        ? "exfil:imperative-with-destination"
        : "exfil:imperative-credentials",
      hasDestination
        ? "imperative exfiltration with a destination"
        : "imperative verb governing credentials",
      hasDestination ? 2 : 1.5,
    );
  }

  // 3. Exfiltration-shaped: secret material next to a URL — or next to
  // an exfiltration verb (a pasted private key followed by "upload to
  // backup" has no URL, but the pairing is the same shape).
  const hasUrl = URL_PATTERN.test(text);
  const hasExfilVerb = EXFIL_VERB.test(text);
  if (hasUrl || hasExfilVerb) {
    for (const { code, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        push(
          signals,
          code,
          hasUrl
            ? "URL adjacent to secret material"
            : "exfiltration verb with secret material",
          2,
        );
      }
    }
  }

  // 4. Encoded payload shape.
  if (BASE64_BLOB.test(text)) {
    push(signals, "suspicious:encoded-blob", "long base64 blob", 1);
  }

  const score = signals.reduce((sum, s) => sum + s.points, 0);
  return {
    flagged: score >= QUARANTINE_FLAG_THRESHOLD,
    score,
    signals,
    reason: signals.map((s) => s.code).join(";"),
  };
}
