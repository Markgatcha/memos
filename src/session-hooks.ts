/**
 * Session hooks — automatic fact extraction at session end.
 *
 * Claude Code and OpenCode can run a hook when a session ends. This module
 * provides:
 *
 * - `parseClaudeTranscript()`: convert a Claude Code JSONL transcript into
 *   `ConversationMessage[]` for `MemOS.extractFacts()`.
 * - `runSessionHook()`: the hook entrypoint — reads hook JSON from stdin
 *   (Claude Code SessionEnd format), extracts the transcript path, and
 *   stores durable facts via `extractFacts({ autoStore: true })`.
 * - `claudeCodeHookConfig()` / `openCodePluginSource()`: setup artifacts.
 *
 * The hook feeds the existing extraction/storage path — it never drops or
 * rewrites memories, it only calls `extractFacts` with `autoStore: true`.
 *
 * @module @memos/session-hooks
 */

import { readFileSync, existsSync } from "node:fs";
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
  const messages: ConversationMessage[] = [];
  const lines = readFileSync(transcriptPath, "utf-8").split("\n");
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
