/**
 * Session hooks — automatic fact extraction at session end.
 *
 * Claude Code and OpenCode can run a hook when a session ends. This module
 * provides:
 *
 * - `parseClaudeTranscript()` / `parseClaudeTranscriptText()`: convert a
 *   Claude Code JSONL transcript into `ConversationMessage[]` for
 *   `MemOS.extractFacts()`.
 * - `parsePlainTranscript()`: convert `User:`/`Assistant:` plain-text
 *   transcripts.
 * - `parseTranscriptFile()`: try Claude JSONL first, fall back to
 *   plain text when it yields nothing (used by both `extract-facts`
 *   and `session-hook`).
 * - `findOpenCodeSessionMessages()`: load an ended OpenCode session's
 *   messages from OpenCode's data dir (backs `--opencode-session`).
 * - `session-hook` (in the CLI): the hook entrypoint — reads hook JSON
 *   from stdin (Claude Code SessionEnd format) or `--opencode-session`,
 *   extracts the transcript, and stores durable facts via
 *   `extractFacts({ autoStore: true })`.
 * - `claudeCodeHookConfig()` / `openCodePluginSource()`: setup artifacts.
 *
 * The hook feeds the existing extraction/storage path — it never drops or
 * rewrites memories, it only calls `extractFacts` with `autoStore: true`.
 *
 * @module @memos/session-hooks
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { ConversationMessage } from "./types.js";

/** Hook input JSON (Claude Code SessionEnd format). */
export interface SessionHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
}

/** Result of running the session hook. */
export interface SessionHookResult {
  /** Whether the hook ran successfully. */
  ok: boolean;
  /** Number of facts extracted. */
  facts: number;
  /** Number of facts stored. */
  stored: number;
  /** Number of duplicates skipped. */
  duplicates: number;
  /** Human-readable message. */
  message: string;
}

/**
 * Parse a Claude Code JSONL transcript into conversation messages.
 *
 * Each line is a JSON object with `type` ("user" | "assistant") and a
 * `message` object containing `role` and `content` (string or array of
 * content blocks). Only text content is extracted; tool calls/results
 * are skipped.
 */
export function parseClaudeTranscript(
  transcriptPath: string,
): ConversationMessage[] {
  if (!existsSync(transcriptPath)) {
    throw new Error(`transcript not found: ${transcriptPath}`);
  }
  return parseClaudeTranscriptText(readFileSync(transcriptPath, "utf-8"));
}

/**
 * Parse Claude Code JSONL transcript text into conversation messages.
 * Malformed lines are skipped. Returns an empty array when no line
 * yields a message — callers that want a plain-text fallback should use
 * `parseTranscriptFile()` instead of treating this as an error.
 */
export function parseClaudeTranscriptText(text: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed lines
    }
    // Claude Code transcript format: { type: "user"|"assistant", message: { role, content } }
    const msg = entry.message;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    const text = extractTextContent(msg.content);
    if (!text) continue;
    messages.push({ role, content: text });
  }
  return messages;
}

/**
 * Parse a transcript file of unknown format.
 *
 * Tries Claude Code JSONL first; when that yields no messages but the
 * file is non-empty, falls back to plain-text parsing (`User:` /
 * `Assistant:` prefixes). This is the entrypoint both `extract-facts`
 * and `session-hook` use — previously the fallback was dead code
 * because the JSONL parser returned `[]` instead of throwing.
 */
export function parseTranscriptFile(
  transcriptPath: string,
): ConversationMessage[] {
  if (!existsSync(transcriptPath)) {
    throw new Error(`transcript not found: ${transcriptPath}`);
  }
  const raw = readFileSync(transcriptPath, "utf-8");
  if (!raw.trim()) return [];
  const claude = parseClaudeTranscriptText(raw);
  if (claude.length > 0) return claude;
  return parsePlainTranscript(raw);
}

