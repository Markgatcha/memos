/**
 * Structured, actionable errors.
 *
 * The old CLI printed `Fatal: <message>` and exited. That is enough for the
 * author, not for a user staring at a failed MCP hook. Every error now carries
 * a stable code, a hint, optional context (db path, provider, command), and a
 * redacted crash report path. `MEMOS_DEBUG=1` adds the stack.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "./redact.js";

export type MemOSErrorCode =
  | "MEMOS_DB_OPEN"
  | "MEMOS_DB_LOCKED"
  | "MEMOS_DB_CORRUPT"
  | "MEMOS_DB_ENCRYPTED"
  | "MEMOS_MIGRATION_FAILED"
  | "MEMOS_EMBEDDING_UNAVAILABLE"
  | "MEMOS_EMBEDDING_FAILED"
  | "MEMOS_PROVIDER_AUTH"
  | "MEMOS_PROVIDER_RATE_LIMIT"
  | "MEMOS_PROVIDER_TIMEOUT"
  | "MEMOS_CONFIG_INVALID"
  | "MEMOS_INVALID_INPUT"
  | "MEMOS_NOT_FOUND"
  | "MEMOS_IO"
  | "MEMOS_MCP_TOOL_FAILED"
  | "MEMOS_UNKNOWN";

export interface MemOSErrorOptions {
  code?: MemOSErrorCode;
  hint?: string;
  context?: Record<string, unknown>;
  cause?: unknown;
  docsUrl?: string;
}

const HINTS: Record<MemOSErrorCode, string> = {
  MEMOS_DB_OPEN:
    "Check that the database path is writable and that the directory exists. Run `memos doctor`.",
  MEMOS_DB_LOCKED:
    "Another MemOS process is writing. Wait a moment, then retry. If it persists, close other MCP/CLI processes or raise the SQLite busy timeout.",
  MEMOS_DB_CORRUPT:
    "Restore from a backup (`memos restore <path>`). Keep the corrupt file for inspection; do not overwrite it.",
  MEMOS_DB_ENCRYPTED:
    "This database is encrypted. Set MEMOS_KEY or pass `--key` to `memos encrypt/decrypt`.",
  MEMOS_MIGRATION_FAILED:
    "Back up the database, then run `memos doctor --json` and include the migration error in a bug report.",
  MEMOS_EMBEDDING_UNAVAILABLE:
    "Run `memos doctor`. Install `@huggingface/transformers`, start Ollama, or use the default Model2Vec provider.",
  MEMOS_EMBEDDING_FAILED:
    "The embedding provider failed during inference. Re-run `memos doctor`, then `memos reindex-embeddings --purge-stale`.",
  MEMOS_PROVIDER_AUTH:
    "The provider rejected the credentials. Check the API key environment variable (MEMOS_EMBEDDING_API_KEY / provider key).",
  MEMOS_PROVIDER_RATE_LIMIT:
    "The provider is rate-limiting requests. Reduce embedding concurrency or retry after the reset window.",
  MEMOS_PROVIDER_TIMEOUT:
    "The provider did not respond in time. Check the base URL/network, or raise the timeout in the provider config.",
  MEMOS_CONFIG_INVALID:
    "Check `~/.memos/config.json` or `.memos.json`. Run `memos init --yes` to regenerate a minimal config.",
  MEMOS_INVALID_INPUT: "Check the command usage with `memos <command> --help`.",
  MEMOS_NOT_FOUND:
    "The requested memory/lesson does not exist in this database. Check the id or run `memos search`.",
  MEMOS_IO:
    "A filesystem operation failed. Check free disk space, permissions, and the target path.",
  MEMOS_MCP_TOOL_FAILED:
    "The MCP tool failed. Check the MemOS server stderr and run `memos doctor`; the tool input is included in the error context.",
  MEMOS_UNKNOWN:
    "Run the failing command with MEMOS_DEBUG=1, then attach the crash report to a bug report.",
};

export class MemOSError extends Error {
  public readonly code: MemOSErrorCode;
  public readonly hint: string;
  public readonly context: Record<string, unknown>;
  public readonly docsUrl?: string;

  constructor(message: string, options: MemOSErrorOptions = {}) {
    super(redactSecrets(message), { cause: options.cause });
    this.name = "MemOSError";
    this.code = options.code ?? "MEMOS_UNKNOWN";
    this.hint = options.hint ?? HINTS[this.code];
    this.context = options.context ?? {};
    this.docsUrl =
      options.docsUrl ??
      "https://github.com/Markgatcha/memos/blob/main/docs/troubleshooting.md";
  }
}

export function isMemOSError(error: unknown): error is MemOSError {
  return error instanceof MemOSError;
}

/** Convert any thrown value into a MemOSError, preserving cause/message. */
export function asMemOSError(
  error: unknown,
  fallbackCode: MemOSErrorCode = "MEMOS_UNKNOWN",
  context: Record<string, unknown> = {},
): MemOSError {
  if (isMemOSError(error)) {
    if (Object.keys(context).length === 0) return error;
    return new MemOSError(error.message, {
      code: error.code,
      hint: error.hint,
      context: { ...error.context, ...context },
      cause: error.cause ?? error,
      ...(error.docsUrl ? { docsUrl: error.docsUrl } : {}),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = classifyError(message, fallbackCode);
  return new MemOSError(message, {
    code,
    context,
    cause: error,
  });
}

export function classifyError(
  message: string,
  fallback: MemOSErrorCode = "MEMOS_UNKNOWN",
): MemOSErrorCode {
  const text = message.toLowerCase();
  if (text.includes("sqlite_busy") || text.includes("database is locked")) {
    return "MEMOS_DB_LOCKED";
  }
  if (
    text.includes("sqlite_corrupt") ||
    text.includes("database disk image is malformed")
  ) {
    return "MEMOS_DB_CORRUPT";
  }
  if (
    text.includes("sqlite_notadb") ||
    text.includes("file is not a database") ||
    text.includes("decryption")
  ) {
    return "MEMOS_DB_ENCRYPTED";
  }
  if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("unauthorized") ||
    text.includes("invalid api key")
  ) {
    return "MEMOS_PROVIDER_AUTH";
  }
  if (text.includes("429") || text.includes("rate limit")) {
    return "MEMOS_PROVIDER_RATE_LIMIT";
  }
  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("aborted")
  ) {
    return "MEMOS_PROVIDER_TIMEOUT";
  }
  if (
    text.includes("eacces") ||
    text.includes("eperm") ||
    text.includes("enospc") ||
    text.includes("no such file or directory") ||
    text.includes("cannot open")
  ) {
    return "MEMOS_IO";
  }
  if (
    text.includes("embed") &&
    (text.includes("fallback") || text.includes("model"))
  ) {
    return "MEMOS_EMBEDDING_FAILED";
  }
  return fallback;
}

export interface FormatErrorOptions {
  debug?: boolean;
  reportPath?: string | null;
}

/** Human-facing, copy-pasteable error card. */
export function formatErrorCard(
  error: MemOSError,
  options: FormatErrorOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`MemOS error [${error.code}]`);
  lines.push(`  ${redactSecrets(error.message)}`);
  lines.push(`  what to do: ${error.hint}`);
  const context = Object.entries(error.context).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
  );
  if (context.length > 0) {
    lines.push("  context:");
    for (const [key, value] of context) {
      lines.push(`    ${key}: ${formatValue(value)}`);
    }
  }
  if (error.docsUrl) lines.push(`  docs: ${error.docsUrl}`);
  if (options.reportPath) {
    lines.push(`  crash report: ${options.reportPath}`);
  }
  if (options.debug && error.stack) {
    lines.push("  stack:");
    for (const line of redactSecrets(error.stack).split("\n")) {
      lines.push(`    ${line}`);
    }
  } else {
    lines.push("  set MEMOS_DEBUG=1 for the stack trace");
  }
  return lines.join("\n");
}

