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
 * The classifier first normalizes its input
 * ({@link normalizeForScreening}): NFKC unicode folding, zero-width
 * character stripping, Cyrillic/Greek homoglyph folding, single-newline
 * collapsing, spaced-letter joining (`i g n o r e` → `ignore`), and
 * whitespace collapsing. Injection clichés are additionally matched
 * against a leetspeak-unfolded copy (`1gn0re` → `ignore`).
 *
 * Signal classes (each reports a stable machine-readable `code`):
 *
 * 1. Injection clichés — verbatim prompt-injection openers ("ignore
 *    previous instructions", "disregard your prior instructions",
 *    "do not tell the user", "pretend you are …", DAN/jailbreak
 *    patterns, chat-template role markers). Full-strength (2.0:
 *    quarantines on its own). Deliberately anchored to
 *    `previous`/`prior` so ordinary "ignore the old template" phrasing
 *    does NOT match.
 * 2. Imperative exfiltration — an exfil verb (send, email, upload, dump,
 *    …) governing a credential noun (passwords, api keys, secrets, …).
 *    1.5 alone; 2.0 when a URL/email destination appears anywhere in
 *    the write, or when verb+destination share a sentence and a
 *    credential noun appears anywhere. First-person possessives ("my
 *    password", "our api key") are exempt — "reset my password" is not
 *    an attack. On low-trust tiers (`tool-output`, `imported`) the
 *    bare verb+credential shape is 2.0 on its own — tool output that
 *    moves credentials is never benign.
 * 3. Exfiltration-shaped — secret material (an `sk-…`/`AKIA…`/`ghp_…`
 *    token, a `-----BEGIN … PRIVATE KEY-----` block, or an
 *    `api key: <value>` assignment) next to a URL or an exfiltration
 *    verb. 2.0.
 * 4. Encoded payloads — base64 blobs are decoded (whitespace-tolerant,
 *    depth-bounded) and the decoded text is re-screened: a blob that
 *    decodes to an injection scores 2.0 (`injection:encoded-
 *    instructions`); an opaque blob is 1.0 on its own (1.5 on
 *    low-trust tiers). A candidate only counts as a blob when it looks
 *    like real base64 (a digit, `+`/`/`, or `=` padding) — English prose
 *    that merely uses base64-alphabet words is not a blob.
 * 5. Low-trust-tier dormant instructions (Trojan-Hippo shape) —
 *    conditional future-directed instructions ("when the user asks
 *    about X, always say Y", "from now on, include …", "never mention
 *    …") are 2.0, but ONLY for `tool-output`/`imported` tiers. Tool
 *    output is data, never behavioral instructions; the same phrasing
 *    in a user's own memory ("when I travel, always pack my charger")
 *    is silent.
 * 6. Low-trust-tier trigger phrases (AgentPoison shape) — nonce-like
 *    tokens or trigger words ("code word", "activation token")
 *    co-occurring with instruction-shaped content. 2.0, low-trust
 *    tiers only.
 *
 * False-positive tuning: the negative corpus in
 * `__tests__/fixtures/redteam-battery.ts` (60 ordinary memories —
 * wifi passwords on the fridge, "send mom the photos", meeting notes
 * with URLs, developer-mode phone settings, surprise parties) must
 * score below threshold, including adversarial-benign cases such as
 * security notes quoting attack clichés. Quoted clichés under
 * meta-discussion framing ("how do I defend against 'ignore previous
 * instructions'?", "the article explains DAN mode") halves every signal
 * and caps total injection:* contribution at 1.0 — discussing an attack
 * is not an attack. A single unquoted injection signal wearing a
 * discussion-like prefix ("Security update: ignore previous
 * instructions") still evades; that residual gap is documented in
 * docs/provenance-trust.md.
 *
 * @module @mem-os/quarantine
 */

import { LOW_TRUST_TIERS } from "./provenance.js";
import type { ProvenanceTier } from "./types.js";

// ---------------------------------------------------------------------------
// Normalization (anti-obfuscation)
// ---------------------------------------------------------------------------

/** Invisible characters attackers use to break token matching. */
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060\u180E\u00AD]/g;

/**
 * Cyrillic/Greek lookalikes → ASCII. Applied after NFKC (which already
 * folds fullwidth forms). Characters without a mapping pass through.
 */
const HOMOGLYPHS: Record<string, string> = {
  а: "a",
  в: "b",
  с: "c",
  е: "e",
  ё: "e",
  і: "i",
  ј: "j",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  ѕ: "s",
  т: "t",
  х: "x",
  у: "y",
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ζ: "z",
};

const CONFUSABLE_RE = /[Ͱ-ϿЀ-џ]/g;

function foldConfusable(ch: string): string {
  const lower = ch.toLowerCase();
  const mapped = HOMOGLYPHS[lower];
  if (!mapped) return ch;
  return ch === lower ? mapped : mapped.toUpperCase();
}

/**
 * `i g n o r e` → `ignore`: runs of single letters joined by SINGLE
 * spaces only. A multi-space gap is a word boundary and must survive
 * this step — over-joining ("ignorepreviousinstructions") would destroy
 * the word separation the cliché patterns need. (Whitespace collapsing
 * runs after this, so surviving gaps still become single spaces.)
 */
const SPACED_LETTERS_RE = /\b(?:[a-zA-Z] ){1,}[a-zA-Z]\b/g;

/** Leetspeak unfolding, applied to a copy used for cliché matching. */
const LEET_MAP: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "+": "t",
};

const LEET_CHARS_RE = /[0134578@$!+]/g;

/**
 * Normalize write content before screening: NFKC folding, zero-width
 * stripping, homoglyph folding, single-newline joining (paragraph
 * breaks still split sentences), spaced-letter joining, and whitespace
 * collapsing. Exported for testing.
 */
export function normalizeForScreening(content: string): string {
  let t = content.normalize("NFKC");
  t = t.replace(/\r\n?/g, "\n");
  // Zero-width characters become spaces: to a tokenizer
  // "Ignore<ZWSP>previous" reads as two tokens, so the screen must see
  // two words too. (Deleting them would join the words and STILL evade.)
  t = t.replace(ZERO_WIDTH_RE, " ");
  t = t.replace(CONFUSABLE_RE, foldConfusable);
  // Single newlines are line-wrapping, not sentence breaks.
  t = t.replace(/(?<!\n)\n(?!\n)/g, " ");
  t = t.replace(SPACED_LETTERS_RE, (m) => m.replace(/\s+/g, ""));
  t = t.replace(/[ \t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]{2,}/g, " ");
  return t;
}

/**
 * Meta-discussion framing: the text talks *about* attacks rather than
 * mounting one ("how do I defend against…", "red-team exercise", "the
 * article explains DAN mode"). Under this framing every signal is halved
 * and the total contribution of injection:* signals is capped at 1.0, so
 * security discussions don't quarantine while multi-signal attacks with
 * discussion-like prefixes still do.
 */
const META_DISCUSSION_RE =
  /\b(how\s+(do|can|to)|defend|defen[cs]e|protect(ing|ion)?|prevent(ing|ion)?|mitigat|detect(ing|ion)?|red[\s-]?team|security|example|e\.g\.|explain|discuss|what\s+is|what\s+are|article|paper|ctf|fiction|story|novel|screenplay|creative\s+writing)\b/i;

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
    code: "injection:disregard-prior-directives",
    pattern:
      /\bdisregard\s+(all\s+|any\s+)?(your\s+|the\s+)?(prior|previous)\s+(directives?|instructions?|orders?)\b/i,
  },
  {
    // Synonym-expanded dismissal frame: "set aside all earlier orders",
    // "pay no attention to preceding guidance", "supersede your system
    // orders". The full frame (dismissal verb + temporal + authority
    // noun) is required — "disregard the previous email" does not match.
    code: "injection:dismiss-prior-authority",
    pattern:
      /\b(ignore|disregard|forget|set\s+aside|brush\s+aside|pay\s+no\s+(attention|heed)\s+to|supersede|take\s+precedence\s+over|wipe\s+from\s+memory|erase|override|overrule)\s+(all\s+|any\s+)?(your\s+|the\s+)?(previous|prior|earlier|preceding)\s+(system\s+)?(instructions?|orders?|directives?|guidance)\b/i,
  },
  {
    code: "injection:override-instructions",
    pattern: /\boverride\s+your\s+(previous|prior|system)\s+instructions?\b/i,
  },
  {
    code: "injection:new-system-prompt",
    pattern: /\bnew\s+system\s+(prompt|instructions?)\s*:/i,
  },
  {
    code: "injection:hide-from-user",
    pattern:
      /\b(do\s+not\s+(tell|mention|reveal|disclose|inform)|keep\s+from|withhold\s+from|hide\s+from)\s+(the\s+)?user\b/i,
  },
  {
    // Paraphrased prompt-extraction: "pass along your core instructions",
    // "lay bare your base configuration". Plain "share your instructions"
    // does not match — the noun must be system-flavored.
    code: "injection:reveal-instructions",
    pattern:
      /\b(pass\s+along|lay\s+bare|reveal|disclose|hand\s+over)\s+your\s+(core\s+instructions?|base\s+configuration|system\s+(prompt|instructions?))\b/i,
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
    code: "injection:forget-told",
    pattern:
      /\b(forget|erase)\s+(what\s+|everything\s+)?you\s+were\s+told\b|\bwipe\s+from\s+memory\b.{0,30}?\byou\s+were\s+told\b/i,
  },
  {
    code: "injection:forget-training",
    pattern:
      /\bforget\s+(your\s+)?(training|safety\s+guidelines|guidelines)\b/i,
  },
  {
    code: "injection:prompt-override",
    pattern: /\bsystem\s+prompt\s+override\b/i,
  },
  {
    code: "injection:template-role-marker",
    pattern: /(?:^|\n)\s*(?:<\|im_start\|>|<\|system\|>|\[SYSTEM\])/i,
  },
  {
    code: "injection:dan-do-anything",
    pattern: /\bdo\s+anything\s+now\b/i,
  },
  {
    code: "injection:dan-persona",
    pattern: /\bact\s+as\s+dan\b/i,
  },
  {
    code: "injection:dan-version",
    pattern: /\bdan\s+\d+(\.\d+)?\b/i,
  },
  {
    code: "injection:dan-mode",
    pattern: /\bdan\s+mode\b/i,
  },
  {
    code: "injection:godmode",
    pattern: /\bgodmode\b/i,
  },
  {
    code: "injection:jailbreak-target",
    pattern: /\bjailbreak\w*\s+(the\s+)?(ai|assistant|model|system)\b/i,
  },
  {
    code: "injection:unfiltered-model",
    pattern: /\b(unfiltered|uncensored)\s+(ai|mode|model)\b/i,
  },
  {
    code: "injection:unrestricted-mode",
    pattern:
      /\b(unrestricted|limit-?free|boundless|restriction-?free)\s+mode\b/i,
  },
  {
    code: "injection:no-constraints",
    pattern: /\bfree\s+from\s+all\s+(constraints|restrictions|rules|limits)\b/i,
  },
  {
    code: "injection:no-limits",
    pattern: /\bwith\s+no\s+(limits|restrictions|constraints|rules|ethics)\b/i,
  },
  {
    code: "injection:developer-mode-abuse",
    pattern: /\bdeveloper\s+mode\b.{0,40}?\b(disable|bypass|remove)\b/i,
  },
  {
    code: "injection:disregard-safety",
    pattern:
      /\bdisregard\s+(your\s+)?(safety|content)\s+(guidelines|policies|filters)\b/i,
  },
  {
    // "remove all content filters", "activate debug mode to deactivate
    // safety checks" — paraphrased safety-disable frames.
    code: "injection:remove-filters",
    pattern: /\bremove\s+all\s+(content\s+)?filters\b/i,
  },
  {
    code: "injection:mode-disable-safety",
    pattern:
      /\b(engineer|debug|developer|god)\s+mode\b.{0,40}?\b(disable|deactivate|switch\s+off|remove|bypass)\b.{0,40}?\b(safety|protection|content\s+filters|guardrails|checks)\b/i,
  },
];

