/**
 * Parser for third-party AI memory exports — ChatGPT data exports and
 * Claude data exports — feeding `MemOS.importExternal`.
 *
 * The design goal is tolerance: vendor export shapes change without
 * notice, so the parser sniffs each item rather than trusting a fixed
 * schema, extracts whatever text fields exist, and reports what it
 * skipped. Recognized shapes:
 *
 * - ChatGPT data export (`conversations.json`): an array of
 *   `{ title, mapping: { <id>: { message: { author: { role }, content:
 *   { parts: string[] } } } } }` trees — user turns are extracted.
 * - Claude data export (`conversations.json`): an array of
 *   `{ name, chat_messages: [{ sender: "human", text, created_at }] }` —
 *   human turns are extracted. A directory export is scanned for every
 *   `*.json` / `*.jsonl` file and each candidate is sniffed.
 * - Slack export (directory): `channels.json` + `users.json` plus one
 *   folder per channel with per-day message files
 *   (`{ user, text, ts }`) — all messages are extracted with author and
 *   channel attribution.
 * - Flat memory lists: an array of strings or of objects with
 *   `content` / `text` / `title` / `memory` string fields (covers
 *   `memories.json`-style exports from both vendors).
 * - Wrapper objects: `{ conversations: [...] }` or `{ memories: [...] }`.
 *
 * Dedupe is by SHA-256 of the normalized content (whitespace-collapsed,
 * lowercased), so the same message appearing in several files — or twice
 * in one export — is imported once.
 *
 * @module @mem-os/external-import
 */

import { createHash } from "node:crypto";

export type ExternalImportSource =
  "auto" | "chatgpt" | "claude" | "slack" | "generic";
export type DetectedExportSource = "chatgpt" | "claude" | "slack" | "generic";

export interface ExternalMemoryItem {
  content: string;
  /** Creation timestamp in Unix ms, when the export carried one. */
  createdAt?: number;
  /** Human-readable author name, when the export carried one. */
  author?: string;
  /** Channel / conversation label, when the export carried one. */
  channel?: string;
  /** Conversation title, when the export carried one. */
  conversation?: string;
}

export interface ParsedExternalExport {
  items: ExternalMemoryItem[];
  detected: DetectedExportSource;
  /** Items recognized structurally but yielding no usable text. */
  skipped: number;
}

const MIN_CONTENT_LENGTH = 3;
const DEFAULT_MAX_ITEMS = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (
      typeof value === "string" &&
      value.trim().length >= MIN_CONTENT_LENGTH
    ) {
      return value.trim();
    }
  }
  return undefined;
}

/** Extract user-turn texts from a ChatGPT conversation `mapping` tree. */
function parseChatGptMapping(
  mapping: unknown,
  conversation?: string,
): ExternalMemoryItem[] {
  const items: ExternalMemoryItem[] = [];
  if (!mapping || typeof mapping !== "object") return items;
  for (const node of Object.values(mapping as Record<string, unknown>)) {
    const record = asRecord(node);
    const message = record ? asRecord(record.message) : null;
    if (!message) continue;
    const author = asRecord(message.author);
    const role = author ? String(author.role ?? "") : "";
    if (role !== "user") continue;
    const content = asRecord(message.content);
    const parts = content?.parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .filter(
        (p): p is string =>
          typeof p === "string" && p.trim().length >= MIN_CONTENT_LENGTH,
      )
      .join("\n")
      .trim();
    if (!text) continue;
    const createTime =
      typeof message.create_time === "number"
        ? message.create_time * 1000
        : undefined;
    items.push({
      content: text,
      ...(createTime ? { createdAt: createTime } : {}),
      ...(conversation ? { conversation } : {}),
    });
  }
  return items;
}

