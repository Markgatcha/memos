/**
 * Write-time contradiction candidate detection + read-time rule-based
 * resolution for MemOS.
 *
 * Background: MemOS is ADD-only — old facts are never deleted, they are
 * invalidated at read time. The gap this closes is *detection*: without
 * it, conflicting facts accumulate silently (the MemPalace failure mode
 * called out in the accuracy research). The detection recipe comes from
 * nirdiamant's semantic-memory thresholds — embedding similarity > 0.85
 * means duplicate, the 0.5–0.85 band plus entity overlap means
 * *contradiction candidate* — and the resolution policy mirrors the
 * mem0^g conflict-detector pattern, minus its LLM adjudication.
 *
 * Two entry points:
 *
 * 1. Write time — {@link findContradictionCandidates}: after a node is
 *    stored and its embedding persisted, scan a bounded set of semantic
 *    neighbors (the caller does the bounded scan; this function is pure)
 *    and flag pairs in the contradiction band. Flagged pairs are
 *    persisted to the `contradictions` table with status `unresolved`
 *    (add-only: both versions are kept, with provenance).
 *
 * 2. Read time — {@link resolveContradictionsAtRead}: when BOTH members
 *    of a recorded contradiction pair appear in a result set, demote the
 *    OLDER one (multiply its score by {@link CONTRADICTION_DEMOTION_FACTOR})
 *    so the newer version wins. Never removes anything. Deterministic.
 *
 * No LLM anywhere on this path — detection and resolution are
 * rule-based. LLM adjudication (e.g. in the sleep-time dreaming loop)
 * is an explicit future step, not part of this module.
 *
 * @module @memos/contradictions
 */

import { cosineSimilarity } from "./embeddings.js";
import { sharesSubject } from "./confidence-machine.js";
import { entityOverlap, extractQueryEntities } from "./entity-extraction.js";
import { compareScoredMemories } from "./retrieval.js";
import type { ContradictionRecord, MemoryNode, ScoredMemory } from "./types.js";

/**
 * Lower bound of the contradiction band. Below this, two memories are
 * unrelated — flagging them would be pure noise.
 */
export const CONTRADICTION_SIM_MIN = 0.5;

/**
 * Upper bound (exclusive) of the contradiction band. At or above this,
 * the pair is a duplicate/paraphrase, not a contradiction — the
 * evidence-learning store path (reinforce) already owns that band.
 */
export const CONTRADICTION_SIM_MAX = 0.85;

/**
 * Write-time neighbor scan bound. Contradiction detection must not
 * become a full table scan on every write — the caller asks for the
 * top-N semantic neighbors and this module scores only those.
 */
export const CONTRADICTION_SCAN_LIMIT = 50;

/**
 * Read-time demotion factor for the older member of a contradiction
 * pair. 0.5 is strong enough to flip genuinely-tied pairs while a
 * clearly more relevant old memory still keeps its rank.
 */
export const CONTRADICTION_DEMOTION_FACTOR = 0.5;

/**
 * A pre-existing memory eligible for contradiction comparison. The
 * caller (the store path) fetches these from a bounded semantic-neighbor
 * scan; `entities` are the stored entities/tags of the candidate.
 */
export interface ContradictionCandidateInput {
  id: string;
  content: string;
  vector: ArrayLike<number>;
  entities: string[];
}

/**
 * A flagged contradiction candidate: the existing memory id plus the
 * measured cosine similarity (for provenance / future adjudication).
 */
export interface ContradictionCandidate {
  id: string;
  similarity: number;
}

/**
 * Stored entity surface forms for a memory node: `metadata.entities`
 * plus `tags`, lowercased and deduped. The entity-overlap check in
 * {@link findContradictionCandidates} compares the NEW memory's
 * extracted entities against these.
 */
export function storedEntities(node: {
  tags?: readonly string[];
  metadata?: { entities?: unknown };
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const tag of node.tags ?? []) push(tag);
  const metaEntities = node.metadata?.entities;
  if (Array.isArray(metaEntities)) {
    for (const entity of metaEntities) push(entity);
  }
  return out;
}

/**
 * Flag contradiction candidates among existing memories for a newly
 * written memory.
 *
 * A candidate is flagged when ALL of these hold:
 *   1. cosine similarity is in [CONTRADICTION_SIM_MIN, CONTRADICTION_SIM_MAX)
 *      — the nirdiamant recipe band (>= 0.85 is a duplicate, < 0.5 is
 *      unrelated);
 *   2. entity overlap > 0 between the new content's extracted entities
 *      and the candidate's stored entities (rules out topically
 *      unrelated near-neighbors);
 *   3. {@link sharesSubject} — the texts share at least one meaningful
 *      content word, so a negation can only contradict a memory that is
 *      actually about the same thing.
 *
 * Pure function: no storage, no LLM. Deterministic — candidates are
 * returned in input order.
 *
 * @param newContent — The newly stored memory's content.
 * @param newVector — The newly stored memory's embedding vector.
 * @param candidates — Existing memories from the bounded neighbor scan.
 * @returns Flagged candidates ({id, similarity}).
 */