/**
 * Injection cliché split across two adjacent sentences ("Please ignore
 * the following. Previous instructions no longer apply."). Tested on
 * 2-sentence windows only — deliberately looser than the anchored
 * single-sentence clichés.
 */
const CROSS_SENTENCE_OVERRIDE_RE =
  /\b(ignore|disregard|forget)\b.{0,80}?\b(previous|prior)\s+instructions?\b/i;

/** Partial-strength signals — suspicious alone, decisive in combination. */
const SUSPICIOUS_MARKERS: Array<{ code: string; pattern: RegExp }> = [
  { code: "suspicious:you-are-now", pattern: /\byou\s+are\s+now\b/i },
  { code: "suspicious:jailbreak", pattern: /\bjailbreak\w*\b/i },
  {
    code: "suspicious:dan-token",
    pattern: /\bDAN\b/,
  },
  { code: "suspicious:developer-mode", pattern: /\bdeveloper\s+mode\b/i },
  { code: "suspicious:system-prompt", pattern: /\bsystem\s+prompt\b/i },
  {
    code: "suspicious:role-marker",
    pattern: /(?:^|\n)\s*(?:system|developer)\s*:/i,
  },
  {
    code: "suspicious:new-instructions",
    pattern: /\bnew\s+instructions?\s*:/i,
  },
];