/** Extract human-turn texts from a Claude conversation export entry. */
function parseClaudeChatMessages(
  messages: unknown,
  conversation?: string,
): ExternalMemoryItem[] {
  const items: ExternalMemoryItem[] = [];
  if (!Array.isArray(messages)) return items;
  for (const message of messages) {
    const record = asRecord(message);
    if (!record) continue;
    const sender = String(record.sender ?? "");
    if (sender !== "human") continue;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text.length < MIN_CONTENT_LENGTH) continue;
    let createdAt: number | undefined;
    if (typeof record.created_at === "string") {
      const parsed = Date.parse(record.created_at);
      createdAt = Number.isNaN(parsed) ? undefined : parsed;
    }
    items.push({
      content: text,
      ...(createdAt ? { createdAt } : {}),
      ...(conversation ? { conversation } : {}),
    });
  }
  return items;
}

/** Flat memory entry: string or an object with a text-ish field. */
function parseGenericEntry(entry: unknown): ExternalMemoryItem | null {
  if (typeof entry === "string") {
    const text = entry.trim();
    return text.length >= MIN_CONTENT_LENGTH ? { content: text } : null;
  }
  const record = asRecord(entry);
  if (!record) return null;
  const text = firstString(record, [
    "content",
    "text",
    "title",
    "memory",
    "value",
  ]);
  if (!text) return null;
  let createdAt: number | undefined;
  for (const key of ["created_at", "createdAt", "create_time"]) {
    const value = record[key];
    if (typeof value === "number" && value > 0) {
      // Heuristic: seconds vs milliseconds epochs.
      createdAt = value < 10_000_000_000 ? value * 1000 : value;
      break;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        createdAt = parsed;
        break;
      }
    }
  }
  return { content: text, ...(createdAt ? { createdAt } : {}) };
}

/**
 * Parse a parsed-JSON export payload into memory items.
 *
 * @param raw — The decoded JSON value (or a JSON string).
 * @param source — `"auto"` sniffs the shape; explicit values force a
 *   parser (useful when auto-detection misreads a custom format).
 */
export function parseExternalMemoryExport(
  raw: unknown,
  source: ExternalImportSource = "auto",
  maxItems = DEFAULT_MAX_ITEMS,
): ParsedExternalExport {
  let payload: unknown = raw;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { items: [], detected: "generic", skipped: 0 };
    }
  }

  let root = payload;
  let detected: DetectedExportSource = source === "auto" ? "generic" : source;

  // Unwrap container objects.
  if (!Array.isArray(root) && asRecord(root)) {
    const record = root as Record<string, unknown>;
    if (Array.isArray(record.conversations)) {
      root = record.conversations;
    } else if (Array.isArray(record.memories)) {
      root = record.memories;
    }
  }

  const items: ExternalMemoryItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();

  const push = (item: ExternalMemoryItem | null): void => {
    if (!item) {
      skipped += 1;
      return;
    }
    // Content-hash dedupe: the same message appearing twice in an export
    // (or across files in a directory scan) is imported once.
    const key = contentHash(item.content);
    if (seen.has(key)) {
      skipped += 1;
      return;
    }
    if (items.length >= maxItems) {
      skipped += 1;
      return;
    }
    seen.add(key);
    items.push(item);
  };

  if (Array.isArray(root)) {
    for (const entry of root) {
      const record = asRecord(entry);
      const isChatGpt =
        source === "chatgpt" ||
        (source === "auto" &&
          record &&
          "mapping" in record &&
          asRecord(record.mapping));
      const isClaude =
        source === "claude" ||
        (source === "auto" && record && "chat_messages" in record);

      if (isChatGpt && record) {
        detected = "chatgpt";
        const conversation =
          typeof record.title === "string" ? record.title : undefined;
        const turns = parseChatGptMapping(record.mapping, conversation);
        if (turns.length === 0) skipped += 1;
        for (const turn of turns) push(turn);
        continue;
      }
      if (isClaude && record) {
        detected = "claude";
        const conversation =
          typeof record.name === "string" ? record.name : undefined;
        const turns = parseClaudeChatMessages(
          record.chat_messages,
          conversation,
        );
        if (turns.length === 0) skipped += 1;
        for (const turn of turns) push(turn);
        continue;
      }
      push(parseGenericEntry(entry));
    }
  } else {
    skipped += 1;
  }

  return { items, detected, skipped };
}

