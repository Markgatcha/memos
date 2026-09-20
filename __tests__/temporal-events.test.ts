/**
 * Tests for deterministic temporal event memory + reminders.
 *
 * Covers Mark's exact cross-harness scenario: an event stored by one
 * MemOS instance (harness/model A) is updated 4h later by a FRESH
 * instance on the same DB file (harness/model B) — no shared process
 * state, only the same deterministic parsing/resolution rules.
 *
 * Time is injected (`store(..., { now })`); the hermetic suite uses no
 * embeddings and no LLM anywhere.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemOS } from "../src/memory";
import { parseTemporal, parseDuration, addDuration } from "../src/temporal";
import {
  detectEvent,
  detectEventUpdate,
  extractEventKind,
  splitRemindText,
  isScheduledEventNode,
  listReminders,
  type EventMetadata,
} from "../src/event-memory";

// Saturday 2026-09-19 18:00 local — Mark's scenario reference time.
const T0 = new Date(2026, 8, 19, 18, 0, 0);
const T1 = new Date(T0.getTime() + 4 * 3_600_000); // +4h, different harness
const iso = (d: Date) => d.toISOString();

function newMemos(dbPath: string): MemOS {
  return new MemOS({ dbPath, embeddings: { enabled: false } });
}

function tempDb(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "memos-temporal-"));
  return { dir, dbPath: join(dir, "events.db") };
}

function eventOf(node: { metadata: Record<string, unknown> }): EventMetadata {
  return node.metadata.event as EventMetadata;
}

// ---------------------------------------------------------------------------
// Temporal parser unit tests (all with injected `now`)
// ---------------------------------------------------------------------------

describe("parseTemporal", () => {
  test("tomorrow", () => {
    const p = parseTemporal("tomorrow", T0)!;
    expect(iso(p.at)).toBe(iso(new Date(2026, 8, 20, 0, 0, 0)));
    expect(p.grain).toBe("day");
    expect(p.yearCertain).toBe(true);
  });

  test("next Friday", () => {
    const p = parseTemporal("meeting next Friday", T0)!;
    expect(iso(p.at)).toBe(iso(new Date(2026, 8, 25, 0, 0, 0)));
    expect(p.text).toBe("next Friday");
  });

  test("in 2 hours", () => {
    const p = parseTemporal("remind me in 2 hours", T0)!;
    expect(iso(p.at)).toBe(iso(new Date(2026, 8, 19, 20, 0, 0)));
    expect(p.grain).toBe("hour");
  });

  test("explicit dates", () => {
    const a = parseTemporal("deadline Sept 24", T0)!;
    expect(iso(a.at)).toBe(iso(new Date(2026, 8, 24, 0, 0, 0)));
    expect(a.yearCertain).toBe(false); // year-less → not certain
    const b = parseTemporal("deadline 2026-09-24", T0)!;
    expect(iso(b.at)).toBe(iso(new Date(2026, 8, 24, 0, 0, 0)));
    expect(b.yearCertain).toBe(true);
  });

  test("tonight / this Thursday / on Monday", () => {
    expect(iso(parseTemporal("tonight", T0)!.at)).toBe(
      iso(new Date(2026, 8, 19, 21, 0, 0)),
    );
    expect(iso(parseTemporal("this Thursday", T0)!.at)).toBe(
      iso(new Date(2026, 8, 24, 0, 0, 0)),
    );
    expect(iso(parseTemporal("on Monday", T0)!.at)).toBe(
      iso(new Date(2026, 8, 21, 0, 0, 0)),
    );
  });

  test("tomorrow at 2pm merges date+time", () => {
    const p = parseTemporal("call tomorrow at 2pm", T0)!;
    expect(iso(p.at)).toBe(iso(new Date(2026, 8, 20, 14, 0, 0)));
    expect(p.grain).toBe("hour");
  });

  test("bare past time rolls to tomorrow", () => {
    // 3pm already passed at 18:00 → tomorrow 15:00.
    const p = parseTemporal("meeting at 3pm", T0)!;
    expect(iso(p.at)).toBe(iso(new Date(2026, 8, 20, 15, 0, 0)));
  });

  test("last temporal expression wins (speaker refinement)", () => {
    const p = parseTemporal("I have a meeting tomorrow on Monday", T0)!;
    expect(iso(p.at)).toBe(iso(new Date(2026, 8, 21, 0, 0, 0)));
  });

  test("no temporal expression → null", () => {
    expect(parseTemporal("just a plain memory", T0)).toBeNull();
    expect(parseTemporal("", T0)).toBeNull();
  });
});

describe("parseDuration / addDuration", () => {
  test("'3 days later' parses as a duration", () => {
    const d = parseDuration("never mind that meeting got moved 3 days later")!;
    expect(d.days).toBe(3);
    expect(d.text).toBe("3 days later");
  });

  test("duration anchors to the event datetime, not now", () => {
    const d = parseDuration("moved 3 days later")!;
    // Monday 2026-09-21 + 3 days = Thursday 2026-09-24.
    expect(iso(addDuration(new Date(2026, 8, 21, 0, 0, 0), d))).toBe(
      iso(new Date(2026, 8, 24, 0, 0, 0)),
    );
  });

  test("no offset → null", () => {
    expect(parseDuration("moved to Friday")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

describe("detectEvent", () => {
  test("event noun + temporal → scheduled event", () => {
    const e = detectEvent("I have a meeting tomorrow on Monday", T0)!;
    expect(e.kind).toBe("meeting");
    expect(e.label).toBe("meeting");
    expect(e.at).toBe(iso(new Date(2026, 8, 21, 0, 0, 0)));
    expect(e.status).toBe("scheduled");
    expect(e.reminder_at).toBe(e.at);
  });

  test("no event noun → null", () => {
    expect(detectEvent("my birthday is June 1", T0)).toBeNull();
    expect(detectEvent("tomorrow will be nice", T0)).toBeNull();
  });

  test("no temporal → null", () => {
    expect(detectEvent("I have a meeting", T0)).toBeNull();
  });

  test("year-less / recurring → status recurring, never a reminder", () => {
    const e = detectEvent("birthday party on June 1", T0)!;
    expect(e.status).toBe("recurring");
    const weekly = detectEvent("standup every Monday", T0)!;
    expect(weekly.status).toBe("recurring");
  });

  test("compound noun keeps modifier in label", () => {
    const e = detectEvent("dentist appointment on Friday", T0)!;
    expect(e.kind).toBe("appointment");
    expect(e.label).toBe("dentist appointment");
  });
});

describe("detectEventUpdate", () => {
  test("moved + duration", () => {
    const u = detectEventUpdate(
      "never mind that meeting got moved 3 days later",
      T1,
    )!;
    expect(u.intent).toBe("update");
    expect(u.kind).toBe("meeting");
    expect(u.duration?.days).toBe(3);
  });

  test("moved to <weekday> → absolute vs now", () => {
    const u = detectEventUpdate("that call got moved to Friday", T1)!;
    expect(u.intent).toBe("update");
    expect(u.kind).toBe("call");
    expect(u.newTime?.at).toBe(iso(new Date(2026, 8, 25, 0, 0, 0)));
  });

  test("cancel intent", () => {
    const u = detectEventUpdate("the dentist appointment is cancelled", T1)!;
    expect(u.intent).toBe("cancel");
    expect(u.kind).toBe("appointment");
  });

  test("update verb but no new time → null (fail safe)", () => {
    expect(detectEventUpdate("we moved the meeting", T1)).toBeNull();
    expect(detectEventUpdate("I have a meeting tomorrow", T1)).toBeNull();
  });

  test("bare 'it' carries no kind", () => {
    expect(extractEventKind("never mind, it got moved")).toBeUndefined();
    expect(extractEventKind("that meeting got moved")).toBe("meeting");
  });
});

describe("splitRemindText", () => {
  test("splits trailing temporal", () => {
    expect(splitRemindText("call mom at tomorrow 9am")).toEqual({
      text: "call mom",
      temporal: "tomorrow 9am",
    });
  });

  test("no temporal → null", () => {
    expect(splitRemindText("just some text")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mark's exact cross-harness scenario
// ---------------------------------------------------------------------------

describe("cross-harness event continuity", () => {
  test("store Saturday → update 4h later from a fresh instance → reminder fires Thursday", async () => {
    const { dir, dbPath } = tempDb();
    try {
      // Harness/model A, Saturday 2026-09-19 18:00.
      const memosA = newMemos(dbPath);
      await memosA.init();
      const stored = await memosA.store("I have a meeting tomorrow on Monday", {
        now: T0.getTime(),
      });
      const created = eventOf(stored.node);
      expect(created.status).toBe("scheduled");
      expect(created.kind).toBe("meeting");
      expect(created.at).toBe(iso(new Date(2026, 8, 21, 0, 0, 0)));
      const oldId = stored.node.id;
      await memosA.close();

      // Harness/model B: a FRESH instance on the SAME db file, 4h later.
      const memosB = newMemos(dbPath);
      await memosB.init();
      const updated = await memosB.store(
        "never mind that meeting got moved 3 days later",
        { now: T1.getTime() },
      );
      const moved = eventOf(updated.node);
      expect(moved.status).toBe("scheduled");
      expect(moved.kind).toBe("meeting");
      // Monday 9/21 + 3 days = Thursday 9/24.
      expect(moved.at).toBe(iso(new Date(2026, 8, 24, 0, 0, 0)));

      // Old version's validity interval is closed (add-only history kept).
      const oldNode = await memosB.retrieve(oldId);
      expect(oldNode).not.toBeNull();
      expect(oldNode!.validTo).not.toBeNull();

      // temporal_precedes edge links old → new.
      const timeline = await memosB.history(oldId);
      const precedes = timeline.edges.filter(
        (e) => e.relation === "temporal_precedes" && e.sourceId === oldId,
      );
      expect(precedes.length).toBeGreaterThanOrEqual(1);
      expect(precedes[0]!.targetId).toBe(updated.node.id);

      // The reminder fires on Thursday.
      const due = await listReminders(memosB, {
        now: new Date(2026, 8, 24, 12, 0, 0),
        dueOnly: true,
      });
      expect(due).toHaveLength(1);
      expect(due[0]!.label).toBe("meeting");
      expect(due[0]!.id).toBe(updated.node.id);
      expect(due[0]!.due).toBe(true);

      // And it is NOT due on Wednesday.
      const wed = await listReminders(memosB, {
        now: new Date(2026, 8, 23, 12, 0, 0),
        dueOnly: true,
      });
      expect(wed).toHaveLength(0);

      await memosB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cancellation closes the event and removes the reminder", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      const stored = await memos.store("dentist appointment on Friday", {
        now: T0.getTime(),
      });
      expect(eventOf(stored.node).status).toBe("scheduled");

      const cancelled = await memos.store(
        "the dentist appointment is cancelled",
        { now: T1.getTime() },
      );
      const cancelEvent = eventOf(cancelled.node);
      expect(cancelEvent.status).toBe("cancelled");
      expect(cancelEvent.label).toBe("dentist appointment");
      expect(cancelEvent.at).toBe(eventOf(stored.node).at);

      const oldNode = await memos.retrieve(stored.node.id);
      expect(oldNode!.validTo).not.toBeNull();

      const reminders = await listReminders(memos, { now: T1 });
      expect(reminders).toHaveLength(0);
      await memos.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("'moved to Friday' resolves absolute vs now", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      const stored = await memos.store("I have a call on Monday", {
        now: T0.getTime(),
      });
      expect(eventOf(stored.node).at).toBe(iso(new Date(2026, 8, 21, 0, 0, 0)));

      const updated = await memos.store("that call got moved to Friday", {
        now: T1.getTime(),
      });
      expect(eventOf(updated.node).at).toBe(
        iso(new Date(2026, 8, 25, 0, 0, 0)),
      );
      await memos.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ambiguous 'it got moved' with several open events → fail safe (no guess)", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      const a = await memos.store("team meeting on Monday", {
        now: T0.getTime(),
      });
      const b = await memos.store("dentist appointment on Tuesday", {
        now: T0.getTime(),
      });
      // No kind named + two open events → stored as a normal memory.
      const c = await memos.store("it got moved to Friday", {
        now: T1.getTime(),
      });
      expect(c.node.metadata.event).toBeUndefined();
      expect((await memos.retrieve(a.node.id))!.validTo).toBeNull();
      expect((await memos.retrieve(b.node.id))!.validTo).toBeNull();
      await memos.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("birthday (year-less, no event noun) → no scheduled event, no reminder", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      const stored = await memos.store("my birthday is June 1", {
        now: T0.getTime(),
      });
      expect(stored.node.metadata.event).toBeUndefined();

      // Recurring events are structured but never reminders.
      const party = await memos.store("birthday party on June 1", {
        now: T0.getTime(),
      });
      expect(eventOf(party.node).status).toBe("recurring");
      expect(isScheduledEventNode(party.node)).toBe(false);

      const reminders = await listReminders(memos, {
        now: new Date(2027, 5, 2, 12, 0, 0),
      });
      expect(reminders).toHaveLength(0);
      await memos.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("listReminders orders by reminder time, quarantined excluded", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      await memos.store("flight on Friday", { now: T0.getTime() });
      await memos.store("dentist appointment tomorrow", { now: T0.getTime() });
      const all = await listReminders(memos, { now: T0 });
      expect(all).toHaveLength(2);
      // Tomorrow (Sun) before Friday.
      expect(all[0]!.label).toBe("dentist appointment");
      expect(all[1]!.label).toBe("flight");
      await memos.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit metadata.event wins over detection (memos remind path)", async () => {
    const { dir, dbPath } = tempDb();
    try {
      const memos = newMemos(dbPath);
      await memos.init();
      const at = iso(new Date(2026, 8, 20, 9, 0, 0));
      const stored = await memos.store("call mom", {
        now: T0.getTime(),
        metadata: {
          event: {
            kind: "reminder",
            label: "call mom",
            at,
            grain: "hour",
            status: "scheduled",
            reminder_at: at,
          },
        },
      });
      const e = eventOf(stored.node);
      expect(e.kind).toBe("reminder");
      expect(e.at).toBe(at);
      const due = await listReminders(memos, {
        now: new Date(2026, 8, 20, 12, 0, 0),
        dueOnly: true,
      });
      expect(due).toHaveLength(1);
      expect(due[0]!.label).toBe("call mom");
      await memos.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