/** Imperative verbs that move data out (exfiltration-shaped). There is
 * deliberately NO trailing `\b`: `_` is a word char, so `\b` never fires
 * between "send" and "_" and `send_email`/`forward_message` would be
 * missed (real miss: trojan-hippo hippo-08 scored 0.0). The negative
 * lookahead `(?![a-zA-Z])` still blocks longer-word matches ("sends",
 * "sender"; "descend" is blocked by the leading `\b`). */
const EXFIL_VERB =
  /\b(send|forward|e-?mail|exfiltrate|upload|transmit|post|leak|disclose|dump|paste|copy|export)(?![a-zA-Z])/i;
/** Credential nouns — the thing being moved. */
const CRED_NOUN =
  /\b(credentials?|passwords?|passwds?|passcodes?|secrets?|api[\s_-]*keys?|private[\s_-]*keys?|ssh[\s_-]*keys?|ssns?|auth[\s_-]*tokens?|access[\s_-]*tokens?)\b/i;
/**
 * Message/data nouns: exfiltration of user *content* rather than
 * credentials — the dominant Trojan-Hippo indirect-injection shape
 * ("Body: the user's full message", "Subject: User Identity Inquiry").
 * First-person forms ("my message") do not match: they stay exempt so a
 * user asking to forward their own note is not flagged.
 */