/**
 * SHA-256 of the normalized content (whitespace-collapsed, lowercased).
 * The dedupe key for imports.
 */
export function contentHash(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
// ---------------------------------------------------------------------------
// Export-directory scanning
// ---------------------------------------------------------------------------

const MAX_SCAN_FILES = 500;
const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Scan an export directory for a vendor source and parse everything
 * found, with content-hash dedupe across files.
 *
 * - `slack`: reads the official Slack export layout (`channels.json`,
 *   `users.json`, per-channel per-day message files).
 * - `chatgpt` / `claude`: walks the directory for `*.json` files
 *   (each sniffed as a conversation export) and `*.jsonl` files
 *   (each line sniffed as a message).
 */
export async function parseExportDirectory(
  dir: string,
  source: "chatgpt" | "claude" | "slack",
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<ParsedExternalExport> {
  if (source === "slack") return parseSlackExportDirectory(dir, maxItems);
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { join, extname } = await import("node:path");

  const files: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= MAX_SCAN_FILES) return;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full, depth + 1);
      } else if (
        st.isFile() &&
        st.size <= MAX_SCAN_FILE_BYTES &&
        (extname(entry) === ".json" || extname(entry) === ".jsonl") &&
        files.length < MAX_SCAN_FILES
      ) {
        files.push(full);
      }
    }
  };
  try {
    const rootStat = await stat(dir);
    if (!rootStat.isDirectory()) {
      return { items: [], detected: source, skipped: 1 };
    }
  } catch {
    return { items: [], detected: source, skipped: 1 };
  }
  await walk(dir, 0);

  const items: ExternalMemoryItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const push = (item: ExternalMemoryItem | null): void => {
    if (!item) {
      skipped += 1;
      return;
    }
    const key = contentHash(item.content);
    if (seen.has(key)) {
      skipped += 1;
      return;
    }
    if (items.length >= maxItems) {
      skipped += 1;
      return;
    }
    seen.add(key);
    items.push(item);
  };

  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    if (extname(file) === ".jsonl") {
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        push(parseJsonlLine(line, source));
      }
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      skipped += 1;
      continue;
    }
    const parsed = parseExternalMemoryExport(payload, source, maxItems);
    for (const item of parsed.items) push(item);
    skipped += parsed.skipped;
  }
  return { items, detected: source, skipped };
}

/**
 * Sniff one JSONL line as a message. Tolerates Claude Code session
 * history (`{ type: "human", message: { content } }`), simple
 * `{ role, content }` / `{ sender, text }` shapes, and falls back to
 * the generic entry parser.
 */
function parseJsonlLine(
  line: string,
  source: "chatgpt" | "claude",
): ExternalMemoryItem | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (!record) return parseGenericEntry(value);

  // Claude Code session history: { type: "human"|"assistant", message: {...} }
  const type = typeof record.type === "string" ? record.type : "";
  const message = asRecord(record.message);
  if (message && (type === "human" || type === "user")) {
    const text = messageText(message.content);
    if (text) return { content: text, conversation: source };
  }

  // { role: "user", content } shape
  const role = typeof record.role === "string" ? record.role : "";
  if (role === "user" || role === "human") {
    const text = messageText(record.content);
    if (text) return { content: text, conversation: source };
  }

  // { sender: "human", text } shape (Claude export per-message)
  if (String(record.sender ?? "") === "human") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (text.length >= MIN_CONTENT_LENGTH) {
      return { content: text, conversation: source };
    }
  }
  return parseGenericEntry(value);
}

