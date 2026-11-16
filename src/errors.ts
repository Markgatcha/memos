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
  | "MEMOS_BRIDGE_UNAVAILABLE"
  | "MEMOS_BRIDGE_CRASHED"
  | "MEMOS_SERVER_ERROR"
  | "MEMOS_UNKNOWN";

export interface MemOSErrorOptions {
  code?: MemOSErrorCode;
  hint?: string;
  explanation?: string;
  context?: Record<string, unknown>;
  cause?: unknown;
  docsUrl?: string;
}

const DOCS_URL =
  "https://github.com/Markgatcha/memos/blob/main/docs/troubleshooting.md";

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
  MEMOS_BRIDGE_UNAVAILABLE:
    "The HTTP layer cannot reach the Node.js bridge that holds your memories. Check the server log for bridge startup errors (better-sqlite3 install, Node on PATH), then restart `python -m memos.server.main`.",
  MEMOS_BRIDGE_CRASHED:
    "The Node.js bridge died or stopped responding mid-request. Check the server stderr for a crash report (missing native binding, out of memory), then restart `python -m memos.server.main`.",
  MEMOS_SERVER_ERROR:
    "Something failed inside the MemOS server outside normal request handling. Set MEMOS_LOG_LEVEL=debug for a fuller traceback, or include this report in a bug report.",
  MEMOS_UNKNOWN:
    "Run the failing command with MEMOS_DEBUG=1, then attach the crash report to a bug report.",
};

/**
 * Bug explainers: for every error code, what probably went wrong and why.
 *
 * HINTS answer "what do I do now?". This registry answers the question a user
 * actually asks first — "what happened?" — with a plain-English explanation
 * and the likely causes, in rough order of probability. `memos explain-error`
 * prints this; the CLI, MCP and HTTP surfaces attach it to unexpected
 * failures automatically.
 */
export interface MemOSErrorExplainer {
  code: MemOSErrorCode;
  /** One-line label for the failure class. */
  summary: string;
  /** What probably went wrong, and when it happens. */
  explanation: string;
  /** Most likely causes first. */
  likelyCauses: string[];
  /** Mirrors HINTS[code]: what to do next. */
  hint: string;
  docsUrl: string;
}

const EXPLANATIONS: Record<
  MemOSErrorCode,
  { summary: string; explanation: string; likelyCauses: string[] }
