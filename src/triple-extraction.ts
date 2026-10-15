/**
 * Rule-based semantic triple extraction for write-time structuring.
 *
 * Extracts (subject, predicate, object) triples from memory content at
 * store time. Inspired by Memori's "Advanced Augmentation" pipeline, which
 * converts unstructured dialogue into semantic triples for precise
 * retrieval — but rule-based and local-first (no LLM needed).
 *
 * This is experimental and opt-in. Triples are stored in node metadata
 * (`metadata.triples`) and can boost retrieval when the query's triples
 * match stored triples.
 *
 * The extractor uses simple SVO patterns. It's heuristic, not perfect —
 * but it's fast, deterministic, and testable through the accuracy gate.
 */

export interface SemanticTriple {
  subject: string;
  predicate: string;
  object: string;
}

// Common copular/linking verbs that form "X is Y" triples.
const COPULAR = new Set([
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "become",
  "became",
]);

// Common possession/relation verbs for "X has Y" triples.
const POSSESSIVE = new Set(["has", "have", "had", "owns", "owned", "contains"]);

// Preference verbs for "X prefers/likes Y" triples.
const PREFERENCE = new Set([
  "prefers",
  "prefer",
  "likes",
  "like",
  "loves",
  "love",
  "hates",
  "hate",
  "dislikes",
  "dislike",
  "enjoys",
  "enjoy",
]);

// Action / configuration verbs worth capturing as triples. The original
// copular/possessive/preference set covered maybe a third of the facts
// agents actually store ("the deploy uses pnpm", "the api reads its
// config from env"), which is why write-time triples never fired and
// the retrieval boost built on top of them was dead weight. Kept to
// present tense + the past forms that show up in stored facts.
const ACTION_VERBS = new Set([
  "uses",
  "use",
  "used",
  "uses",
  "runs",
  "run",
  "reads",
  "read",
  "writes",
  "write",
  "owns",
  "own",
  "owns",
  "deploys",
  "deploy",
  "deployed",
  "reviews",
  "review",
  "maintains",
  "maintain",
  "approves",
  "approve",
  "can",
  "caps",
  "cap",
  "connects",
  "connect",
  "listens",
  "listen",
  "exposes",
  "expose",
  "requires",
  "require",
  "blocks",
  "block",
  "stores",
  "store",
  "lives",
  "live",
  "works",
  "work",
  "located",
  "migrated",
  "switched",
  "created",
  "added",
  "removed",
  "installed",
  "configured",
  "decided",
  "prefers",
]);

/**
 * Trailing / leading fillers that carry no slot value. Stripping them
 * from a subject or object is what lets a stored triple
 * ("the user prefers dark mode in every editor") match a query triple
 * ("user prefers dark mode in every editor") — the leading "the" alone
 * made the two subjects compare unequal, so `triplesMatch` never fired
 * on real corpus pairs.
 */
const SLOT_FILLERS = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "with",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "by",
  "from",
  "that",
  "this",
  "it",
  "its",
]);

/**
 * Words that open a subject span without belonging to it: interrogatives
 * on the query side, and the auxiliaries that follow them ("what DOES
 * the api service …"). Stripped by {@link trimSubject} so a question and
 * the memory it asks about reduce to the same subject.
 */
const SUBJECT_OPENERS = new Set([
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "how",
  "when",
  "where",
  "why",
  "does",
  "do",
  "did",
  "is",
  "are",
  "was",
  "were",
  "can",
  "could",
  "should",
  "would",
  "will",
  "has",
  "have",
  "had",
]);

/** Coordination words that trail a subject span. */
const SUBJECT_AUXILIARIES = new Set(["and", "but", "or", "so", "then"]);

/** Drop leading/trailing filler words from a slot value. */
function trimSlot(value: string): string {
  const words = normalizeWords(value);
  while (words.length > 0 && SLOT_FILLERS.has(words[0]!)) words.shift();
  while (words.length > 0 && SLOT_FILLERS.has(words[words.length - 1]!)) {
    words.pop();
  }
  return words.join(" ");
}

/**
 * Subject-specific trim: the same filler strip, then whatever turns the
 * span into a noun phrase.
 *
 * Two things land in a subject besides fillers. Interrogative openers
 * ("what", "which", "who") and auxiliaries ("does", "is") — the query side
 * of the boost is natural language, and without stripping them
 * "what does the api service read its config from" yielded the subject
 * "what does the api service", which never equals the stored "api
 * service", so `triplesMatch` could not fire on any real pair.
 *
 * The strips have to iterate, not run once: filling an interrogative off
 * the front can expose a filler ("what THE api service") that the first
 * filler pass was never offered.
 */
