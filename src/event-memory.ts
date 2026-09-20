/**
 * Deterministic temporal event memory: extraction, update/cancel
 * resolution, and reminder listing. No LLM on any path — regex intent
 * detection plus the deterministic parser in `./temporal.js`, mirroring
 * the `src/revert.ts` pattern.
 *
 * Cross-harness continuity: every harness (any model, any process) shares
 * the same DB file and runs the same parsing/resolution rules, so an
 * event stored by model A is updatable by model B. The update path reads
 * the event's CURRENT row from the store (not from conversation state),
 * so there is no per-harness state to drift.
 *
 * @module @memos/event-memory
 */

import {
  parseTemporal,
  parseDuration,
  type ParsedTemporal,
  type TemporalDuration,
  type TemporalGrain,
} from "./temporal.js";
import type { MemoryNode, ScoredMemory, SearchFilter } from "./types.js";

/** Event status lifecycle. */
export type EventStatus = "scheduled" | "recurring" | "cancelled";

/**
 * Structured event payload stored in `metadata.event`.
 *
 * - `kind`: canonical event noun ("meeting", "appointment", "reminder").
 * - `label`: human noun phrase ("meeting", "dentist appointment").
 * - `at`: ISO-8601 datetime of the event.
 * - `grain`: temporal resolution of the parse.
 * - `status`: "scheduled" events feed reminders; "recurring" (year-less
 *   or every-X references) and "cancelled" never do.
 * - `reminder_at`: ISO-8601; when the reminder fires (defaults to `at`).
 */
export interface EventMetadata {
  kind: string;
  label: string;
  at: string;
  grain: TemporalGrain;
  status: EventStatus;
  reminder_at: string;
}

/** Result of `detectEvent`. */
export interface DetectedEvent extends EventMetadata {}

/** A natural-language event update or cancellation. */
export interface EventUpdate {
  intent: "update" | "cancel";
  /** Named event kind ("meeting"), absent for bare "it". */
  kind?: string;
  /** New absolute-ish time (parsed against `now`), for updates. */
  newTime?: { at: string; grain: TemporalGrain };
  /** Bare relative offset ("3 days later") — anchored to the EVENT's
   *  current datetime, not to now. */
  duration?: TemporalDuration;
  /** Name of the pattern that fired (debugging / docs). */
  pattern: string;
}

// Event nouns that make a memory an event when co-occurring with a
// temporal expression. Kept to concrete, schedulable nouns — notably NOT
// "birthday" (year-less by nature; see the recurring rule below).
const EVENT_NOUNS = [
  "meeting",
  "call",
  "appointment",
  "deadline",
  "flight",
  "interview",
  "dinner",
  "lunch",
  "breakfast",
  "brunch",
  "coffee",
  "standup",
  "review",
  "doctor",
  "dentist",
  "party",
  "class",
  "lesson",
  "exam",
  "presentation",
  "demo",
  "sync",
  "workshop",
  "conference",
  "webinar",
  "session",
  "trip",
  "wedding",
  "checkup",
  "reminder",
  "1:1",
] as const;

const EVENT_NOUN_SET = new Set<string>(EVENT_NOUNS);

// "dentist appointment" / "team meeting" style compounds: the modifier is
// kept in the label, the head noun is the kind.
const COMPOUND_RE = new RegExp(
  String.raw`\b(dentist|doctor|team|standup|project|client)\s+(appointment|meeting|call|review|sync|session)\b`,
  "i",
);
const NOUN_RE = new RegExp(
  String.raw`\b(${EVENT_NOUNS.map((n) =>
    n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})\b`,
  "i",
);

// Year-less / repeating references never become scheduled reminders.
const RECURRING_RE =
  /\b(every|each)\b|\b(daily|weekly|monthly|yearly|annually)\b/i;

/**
 * Detect a schedulable event in free text: an event noun co-occurring
 * with a temporal expression.
 *
 * Guard (deterministic): dates without a year ("my birthday is June 1")
 * or recurring references ("every Monday") yield `status: "recurring"` —
 * they are stored as structured events but NEVER produce reminders.
 *
 * @param content — The memory text.
 * @param now     — Reference time for temporal parsing.
 * @returns The detected event, or null when no event noun + temporal
 *   expression co-occur.
 */
