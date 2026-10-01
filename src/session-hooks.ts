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
 * `OPENCODE_DATA_DIR` wins when set; otherwise the platform default.
 */
export function openCodeDataDirs(): string[] {
  const dirs: string[] = [];
  const envDir = process.env.OPENCODE_DATA_DIR;
  if (envDir) dirs.push(envDir);
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
 * OpenCode persists sessions under `<dataDir>/project/<id>/storage/`:
 * message headers in `storage/message/info/*.json` (each carries
 * `sessionID`, `role`, and `time.created`) and content parts in
 * `storage/part/info/*.json` (each carries `messageID`; `type: "text"`
 * parts carry the visible text).
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
  role: string;
  created: number;
  messageId: string;
  projectDir: string;
}

function readOpenCodeSession(
  dataDir: string,
  sessionId: string,
): ConversationMessage[] {
  const projectRoot = join(dataDir, "project");
  if (!existsSync(projectRoot)) return [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectRoot);
  } catch {
    return [];
  }
  const headers: OpenCodeMessageHeader[] = [];
  for (const proj of projectDirs) {
    const projectDir = join(projectRoot, proj);
    const messageDir = join(projectDir, "storage", "message", "info");
    if (!existsSync(messageDir)) continue;
    let files: string[];
    try {
      files = readdirSync(messageDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(readFileSync(join(messageDir, file), "utf-8"));
        if (
          raw.sessionID !== sessionId ||
          (raw.role !== "user" && raw.role !== "assistant")
        ) {
          continue;
        }
        headers.push({
          role: raw.role,
          created: typeof raw.time?.created === "number" ? raw.time.created : 0,
          messageId:
            typeof raw.id === "string" ? raw.id : file.replace(/\.json$/, ""),
          projectDir,
        });
      } catch {
        continue; // skip unreadable message headers
      }
    }
  }
  headers.sort((a, b) => a.created - b.created);
  const messages: ConversationMessage[] = [];
  for (const header of headers) {
    const text = readOpenCodeParts(header.projectDir, header.messageId);
    if (text) {
      messages.push({
        role: header.role as "user" | "assistant",
        content: text,
      });
    }
  }
  return messages;
}

/** Concatenate the text parts of an OpenCode message. */
function readOpenCodeParts(projectDir: string, messageId: string): string {
  const partDir = join(projectDir, "storage", "part", "info");
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
      const part = JSON.parse(readFileSync(join(partDir, file), "utf-8"));
      if (
        part.messageID === messageId &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim()
      ) {
        texts.push(part.text.trim());
      }
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
