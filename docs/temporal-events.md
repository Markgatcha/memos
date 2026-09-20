# Temporal Event Memory & Reminders

MemOS extracts **scheduled events** from plain utterances, lets any
harness reschedule or cancel them in natural language, and surfaces
**due reminders** — all **deterministically, with no LLM on any path**.

## The idea in one scenario

Saturday 18:00, harness/model A:

> "I have a meeting tomorrow on Monday, save that"

MemOS stores the memory with structured `metadata.event`:

```json
{
  "kind": "meeting",
  "label": "meeting",
  "at": "2026-09-21T00:00:00.000Z",
  "grain": "day",
  "status": "scheduled",
  "reminder_at": "2026-09-21T00:00:00.000Z"
}
```

Four hours later, a **different** harness/model B on the **same DB file**:

> "never mind that meeting got moved 3 days later"

MemOS resolves "that meeting" to the open event, computes
Monday 9/21 + 3 days = **Thursday 9/24**, writes the replacement, and
closes the old version's validity interval (`valid_to`, add-only —
history is kept, with a `temporal_precedes` edge linking old → new).

Thursday, any harness polls and the reminder fires.

## How it works

### 1. Deterministic temporal parsing (`src/temporal.ts`)

Hand-rolled, zero-dependency, fully deterministic given an explicit
reference time — every function takes `now: Date` (injectable in
tests). Supported: `tomorrow`, `today`, `tonight`, `on Monday`,
`next Friday`, `this Thursday`, `3 days later`, `in 2 hours`,
`at 3pm`, `tomorrow at 2pm`, `Sept 24`, `2026-09-24`, `noon`,
`midnight`.

Rules (also in code comments):

- **Last expression wins** — "tomorrow, on Monday" → Monday (mirrors
  how speakers refine).
- Adjacent date+time merges ("tomorrow at 2pm"); adjacent date+date
  refines to the second.
- Bare/`on`/​`next` weekday = next occurrence strictly after today;
  `this <day>` includes today; `last <day>` = most recent past.
- Day-grain resolves to local start-of-day 00:00 (`tonight` → 21:00);
  a bare past time ("at 3pm" at 18:00) rolls to tomorrow.
- Bare offsets ("3 days later") also parse as a **duration** awaiting
  an anchor.

Why not `chrono`: `npm install chrono` resolves to a _timezone-offset_
library, not a date parser (the parser is `chrono-node`). `chrono-node`
v2.10.1 was evaluated — zero deps, dual CJS/ESM, typed — but ships
~7 MB of locale data and its weekday/time defaults still need a
deterministic wrapper for MemOS's fixed phrase set. The hand-rolled
parser is smaller, dependency-free, and every rule is explicit.

### 2. Event extraction on `store()` (`src/event-memory.ts`)

`detectEvent(content, now)` fires when an **event noun** (meeting,
call, appointment, deadline, flight, interview, dinner, lunch,
standup, review, doctor, dentist, party, …) co-occurs with a temporal
expression. `store()` attaches the result as `metadata.event` — unless
`opts.metadata.event` is already set (explicit wins, e.g.
`memos remind`). Plain memories are untouched (additive).

**Recurring guard:** year-less dates ("my birthday is June 1") and
repeating references ("every Monday") are stored with
`status: "recurring"` — structured, but they **never** produce
reminders.

### 3. Update / cancel resolution (in `store()`, before the write)

`detectEventUpdate(content, now)` detects:

- **Update:** "moved", "rescheduled", "pushed (back|to)", "postponed",
  "changed to", "never mind … moved", "actually … at \<time\>"
- **Cancel:** "cancelled", "canceled", "called off",
  "never mind … cancel"

Resolution (deterministic tiebreaks, documented in code):

- Named kind ("that meeting") → newest open event whose
  `metadata.event.kind` matches, or whose label contains the kind
  (createdAt desc, id asc).
- Unnamed ("it got moved") → only when **exactly one** open event
  exists; zero or ambiguous → **fail safe**, stored as a normal memory
  (never guess).
- Within the write's namespace; only currently-valid (`valid_to`
  null), non-quarantined, `status: "scheduled"` events.

Semantics:

- "moved **3 days later**" → duration anchored to the **event's**
  datetime (not now).
- "moved **to Friday**" → parsed absolute-ish against now.
- Update = write replacement node + `supersede(oldId, newId)`.
- Cancel = write node with `status: "cancelled"` (same label/at) +
  `supersede(oldId, newId)`.
- An update verb with **no resolvable new time** ("we moved the
  meeting") is not an update — normal write.

### 4. Reminders

`listReminders(source, { now, dueOnly, namespace })` scans
currently-valid, non-quarantined `status: "scheduled"` events.
`dueOnly` → `reminder_at <= now`; otherwise all scheduled, earliest
first (deterministic order: reminder_at, createdAt, id).

- CLI: `memos reminders` (upcoming), `memos reminders --due`,
  `memos remind "<text>" at <temporal-expression>`
- MCP: `memos_reminders` with `{ due?: boolean, namespace?: string }`
- SDK: `listReminders(memos, { now, dueOnly })` (exported from
  `@memos/sdk`)

## Harness polling pattern (read this)

MemOS **surfaces** due reminders; it does **not** push-notify.
Delivery is the harness's job: poll `memos_reminders` (or
`memos reminders --due`) on the harness's own schedule — e.g. once per
turn, or on a timer — and surface due items to the user itself.

## Cross-harness semantics

Continuity comes from two facts, not from shared conversation state:

1. **Same DB file** — the update path reads the event's _current row_
   from the store at write time.
2. **Same deterministic rules** — parsing, intent detection, and
   resolution are pure functions of (text, now, DB rows). No LLM, no
   per-harness state.

So model A's memory is updatable by model B: any harness/process with
the DB file and the same MemOS version converges on the same result.
For tests, `store(content, { now })` injects the reference time.

## Limitations

- **No push notifications.** Polling only; the harness owns delivery.
- **Single temporal expression per utterance wins** (last one) — "lunch
  Monday, dinner Tuesday" keeps Tuesday only.
- **Day-grain = start of day.** "Meeting tomorrow" reminds at 00:00;
  use an explicit time ("tomorrow at 9am") for a daytime reminder.
- **No recurrence expansion.** "every Monday" is `status: "recurring"`
  and never reminds; expanding recurrences is future work.
- **Ambiguity fails safe.** Unnamed updates with several open events,
  or updates with no parseable new time, are stored as plain memories
  instead of guessing.
- **v1 scan.** `listReminders` is a local scan (like the
  decay/consolidation passes), not an index lookup.
- **Timezone-naive.** Parsing uses the process local timezone; all
  harnesses sharing a DB should agree on TZ (UTC recommended).
- Fixed English phrase set; extending the grammar means extending
  `src/temporal.ts` + tests.
