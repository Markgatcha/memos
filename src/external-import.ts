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
 *   human turns are extracted.
 * - Flat memory lists: an array of strings or of objects with
 *   `content` / `text` / `title` / `memory` string fields (covers
 *   `memories.json`-style exports from both vendors).
 * - Wrapper objects: `{ conversations: [...] }` or `{ memories: [...] }`.
 *
 * @module @mem-os/external-import
 */

export type ExternalImportSource = "auto" | "chatgpt" | "claude" | "generic";
export type DetectedExportSource = "chatgpt" | "claude" | "generic";

export interface ExternalMemoryItem {
  content: string;
  /** Creation timestamp in Unix ms, when the export carried one. */
  createdAt?: number;
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
function parseChatGptMapping(mapping: unknown): ExternalMemoryItem[] {
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
    });
  }
  return items;
}

/** Extract human-turn texts from a Claude conversation export entry. */
function parseClaudeChatMessages(messages: unknown): ExternalMemoryItem[] {
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
    items.push({ content: text, ...(createdAt ? { createdAt } : {}) });
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
    const key = item.content.toLowerCase();
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
        const turns = parseChatGptMapping(record.mapping);
        if (turns.length === 0) skipped += 1;
        for (const turn of turns) push(turn);
        continue;
      }
      if (isClaude && record) {
        detected = "claude";
        const turns = parseClaudeChatMessages(record.chat_messages);
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