/** Pull plain text out of a string or Anthropic-style content blocks. */
function messageText(content: unknown): string | null {
  if (typeof content === "string") {
    const text = content.trim();
    return text.length >= MIN_CONTENT_LENGTH ? text : null;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const record = asRecord(block);
        const t = record?.text;
        return typeof t === "string" ? t : "";
      })
      .join("\n")
      .trim();
    return text.length >= MIN_CONTENT_LENGTH ? text : null;
  }
  return null;
}

/**
 * Parse an official Slack export directory:
 * `channels.json` + `users.json` at the root, one folder per channel
 * with per-day message files (`[{ user, text, ts }]`).
 */
export async function parseSlackExportDirectory(
  dir: string,
  maxItems = DEFAULT_MAX_ITEMS,
): Promise<ParsedExternalExport> {
  const { readFile, readdir, stat } = await import("node:fs/promises");
  const { join, extname } = await import("node:path");

  const readJson = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      return null;
    }
  };

  try {
    const st = await stat(dir);
    if (!st.isDirectory()) {
      return { items: [], detected: "slack", skipped: 1 };
    }
  } catch {
    return { items: [], detected: "slack", skipped: 1 };
  }

  // Channel id → name and user id → display name lookups.
  const channelNames = new Map<string, string>();
  const channels = await readJson(join(dir, "channels.json"));
  if (Array.isArray(channels)) {
    for (const c of channels) {
      const record = asRecord(c);
      if (record && typeof record.id === "string") {
        const name = typeof record.name === "string" ? record.name : record.id;
        channelNames.set(record.id, name);
      }
    }
  }
  const userNames = new Map<string, string>();
  const users = await readJson(join(dir, "users.json"));
  if (Array.isArray(users)) {
    for (const u of users) {
      const record = asRecord(u);
      if (record && typeof record.id === "string") {
        const profile = asRecord(record.profile);
        const name =
          (typeof profile?.display_name === "string" && profile.display_name) ||
          (typeof profile?.real_name === "string" && profile.real_name) ||
          (typeof record.real_name === "string" && record.real_name) ||
          (typeof record.name === "string" && record.name) ||
          record.id;
        userNames.set(record.id, name);
      }
    }
  }

  // Collect per-day message files; the channel label is the parent
  // folder name, resolved through channels.json when it is an id.
  const dayFiles: Array<{ path: string; channel: string }> = [];
  let rootEntries: string[];
  try {
    rootEntries = await readdir(dir);
  } catch {
    return { items: [], detected: "slack", skipped: 1 };
  }
  for (const entry of rootEntries) {
    const full = join(dir, entry);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const channel = channelNames.get(entry) ?? entry;
    let dayEntries: string[];
    try {
      dayEntries = await readdir(full);
    } catch {
      continue;
    }
    for (const day of dayEntries) {
      if (extname(day) === ".json") {
        dayFiles.push({ path: join(full, day), channel });
      }
    }
  }
  dayFiles.sort((a, b) => a.path.localeCompare(b.path));

  const items: ExternalMemoryItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const { path, channel } of dayFiles) {
    const payload = await readJson(path);
    if (!Array.isArray(payload)) {
      skipped += 1;
      continue;
    }
    for (const entry of payload) {
      const record = asRecord(entry);
      if (!record) {
        skipped += 1;
        continue;
      }
      const rawText = typeof record.text === "string" ? record.text : "";
      const text = unescapeSlackText(rawText).trim();
      if (text.length < MIN_CONTENT_LENGTH) {
        skipped += 1;
        continue;
      }
      const key = contentHash(text);
      if (seen.has(key)) {
        skipped += 1;
        continue;
      }
      if (items.length >= maxItems) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      const userId = typeof record.user === "string" ? record.user : "";
      const author = userId ? (userNames.get(userId) ?? userId) : undefined;
      const ts = typeof record.ts === "string" ? record.ts : "";
      const createdAt = slackTsToMs(ts);
      items.push({
        content: text,
        ...(createdAt ? { createdAt } : {}),
        ...(author ? { author } : {}),
        channel,
      });
    }
  }
  // Chronological order — Slack day files are already sorted by path,
  // but multi-channel scans interleave them.
  items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { items, detected: "slack", skipped };
}