> = {
  MEMOS_DB_OPEN: {
    summary: "The database file could not be opened",
    explanation:
      "MemOS could not open the SQLite store. Opening happens at startup and on every command that touches the database; it fails when the path or its directory is missing, not writable, points at a directory, or the native SQLite binding failed to load.",
    likelyCauses: [
      "The --db path (or MEMOS_DB_PATH) points at a directory or a non-existent parent folder",
      "No write permission on the file or its directory (common for a database copied from another machine)",
      "First run after npm install with the better-sqlite3 native binding missing or blocked",
      "The file is on a read-only mount or a filesystem that does not support SQLite locking",
    ],
  },
  MEMOS_DB_LOCKED: {
    summary: "SQLite reports the database is locked",
    explanation:
      "Another process holds a write lock (or a long write is in progress) and MemOS's busy timeout expired first. SQLite allows many concurrent readers but exactly one writer, so any overlapping write — including a crashed process that left a lock behind — blocks this command.",
    likelyCauses: [
      "A hung memos/MCP process writing to the same store",
      "A crash interrupted a write; SQLite is recovering the WAL",
      "`memos backup` or an ingest running at the same time as this command",
      "The database lives on a network drive or synced folder that serializes file locks poorly",
    ],
  },
  MEMOS_DB_CORRUPT: {
    summary: "The database file failed SQLite's integrity checks",
    explanation:
      "SQLite could not parse the pages of the file, which means the bytes no longer match what SQLite wrote. Reads may return garbage and writes are refused, to keep the damage from spreading. This is almost never a MemOS logic bug — it is how the file ended up broken that matters.",
    likelyCauses: [
      "The disk filled up or the machine lost power mid-write",
      "The database was copied or synced while it was open (the -wal/-shm sidecars were left behind)",
      "Two processes wrote without SQLite's locking (file on a network share)",
      "A restore of a partial or mismatched backup file",
    ],
  },
  MEMOS_DB_ENCRYPTED: {
    summary:
      "The store is encrypted (or not a database) and the key is wrong or missing",
    explanation:
      "MemOS opened a file it could not read as plaintext SQLite. With encryption enabled, the full key is required for every connection; without a key, MemOS refuses to touch the file. A non-database file produces the same family of errors.",
    likelyCauses: [
      "The database was encrypted with `memos encrypt` and MEMOS_KEY / --key was not supplied",
      "The wrong key was supplied (keys are not validated until a page is read)",
      "--db points at a file that is not a MemOS database at all (e.g. a JSON export renamed to .db)",
      "The file was created by a different encryption build without the matching cipher",
    ],
  },
  MEMOS_MIGRATION_FAILED: {
    summary: "A schema migration did not apply cleanly",
    explanation:
      "MemOS upgrades the on-disk schema when opening the store. A step failed — the store was left at the previous version, or the migration could not complete, so the command stopped rather than risk the file.",
    likelyCauses: [
      "Disk filled up or the process was interrupted mid-migration",
      "The database was backed up or copied in the middle of a migration",
      "A manual ALTER/DROP outside MemOS left an unexpected schema",
      "An old database opened by a build older than the migration that created it",
    ],
  },
  MEMOS_EMBEDDING_UNAVAILABLE: {
    summary: "No embedding backend is reachable",
    explanation:
      "Semantic search needs an embedder. None is available: the default Model2Vec provider could not load, or the configured remote provider (Ollama / HF / OpenAI-compatible) is down, unreachable, or not installed.",
    likelyCauses: [
      "First run: the optional Model2Vec package (@yarflam/potion-base-8m) is not installed or the install was blocked",
      "MEMOS_EMBEDDING_PROVIDER points at an endpoint that is not running (e.g. Ollama on 11434)",
      "Offline environment with a cleared model cache",
      "A proxy or firewall is blocking the embedding endpoint",
    ],
  },
  MEMOS_EMBEDDING_FAILED: {
    summary: "The embedding provider errored during inference",
    explanation:
      "An embedding backend was configured and reachable, but failed while embedding a document or query — so this is an inference-time failure, not a setup failure.",
    likelyCauses: [
      "The provider rejected the input (too large, unsupported content type)",
      "The model ran out of memory or the runtime crashed mid-batch",
      "A corrupt or partially downloaded model cache",
      "The configured dimensions no longer match the stored vectors (re-embed with `memos reindex-embeddings`)",
    ],
  },
  MEMOS_PROVIDER_AUTH: {
    summary: "The provider rejected the credentials (401/403)",
    explanation:
      "The remote embedding or LLM provider refused the request because the credentials were missing, invalid, revoked, or lack permission for the requested model. MemOS does not retry auth failures.",
    likelyCauses: [
      "MEMOS_EMBEDDING_API_KEY (or the provider-specific key) is unset, mistyped, or has a stray newline",
      "The key was revoked or its project does not have access to the model",
      "Wrong header name for the endpoint (some providers expect Authorization: Bearer, others a custom header)",
      "The base URL points at a gateway that expects a different credential",
    ],
  },
  MEMOS_PROVIDER_RATE_LIMIT: {
    summary: "The provider throttled the request (429)",
    explanation:
      "The provider returned a rate-limit response. Bulk operations hit this fastest; MemOS stops rather than silently drop embeddings it promised to store.",
    likelyCauses: [
      "Bulk ingest or reindexing exceeds the provider's per-minute/per-day quota",
      "A shared API key used by many processes at once",
      "A retry loop re-sending the throttled request and deepening the limit",
      "A free-tier rate window (quotas reset hourly or daily — wait and retry)",
    ],
  },
  MEMOS_PROVIDER_TIMEOUT: {
    summary: "The provider did not answer within the timeout",
    explanation:
      "The request was sent but no response arrived in time — the network path, a proxy, or the provider itself is slow or down. The model may still have processed the request server-side.",
    likelyCauses: [
      "A proxy/VPN/firewall is silently dropping long-lived HTTPS connections",
      "The base URL is wrong (http vs https, wrong port) so the connection hangs",
      "The provider is overloaded or the model is cold-starting (first request after idle)",
      "Very large documents embedded in a single call — lower MEMOS_EMBEDDING_BATCH_SIZE",
    ],
  },
  MEMOS_CONFIG_INVALID: {
    summary: "Configuration could not be parsed or validated",
    explanation:
      "~/.memos/config.json or a local .memos.json contains JSON that will not parse or values MemOS cannot accept. MemOS refuses to guess, so the command stops before touching the store.",
    likelyCauses: [
      "A hand edit left a trailing comma, a comment, or smart quotes in the JSON",
      "The file was truncated (disk full or an interrupted write)",
      "A merge conflict marker was committed into .memos.json",
      "An environment variable (e.g. MEMOS_PORT, MEMOS_EMBEDDING_DIMENSIONS) is set to a non-numeric value",
    ],
  },
  MEMOS_INVALID_INPUT: {
    summary: "The command or tool received invalid input",
    explanation:
      "Input failed validation before touching the store — a missing argument, a bad flag value, or malformed JSON. Validation happens first so nothing half-runs.",
    likelyCauses: [
      "Missing quotes around content with spaces or shell metacharacters",
      "An unknown flag or a value the flag does not accept (e.g. --pool banana)",
      "Malformed JSON on stdin to the bridge or an MCP tool call",
      "A namespace/pool/type that does not match MemOS's accepted values",
    ],
  },
  MEMOS_NOT_FOUND: {
    summary: "The requested memory, lesson, or record does not exist",
    explanation:
      "No row matches the given id in this database — it was deleted, superseded and archived, or the id belongs to a different store than the one this command opened.",
    likelyCauses: [
      "The id came from another machine, dump, or an older backup",
      "--db / MEMOS_DB_PATH points at a different (newer or empty) database",
      "The memory was forgotten or purged by `memos consolidate`",
      "A typo in the id (ids are case-sensitive)",
    ],
  },
  MEMOS_IO: {
    summary: "A filesystem operation failed",
    explanation:
      "An OS-level file operation failed — open, read, write, rename, mkdir — due to permissions, missing paths, or disk conditions. The message names the failing operation.",
    likelyCauses: [
      "Disk full (ENOSPC) while writing a backup, export, or crash report",
      "No permission on the target path, or a Windows file lock on the file being written",
      "The backup/export destination directory does not exist",
      "Invalid path characters or a path longer than the OS limit",
    ],
  },
  MEMOS_MCP_TOOL_FAILED: {
    summary: "An MCP tool call failed",
    explanation:
      "A tool raised inside the MemOS MCP server. When MemOS recognized the underlying failure, the structured payload carries its code; otherwise treat the server stderr as the source of truth.",
    likelyCauses: [
      "The underlying db/embedding/provider error — check the code in the same payload",
      "The MCP server is running a stale build from before a recent upgrade",
      "The tool timed out on a large ingest or reindex",
      "A harness passed arguments the tool schema does not accept",
    ],
  },
  MEMOS_BRIDGE_UNAVAILABLE: {
    summary: "The HTTP server cannot reach its Node.js bridge",
    explanation:
      "The Python HTTP layer proxies every memory operation to a Node subprocess that runs the SDK. That subprocess is not running — it never started, exited earlier, or failed its SDK self-check — so no request can be served.",
    likelyCauses: [
      "First run: the staged runtime (~/.memos/runtime/js) failed its npm install (offline, blocked scripts)",
      "better-sqlite3 is present but its native binding is missing — npm install was interrupted or scripts were blocked",
      "Node.js is not on PATH for the server process",
      "The staged runtime is corrupt after an upgrade (delete ~/.memos/runtime/js and restart)",
    ],
  },
  MEMOS_BRIDGE_CRASHED: {
    summary: "The Node.js bridge died or went silent mid-request",
    explanation:
      "The bridge accepted the request but produced no usable answer — it crashed, was killed, or wrote nothing to stdout. The HTTP layer cannot know whether the operation completed, so it reports failure instead of guessing.",
    likelyCauses: [
      "The Node process ran out of memory (large ingest or reindex)",
      "A native module (better-sqlite3 / sqlite-vec) segfaulted",
      "An unhandled SDK exception killed the bridge on a code path with no error handler",
      "Something printed to stdout that was not a protocol frame (check server log)",
    ],
  },
  MEMOS_SERVER_ERROR: {
    summary: "An unexpected error escaped the HTTP server's request handling",
    explanation:
      "An exception that is not a client error and not a bridge failure reached the server's last-resort handler. This is a bug or an environment problem — malformed client input does not produce this code.",
    likelyCauses: [
      "A bug in the server or routes (include the message and your MemOS version in a bug report)",
      "Disk full while writing logs or exporting",
      "The staged runtime was modified while the server was running",
      "Incompatible fastapi/pydantic versions (check the server startup log)",
    ],
  },
  MEMOS_UNKNOWN: {
    summary: "An unexpected error MemOS could not classify",
    explanation:
      "Something threw that matches none of the known failure signatures. The redacted crash report written for this code has the stack and the context MemOS had at the time — it is the fastest route to a root cause.",
    likelyCauses: [
      "A genuine bug (please file it with the crash report attached)",
      "Node ran out of heap on a very large operation (--max-old-space-size)",
      "An OS error without a Node error code (exotic filesystem, sandboxed environment)",
    ],
  },
};

