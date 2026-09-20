/**
 * Deterministic temporal parsing for MemOS — no LLM on any path.
 *
 * Why hand-rolled instead of `chrono`:
 * - `npm install chrono` resolves to a *timezone-offset* library, not a
 *   date parser (the parser lives in `chrono-node`).
 * - `chrono-node` (v2.10.1, evaluated 2026-09-19) is zero-dependency and
 *   dual CJS/ESM with types, but ships ~7MB of locale data and its
 *   weekday/time-of-day defaults ("at 3pm" at 18:00 silently rolls to
 *   tomorrow, multi-expression sentences need ad-hoc disambiguation)
 *   would still need a deterministic wrapper for MemOS's exact phrase
 *   set. A minimal hand-rolled parser is smaller, has zero dependencies,
 *   and every rule below is explicit and testable. Revisit if the phrase
 *   set grows beyond the documented grammar.
 *
 * Grammar (all case-insensitive, evaluated against an explicit `now`):
 * - Relative: "in 2 hours", "in 3 days", "3 days later"
 * - Day words: "today", "tonight" (= today 21:00), "tomorrow"
 * - Weekdays: "Monday", "on Monday", "this Thursday", "next Friday",
 *   "last Friday"
 * - Month/day: "Sept 24", "September 24th" (year-less → yearCertain=false)
 * - ISO: "2026-09-24"
 * - Times: "at 3pm", "at 2:30pm", "at 15:00", "noon", "midnight"
 *   (a bare time attaches to today, rolling to tomorrow when past)
 * - Date+time adjacency merges: "tomorrow at 2pm", "at 3pm tomorrow"
 *
 * Deterministic rules (documented, no guessing):
 * 1. When several temporal expressions occur, the LAST one wins — this
 *    mirrors how speakers refine ("tomorrow, on Monday" → Monday).
 * 2. Adjacent date+date ("tomorrow on Monday") refines to the second date.
 * 3. Adjacent date+time merges into one datetime.
 * 4. Bare/"on" weekday = next occurrence strictly after today;
 *    "this <day>" = upcoming occurrence including today; "next <day>" =
 *    next occurrence strictly after today; "last <day>" = most recent
 *    past occurrence.
 * 5. Day-grain results resolve to local start-of-day 00:00 (an all-day
 *    event starts when the day starts), except "tonight" → 21:00.
 *
 * @module @memos/temporal
 */

/** Temporal resolution of a parsed expression. */
export type TemporalGrain = "day" | "hour" | "minute";

export interface ParsedTemporal {
  /** Resolved local datetime. */
  at: Date;
  /** Resolution: day (date only), hour, or minute. */
  grain: TemporalGrain;
  /** The exact source text that produced this parse. */
  text: string;
  /** False when the expression carried no year ("Sept 24", "June 1"). */
  yearCertain: boolean;
}

/** A bare relative offset ("3 days later") awaiting an anchor. */
export interface TemporalDuration {
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** The exact source text that produced this duration. */
  text: string;
}

const MS_PER = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

type DurationUnit = keyof typeof MS_PER | "month" | "year";

const UNIT_ALIASES: Record<string, DurationUnit> = {
  second: "second",
  seconds: "second",
  sec: "second",
  secs: "second",
  s: "second",
  minute: "minute",
  minutes: "minute",
  min: "minute",
  mins: "minute",
  m: "minute",
  hour: "hour",
  hours: "hour",
  hr: "hour",
  hrs: "hour",
  h: "hour",
  day: "day",
  days: "day",
  d: "day",
  week: "week",
  weeks: "week",
  w: "week",
  month: "month",
  months: "month",
  year: "year",
  years: "year",
  y: "year",
};

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednes: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  satur: 6,
  saturday: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const WEEKDAY_SRC = Object.keys(WEEKDAY_ALIASES)
  .sort((a, b) => b.length - a.length)
  .join("|");
const MONTH_SRC = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

/**
 * Master pattern. Alternation order is longest-first within each class so
 * "September" wins over "sep", and classes are ordered so relative forms
 * match before their weekday/day-word parts can fragment them.
 */