export function detectEvent(content: string, now: Date): DetectedEvent | null {
  if (!content || typeof content !== "string") return null;
  const compound = COMPOUND_RE.exec(content);
  const nounMatch = compound ?? NOUN_RE.exec(content);
  if (!nounMatch) return null;
  const parsed: ParsedTemporal | null = parseTemporal(content, now);
  if (!parsed) return null;

  let kind: string;
  let label: string;
  if (compound) {
    kind = compound[2]!.toLowerCase();
    label = `${compound[1]!.toLowerCase()} ${kind}`;
  } else {
    kind = nounMatch[1]!.toLowerCase();
    label = kind;
  }

  const recurring = RECURRING_RE.test(content) || !parsed.yearCertain;
  const at = parsed.at.toISOString();
  return {
    kind,
    label,
    at,
    grain: parsed.grain,
    status: recurring ? "recurring" : "scheduled",
    reminder_at: at,
  };
}

// Update-intent verbs. Evaluation order: cancel patterns run BEFORE
// update patterns (a cancellation is terminal — "moved then cancelled"
// must cancel, never reschedule).
const CANCEL_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "cancelled", regex: /\b(cancelled|canceled|cancel)\b/i },
  { name: "called-off", regex: /\bcalled\s+off\b/i },
  // "never mind, forget about that meeting" — cancel-scoped "never mind".
  // (Bare "never mind that" without a cancel verb is NOT a cancel; the
  // revert module owns that phrasing.)
  { name: "never-mind-cancel", regex: /\bnever\s+mind\b.{0,40}\bcancel\b/i },
];

const UPDATE_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "rescheduled", regex: /\breschedul(?:ed|e|ing)\b/i },
  { name: "postponed", regex: /\bpostponed?\b/i },
  { name: "moved", regex: /\bmoved?\b/i },
  { name: "pushed", regex: /\bpushed?\s+(?:back|forward|up|to)?\b/i },
  { name: "changed-to", regex: /\bchanged?\s+to\b/i },
  // "actually the meeting is at 3pm now" — explicit new time.
  { name: "actually-at", regex: /\bactually\b.{0,60}\bat\s+\d/i },
];

// Target extraction: "that meeting", "the dentist appointment", "my call".
// "it" alone carries no kind (falls back to the single-open-event rule).
const KIND_TARGET_RE =
  /\b(?:that|the|this|my|our|your)\s+([a-z][a-z0-9]*(?:\s+[a-z][a-z0-9]*)?)\b/i;

/**
 * Detect an event update/cancellation command in free text.
 *
 * Returns null when: no update/cancel intent; intent present but no
 * resolvable new time (fail safe — the write proceeds as a normal
 * memory); or the text names no actionable target. An update intent
 * WITHOUT a new time or duration is not an update — e.g. "we moved the
 * meeting" (no when) must not touch the stored event.
 *
 * @param content — The memory text.
 * @param now     — Reference time for absolute-ish new times.
 */
export function detectEventUpdate(
  content: string,
  now: Date,
): EventUpdate | null {
  if (!content || typeof content !== "string") return null;

  const kind = extractEventKind(content);

  for (const pattern of CANCEL_PATTERNS) {
    if (pattern.regex.test(content)) {
      const update: EventUpdate = { intent: "cancel", pattern: pattern.name };
      if (kind) update.kind = kind;
      return update;
    }
  }

  for (const pattern of UPDATE_PATTERNS) {
    if (pattern.regex.test(content)) {
      // Bare relative offset anchors to the EVENT's datetime, not now.
      const duration = parseDuration(content);
      if (duration) {
        const update: EventUpdate = {
          intent: "update",
          duration,
          pattern: `${pattern.name}+duration`,
        };
        if (kind) update.kind = kind;
        return update;
      }
      // Otherwise parse absolute-ish against now ("moved to Friday").
      const parsed = parseTemporal(content, now);
      if (!parsed) return null; // intent but no time → fail safe
      const update: EventUpdate = {
        intent: "update",
        newTime: { at: parsed.at.toISOString(), grain: parsed.grain },
        pattern: pattern.name,
      };
      if (kind) update.kind = kind;
      return update;
    }
  }
  return null;
}

/**
 * Extract the named event kind from an update/cancel utterance.
 * "that meeting" → "meeting"; "the dentist appointment" → "appointment";
 * bare "it" → undefined.
 */
export function extractEventKind(content: string): string | undefined {
  const m = KIND_TARGET_RE.exec(content);
  if (!m?.[1]) return undefined;
  const phrase = m[1].toLowerCase().trim();
  const words = phrase.split(/\s+/);
  const head = words[words.length - 1]!;
  if (EVENT_NOUN_SET.has(head)) return head;
  // Modifier-first phrasing ("that dentist") — accept the modifier when
  // it is itself an event noun.
  if (words.length > 1 && EVENT_NOUN_SET.has(words[0]!)) return words[0];
  return undefined;
}

