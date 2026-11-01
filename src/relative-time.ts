/**
 * Relative-offset detection for retrieval anchoring.
 *
 * `parseTemporal` resolves absolute expressions ("last Tuesday", "June 1");
 * `parseDuration` resolves bare offsets ("3 days later"). Neither covers the
 * shape a *question* uses most: a quantity plus a trailing "ago" ("10 days
 * ago", "two weeks ago", "a month ago"). That shape is exactly what
 * temporal-reasoning questions carry, and without it the only signal left is
 * lexical similarity, which fails when the evidence says "I just got a
 * smoker today" and the question asks "10 days ago".
 */

export interface RelativeAgoOffset {
  /** The matched source text, e.g. "10 days ago". */
  text: string;
  /** Point in time the expression refers to, resolved from `now`. */
  at: Date;
  /** Tolerance in days either side of `at` (widened for coarse units). */
  windowDays: number;
}

const UNITS: Record<string, { days: number; window: number }> = {
  day: { days: 1, window: 1 },
  week: { days: 7, window: 3 },
  month: { days: 30, window: 7 },
  year: { days: 365, window: 30 },
};

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  a_few: 3,
  few: 3,
  couple: 2,
};

const AGO_RE =
  /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|couple(?: of)?)\s+(day|week|month|year)s?\s+ago\b/i;
const PAST_PREFIX_RE =
  /\b(?:in|over|during)\s+the\s+(?:past|last)\s+(day|week|month|year)\b/i;

function quantityOf(raw: string): number | null {
  const t = raw.toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  if (t === "couple" || t === "couple of") return 2;
  return WORD_NUMBERS[t] ?? null;
}

/**
 * Find a relative "N units ago" (or "in the past/last N units") expression.
 *
 * @param text — Query text.
 * @param now  — Reference time; the offset is subtracted from it.
 * @returns The resolved instant and a tolerance window, or null.
 */
export function parseRelativeAgo(
  text: string,
  now: Date,
): RelativeAgoOffset | null {
  if (!text || typeof text !== "string") return null;

  const back = (unitKey: string, n: number): RelativeAgoOffset | null => {
    const unit = UNITS[unitKey];
    if (!unit || !Number.isFinite(n) || n <= 0) return null;
    const at = new Date(now.getTime() - n * unit.days * 86_400_000);
    return {
      text: text.trim(),
      at,
      // A coarse unit ("a month ago") spans a range, so widen the window with
      // the unit rather than pretending day precision.
      windowDays:
        unit.window +
        (unit.days > 1 ? Math.min(unit.window, Math.ceil(n / 2)) : 0),
    };
  };

  const m = AGO_RE.exec(text);
  if (m) {
    const n = quantityOf(m[1] ?? "");
    const unit = (m[2] ?? "").toLowerCase();
    if (n !== null && UNITS[unit]) {
      const r = back(unit, n);
      if (r) r.text = m[0];
      return r;
    }
  }

  const p = PAST_PREFIX_RE.exec(text);
  if (p) {
    const unit = (p[1] ?? "").toLowerCase();
    const r = back(unit, 1);
    if (r) r.text = p[0];
    return r;
  }

  return null;
}