/** Extract plain text from Claude Code content (string or block array). */
function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

/**
 * Parse a plain-text or markdown transcript into conversation messages.
 * Lines starting with "User:" / "Human:" become user messages;
 * "Assistant:" / "Claude:" become assistant messages.
 */
export function parsePlainTranscript(text: string): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const lines = text.split("\n");
  let currentRole: "user" | "assistant" | null = null;
  let currentText: string[] = [];

  const flush = () => {
    const content = currentText.join("\n").trim();
    if (currentRole && content) {
      messages.push({ role: currentRole, content });
    }
    currentText = [];
  };

  for (const line of lines) {
    const userMatch = /^(user|human)\s*:/i.exec(line);
    const assistantMatch = /^(assistant|claude|ai)\s*:/i.exec(line);
    if (userMatch) {
      flush();
      currentRole = "user";
      currentText.push(line.slice(userMatch[0].length).trim());
    } else if (assistantMatch) {
      flush();
      currentRole = "assistant";
      currentText.push(line.slice(assistantMatch[0].length).trim());
    } else if (currentRole) {
      currentText.push(line);
    }
  }
  flush();
  return messages;
}

/**
 * Candidate OpenCode data directories, in priority order.
 *
 * OpenCode resolves its data dir as `$XDG_DATA_HOME/opencode`, falling
 * back to the platform default (`~/.local/share/opencode` on Linux,
 * `~/Library/Application Support/opencode` on macOS). There is no
 * `OPENCODE_DATA_DIR` env var in OpenCode itself — honor the real
 * `XDG_DATA_HOME` override here instead.
 */
export function openCodeDataDirs(): string[] {
  const dirs: string[] = [];
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) dirs.push(join(xdg, "opencode"));
  const home = process.env.HOME ?? "";
  if (process.platform === "darwin") {
    dirs.push(join(home, "Library", "Application Support", "opencode"));
  } else if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    dirs.push(join(process.env.LOCALAPPDATA, "opencode"));
  } else {
    dirs.push(join(home, ".local", "share", "opencode"));
  }
  return dirs;
}

/**
 * Load the user/assistant messages of an OpenCode session.
 *
 * Current OpenCode persists sessions in SQLite at
 * `<dataDir>/opencode.db` (tables `session`, `message`, `part`; message
 * rows carry `session_id` plus a JSON `data` column with `role` and
 * `time.created`, part rows carry `message_id` plus a JSON `data`
 * column where `type: "text"` parts hold the visible text in
 * `data.text`). Older installs used JSON files at
 * `<dataDir>/storage/message/<sessionId>/<messageId>.json` and
 * `<dataDir>/storage/part/<messageId>/<partId>.json` — tried as a
 * fallback when the database is absent or unreadable.
 *
 * Returns an empty array when the session cannot be found — the caller
 * (session-hook) treats that as fail-open, not an error.
 *
 * @param sessionId The OpenCode session ID (from the `session.deleted` event).
 * @param dataDir   Override the data directory (e.g. in tests). When
 *                  omitted, `openCodeDataDirs()` is searched in order.
 */
export function findOpenCodeSessionMessages(
  sessionId: string,
  dataDir?: string,
): ConversationMessage[] {
  const dirs = dataDir ? [dataDir] : openCodeDataDirs();
  for (const dir of dirs) {
    const messages = readOpenCodeSession(dir, sessionId);
    if (messages.length > 0) return messages;
  }
  return [];
}

interface OpenCodeMessageHeader {
  role: "user" | "assistant";
  created: number;
  messageId: string;
}

/**
 * Read one OpenCode data dir: SQLite first, legacy JSON fallback.
 * Never throws — any unreadable layout yields [].
 */
function readOpenCodeSession(
  dataDir: string,
  sessionId: string,
): ConversationMessage[] {
  const fromDb = readOpenCodeSessionSqlite(dataDir, sessionId);
  if (fromDb.length > 0) return fromDb;
  return readOpenCodeSessionLegacyJson(dataDir, sessionId);
}