/**
 * Split a `memos remind "<text>" at <temporal-expression>` command.
 * The temporal expression is the text after the LAST " at " whose suffix
 * parses as a temporal expression (deterministic).
 *
 * @returns `{ text, temporal }`, or null when no trailing temporal
 *   expression is found.
 */
export function splitRemindText(input: string): {
  text: string;
  temporal: string;
} | null {
  if (!input || typeof input !== "string") return null;
  // Walk " at " occurrences right-to-left; the first (rightmost) suffix
  // that parses wins.
  const lower = input.toLowerCase();
  let idx = lower.lastIndexOf(" at ");
  while (idx !== -1) {
    const text = input.slice(0, idx).trim();
    const temporal = input.slice(idx + 4).trim();
    if (text.length > 0 && temporal.length > 0) {
      // Suffix must parse against an arbitrary fixed reference — the
      // parse here only validates shape, not the resolved datetime.
      if (parseTemporal(temporal, new Date(2026, 0, 1, 12, 0, 0))) {
        return { text, temporal };
      }
    }
    idx = lower.lastIndexOf(" at ", idx - 1);
  }
  return null;
}

/** True when the node is a currently-open scheduled event. */
export function isScheduledEventNode(node: MemoryNode): boolean {
  const event = (node.metadata as Record<string, unknown> | undefined)
    ?.event as EventMetadata | undefined;
  return (
    node.validTo === null &&
    node.quarantined === false &&
    typeof event === "object" &&
    event !== null &&
    event.status === "scheduled" &&
    typeof event.reminder_at === "string"
  );
}

/** Minimal read surface `listReminders` needs (MemOS satisfies it). */
export interface ReminderSource {
  search(filter: SearchFilter): Promise<ScoredMemory[]>;
}

export interface ListRemindersOptions {
  /** Reference time ("now"); Date or Unix ms. */
  now: Date | number;
  /** When true, only reminders with reminder_at <= now. */
  dueOnly?: boolean;
  /** Namespace to scan (default: all namespaces). */
  namespace?: string;
  /** Scan cap (default 10_000 — same local-scan approach as other
   *  maintenance passes in the codebase; v1 simplicity over an index). */
  limit?: number;
}

export interface ReminderEntry {
  id: string;
  kind: string;
  label: string;
  at: string;
  grain: TemporalGrain;
  reminderAt: string;
  content: string;
  createdAt: number;
  /** True when reminderAt <= now at listing time. */
  due: boolean;
}

/**
 * List scheduled event reminders.
 *
 * Scans currently-valid (valid_to null), non-quarantined nodes carrying
 * `metadata.event.status === "scheduled"`. Deterministic ordering:
 * reminder_at ascending, then createdAt ascending, then id ascending.
 *
 * v1 note: this is a full local scan (like the decay/consolidation
 * passes), not an index lookup — fine for a local-first store, revisit
 * with a metadata index if reminder volume grows.
 *
 * Honest scope: MemOS SURFACES due reminders; it does not push-notify.
 * Delivery/notification is the harness's job — poll `memos_reminders`
 * (or `memos reminders --due`) on the harness's own schedule.
 */
export async function listReminders(
  source: ReminderSource,
  opts: ListRemindersOptions,
): Promise<ReminderEntry[]> {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : opts.now;
  const filter: SearchFilter = { limit: opts.limit ?? 10_000 };
  if (opts.namespace !== undefined) filter.namespace = opts.namespace;
  const rows = await source.search(filter);
  const entries: ReminderEntry[] = [];
  for (const { node } of rows) {
    if (!isScheduledEventNode(node)) continue;
    const event = node.metadata.event as EventMetadata;
    const reminderMs = new Date(event.reminder_at).getTime();
    if (Number.isNaN(reminderMs)) continue;
    const due = reminderMs <= nowMs;
    if (opts.dueOnly && !due) continue;
    entries.push({
      id: node.id,
      kind: event.kind,
      label: event.label,
      at: event.at,
      grain: event.grain,
      reminderAt: event.reminder_at,
      content: node.content,
      createdAt: node.createdAt,
      due,
    });
  }
  // Deterministic order: reminder time, then creation time, then id.
  entries.sort(
    (a, b) =>
      new Date(a.reminderAt).getTime() - new Date(b.reminderAt).getTime() ||
      a.createdAt - b.createdAt ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return entries;
}
