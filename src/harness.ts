/**
 * Harness attribution for MemOS — "one memory, every harness."
 *
 * Every memory records the agent harness (Claude Code, Cline, Codex,
 * Gemini CLI, OpenClaw, …) that wrote it, stamped deterministically at
 * write time. Detection is environment-based — pure, synchronous, no
 * LLM anywhere — so a fresh process on the same DB file attributes
 * identically to the process that wrote the memory.
 *
 * Detection rules, in priority order:
 *
 * 1. `MEMOS_HARNESS` — explicit override. Wins over everything; this is
 *    also the supported seam for tests and for deployments where the
 *    harness is known but leaves no env marker.
 * 2. Known harness env markers (prefix match, first hit wins in the
 *    table order below).
 * 3. `"unknown"` — unattributed (plain SDK use, legacy rows, tests).
 *
 * The tag is *attribution*, not isolation: it says which harness
 * authored a memory version. Cross-harness reads default to `all`;
 * `recall({ harness })` / `search({ harness })` scope to one harness.
 * When harness B updates a memory written by harness A, the old version
 * keeps its A tag and the replacement carries B — supersession is
 * version-scoped, so the version ledger stays honest.
 *
 * @module @memos/harness
 */

/** Attribution value for memories written with no detectable harness. */
export const UNKNOWN_HARNESS = "unknown";

/** Environment variable that explicitly overrides harness detection. */
export const MEMOS_HARNESS_ENV = "MEMOS_HARNESS";

/**
 * Known harness env markers. Order is priority: the first matching
 * entry wins, so more specific harnesses must precede less specific
 * ones. `match` is either an exact variable name or a prefix
 * (trailing `_` means "prefix match").
 */
export const HARNESS_MARKERS: ReadonlyArray<{
  /** Exact env var name or `PREFIX_` for a prefix match. */
  match: string;
  /** Normalized harness slug stamped on memories. */
  harness: string;
}> = [
  { match: "CLAUDECODE", harness: "claude-code" },
  { match: "CLAUDE_CODE_", harness: "claude-code" },
  { match: "CLINE_", harness: "cline" },
  { match: "CODEX_", harness: "codex" },
  { match: "GEMINI_", harness: "gemini-cli" },
  { match: "OPENCLAW_", harness: "openclaw" },
];

/**
 * Normalize a raw harness name to a stable slug: trimmed, lowercased,
 * whitespace/underscores collapsed to `-`. Empty input normalizes to
 * {@link UNKNOWN_HARNESS}.
 */
export function normalizeHarness(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return slug.length > 0 ? slug : UNKNOWN_HARNESS;
}

/**
 * Deterministically detect the current harness from the environment.
 *
 * Pure function of its input — pass `process.env` in production, a
 * stub record in tests. Scans each marker in priority order; the first
 * env var that is set and non-empty wins. `MEMOS_HARNESS` always wins.
 *
 * @param env — Environment mapping. Defaults to `process.env`.
 * @returns A harness slug (`"claude-code"`, `"cline"`, `"codex"`,
 *   `"gemini-cli"`, `"openclaw"`, a `MEMOS_HARNESS` slug, or
 *   `"unknown"`).
 */
export function detectHarness(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const override = env[MEMOS_HARNESS_ENV];
  if (override !== undefined && override.trim().length > 0) {
    return normalizeHarness(override);
  }
  const names = Object.keys(env);
  for (const marker of HARNESS_MARKERS) {
    if (marker.match.endsWith("_")) {
      // Prefix marker, e.g. CLAUDE_CODE_ matches CLAUDE_CODE_ENTRYPOINT.
      const hit = names.some(
        (name) =>
          name.startsWith(marker.match) && (env[name] ?? "").trim().length > 0,
      );
      if (hit) return marker.harness;
    } else {
      const value = env[marker.match];
      if (value !== undefined && value.trim().length > 0) {
        return marker.harness;
      }
    }
  }
  return UNKNOWN_HARNESS;
}