/** Look up an explainer by code; tolerant of case, dashes, and a missing prefix. */
export function explainErrorCode(code: string): MemOSErrorExplainer | null {
  const normalized = normalizeErrorCode(code);
  if (!normalized) return null;
  const entry = EXPLANATIONS[normalized];
  return {
    code: normalized,
    ...entry,
    hint: HINTS[normalized],
    docsUrl: DOCS_URL,
  };
}

/** Every known error code with its explainer, in stable declaration order. */
export function listErrorExplainers(): MemOSErrorExplainer[] {
  return (Object.keys(EXPLANATIONS) as MemOSErrorCode[]).map(
    (code) =>
      ({
        code,
        ...EXPLANATIONS[code]!,
        hint: HINTS[code]!,
        docsUrl: DOCS_URL,
      }) as MemOSErrorExplainer,
  );
}

/** Normalize user-supplied code spellings to a MemOSErrorCode, or null. */
export function normalizeErrorCode(input: string): MemOSErrorCode | null {
  const upper = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const withPrefix = upper.startsWith("MEMOS_") ? upper : `MEMOS_${upper}`;
  return Object.prototype.hasOwnProperty.call(EXPLANATIONS, withPrefix)
    ? (withPrefix as MemOSErrorCode)
    : null;
}

/** Human-facing explainer card, printed by `memos explain-error`. */
export function formatErrorExplainer(explainer: MemOSErrorExplainer): string {
  const lines: string[] = [];
  lines.push(`${explainer.code} — ${explainer.summary}`);
  lines.push("");
  lines.push("What probably went wrong:");
  lines.push(`  ${explainer.explanation}`);
  if (explainer.likelyCauses.length > 0) {
    lines.push("");
    lines.push("Likely causes (most probable first):");
    for (const cause of explainer.likelyCauses) {
      lines.push(`  - ${cause}`);
    }
  }
  lines.push("");
  lines.push("What to do:");
  lines.push(`  ${explainer.hint}`);
  lines.push("");
  lines.push(`Docs: ${explainer.docsUrl}`);
  return lines.join("\n");
}