/** Parse a JSON blob that may be the row itself or nested under `data`. */
function openCodeJsonField<T>(parsed: unknown, field: string): T | undefined {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (field in obj) return obj[field] as T;
    const data = obj.data;
    if (data && typeof data === "object" && field in (data as object)) {
      return (data as Record<string, unknown>)[field] as T;
    }
  }
  return undefined;
}

/**
 * Read an OpenCode session from `<dataDir>/opencode.db` (SQLite).
 *
 * Opened read-only with `fileMustExist` so we never create an empty
 * database at OpenCode's path, and never disturb a running OpenCode
 * instance's WAL.
 */
function readOpenCodeSessionSqlite(
  dataDir: string,
  sessionId: string,
): ConversationMessage[] {
  const candidates = [join(dataDir, "opencode.db")];
  try {
    for (const file of readdirSync(dataDir)) {
      // Channel-specific databases: opencode-<channel>.db
      if (/^opencode-.+\.db$/.test(file)) candidates.push(join(dataDir, file));
    }
  } catch {
    return []; // data dir unreadable — fall through to legacy JSON
  }
  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const tables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
      if (!tables.has("message") || !tables.has("part")) continue;
      const headers: OpenCodeMessageHeader[] = [];
      const rows = db
        .prepare("SELECT id, data FROM message WHERE session_id = ?")
        .all(sessionId) as Array<{ id: string; data: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data);
          const role = openCodeJsonField<string>(parsed, "role");
          if (role !== "user" && role !== "assistant") continue;
          const time = openCodeJsonField<{ created?: unknown }>(parsed, "time");
          const created =
            time && typeof time.created === "number" ? time.created : 0;
          headers.push({ role, created, messageId: row.id });
        } catch {
          continue; // skip unreadable message rows
        }
      }
      headers.sort(
        (a, b) => a.created - b.created || (a.messageId < b.messageId ? -1 : 1),
      );
      const partStmt = db.prepare("SELECT data FROM part WHERE message_id = ?");
      const messages: ConversationMessage[] = [];
      for (const header of headers) {
        const texts: string[] = [];
        try {
          const parts = partStmt.all(header.messageId) as Array<{
            data: string;
          }>;
          for (const part of parts) {
            try {
              const parsed = JSON.parse(part.data);
              if (
                openCodeJsonField<string>(parsed, "type") === "text" &&
                typeof openCodeJsonField<string>(parsed, "text") === "string"
              ) {
                const text = (
                  openCodeJsonField<string>(parsed, "text") as string
                ).trim();
                if (text) texts.push(text);
              }
            } catch {
              continue; // skip unreadable part rows
            }
          }
        } catch {
          continue; // skip messages whose parts can't be read
        }
        const text = texts.join("\n").trim();
        if (text) messages.push({ role: header.role, content: text });
      }
      if (messages.length > 0) return messages;
    } catch {
      continue; // locked/corrupt db — try the next candidate
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close errors on a read-only handle
      }
    }
  }
  return [];
}

/**
 * Read an OpenCode session from the legacy JSON layout:
 * `<dataDir>/storage/message/<sessionId>/<messageId>.json` and
 * `<dataDir>/storage/part/<messageId>/<partId>.json`.
 */
