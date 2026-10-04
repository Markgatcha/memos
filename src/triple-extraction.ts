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

    // Pattern 1: "X is Y" / "X are Y" (copular)
    // Pattern 2: "X has Y" (possessive)
    // Pattern 3: "X prefers Y" (preference)
    for (let i = 1; i < words.length - 1; i++) {
      const verb = words[i]!.toLowerCase().replace(/[^a-z]/g, "");
      const subject = words
        .slice(0, i)
        .join(" ")
        .trim();
      const object = words
        .slice(i + 1)
        .join(" ")
        .trim();

      if (subject.length < 2 || object.length < 2) continue;
      if (subject.length > 60 || object.length > 60) continue;

      let predicate: string | null = null;
      if (COPULAR.has(verb)) predicate = "is";
      else if (POSSESSIVE.has(verb)) predicate = "has";
      else if (PREFERENCE.has(verb)) predicate = verb;

      if (predicate) {
        const key = `${subject}|${predicate}|${object}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          triples.push({
            subject: subject.toLowerCase(),
            predicate,
            object: object.toLowerCase(),
          });
        }
        break; // One triple per sentence (the main clause)
      }
    }
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
