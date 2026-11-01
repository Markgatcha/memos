/**
 * Chronological neighbour expansion and relative-time anchoring.
 *
 * Both features exist because semantic similarity answers "what is this
 * about", and users routinely ask "what happened around then". A conversation
 * is a timeline: the answer to "what did we decide in that session" is very
 * often in the turn just before or after the one that matched, and the answer
 * to "what did I buy 10 days ago" is often phrased with none of the
 * question's words ("I just got a smoker today").
 *
 * Design rules, learned the hard way on LongMemEval:
 *
 *   1. These are RE-RANKING passes over results the retriever already
 *      returned, never a substitute for retrieval. A date filter alone is
 *      near-useless: relative-offset windows cover 10%-77% of a typical
 *      conversation corpus, so "everything in the window" is close to a
 *      random pick. Rank inside the window, don't replace the ranking.
 *   2. Never exceed `limit`, and never drop a result to make room for an
 *      injected one. Appending past the caller's K turns a Recall@K number
 *      into "K plus some free extras" and is not a real measurement.
 *   3. Expand ONLY from memories the query actually matched. A neighbour of
 *      an unrelated session is not a neighbour of the answer; it is merely
 *      next in time. Scanning the whole corpus for neighbours lets date
 *      adjacency override retrieval, which measurably LOWERED LongMemEval
 *      all-evidence recall (97.8% -> 97.0%) by evicting sessions that had
 *      legitimately matched.
 *   4. The promotion budget is small. Each inserted memory is a slot taken
 *      from the retriever's ranking, so spend it on the closest neighbours
 *      of the strongest hits only.
 */
import type { MemoryNode, ScoredMemory } from "./types.js";

/**
 * Timestamp used for ordering: `validFrom`, else record `updatedAt`.
 *
 * `metadata.timestamp` is checked BEFORE the numeric record fields: an
 * imported memory carries its original event time there while
 * `createdAt`/`updatedAt` record when the row was written. Anchoring on
 * "when it was imported" would put every imported memory in the same window
 * and defeat the point.
 */