export function findContradictionCandidates(
  newContent: string,
  newVector: ArrayLike<number>,
  candidates: ContradictionCandidateInput[],
): ContradictionCandidate[] {
  const newEntities = extractQueryEntities(newContent).map((e) =>
    e.toLowerCase(),
  );
  const flagged: ContradictionCandidate[] = [];
  for (const candidate of candidates) {
    const similarity = cosineSimilarity(newVector, candidate.vector);
    if (
      similarity < CONTRADICTION_SIM_MIN ||
      similarity >= CONTRADICTION_SIM_MAX
    ) {
      continue;
    }
    if (
      entityOverlap(newEntities, {
        metadata: { entities: candidate.entities },
      }) <= 0
    ) {
      continue;
    }
    if (!sharesSubject(newContent, candidate.content)) {
      continue;
    }
    flagged.push({ id: candidate.id, similarity });
  }
  return flagged;
}

/**
 * Rule-based contradiction resolution at read time.
 *
 * For every recorded contradiction pair whose BOTH members appear in
 * `results`, demote the OLDER member (smaller `createdAt`; id as the
 * tiebreak) by multiplying its score with
 * {@link CONTRADICTION_DEMOTION_FACTOR}. The demoted result carries a
 * `scores.contradiction_demoted` marker (the factor) and its
 * `scores.hybrid` is refreshed to the demoted score — mirroring the
 * convention in `fuseResults`.
 *
 * Rules:
 *   - Never removes results. Add-only is preserved: both versions stay
 *     in the set; the newer one simply outranks the older.
 *   - Pairs with only ONE member in the set are untouched.
 *   - Deterministic: pairs are processed in canonical (node_a, node_b)
 *     order and the output is re-sorted with `compareScoredMemories`.
 *   - Pure: inputs are not mutated — demoted results are new objects
 *     with fresh `scores` records (the input `scores` objects may be
 *     shared with other result sets).
 *
 * @param results — Scored memories from hybrid search (post-fusion).
 * @param pairs — Recorded contradiction pairs (canonically ordered).
 * @returns A new array with older pair members demoted, sorted best-first.
 */
export function resolveContradictionsAtRead(
  results: ScoredMemory[],
  pairs: ContradictionRecord[],
): ScoredMemory[] {
  if (results.length < 2 || pairs.length === 0) return [...results];

  const byId = new Map<string, number>();
  for (let i = 0; i < results.length; i += 1) {
    const id = results[i]?.node.id;
    if (id !== undefined && !byId.has(id)) byId.set(id, i);
  }

  // Canonical processing order so overlapping pairs resolve
  // deterministically no matter the input order.
  const ordered = [...pairs].sort((a, b) =>
    a.nodeA < b.nodeA
      ? -1
      : a.nodeA > b.nodeA
        ? 1
        : a.nodeB < b.nodeB
          ? -1
          : a.nodeB > b.nodeB
            ? 1
            : 0,
  );

  const demoted = new Set<string>();
  const adjusted: ScoredMemory[] = results.map((r) => ({ ...r }));

  for (const pair of ordered) {
    const idxA = byId.get(pair.nodeA);
    const idxB = byId.get(pair.nodeB);
    if (idxA === undefined || idxB === undefined) continue; // only one member present
    const a = adjusted[idxA]!;
    const b = adjusted[idxB]!;
    // The older member loses: smaller createdAt, with the node id as a
    // deterministic tiebreak (createdAt is monotonic per MemOS instance,
    // but imports can collide on the same millisecond).
    const olderIdx =
      a.node.createdAt < b.node.createdAt ||
      (a.node.createdAt === b.node.createdAt && a.node.id < b.node.id)
        ? idxA
        : idxB;
    if (demoted.has(adjusted[olderIdx]!.node.id)) continue; // already demoted via another pair
    const target = adjusted[olderIdx]!;
    const newScore = target.score * CONTRADICTION_DEMOTION_FACTOR;
    adjusted[olderIdx] = {
      ...target,
      score: newScore,
      scores: {
        ...(target.scores ?? {}),
        contradiction_demoted: CONTRADICTION_DEMOTION_FACTOR,
        hybrid: newScore,
      },
    };
    demoted.add(target.node.id);
  }

  return adjusted.sort(compareScoredMemories);
}

/** Node entity-shape accepted by {@link nodeContradictionCandidates}. */
export type ContradictionScannableNode = Pick<
  MemoryNode,
  "id" | "content" | "tags" | "metadata" | "validTo"
>;

/**
 * Build the {@link ContradictionCandidateInput} list for a batch of
 * existing nodes given their vectors. Historical nodes (`validTo !==
 * null`) are skipped — a superseded memory is already out of the
 * read-time running and must not accumulate new contradiction pairs.
 */
export function nodeContradictionCandidates(
  nodes: ContradictionScannableNode[],
  vectors: ReadonlyMap<string, ArrayLike<number>>,
  excludeId?: string,
): ContradictionCandidateInput[] {
  const out: ContradictionCandidateInput[] = [];
  for (const node of nodes) {
    if (node.id === excludeId) continue;
    if (node.validTo !== null) continue;
    const vector = vectors.get(node.id);
    if (!vector) continue;
    out.push({
      id: node.id,
      content: node.content,
      vector,
      entities: storedEntities(node),
    });
  }
  return out;
}