/** Structured payload for `--json` failures and MCP tool errors. */
export function errorPayload(error: MemOSError): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: redactSecrets(error.message),
      hint: error.hint,
      context: redactContext(error.context),
      docsUrl: error.docsUrl,
    },
  };
}

export interface CrashReportOptions {
  command?: string;
  argv?: string[];
  context?: Record<string, unknown>;
}

/**
 * Write a redacted JSON crash report. Returns the path, or null when the
 * report directory is not writable (the original error must still surface).
 */
export function writeCrashReport(
  error: MemOSError,
  options: CrashReportOptions = {},
): string | null {
  try {
    const dir =
      process.env.MEMOS_CRASH_DIR ?? join(homedir(), ".memos", "crash-reports");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `crash-${stamp}-${process.pid}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          schema: "memos.crash.v1",
          at: new Date().toISOString(),
          code: error.code,
          message: redactSecrets(error.message),
          hint: error.hint,
          stack: error.stack ? redactSecrets(error.stack) : null,
          context: redactContext({ ...error.context, ...options.context }),
          command: options.command ?? null,
          argv: (options.argv ?? []).map((arg) => redactSecrets(arg)),
          runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pid: process.pid,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    return path;
  } catch {
    return null;
  }
}

export function readLatestCrashReport(): Record<string, unknown> | null {
  try {
    const dir =
      process.env.MEMOS_CRASH_DIR ?? join(homedir(), ".memos", "crash-reports");
    const files = readdirSync(dir)
      .filter((name) => name.startsWith("crash-") && name.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return JSON.parse(readFileSync(join(dir, files[0]!), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

const SECRET_KEY = /(token|key|secret|password|passwd|authorization)/i;

function redactContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = typeof value === "string" ? redactSecrets(value) : value;
  }
  return out;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return redactSecrets(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