export function memoryInstant(node: MemoryNode): number | null {
  const raw = node.metadata?.timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const candidates = [
    typeof node.validFrom === "number" ? node.validFrom : null,
    typeof node.updatedAt === "number" ? node.updatedAt : null,
    typeof node.createdAt === "number" ? node.createdAt : null,
  ];
  for (const value of candidates) {
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

export interface NeighbourExpansionOptions {
  /** Neighbours considered on each side of a hit. Default 2. */
  radius?: number;
  /**
   * Maximum memories inserted. Default `ceil(limit / 5)` — a fifth of the
   * window, so the retriever's own ranking still owns 80% of the slots.
   */
  injected?: number;
}

export interface NeighbourExpansionResult {
  results: ScoredMemory[];
  /** How many additional memories were promoted into the list. */
  injected: number;
}

/**
 * Promote the temporally adjacent memories of results that already matched.
 *
 * Adjacency is defined inside `pool`: memories in the same pool form a
 * sequence ordered by time, and a hit's neighbours are its immediate
 * predecessor and successor there. Only `results` participate — both as
 * seeds and as neighbour candidates — so this pass can never introduce a
 * memory the retriever did not return, and it never outranks the retriever
 * above the slots it replaces.
 *
 * Promoted memories take the lowest-ranked slots, in order, and are given a
 * score just below the hit that produced them so downstream consumers see
 * them as "plausibly part of the same episode", not as strong matches.
 *
 * @returns The re-ordered list (same length) and how many slots changed.
 */
export function expandToTemporalNeighbours(
  results: ScoredMemory[],
  limit: number,
  options: NeighbourExpansionOptions = {},
): NeighbourExpansionResult {
  const radius = Math.max(1, options.radius ?? 2);
  const head = results.slice(0, limit);
  if (head.length < 3) return { results: head, injected: 0 };
  const maxInjected = Math.max(1, options.injected ?? Math.ceil(limit / 5));

  // Timeline over the RETURNED entries only (see design rule 3).
  const timelines = new Map<
    string,
    Array<{ entry: ScoredMemory; at: number }>
  >();
  for (const entry of head) {
    const at = memoryInstant(entry.node);
    if (at === null) continue;
    const pool = String(entry.node.pool ?? "event");
    const list = timelines.get(pool) ?? [];
    list.push({ entry, at });
    timelines.set(pool, list);
  }
  const index = new Map<string, { pool: string; i: number }>();
  for (const [pool, list] of timelines) {
    list.sort(
      (a, b) => a.at - b.at || a.entry.node.id.localeCompare(b.entry.node.id),
    );
    list.forEach((x, i) => index.set(x.entry.node.id, { pool, i }));
  }

  const present = new Set(head.map((r) => r.node.id));
  const candidates: Array<{ entry: ScoredMemory; score: number }> = [];
  const seen = new Set<string>();
  // Seeds strongest-first so the promotion budget is spent on the hits that
  // are most likely to anchor a real episode.
  for (const hit of [...head].sort((a, b) => b.score - a.score)) {
    const pos = index.get(hit.node.id);
    if (!pos) continue;
    const list = timelines.get(pos.pool);
    if (!list) continue;
    for (const offset of [-1, 1, -2, 2].slice(0, radius * 2)) {
      const neighbour = list[pos.i + offset];
      if (!neighbour) continue;
      const id = neighbour.entry.node.id;
      if (present.has(id) || seen.has(id)) continue;
      seen.add(id);
      candidates.push({
        entry: neighbour.entry,
        score: hit.score / (1 + Math.abs(offset)),
      });
    }
  }
  if (candidates.length === 0) return { results: head, injected: 0 };

  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, maxInjected);
  const out = [...head];
  // Replace the weakest slots, weakest first, so the head of the list — the
  // part a caller actually reads — is left alone.
  let slot = out.length - 1;
  let injected = 0;
  for (const pick of chosen) {
    while (slot >= 0 && present.has(out[slot]!.node.id) === false) slot -= 1;
    if (slot < 0) break;
    const victim = out[slot]!;
    if (victim.score > pick.score) break;
    out[slot] = { node: pick.entry.node, score: pick.score };
    present.add(pick.entry.node.id);
    slot -= 1;
    injected += 1;
  }
  return { results: out, injected };
}

export interface RelativeTimeAnchorOptions {
  /** Instant the query's expression resolves to. */
  at: number;
  /** Tolerance either side, in days. */
  windowDays: number;
}

export interface RelativeTimeAnchorResult {
  results: ScoredMemory[];
  /** How many results changed position relative to their original rank. */
  moved: number;
}

/**
 * Promote memories whose timestamp falls inside a relative-time window,
 * preserving semantic order within both the inside and outside groups.
 *
 * This is deliberately a *stable partition*, not a score recomputation: an
 * in-window memory keeps its relative order among the other in-window
 * memories, and the same holds outside it. That keeps the semantic ranking
 * meaningful instead of letting the timestamp dominate, and it is monotone in
 * the window size (a wider window moves strictly more items up, never
 * re-randomising the order).
 */
export function applyRelativeTimeAnchor(
  results: ScoredMemory[],
  window: RelativeTimeAnchorOptions,
): RelativeTimeAnchorResult {
  if (results.length === 0) return { results, moved: 0 };
  const span = Math.max(0, window.windowDays) * 86_400_000;
  const lo = window.at - span;
  const hi = window.at + span;

  const inside: ScoredMemory[] = [];
  const outside: ScoredMemory[] = [];
  for (const r of results) {
    const at = memoryInstant(r.node);
    // Untimestamped memories cannot be placed in the window; they keep their
    // original relative slot by staying in the "outside" group.
    if (at !== null && at >= lo && at <= hi) inside.push(r);
    else outside.push(r);
  }
  if (inside.length === 0 || outside.length === 0) return { results, moved: 0 };
  const merged = [...inside, ...outside];
  let moved = 0;
  for (let i = 0; i < merged.length; i += 1) {
    if (merged[i]?.node.id !== results[i]?.node.id) moved += 1;
  }
  return { results: merged, moved };
}