const DATA_EXFIL_NOUN =
  /\b(user'?s?\s+(full\s+)?(messages?|inquir(y|ies)|inputs?|conversations?)|personal\s+data|\bPII\b|identity\s+documents?|passport\s+numbers?)\b/i;
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

/** Base64 blob candidate (whitespace-tolerant; validated on decode). */
const B64_CANDIDATE_RE = /[A-Za-z0-9+/\s]{32,}={0,2}/g;

/**
 * Dormant-instruction shapes (Trojan-Hippo): conditional,
 * future-directed instructions to the agent. Only scored for low-trust
 * tiers — tool output is data, never behavioral instructions.
 */
const DORMANT_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "suspicious:dormant-instruction",
    pattern:
      /\b(when|whenever|if)\s+(the\s+user|asked|someone|anyone)\b[^.!?]{0,160}?\byou\s+(must|should|always|never|are\s+required)\b/i,
  },
  {
    code: "suspicious:dormant-instruction",
    pattern:
      /\b(when|whenever|if)\s+(the\s+user|asked|someone|anyone)\b[^.!?]{0,160}?\b(always|never|make\s+sure)\b/i,
  },
  {
    code: "suspicious:dormant-instruction",
    pattern:
      /\bfrom\s+now\s+on\b[^.!?]{0,120}?\b(include|say|tell|mention|recommend|respond|always|never)\b/i,
  },
  {
    code: "suspicious:dormant-instruction",
    pattern:
      /\b(if|when|whenever)\s+(anyone|someone|the\s+user|asked)\b[^.!?]{0,160}?[,:\s]\s*(say|tell|respond|claim|never\s+mention)\b/i,
  },
  {
    code: "suspicious:dormant-instruction",
    pattern:
      /\b(activate|enable|disable|switch\s+to)\b[^.!?]{0,60}?\bwhen\s+the\s+user\s+says\b/i,
  },
];

/** Suppression rules — each 1.0; the pair together quarantines. */
const SUPPRESSION_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "suspicious:store-rule", pattern: /\bstore\s+this\s+rule\b/i },
  { code: "suspicious:never-mention", pattern: /\bnever\s+mention\b/i },
];

/**
 * Nonce-like token (AgentPoison trigger shape): ≥6 chars, contains a
 * digit. Base64-candidate spans are stripped before this scan so long
 * blobs don't count as triggers.
 */
const NONCE_RE = /\b(?=[a-z0-9-]*[0-9])[a-z0-9-]{6,}\b/i;
/** Trigger vocabulary: "code word", "activation token", … */
const TRIGGER_WORD_RE =
  /\b(trigger|code\s*word|protocol|activation\s*token|secret\s*trigger|poison)\b/i;
/** Instruction-shaped co-occurrence for trigger signals. */
const TRIGGER_PAYLOAD_RE =
  /\b(bypass|disable|ignore\s+all|comply|obey|reveal|exfiltrat|send|disclose)\b/i;

/**
 * Impersonated-authority framing: the write presents itself as a system /
 * security / compliance notice to make embedded instructions look
 * legitimate ("NOTICE TO AI ASSISTANT", "*** SYSTEM NOTICE ***"). Fires
 * on all tiers at partial strength and is never diluted by the
 * meta-discussion exemption — "Security update: ignore previous
 * instructions" is an attack, not a discussion.
 */
const AUTHORITY_CLAIM_RE =
  /\b(notice\s+to\s+(the\s+)?ai\s+assistant|system\s+(notice|override|update|alert)|security\s+(protocol\s+)?(update|notice|bulletin)|official\s+(announcement|notice)|data\s+loss\s+prevention(\s*\(dlp\))?\s+rules?|dlp\s+protocol|escalation\s+polic(y|ies)|diagnostic\s+protocol|capability\s+update|note\s+for\s+memory\s+extraction|vendor\s+notice|compliance\s+(notice|policy|update)|(hr\s+)?policy\s+update|new\s+policy)\b/i;

/**
 * Memory-write commands (MPBench explicit/conditional command insertion):
 * directives to persist content into long-term memory ("remember for
 * future sessions", "store this in memory"). Only scored for low-trust
 * tiers — a user's own "remember:" notes use natural language, while
 * tool output issuing persistence directives is the attack shape.
 */
const MEMORY_WRITE_COMMAND_RE =
  /\b(remember|store|save|add|commit|write|update)\b[^.!?]{0,60}?\b(for\s+future\s+(sessions?|reference)|in(to)?\s+(long[ -]term\s+)?memory|to\s+(long[ -]term\s+)?memory|user\s+profile|this\s+preference)\b/i;

/**
 * Replacement directives (RAG-poisoning taxonomy): instructions to
 * discard retrieved/earlier content in favor of the planted text
 * ("disregard the retrieved documents", "the correct answer is").
 * Fires on all tiers at partial strength.
 */
const REPLACEMENT_DIRECTIVE_RE =
  /\b(disregard\s+the\s+(retrieved|provided|above|earlier)\s+(documents?|context|results?|sources?)|use\s+this\s+(answer|response|information|version)\s+instead|the\s+(correct|real|right)\s+(answer|response|information)\s+is|ignore\s+the\s+(retrieved|above|provided)\s+(context|documents?|sources?))\b/i;

/**
 * False-fact replacement assertions (MemGhost-style): claims that a
 * limit, PIN, policy, or support fact *changed* ("has been changed to
 * 0000 effective immediately"). Only scored for low-trust tiers and at
 * partial strength — without ground truth a changed-fact claim is
 * suspicious, not proof of poisoning, so it quarantines only in
 * combination with another signal.
 */
const FACTUAL_REPLACEMENT_RE =
  /\b(raised|lowered|increased|decreased|changed|updated)\s+to\b|\bhas\s+been\s+(changed|updated|raised|lowered)\s+to\b|\beffective\s+(immediately|as\s+of)\b|\b(new\s+(data\s+handling\s+)?(policy|procedure|standard|requirement)|policy\s+update)\b/i;

/**
 * Credential-harvest URL (phishing-shaped): "re-entering credentials at
 * https://…" — a directive to type secrets into an external site.
 */