function trimSubject(value: string): string {
  const words = normalizeWords(value);
  let trimmed = true;
  while (trimmed) {
    trimmed = false;
    while (words.length > 0 && SLOT_FILLERS.has(words[0]!)) {
      words.shift();
      trimmed = true;
    }
    while (words.length > 0 && SUBJECT_OPENERS.has(words[0]!)) {
      words.shift();
      trimmed = true;
    }
    while (words.length > 0 && SLOT_FILLERS.has(words[words.length - 1]!)) {
      words.pop();
      trimmed = true;
    }
    while (words.length > 0 && SUBJECT_AUXILIARIES.has(words[words.length - 1]!)) {
      words.pop();
      trimmed = true;
    }
  }
  return words.join(" ");
}

/**
 * Lowercase a slot value into comparable words. Possessive `'s` attaches
 * to the preceding word in English ("user's timezone" = the user's
 * timezone, not a subject called "user s timezone"), so it is deleted
 * rather than turned into a space by the punctuation scrub.
 */
function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalize a token to its bare verb form for set membership. */
function verbOf(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

/** Canonical verb classes: the main clause of a sentence is one of these. */
const CANONICAL_VERBS = new Set([...COPULAR, ...POSSESSIVE, ...PREFERENCE]);

/**
 * Position of the main verb in a sentence's word list.
 *
 * Copular / possessive / preference verbs win outright (pass 1). Action
 * verbs (pass 2) only apply when none of those is present, and a
 * candidate is skipped when a further verb still sits in its object —
 * that is what keeps "The deploy pipeline uses pnpm" from yielding the
 * subject "the deploy" for the predicate "deploy".
 *
 * @returns Word index of the main verb, or -1 when the sentence has none.
 */
function mainVerbIndex(words: string[]): number {
  for (let i = 1; i < words.length - 1; i += 1) {
    if (CANONICAL_VERBS.has(verbOf(words[i]!))) return i;
  }
  for (let i = 1; i < words.length - 1; i += 1) {
    if (!ACTION_VERBS.has(verbOf(words[i]!))) continue;
    const objectHasVerb = words
      .slice(i + 1)
      .some((w) => ACTION_VERBS.has(verbOf(w)));
    if (!objectHasVerb) return i;
  }
  return -1;
}

/**
 * Extract semantic triples from text.
 * Returns array of {subject, predicate, object}.
 */
export function extractTriples(text: string): SemanticTriple[] {
  if (!text || text.length < 10) return [];

  const triples: SemanticTriple[] = [];
  const seen = new Set<string>();

  // Split into sentences (simple).
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    if (words.length < 3 || words.length > 40) continue;

    // One triple per sentence (the main clause): the first canonical
    // verb splits subject from object, and action verbs (@see
    // mainVerbIndex) only fill in when the sentence has none.
    const i = mainVerbIndex(words);
    if (i < 0) continue;

    const verb = verbOf(words[i]!);
    const rawSubject = words.slice(0, i).join(" ").trim();
    const rawObject = words
      .slice(i + 1)
      .join(" ")
      .trim();
    if (rawSubject.length < 2 || rawObject.length < 2) continue;

    let predicate: string | null = null;
    if (COPULAR.has(verb)) predicate = "is";
    else if (POSSESSIVE.has(verb)) predicate = "has";
    else if (PREFERENCE.has(verb) || ACTION_VERBS.has(verb)) predicate = verb;
    if (!predicate) continue;

    const subject = trimSubject(rawSubject);
    const object = trimSlot(rawObject);
    if (subject.length < 2 || object.length < 2) continue;
    if (subject.length > 60 || object.length > 60) continue;
    const key = `${subject}|${predicate}|${object}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    triples.push({
      subject: subject.toLowerCase(),
      predicate,
      object: object.toLowerCase(),
    });
  }

  return triples.slice(0, 10); // Cap at 10 per memory
}

/**
 * Check if a query triple matches a stored triple.
 * Matches on subject+predicate, or subject+object overlap.
 */
export function triplesMatch(
  queryTriples: SemanticTriple[],
  storedTriples: SemanticTriple[],
): boolean {
  for (const qt of queryTriples) {
    for (const st of storedTriples) {
      // Subject + predicate match (e.g., "user prefers" matches)
      if (qt.subject === st.subject && qt.predicate === st.predicate) {
        return true;
      }
      // Subject + object overlap
      if (
        qt.subject === st.subject &&
        (qt.object.includes(st.object) || st.object.includes(qt.object))
      ) {
        return true;
      }
    }
  }
  return false;
}