const MASTER = new RegExp(
  [
    // "in 2 hours" / "3 days later" (relative — also usable as duration)
    String.raw`(?<relative>in\s+(?<rval>\d+)\s+(?<runit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b)`,
    String.raw`(?<later>(?<lval>\d+)\s+(?<lunit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+later\b)`,
    // Day words
    String.raw`(?<dayword>\b(?<dword>today|tonight|tomorrow)\b)`,
    // Weekdays with optional on/this/next/last
    String.raw`(?<weekday>\b(?:(?<wprefix>on|this|next|last)\s+)?(?<wday>${WEEKDAY_SRC})s?\b)`,
    // Month day: "Sept 24", "September 24th"
    String.raw`(?<monthday>\b(?<mname>${MONTH_SRC})\.?\s+(?<mday>\d{1,2})(?:st|nd|rd|th)?\b)`,
    // ISO date
    String.raw`(?<iso>\b(?<iyear>\d{4})-(?<imonth>\d{2})-(?<iday>\d{2})\b)`,
    // Times: "at 3pm", "at 2:30pm", "at 15:00", "9am" (bare time with
    // meridiem), "noon", "midnight". A bare time needs am/pm so plain
    // numbers ("room 3") never parse as times.
    String.raw`(?<time>(?:\bat\s+(?<thour>\d{1,2})(?::(?<tmin>\d{2}))?\s*(?<tmer>am|pm)?\b)|\b(?<thour2>\d{1,2})(?::(?<tmin2>\d{2}))?\s*(?<tmer2>am|pm)\b|\b(?<tword>noon|midnight)\b)`,
  ].join("|"),
  "gi",
);

interface RawMatch {
  text: string;
  start: number;
  end: number;
  kind:
    "relative" | "later" | "dayword" | "weekday" | "monthday" | "iso" | "time";
  groups: Record<string, string | undefined>;
}

function collectMatches(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  MASTER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MASTER.exec(text)) !== null) {
    const groups = m.groups ?? {};
    const kind = (
      [
        "relative",
        "later",
        "dayword",
        "weekday",
        "monthday",
        "iso",
        "time",
      ] as const
    ).find((k) => groups[k] !== undefined);
    if (!kind) continue;
    // Guard against zero-length matches (would loop forever).
    if (m[0].length === 0) {
      MASTER.lastIndex++;
      continue;
    }
    out.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      kind,
      groups,
    });
  }
  return out;
}

/** Local start-of-day for the given date. */
function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

function addMonths(d: Date, n: number): Date {
  const c = new Date(d);
  c.setMonth(c.getMonth() + n);
  return c;
}

function addYears(d: Date, n: number): Date {
  const c = new Date(d);
  c.setFullYear(c.getFullYear() + n);
  return c;
}

function resolveRelative(
  value: number,
  unit: DurationUnit,
  now: Date,
): { at: Date; grain: TemporalGrain } {
  switch (unit) {
    case "second":
      return {
        at: new Date(now.getTime() + value * MS_PER.second),
        grain: "minute",
      };
    case "minute":
      return {
        at: new Date(now.getTime() + value * MS_PER.minute),
        grain: "minute",
      };
    case "hour":
      return {
        at: new Date(now.getTime() + value * MS_PER.hour),
        grain: "hour",
      };
    case "day":
      return { at: new Date(now.getTime() + value * MS_PER.day), grain: "day" };
    case "week":
      return {
        at: new Date(now.getTime() + value * MS_PER.week),
        grain: "day",
      };
    case "month":
      return { at: addMonths(now, value), grain: "day" };
    case "year":
      return { at: addYears(now, value), grain: "day" };
  }
}

