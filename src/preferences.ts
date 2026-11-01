/**
 * Preference capture.
 *
 * Facts are easy: the question names the thing and retrieval matches it.
 * Preferences are harder: "what would I enjoy?" shares no words with "I love
 * hiking in the rain", so lexical and dense retrieval both miss it.
 *
 * This module extracts explicit preference statements from text, normalises
 * them into third-person memories ("User prefers X"), and gives retrieval a
 * dedicated way to fetch them when a question is preference-seeking.
 */

const LIKE_PATTERNS: RegExp[] = [
  /\b(?:i|we)\s+(?:really\s+|also\s+|just\s+|usually\s+|generally\s+)?(?:prefer|like|love|enjoy|adore|fancy)\s+([^.!?\n]{3,140})/gi,
  /\b(?:i'?m|i am|we are)\s+(?:really\s+|also\s+)?(?:interested in|into|keen on|a fan of)\s+([^.!?\n]{3,140})/gi,
  /\b(?:i'?d|i would)\s+rather\s+([^.!?\n]{3,140})/gi,
];

const DISLIKE_PATTERNS: RegExp[] = [
  /\b(?:i|we)\s+(?:really\s+|also\s+|just\s+)?(?:hate|dislike|avoid)\s+([^.!?\n]{3,140})/gi,
  /\b(?:i|we)\s+(?:really\s+)?(?:can'?t stand|cannot stand|don'?t like|do not like)\s+([^.!?\n]{3,140})/gi,
];

const FAVORITE_PATTERN = /\bmy\s+favou?rite\s+([^.!?\n]{3,120})/gi;

export interface ExtractedPreference {
  /** Third-person memory text, e.g. "User prefers dark mode". */
  statement: string;
  polarity: "like" | "dislike";
  /** The raw span the statement came from. */
  source: string;
}

const TRAILING_NOISE =
  /\s*(?:,|;)?\s*(?:though|although|but|because|since|so|anyway|actually|really|a lot|very much|too)\s*$/i;

function cleanObject(raw: string): string {
  let value = raw.replace(/\s+/g, " ").trim();
  value = value.replace(/^["'“”]|["'“”]$/g, "").trim();
  // Stop at the first clause boundary that introduces a new subject: the
  // rest of the sentence is commentary, not part of the preference.
  value = value
    .split(
      /,\s*(?:and|but|so|because|which|that|though|although|i|we|it|they|he|she)\b/i,
    )[0]
    .trim();
  // Drop a trailing clause that usually belongs to the next sentence.
  value = value.replace(TRAILING_NOISE, "").trim();
  value = value.replace(/[.,;:!?]+$/, "").trim();
  if (value.length > 120) value = value.slice(0, 120).trim();
  return value;
}

/**
 * Extract explicit preference statements. Deliberately conservative: only
 * first-person constructions ("I prefer…", "we love…", "my favourite…"), which
 * keeps precision high on chat and agent transcripts.
 */
export function extractPreferences(
  text: string,
  limit = 20,
): ExtractedPreference[] {
  if (!text || limit <= 0) return [];
  const seen = new Set<string>();
  const out: ExtractedPreference[] = [];

  const push = (raw: string, polarity: "like" | "dislike", prefix: string) => {
    const object = cleanObject(raw);
    if (object.length < 3) return;
    const statement = `${prefix}${object}`;
    const key = statement.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ statement, polarity, source: raw.trim().slice(0, 160) });
  };

  for (const pattern of LIKE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // "I'd rather X" reads better as "User would rather X".
      const prefix = /rather/i.test(match[0])
        ? "User would rather "
        : "User prefers ";
      push(match[1], "like", prefix);
      if (out.length >= limit) return out;
    }
  }
  for (const pattern of DISLIKE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      push(match[1], "dislike", "User dislikes ");
      if (out.length >= limit) return out;
    }
  }
  FAVORITE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(FAVORITE_PATTERN)) {
    push(match[1], "like", "User's favorite: ");
    if (out.length >= limit) return out;
  }
  return out;
}

/**
 * Does this question ask for a recommendation, taste, or preference?
 *
 * Used to add preference memories to the context even when the question's
 * wording does not overlap with the stored statement.
 */
export function isPreferenceQuestion(question: string): boolean {
  const text = String(question || "");
  if (!text) return false;
  return (
    /\b(would|could|might|do|did)\s+(i|we)\s+(like|love|enjoy|prefer|want|be interested)/i.test(
      text,
    ) ||
    /\b(recommend|recommendation|suggest|suggestion|favorite|favourite|preference|preferences)\b/i.test(
      text,
    ) ||
    /\b(what|which)\s+(kind|type|sort)\s+of\b[^?]{0,40}\b(do i|would i|i (?:like|enjoy|prefer))/i.test(
      text,
    ) ||
    /\b(for me|suits? me|my taste|my style)\b/i.test(text)
  );
}