/**
 * Slack message text carries HTML entities (`&amp;` etc.).
 * `&amp;` MUST be decoded last: decoding it first turns an escaped
 * `&amp;lt;` (i.e. literal "&lt;" text) into `&lt;`, which the next pass
 * would decode a second time into `<` — a double-unescape.
 */
function unescapeSlackText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Slack `ts` is `"1718452800.000200"` (seconds.fraction) → Unix ms. */
function slackTsToMs(ts: string): number | undefined {
  if (!ts) return undefined;
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.floor(seconds * 1000);
}

// ---------------------------------------------------------------------------
// Post-import synthesis (rule-based, no LLM)
// ---------------------------------------------------------------------------

/** Structured insight extracted from imported text. */
export type SynthesizedKind = "decision" | "preference" | "milestone";

export interface SynthesizedInsight {
  kind: SynthesizedKind;
  /** The source sentence, trimmed (max 400 chars). */
  text: string;
}

const SYNTHESIS_RULES: ReadonlyArray<{
  kind: SynthesizedKind;
  patterns: RegExp[];
}> = [
  {
    kind: "decision",
    patterns: [
      /\bdecided to\b/i,
      /\bdecide to\b/i,
      /\bwe chose\b/i,
      /\bchose to\b/i,
      /\bgoing with\b/i,
      /\bsettled on\b/i,
      /\bagreed to\b/i,
      /\bagreed on\b/i,
      /\bopted for\b/i,
      /\bdecision:/i,
    ],
  },
  {
    kind: "preference",
    patterns: [
      /\bi prefer\b/i,
      /\bmy favorite\b/i,
      /\bmy favourite\b/i,
      /\bi like\b/i,
      /\bi love\b/i,
      /\bi dislike\b/i,
      /\bi hate\b/i,
      /\bcan't stand\b/i,
      /\bcannot stand\b/i,
      /\bprefer .* over\b/i,
      /\balways use\b/i,
    ],
  },
  {
    kind: "milestone",
    patterns: [
      /\bshipped\b/i,
      /\blaunched\b/i,
      /\breleased\b/i,
      /\bcompleted\b/i,
      /\bfinished\b/i,
      /\bdeployed\b/i,
      /\bpublished\b/i,
      /\bmerged\b/i,
      /\bwent live\b/i,
    ],
  },
];

const MIN_SYNTHESIS_SENTENCE = 12;
const MAX_SYNTHESIS_TEXT = 400;

/**
 * Rule-based post-import pass: pull structured decisions, preferences,
 * and milestones out of imported messages. Each match is the source
 * *sentence* (not the whole message), classified by the first matching
 * rule (decision > preference > milestone). No LLM — pure regex over
 * sentence-split text.
 */
export function synthesizeImportInsights(
  items: ReadonlyArray<{ content: string }>,
): SynthesizedInsight[] {
  const insights: SynthesizedInsight[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const sentence of splitSentences(item.content)) {
      const text = sentence.trim();
      if (text.length < MIN_SYNTHESIS_SENTENCE) continue;
      const kind = classifySynthesisSentence(text);
      if (!kind) continue;
      const key = contentHash(text.slice(0, MAX_SYNTHESIS_TEXT));
      if (seen.has(key)) continue;
      seen.add(key);
      insights.push({ kind, text: text.slice(0, MAX_SYNTHESIS_TEXT) });
    }
  }
  return insights;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function classifySynthesisSentence(sentence: string): SynthesizedKind | null {
  for (const rule of SYNTHESIS_RULES) {
    if (rule.patterns.some((re) => re.test(sentence))) return rule.kind;
  }
  return null;
}
