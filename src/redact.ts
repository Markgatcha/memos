/**
 * Redact secret-looking material from text before it reaches a log.
 *
 * Defense in depth for CodeQL js/clear-text-logging: the top-level CLI
 * catch-all logs `err.message`, and a future error message could echo a
 * cipher key, passphrase, or token. UUIDs (memory IDs) and ordinary words
 * are left alone so logs stay debuggable.
 *
 * @module @memos/redact
 */

/**
 * Matches `--key <value>`, `key=<value>`, `password: <value>`,
 * `MEMOS_KEY=<value>`, etc. A bare keyword followed by prose (e.g. "key
 * must be 32 bytes") is NOT matched — only `=`/`:` separators or the
 * `--flag value` form count, so ordinary messages stay readable.
 */
const SECRET_ASSIGNMENT_RE =
  /((?<![\w-])--(?:passphrase|password|passwd|secret|token|api[-_]?key|cipher[-_]?key|key)[\s=]+|\b(?:passphrase|password|passwd|secret|token|api[-_]?key|cipher[-_]?key|key)\s*[:=]\s*|['"]?(?:MEMOS_KEY|MEMOS_SYNC_KEY)['"]?\s*=\s*)\S+/gi;

/** Long opaque tokens (raw keys, bearer tokens) — but not UUIDs. */
const LONG_TOKEN_RE = /\b[A-Za-z0-9+/=_-]{32,}\b/g;
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT_RE, "$1[REDACTED]")
    .replace(LONG_TOKEN_RE, (m) => (UUID_RE.test(m) ? m : "[REDACTED]"));
}