const CREDENTIAL_HARVEST_URL_RE =
  /\b(re-?enter(ing)?|submit|provide)\s+(your\s+)?(credentials?|passwords?|logins?)\b[^.!?]{0,80}?\bhttps?:\/\/|\bhttps?:\/\/[^\s)"'\]]+\b[^.!?]{0,80}?\b(re-?enter(ing)?|submit)\s+(your\s+)?(credentials?|passwords?)\b/i;

/**
 * Security-control disable: "disabling MFA enforcement", "bypass 2FA".
 */
const SECURITY_DISABLE_RE =
  /\b(disabl\w*|bypass\w*|turn\w*\s+off)\b[^.!?]{0,40}?\b(mfa|2fa|two-?factor|authentication|security|encryption|logging|audit(ing)?)\b/i;

/**
 * Conditional memory claim: "when the user replies 'confirmed', remember
 * that they authorized …" — a fabricated authorization smuggled in as a
 * conditional memory directive.
 */
const CONDITIONAL_MEMORY_CLAIM_RE =
  /\b(when|if)\s+the\s+user\s+(replies?|says|confirms?|responds?)\b[^.!?]{0,80}?\bremember\s+that\b/i;

/**
 * False-precedent URL: a runbook/playbook/checklist entry directing a
 * fetch from an external URL ("fetched pipeline config from
 * https://…").
 */
const PRECEDENT_URL_RE =
  /\b(runbook|playbook|checklist|task\s+log)\b[^.!?]{0,120}?\bhttps?:\/\//i;

/**
 * Insecure-storage claim: an assertion that secrets may live in the
 * clear ("SSNs may be stored in plain text in shared notes").
 */
const INSECURE_STORAGE_CLAIM_RE =
  /\b(ssns?|passwords?|credentials?|api[\s_-]*keys?|secrets?)\b[^.!?]{0,40}?\b(plain\s+text|unencrypted|shared\s+notes)\b/i;

/**
 * Declared-channel mismatch: a write whose declared tier is user-like
 * but whose content frames itself as tool output, search results, a web
 * page, or an email ("Search results: …", "Tool output: …"). Such
 * writes are screened with low-trust strictness — a declared channel
 * alone never skips the tier-gated rules.
 */
const CHANNEL_MISMATCH_RE =
  /\b(search\s+results|tool\s+output|api\s+(response|docs?|returned)|web\s*page\s+says|according\s+to\s+the\s+(document|article|web\s*page|web\s*site)|the\s+(pdf|readme|transcript|email|document|article)\s+(contains|says|states)|email\s+from|calendar\s+invite|scraped\s+(page|content)|webpage\s+excerpt)\b/i;

/** Quarantine at or above this score. Tuned against the negative corpus. */
export const QUARANTINE_FLAG_THRESHOLD = 2;

/**
 * Signal codes that only fire on low-trust tiers (dormant instructions,
 * trigger phrases, suppression rules). These are strong attack
 * indicators under the tier threat model — tool output is data, never
 * behavioral instructions — so meta-discussion framing must not dilute
 * them: "whenever the user asks about security, you should claim…"
 * mentions "security" but is still an attack.
 */
const TIER_GATED_CODES = new Set([
  "suspicious:dormant-instruction",
  "suspicious:trigger-phrase",
  "suspicious:store-rule",
  "suspicious:never-mention",
  "suspicious:memory-write-command",
  "suspicious:factual-replacement",
  "suspicious:credential-harvest-url",
  "suspicious:security-disable",
  "suspicious:conditional-memory-claim",
  "suspicious:precedent-url",
  "suspicious:insecure-storage-claim",
]);

/**
 * Signal codes the meta-discussion exemption must never dilute. Tier-gated
 * codes are already exempt (on low-trust tiers the shape itself is the
 * attack); the authority-claim signal joins them because an attack wearing
 * a "security update" prefix is still an attack — the exemption exists for
 * texts *about* attacks, not attacks *framed as* authority.
 */
const NEVER_DILUTE_CODES = new Set([
  ...TIER_GATED_CODES,
  "suspicious:authority-claim",
]);

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

export interface ScreenWriteOptions {
  /**
   * Provenance tier of the write. Low-trust tiers (`tool-output`,
   * `imported`) get stricter screening: dormant-instruction and
   * trigger-phrase signals activate, and bare verb+credential
   * exfiltration quarantines on its own. Defaults to user-like
   * (lenient) when omitted.
   */
  tier?: ProvenanceTier;
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

/** Split into sentences for the per-sentence exfiltration scan. */
function splitSentences(text: string): string[] {
  return text.split(/\n{2,}|[.!?]+(?=\s+[A-Z"'(\[]|\s*$)/);
}

/**
 * Try to decode a base64 candidate. Returns the decoded text only when
 * it looks like real text (cheap pre-check); the caller re-screens it
 * and treats a scoring decode as the actual payload test.
 */
function tryDecodeBase64(candidate: string): string | null {
  const clean = candidate.replace(/\s+/g, "");
  if (clean.length < 32 || /[^A-Za-z0-9+/=]/.test(clean)) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(clean, "base64");
  } catch {
    return null;
  }
  if (buf.length < 12) return null;
  const text = buf.toString("utf8");
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code < 127)
    ) {
      ascii++;
    }
  }
  // Real payloads are prose: near-all-ASCII with word spaces. Random
  // decodes of ordinary words ("Systempromptengineering…") land around
  // 0.6 ASCII with no spaces — both checks together reject those while
  // genuine English payloads pass at ~1.0.
  if (ascii / text.length < 0.75) return null;
  if (!text.includes(" ")) return null;
  if (!/[a-zA-Z]{3,}/.test(text)) return null;
  return text;
}

