/**
 * Command-driven belief revision ("natural-language revert").
 *
 * MemOS has a bitemporal validity ledger (`valid_from`/`valid_to` on nodes
 * and edges) and a contradiction-detection pipeline — but invalidation only
 * fires on *detected* contradictions. This module provides the missing
 * primitive: detecting a *revert command* in user/agent text, locally, with
 * no LLM on the hot path (patterns + entity/scope resolution only).
 *
 * Intent model:
 * - "last" scope — "revert that", "undo what I just told you",
 *   "forget the last thing", "that last thing was wrong", "go back".
 *   Resolves to the most recent currently-valid, non-audit memory in the
 *   namespace (durable across processes: a CLI invocation is its own
 *   session, so "last" means the newest write in the store).
 * - "named" scope — "revert what I said about the dentist",
 *   "undo the dentist appointment". Resolves to the best-matching memory
 *   for the named entity.
 *
 * Disambiguation rule (documented, deterministic):
 * - When several memories match a named target, the most recently created
 *   valid memory wins; every other match is returned as an `alternative`
 *   so the caller (CLI dry-run, MCP dry_run) can confirm before executing.
 * - `forget <named entity>` is deliberately NOT revert intent — it is the
 *   existing `memos_forget` semantic (delete the memory), not a request to
 *   restore an older version. Only `forget the last thing` / `forget what
 *   I said` (no entity named) counts as revert intent.
 *
 * @module @memos/revert
 */

import type { RevertScopeInput } from "./types.js";
export type { RevertScopeInput };

export type RevertScopeKind = "last" | "named" | "unknown";

export interface RevertIntent {
  /** True when the text contains a revert command. */
  detected: boolean;
  /** Which scope the command carries; "unknown" when not detected. */
  scope: RevertScopeKind;
  /** Normalized target phrase for named scope, e.g. "the dentist". */
  target?: string;
  /** Name of the pattern that fired (debugging / docs). */
  pattern?: string;
}

interface RevertPattern {
  name: string;
  scope: RevertScopeKind;
  /** For named scope, capture group 1 is the target phrase. */
  regex: RegExp;
}

// Evaluation order matters: named patterns run BEFORE last-scope patterns
// (e.g. "revert what I said about the dentist" must not be swallowed by the
// "what I said" branch of the last-scope "undo that" pattern). The
// `the\s+(?!last\s+thing\b)` guard keeps "revert the last thing" on the
// last-scope path.
const NAMED_SCOPE_PATTERNS: RevertPattern[] = [
  {
    name: "revert-about",
    scope: "named",
    // The "what I said" branch requires an explicit "about" so bare
    // "revert what I just told you" stays on the last-scope path.
    regex:
      /\brevert\s+(?:what\s+i\s+(?:just\s+)?(?:said|told(?:\s+you)?|mentioned)\s+about\s+|my\s+(?:memory|note|fact)\s+(?:about\s+)?|the\s+(?!last\s+thing\b))(.+?)\s*[.!?;]*$/i,
  },
  {
    name: "undo-about",
    scope: "named",
    regex:
      /\bundo\s+(?:what\s+i\s+(?:just\s+)?(?:said|told(?:\s+you)?|mentioned)\s+about\s+|the\s+(?!last\s+thing\b))(.+?)\s*[.!?;]*$/i,
  },
  {
    name: "thing-was-wrong",
    scope: "named",
    // Guarded so "the last thing was wrong" stays last-scope.
    regex:
      /\bthe\s+(?!last\b)(.+?)\s+(?:thing|fact|note)\s+(?:is|was)\s+wrong\b/i,
  },
];

// Last-scope patterns — evaluated AFTER named patterns.
const LAST_SCOPE_PATTERNS: RevertPattern[] = [
  {
    name: "undo-that",
    scope: "last",
    regex:
      /\b(undo|revert)\s+(that|it|the\s+last\s+thing|what\s+i\s+(?:just\s+)?(?:said|told(?:\s+you)?|mentioned|added|wrote))\b/i,
  },
  {
    name: "take-back",
    scope: "last",
    regex: /\b(take|strike)\s+(that|it)\s+back\b/i,
  },
  {
    name: "go-back",
    scope: "last",
    // Negative lookahead excludes literal travel ("go back home/to X").
    regex:
      /(?:^|[.!?;,\s])go\s+back(?!\s+(?:to|home|there|here|inside|outside|in|into|and|for)\b)/i,
  },
  {
    name: "forget-last-thing",
    scope: "last",
    regex:
      /\bforget\s+(?:the\s+last\s+thing|what\s+i\s+(?:just\s+)?(?:said|told(?:\s+you)?|mentioned|added|wrote))\b/i,
  },
  {
    name: "that-was-wrong",
    scope: "last",
    regex:
      /\b(?:that|this)\s+(?:last\s+thing\s+)?(?:is|was)\s+wrong\b|\blast\s+thing\b.{0,40}\bwrong\b/i,
  },
  {
    name: "scratch-that",
    scope: "last",
    regex: /\b(?:scratch|disregard|ignore|never\s+mind)\s+that\b/i,
  },
];

