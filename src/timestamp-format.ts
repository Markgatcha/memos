/**
 * Human-readable timestamp formatting for recalled memories.
 *
 * From Honcho: LLMs reason better about time when they see explicit
 * absolute + relative timestamps ("2026-09-28 — 6 days ago") instead
 * of raw epoch milliseconds. The TimeQA step-back paper showed +12pts
 * from better temporal grounding.
 *
 * Pure rendering helper — does not affect retrieval scoring.
 */

/**
 * Format an epoch-ms timestamp as "YYYY-MM-DD — N days ago".
 *
 * @param epochMs - Timestamp in epoch milliseconds
 * @param now - Reference time (defaults to Date.now())
 */
export function formatMemoryTimestamp(
  epochMs: number,
  now: number = Date.now(),
): string {
  const date = new Date(epochMs);
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD

  const diffMs = now - epochMs;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  let relative: string;
  if (diffDays < 0) {
    relative = "in the future";
  } else if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      const diffMins = Math.floor(diffMs / (1000 * 60));
      relative = diffMins <= 1 ? "just now" : `${diffMins} minutes ago`;
    } else {
      relative = diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
    }
  } else if (diffDays === 1) {
    relative = "yesterday";
  } else if (diffDays < 30) {
    relative = `${diffDays} days ago`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    relative = months === 1 ? "1 month ago" : `${months} months ago`;
  } else {
    const years = Math.floor(diffDays / 365);
    relative = years === 1 ? "1 year ago" : `${years} years ago`;
  }

  return `${iso} — ${relative}`;
}