export class MemOSError extends Error {
  public readonly code: MemOSErrorCode;
  public readonly hint: string;
  /** What probably went wrong (the bug explainer), not what to do. */
  public readonly explanation: string;
  public readonly context: Record<string, unknown>;
  public readonly docsUrl?: string;

  constructor(message: string, options: MemOSErrorOptions = {}) {
    super(redactSecrets(message), { cause: options.cause });
    this.name = "MemOSError";
    this.code = options.code ?? "MEMOS_UNKNOWN";
    this.hint = options.hint ?? HINTS[this.code];
    this.explanation =
      options.explanation ??
      EXPLANATIONS[this.code]?.explanation ??
      "An unexpected error occurred; see the crash report for details.";
    this.context = options.context ?? {};
    this.docsUrl = options.docsUrl ?? DOCS_URL;
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
      explanation: error.explanation,
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
    text.includes("bridge process not running") ||
    text.includes("bridge is not running") ||
    text.includes("bridge process exited")
  ) {
    return "MEMOS_BRIDGE_UNAVAILABLE";
  }
  if (
    text.includes("no response from memos bridge") ||
    text.includes("bridge process crashed") ||
    text.includes("bridge died") ||
    text.includes("broken pipe")
  ) {
    return "MEMOS_BRIDGE_CRASHED";
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
  lines.push(`  what probably went wrong: ${error.explanation}`);
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
      explanation: error.explanation,
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
          explanation: error.explanation,
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