/**
 * Normalize a captured target phrase: trim, strip trailing punctuation,
 * then surrounding quotes (order matters for `"the gym"!`), collapse
 * whitespace.
 */
export function normalizeRevertTarget(raw: string): string {
  return raw
    .trim()
    .replace(/[.!?;,]+$/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/[.!?;,]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect a revert command in free text. Local-only: regex patterns, no LLM.
 *
 * @param text — The user/agent utterance.
 * @returns The detected intent, or `{ detected: false, scope: "unknown" }`.
 */
export function detectRevertIntent(text: string): RevertIntent {
  if (!text || typeof text !== "string") {
    return { detected: false, scope: "unknown" };
  }
  // Named patterns first — see the comment on NAMED_SCOPE_PATTERNS.
  for (const pattern of NAMED_SCOPE_PATTERNS) {
    const match = pattern.regex.exec(text);
    if (match?.[1]) {
      const target = normalizeRevertTarget(match[1]);
      if (target.length > 0) {
        return {
          detected: true,
          scope: "named",
          target,
          pattern: pattern.name,
        };
      }
    }
  }
  for (const pattern of LAST_SCOPE_PATTERNS) {
    if (pattern.regex.test(text)) {
      return { detected: true, scope: "last", pattern: pattern.name };
    }
  }
  return { detected: false, scope: "unknown" };
}

export interface ParsedRevertArgs {
  scope: RevertScopeInput;
  dryRun: boolean;
  reason?: string;
  actor?: string;
  namespace?: string;
  /** Human-readable error when the args don't form a valid revert. */
  error?: string;
}

/**
 * Parse `memos revert` CLI arguments (pure, no side effects — testable).
 *
 *   memos revert --last [--dry-run] [--reason <r>] [--actor <a>]
 *   memos revert --id <id> [--dry-run] ...
 *   memos revert --about <entity> [--dry-run] ...
 *   memos revert "<natural language>" [--dry-run] ...
 *
 * Flags that take a value: --id, --about, --reason, --actor, --namespace.
 */
export function parseRevertCliArgs(args: string[]): ParsedRevertArgs {
  // Strip global CLI flags (handled by the CLI harness, not the command).
  const filtered: string[] = [];
  const globalsWithValue = new Set(["--db", "--key"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (globalsWithValue.has(args[i]!)) {
      i++;
      continue;
    }
    filtered.push(args[i]!);
  }
  args = filtered;
  const valueOf = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")
      ? args[idx + 1]
      : undefined;
  };
  const dryRun = args.includes("--dry-run");
  const reason = valueOf("--reason");
  const actor = valueOf("--actor");
  const namespace = valueOf("--namespace");
  const id = valueOf("--id");
  const about = valueOf("--about");
  const last = args.includes("--last");
  const positional = args.find(
    (a) =>
      !a.startsWith("--") &&
      a !== id &&
      a !== about &&
      a !== reason &&
      a !== actor &&
      a !== namespace,
  );

  const base: Omit<ParsedRevertArgs, "scope"> = { dryRun };
  if (reason) base.reason = reason;
  if (actor) base.actor = actor;
  if (namespace) base.namespace = namespace;

  const explicit = [
    id && "--id",
    last && "--last",
    about && "--about",
    positional && "<text>",
  ].filter(Boolean) as string[];
  if (explicit.length > 1) {
    return {
      ...base,
      scope: { kind: "last" },
      error: `Conflicting scope flags: ${explicit.join(", ")}. Pick one of --last, --id, --about, or a single text argument.`,
    };
  }
  if (id) return { ...base, scope: { kind: "id", id } };
  if (last) return { ...base, scope: { kind: "last" } };
  if (about) return { ...base, scope: { kind: "entity", entity: about } };
  if (positional) {
    const intent = detectRevertIntent(positional);
    if (!intent.detected) {
      return {
        ...base,
        scope: { kind: "text", text: positional },
        error: `No revert intent detected in "${positional}". Try "revert that", "revert the last thing", or "revert what I said about <topic>".`,
      };
    }
    return { ...base, scope: { kind: "text", text: positional } };
  }
  return {
    ...base,
    scope: { kind: "last" },
    error:
      'Nothing to revert. Usage: memos revert --last | --id <id> | --about <topic> | "<natural language>" [--dry-run]',
  };
}