function readOpenCodeSessionLegacyJson(
  dataDir: string,
  sessionId: string,
): ConversationMessage[] {
  const messageDir = join(dataDir, "storage", "message", sessionId);
  if (!existsSync(messageDir)) return [];
  let files: string[];
  try {
    files = readdirSync(messageDir);
  } catch {
    return [];
  }
  const headers: OpenCodeMessageHeader[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(messageDir, file), "utf-8"));
      const role = openCodeJsonField<string>(parsed, "role");
      if (role !== "user" && role !== "assistant") continue;
      const time = openCodeJsonField<{ created?: unknown }>(parsed, "time");
      const created =
        time && typeof time.created === "number" ? time.created : 0;
      const messageId =
        openCodeJsonField<string>(parsed, "id") ?? file.replace(/\.json$/, "");
      headers.push({ role, created, messageId });
    } catch {
      continue; // skip unreadable message files
    }
  }
  headers.sort(
    (a, b) => a.created - b.created || (a.messageId < b.messageId ? -1 : 1),
  );
  const messages: ConversationMessage[] = [];
  for (const header of headers) {
    const text = readOpenCodePartsLegacy(dataDir, header.messageId);
    if (text) messages.push({ role: header.role, content: text });
  }
  return messages;
}

/** Concatenate the text parts of an OpenCode message (legacy JSON layout). */
function readOpenCodePartsLegacy(dataDir: string, messageId: string): string {
  const partDir = join(dataDir, "storage", "part", messageId);
  if (!existsSync(partDir)) return "";
  let files: string[];
  try {
    files = readdirSync(partDir);
  } catch {
    return "";
  }
  const texts: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(partDir, file), "utf-8"));
      if (openCodeJsonField<string>(parsed, "type") !== "text") continue;
      const text = openCodeJsonField<string>(parsed, "text");
      if (typeof text === "string" && text.trim()) texts.push(text.trim());
    } catch {
      continue; // skip unreadable parts
    }
  }
  return texts.join("\n").trim();
}

/**
 * Generate the Claude Code SessionEnd hook configuration.
 * Add to `.claude/settings.json` (project) or `~/.claude/settings.json` (user).
 */
export function claudeCodeHookConfig(memosBin = "memos"): object {
  return {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: `${memosBin} session-hook`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Generate an OpenCode plugin that runs fact extraction on session end.
 * Save as `.opencode/plugins/memos-session-hook.ts` (or .js).
 */
export function openCodePluginSource(memosBin = "memos"): string {
  return `/**
 * MemOS session hook for OpenCode.
 * Extracts durable facts when a session ends.
 *
 * Install: save as .opencode/plugins/memos-session-hook.ts
 * and add "./plugins" (or the file) to the "plugin" array in opencode.json.
 */
export const MemosSessionHook = async ({ $ }) => {
  return {
    "session.deleted": async (event) => {
      try {
        // event.sessionID identifies the ended session; the transcript
        // is available via the OpenCode session API or export.
        await $\`${memosBin} session-hook --opencode-session \${event.sessionID}\`;
      } catch {
        // Never break session teardown — hooks must be fail-open.
      }
    },
  };
};
`;
}

/**
 * Format hook setup instructions for a target harness.
 */
export function sessionHookInstructions(
  target: string,
  memosBin = "memos",
): string {
  const config = JSON.stringify(claudeCodeHookConfig(memosBin), null, 2);
  switch (target) {
    case "claude-code":
    case "claude":
    case "claudecode":
      return [
        "MemOS session hook — Claude Code:",
        "",
        "Add to .claude/settings.json (project) or ~/.claude/settings.json (user):",
        "",
        config,
        "",
        "When a session ends, the hook runs `memos session-hook`, which reads",
        "the session transcript and stores durable facts via extractFacts().",
        "Set MEMOS_SKIP_SESSION_HOOK=1 to opt out for a single session.",
      ].join("\n");
    case "opencode":
      return [
        "MemOS session hook — OpenCode:",
        "",
        "1. Save this plugin as .opencode/plugins/memos-session-hook.ts:",
        "",
        openCodePluginSource(memosBin),
        "2. Add the plugin to opencode.json:",
        '   { "plugin": ["./plugins/memos-session-hook.ts"] }',
        "",
        "On session end, the plugin runs fact extraction via the memos CLI.",
      ].join("\n");
    default:
      return `Unknown target: ${target}. Supported: claude-code, opencode.`;
  }
}