function resolveWeekday(
  dayIndex: number,
  prefix: string | undefined,
  now: Date,
): Date {
  const base = startOfDay(now);
  const today = now.getDay();
  let delta: number;
  if (prefix === "last") {
    // Most recent past occurrence (strictly before today).
    delta = (today - dayIndex + 7) % 7;
    if (delta === 0) delta = 7;
    return new Date(base.getTime() - delta * MS_PER.day);
  }
  if (prefix === "this") {
    // Upcoming occurrence including today.
    delta = (dayIndex - today + 7) % 7;
    return new Date(base.getTime() + delta * MS_PER.day);
  }
  // Bare, "on", and "next": next occurrence strictly after today.
  delta = (dayIndex - today + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(base.getTime() + delta * MS_PER.day);
}

function resolveTime(
  hour: number,
  minute: number,
  now: Date,
): { at: Date; grain: TemporalGrain } {
  const at = startOfDay(now);
  at.setHours(hour, minute, 0, 0);
  // A bare time that already passed today means tomorrow (deterministic).
  if (at.getTime() <= now.getTime()) {
    at.setTime(at.getTime() + MS_PER.day);
  }
  return { at, grain: minute === 0 ? "hour" : "minute" };
}

interface FoldedDate {
  at: Date;
  grain: TemporalGrain;
  yearCertain: boolean;
  text: string;
}

function matchToDate(m: RawMatch, now: Date): FoldedDate | null {
  const g = m.groups;
  switch (m.kind) {
    case "relative": {
      const unit = UNIT_ALIASES[(g.runit ?? "").toLowerCase()];
      if (!unit) return null;
      const r = resolveRelative(parseInt(g.rval ?? "0", 10), unit, now);
      return { ...r, yearCertain: true, text: m.text };
    }
    case "later": {
      const unit = UNIT_ALIASES[(g.lunit ?? "").toLowerCase()];
      if (!unit) return null;
      const r = resolveRelative(parseInt(g.lval ?? "0", 10), unit, now);
      return { ...r, yearCertain: true, text: m.text };
    }
    case "dayword": {
      const word = (g.dword ?? "").toLowerCase();
      if (word === "tonight") {
        const at = startOfDay(now);
        at.setHours(21, 0, 0, 0);
        return { at, grain: "hour", yearCertain: true, text: m.text };
      }
      const at = startOfDay(now);
      if (word === "tomorrow") at.setTime(at.getTime() + MS_PER.day);
      return { at, grain: "day", yearCertain: true, text: m.text };
    }
    case "weekday": {
      const dayIndex = WEEKDAY_ALIASES[(g.wday ?? "").toLowerCase()];
      if (dayIndex === undefined) return null;
      const at = resolveWeekday(dayIndex, g.wprefix?.toLowerCase(), now);
      return { at, grain: "day", yearCertain: true, text: m.text };
    }
    case "monthday": {
      const month = MONTHS[(g.mname ?? "").toLowerCase().replace(/\.$/, "")];
      const day = parseInt(g.mday ?? "0", 10);
      if (month === undefined || !(day >= 1 && day <= 31)) return null;
      // Next occurrence on or after today (year-less → yearCertain=false).
      let at = new Date(now.getFullYear(), month, day, 0, 0, 0, 0);
      if (at.getTime() < startOfDay(now).getTime()) {
        at = new Date(now.getFullYear() + 1, month, day, 0, 0, 0, 0);
      }
      return { at, grain: "day", yearCertain: false, text: m.text };
    }
    case "iso": {
      const at = new Date(
        parseInt(g.iyear ?? "0", 10),
        parseInt(g.imonth ?? "1", 10) - 1,
        parseInt(g.iday ?? "1", 10),
        0,
        0,
        0,
        0,
      );
      return { at, grain: "day", yearCertain: true, text: m.text };
    }
    case "time": {
      if (g.tword) {
        const word = g.tword.toLowerCase();
        if (word === "noon") {
          const at = startOfDay(now);
          at.setHours(12, 0, 0, 0);
          if (at.getTime() <= now.getTime())
            at.setTime(at.getTime() + MS_PER.day);
          return { at, grain: "hour", yearCertain: true, text: m.text };
        }
        // "midnight" = the next 00:00 strictly after now.
        const at = startOfDay(now);
        at.setTime(at.getTime() + MS_PER.day);
        return { at, grain: "hour", yearCertain: true, text: m.text };
      }
      let hour = parseInt(g.thour ?? g.thour2 ?? "0", 10);
      const minute = parseInt(g.tmin ?? g.tmin2 ?? "0", 10);
      const mer = (g.tmer ?? g.tmer2 ?? "").toLowerCase();
      if (mer === "pm" && hour < 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;
      const r = resolveTime(hour, minute, now);
      return { ...r, yearCertain: true, text: m.text };
    }
  }
}

function isDateKind(kind: RawMatch["kind"]): boolean {
  return (
    kind === "relative" ||
    kind === "later" ||
    kind === "dayword" ||
    kind === "weekday" ||
    kind === "monthday" ||
    kind === "iso"
  );
}

/**
 * Parse the temporal expression(s) in free text.
 *
 * Deterministic given `now`: no system clock reads, no randomness, no LLM.
 * When several expressions occur, the LAST one wins (speaker-refinement
 * rule); adjacent date+time pairs merge ("tomorrow at 2pm"), and adjacent
 * date+date pairs refine to the second ("tomorrow on Monday" → Monday).
 *
 * @param text — Free text possibly containing a temporal expression.
 * @param now  — Reference time; ALL resolution is relative to this.
 * @returns The parsed expression, or null when none is found.
 */
export function parseTemporal(text: string, now: Date): ParsedTemporal | null {
  if (!text || typeof text !== "string") return null;
  const matches = collectMatches(text);
  if (matches.length === 0) return null;

  // Fold: merge adjacent pairs, then take the last date-bearing result.
  // "Adjacent" = separated by whitespace only.
  const folded: Array<{ date: FoldedDate | null; time: RawMatch | null }> = [];
  let i = 0;
  while (i < matches.length) {
    const m = matches[i]!;
    const n = matches[i + 1];
    const adjacent =
      n !== undefined && text.slice(m.end, n.start).trim() === "";
    if (adjacent && n !== undefined) {
      if (isDateKind(m.kind) && n.kind === "time") {
        // "tomorrow at 2pm" — apply the time to the date.
        const d = matchToDate(m, now);
        if (d) {
          const t = matchToDate(n, now);
          if (t) {
            const at = new Date(d.at);
            at.setHours(t.at.getHours(), t.at.getMinutes(), 0, 0);
            folded.push({
              date: {
                at,
                grain: t.grain,
                yearCertain: d.yearCertain,
                text: `${m.text} ${n.text}`,
              },
              time: null,
            });
            i += 2;
            continue;
          }
        }
      } else if (m.kind === "time" && isDateKind(n.kind)) {
        // "at 3pm tomorrow".
        const d = matchToDate(n, now);
        if (d) {
          const t = matchToDate(m, now);
          if (t) {
            const at = new Date(d.at);
            at.setHours(t.at.getHours(), t.at.getMinutes(), 0, 0);
            folded.push({
              date: {
                at,
                grain: t.grain,
                yearCertain: d.yearCertain,
                text: `${m.text} ${n.text}`,
              },
              time: null,
            });
            i += 2;
            continue;
          }
        }
      } else if (isDateKind(m.kind) && isDateKind(n.kind)) {
        // Date refinement: "tomorrow on Monday" → the second date wins.
        const d = matchToDate(n, now);
        folded.push({ date: d, time: null });
        i += 2;
        continue;
      }
    }
    if (isDateKind(m.kind)) {
      folded.push({ date: matchToDate(m, now), time: null });
    } else {
      folded.push({ date: null, time: m });
    }
    i += 1;
  }

  // Last date-bearing entry wins; a trailing lone time attaches to today.
  for (let j = folded.length - 1; j >= 0; j--) {
    const f = folded[j]!;
    if (f.date) {
      return {
        at: f.date.at,
        grain: f.date.grain,
        text: f.date.text,
        yearCertain: f.date.yearCertain,
      };
    }
  }
  // Only time matches (e.g. "at 3pm"): resolve against today.
  for (let j = folded.length - 1; j >= 0; j--) {
    const f = folded[j]!;
    if (f.time) {
      const t = matchToDate(f.time, now);
      if (t) {
        return {
          at: t.at,
          grain: t.grain,
          text: t.text,
          yearCertain: t.yearCertain,
        };
      }
    }
  }
  return null;
}

const DURATION_RE =
  /\b(?<in>in\s+)?(?<val>\d+)\s+(?<unit>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+(?<later>later|from\s+now|hence)\b|\bin\s+(?<val2>\d+)\s+(?<unit2>seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\b/i;

/**
 * Parse a bare relative offset ("3 days later", "in 2 hours") as a
 * DURATION — no anchor applied. Used for event updates ("moved 3 days
 * later"), where the anchor is the event's current datetime, NOT now.
 *
 * @param text — Free text possibly containing a relative offset.
 * @returns The duration, or null when no offset is found.
 */
export function parseDuration(text: string): TemporalDuration | null {
  if (!text || typeof text !== "string") return null;
  const m = DURATION_RE.exec(text);
  if (!m || !m.groups) return null;
  const val = parseInt(m.groups.val ?? m.groups.val2 ?? "0", 10);
  const unit =
    UNIT_ALIASES[(m.groups.unit ?? m.groups.unit2 ?? "").toLowerCase()];
  if (!unit || !(val > 0)) return null;
  const zero: TemporalDuration = {
    years: 0,
    months: 0,
    weeks: 0,
    days: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
    text: m[0].trim(),
  };
  switch (unit) {
    case "second":
      zero.seconds = val;
      break;
    case "minute":
      zero.minutes = val;
      break;
    case "hour":
      zero.hours = val;
      break;
    case "day":
      zero.days = val;
      break;
    case "week":
      zero.weeks = val;
      break;
    case "month":
      zero.months = val;
      break;
    case "year":
      zero.years = val;
      break;
  }
  return zero;
}

/**
 * Apply a duration to an anchor date (calendar-aware for months/years).
 * Deterministic: same anchor + same duration = same result.
 */
export function addDuration(anchor: Date, d: TemporalDuration): Date {
  let at = new Date(anchor);
  if (d.years) at = addYears(at, d.years);
  if (d.months) at = addMonths(at, d.months);
  const ms =
    d.weeks * MS_PER.week +
    d.days * MS_PER.day +
    d.hours * MS_PER.hour +
    d.minutes * MS_PER.minute +
    d.seconds * MS_PER.second;
  if (ms) at = new Date(at.getTime() + ms);
  return at;
}