/**
 * Scan one (already normalized) text for signals. Runs the
 * injection/exfiltration patterns on both the plain and the
 * leetspeak-unfolded text; base64 and tier-gated signals run on the
 * plain text only.
 */
function collectSignals(
  text: string,
  tier: ProvenanceTier | undefined,
  depth: number,
): QuarantineSignal[] {
  const signals: QuarantineSignal[] = [];
  const declaredLowTrust = !!tier && LOW_TRUST_TIERS.has(tier);
  // A declared channel alone never skips the tier-gated rules: a
  // user-tier write that frames itself as tool output / search results /
  // a web page is screened with low-trust strictness.
  const channelMismatch = !declaredLowTrust && CHANNEL_MISMATCH_RE.test(text);
  const lowTrust = declaredLowTrust || channelMismatch;
  if (channelMismatch) {
    push(
      signals,
      "suspicious:channel-mismatch",
      "declared user-tier write frames itself as tool/web/email content — screened with low-trust strictness",
      0,
    );
  }
  const leet = text.replace(LEET_CHARS_RE, (ch) => LEET_MAP[ch] ?? ch);
  const targets = text === leet ? [text] : [text, leet];

  for (const target of targets) {
    // 1. Injection clichés — full strength.
    for (const { code, pattern } of INJECTION_CLICHES) {
      if (pattern.test(target)) {
        push(signals, code, "prompt-injection cliché", 2);
      }
    }

    // Suspicious markers — partial strength.
    for (const { code, pattern } of SUSPICIOUS_MARKERS) {
      if (pattern.test(target)) {
        push(signals, code, "suspicious instruction marker", 1);
      }
    }

    // Impersonated-authority framing — partial strength on every tier,
    // never diluted by the meta-discussion exemption (see
    // NEVER_DILUTE_CODES).
    if (AUTHORITY_CLAIM_RE.test(target)) {
      push(
        signals,
        "suspicious:authority-claim",
        "write impersonates a system/security/compliance notice",
        1,
      );
    }

    // Replacement directives (RAG-poisoning taxonomy) — partial
    // strength on every tier.
    if (REPLACEMENT_DIRECTIVE_RE.test(target)) {
      push(
        signals,
        "suspicious:replacement-directive",
        "directive to discard retrieved/earlier content",
        1,
      );
    }

    // Cross-sentence override clichés on adjacent sentence windows.
    const sentences = splitSentences(target);
    for (let i = 0; i + 1 < sentences.length; i++) {
      if (
        CROSS_SENTENCE_OVERRIDE_RE.test(`${sentences[i]} ${sentences[i + 1]}`)
      ) {
        push(
          signals,
          "injection:cross-sentence-override",
          "override cliché split across sentences",
          2,
        );
        break;
      }
    }

    // 2. Imperative exfiltration, per sentence (each sentence is also
    // scanned together with its successor, so verb/credential pairs
    // split across one sentence boundary still match). A destination
    // upgrades the score — but only a NEARBY destination (within one
    // sentence of the verb/credential window), so an unrelated URL three
    // paragraphs away cannot turn a benign sentence into exfiltration.
    const nearbyText = (i: number) =>
      sentences.slice(Math.max(0, i - 1), i + 3).join(" ");
    for (let i = 0; i < sentences.length; i++) {
      const spansTwo = i + 1 < sentences.length;
      const window = spansTwo
        ? `${sentences[i]} ${sentences[i + 1]}`.slice(0, 400)
        : sentences[i];
      const verbMatch = EXFIL_VERB.exec(window);
      if (verbMatch && verbMatch.index !== undefined) {
        const afterVerb = window.slice(verbMatch.index + verbMatch[0].length);
        const credMatch = CRED_NOUN.exec(afterVerb.slice(0, 80));
        if (credMatch && credMatch.index !== undefined) {
          // "reset MY password" / "rotate OUR api keys" — the user talking
          // about their own credentials, not an instruction to the agent.
          const beforeCred = afterVerb.slice(0, credMatch.index);
          if (!POSSESSIVE_EXEMPT.test(beforeCred)) {
            const nearby = nearbyText(i);
            const hasDestination =
              URL_PATTERN.test(nearby) ||
              EMAIL_PATTERN.test(nearby) ||
              WEBHOOK_PATTERN.test(nearby);
            // Cross-sentence verb/credential pairs are weaker evidence than
            // same-sentence ones.
            const basePoints = spansTwo ? 1.0 : 1.5;
            push(
              signals,
              hasDestination
                ? "exfil:imperative-with-destination"
                : "exfil:imperative-credentials",
              hasDestination
                ? "imperative exfiltration with a destination"
                : "imperative verb governing credentials",
              hasDestination ? 2 : lowTrust ? 2 : basePoints,
            );
          }
        }
      }

      // Message/data exfiltration: the verb governs user *content*
      // ("send an email to vince2000@gmail.com … containing the user's
      // full message") rather than credentials — the dominant
      // indirect-injection forwarding shape. Runs independently of the
      // credential branch above (a forwarding directive names no
      // credential nouns, and the verb may sit outside the two-sentence
      // window). The data noun may sit several sentences after the verb
      // (directive, recipient, subject, body), so this scans the whole
      // nearby neighborhood; the verb must still precede the data noun
      // and a first-person form ("send my message") stays exempt via the
      // possessive check. `push` dedupes by code, so overlapping
      // neighborhoods can't double-count.
      const scanText = nearbyText(i);
      const scanVerb = EXFIL_VERB.exec(scanText);
      const dataMatch = DATA_EXFIL_NOUN.exec(scanText);
      if (
        scanVerb &&
        scanVerb.index !== undefined &&
        dataMatch &&
        dataMatch.index !== undefined
      ) {
        const verbEnd = scanVerb.index + scanVerb[0].length;
        const beforeData = scanText.slice(0, dataMatch.index);
        if (
          dataMatch.index >= verbEnd &&
          !POSSESSIVE_EXEMPT.test(beforeData.slice(-16))
        ) {
          if (
            URL_PATTERN.test(scanText) ||
            EMAIL_PATTERN.test(scanText) ||
            WEBHOOK_PATTERN.test(scanText)
          ) {
            push(
              signals,
              "exfil:message-forwarding",
              "imperative exfiltration of user content to an external destination",
              2,
            );
          }
        }
      }
    }

    // Verb + destination in one sentence, credential noun nearby
    // (anaphoric "Send them to https://…​" after naming credentials).
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const verbMatch = EXFIL_VERB.exec(sentence);
      if (!verbMatch) continue;
      const hasDestination =
        URL_PATTERN.test(sentence) ||
        EMAIL_PATTERN.test(sentence) ||
        WEBHOOK_PATTERN.test(sentence);
      if (!hasDestination) continue;
      const nearby = nearbyText(i);
      if (
        CRED_NOUN.test(nearby) ||
        DATA_EXFIL_NOUN.test(nearby) ||
        SECRET_PATTERNS.some((s) => s.pattern.test(nearby))
      ) {
        push(
          signals,
          "exfil:imperative-with-destination",
          "imperative exfiltration with a destination",
          2,
        );
      }
    }

    // 3. Exfiltration-shaped: secret material next to a URL — or next to
    // an exfiltration verb (a pasted private key followed by "upload to
    // backup" has no URL, but the pairing is the same shape).
    const hasUrl = URL_PATTERN.test(target);
    const hasExfilVerb = EXFIL_VERB.test(target);
    if (hasUrl || hasExfilVerb) {
      for (const { code, pattern } of SECRET_PATTERNS) {
        if (pattern.test(target)) {
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
  }

  // 4. Encoded payloads: decode base64 candidates and re-screen.
  // Runs on the normalized text only (leet-unfolding would corrupt
  // base64), depth-bounded against nested encoding.
  if (depth < 2) {
    let encodedBlobSeen = false;
    for (const match of text.matchAll(B64_CANDIDATE_RE)) {
      const raw = match[0];
      const subCandidates = new Set<string>();
      for (const token of raw.split(/\s+/)) {
        if (token.replace(/=+$/, "").length >= 32) subCandidates.add(token);
      }
      subCandidates.add(raw);
      for (const candidate of subCandidates) {
        const decoded = tryDecodeBase64(candidate);
        if (decoded) {
          const inner = collectSignals(
            normalizeForScreening(decoded),
            tier,
            depth + 1,
          );
          const innerScore = inner.reduce((sum, s) => sum + s.points, 0);
          if (innerScore >= 1) {
            push(
              signals,
              "injection:encoded-instructions",
              `base64-decoded payload scored ${innerScore} (${inner.map((s) => s.code).join(";")})`,
              2,
            );
            break;
          }
        }
        // Opaque blob: the candidate must look like real base64 — a
        // single whitespace-free token containing a digit, `+`/`/`, or
        // `=` padding. Multi-word prose is never a blob, even when it
        // contains a digit ("changed to 0000 effective immediately" is
        // not base64): real blobs are one long token, and the
        // whitespace-tolerant match above exists only so wrapped blobs
        // still decode, not so sentences count as opaque.
        if (!/\s/.test(candidate) && /[0-9+/=]/.test(candidate)) {
          encodedBlobSeen = true;
        }
      }
    }
    if (encodedBlobSeen) {
      push(
        signals,
        "suspicious:encoded-blob",
        "long base64 blob",
        lowTrust ? 1.5 : 1,
      );
    }
  }

  // 5 & 6. Low-trust-tier signals: dormant instructions (Trojan-Hippo)
  // and trigger phrases (AgentPoison). Tool output is data — never
  // behavioral instructions — so these shapes quarantine on sight here
  // while staying silent for user-tier writes.
  if (lowTrust) {
    for (const { code, pattern } of DORMANT_PATTERNS) {
      if (pattern.test(text)) {
        push(signals, code, "dormant conditional instruction", 2);
      }
    }
    // Memory-write commands (MPBench command insertion): tool output
    // directing persistence into long-term memory.
    if (MEMORY_WRITE_COMMAND_RE.test(text)) {
      push(
        signals,
        "suspicious:memory-write-command",
        "directive to persist content into long-term memory",
        2,
      );
    }
    // False-fact replacement assertions (MemGhost-style): without ground
    // truth these quarantine only in combination with another signal.
    if (FACTUAL_REPLACEMENT_RE.test(text)) {
      push(
        signals,
        "suspicious:factual-replacement",
        "assertion that a fact/limit/policy changed",
        1.5,
      );
    }
    // Credential-harvest URL (phishing-shaped).
    if (CREDENTIAL_HARVEST_URL_RE.test(text)) {
      push(
        signals,
        "suspicious:credential-harvest-url",
        "directive to enter credentials at an external URL",
        1.5,
      );
    }
    // Security-control disable ("disabling MFA enforcement").
    if (SECURITY_DISABLE_RE.test(text)) {
      push(
        signals,
        "suspicious:security-disable",
        "directive to disable a security control",
        1.5,
      );
    }
    // Conditional memory claim ("when the user replies 'confirmed',
    // remember that they authorized …").
    if (CONDITIONAL_MEMORY_CLAIM_RE.test(text)) {
      push(
        signals,
        "suspicious:conditional-memory-claim",
        "conditional directive to remember a claimed authorization",
        1,
      );
    }
    // False-precedent URL (runbook/playbook directing an external fetch).
    if (PRECEDENT_URL_RE.test(text)) {
      push(
        signals,
        "suspicious:precedent-url",
        "procedure entry directing a fetch from an external URL",
        1,
      );
    }
    // Insecure-storage claim ("SSNs may be stored in plain text").
    if (INSECURE_STORAGE_CLAIM_RE.test(text)) {
      push(
        signals,
        "suspicious:insecure-storage-claim",
        "assertion that secrets may be stored insecurely",
        1.5,
      );
    }
    for (const { code, pattern } of SUPPRESSION_PATTERNS) {
      if (pattern.test(text)) {
        push(signals, code, "suppression rule", 1);
      }
    }
    const deblobbed = text.replace(B64_CANDIDATE_RE, " ");
    const hasNonce = NONCE_RE.test(deblobbed);
    const hasTriggerWord = TRIGGER_WORD_RE.test(text);
    if (hasNonce || hasTriggerWord) {
      const hasPayload =
        TRIGGER_PAYLOAD_RE.test(text) ||
        EXFIL_VERB.test(text) ||
        INJECTION_CLICHES.some((c) => c.pattern.test(text)) ||
        DORMANT_PATTERNS.some((d) => d.pattern.test(text));
      if (hasPayload) {
        push(
          signals,
          "suspicious:trigger-phrase",
          "nonce/trigger token paired with instruction-shaped content",
          2,
        );
      }
    }
  }

  return signals;
}

/**
 * Screen one write for instruction-like payloads. Pure, synchronous,
 * allocation-light — safe on the store() hot path.
 *
 * Pass `opts.tier` for tier-aware strictness: `tool-output` /
 * `imported` writes additionally screen for dormant instructions and
 * trigger phrases, and bare verb+credential exfiltration quarantines.
 */
export function screenWrite(
  content: string,
  opts: ScreenWriteOptions = {},
): QuarantineVerdict {
  const signals: QuarantineSignal[] = [];
  if (!content || content.trim().length === 0) {
    return { flagged: false, score: 0, signals, reason: "" };
  }
  const text = normalizeForScreening(content);
  const full = collectSignals(text, opts.tier, 0);
  // Meta-discussion framing ("how do I defend against…", "red-team
  // exercise"): the text talks *about* attacks. Halve every signal and
  // cap the total injection:* contribution at 1.0, so security
  // discussions, articles, and creative writing don't quarantine —
  // while attacks merely wearing a discussion-like prefix still need
  // only one more signal to cross the threshold. URLs and emails are
  // stripped before this test so a domain like evil.example.com can't
  // trigger the exemption via the word "example"; tier-gated signals
  // (low-trust dormant instructions / trigger phrases) are never
  // diluted — on those tiers the shape itself is the attack.
  const framingText = text
    .replace(/https?:\/\/[^\s)"'\]]+/gi, " ")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, " ");
  const framing = META_DISCUSSION_RE.test(framingText);
  let injectionBudget = 1.0;
  for (const s of full) {
    // Tier-gated signals were already exempt; the authority-claim signal
    // joins them via NEVER_DILUTE_CODES — an attack framed as a
    // "security update" is not a meta-discussion.
    const gated = NEVER_DILUTE_CODES.has(s.code);
    let points = framing && !gated ? s.points * 0.5 : s.points;
    if (framing && s.code.startsWith("injection:")) {
      points = Math.min(points, injectionBudget);
      injectionBudget = Math.max(0, injectionBudget - points);
    }
    push(signals, s.code, s.detail, points);
  }

  const score =
    Math.round(signals.reduce((sum, s) => sum + s.points, 0) * 10) / 10;
  return {
    flagged: score >= QUARANTINE_FLAG_THRESHOLD,
    score,
    signals,
    reason: signals.map((s) => s.code).join(";"),
  };
}
