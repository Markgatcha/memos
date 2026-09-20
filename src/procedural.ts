/**
 * Procedural memory: self-editing instructions.
 *
 * A memory class that is not facts — it is *lessons that change agent
 * behavior* ("next time check rate limits earlier"). Lessons are captured
 * explicitly (`memorizeProcedural` / `memos learn`), reinforced or demoted
 * by outcome feedback (`recordLessonOutcome` / `memos lesson <id>
 * --outcome`), and injected into context packs as an "operating
 * instructions" section (`recallProcedural` / `contextPack({ lessons })`).
 *
 * All scoring is pure local math — no LLM anywhere:
 * - capture starts at a neutral prior (0.5);
 * - success reinforces with diminishing returns: `s += (1 - s) * 0.2`;
 * - failure demotes proportionally: `s -= s * 0.3`;
 * - a mild time decay (30-day half-life) is applied lazily at read time,
 *   so stored scores stay transparent and auditable.
 *
 * Retrieval blends the decayed score with keyword relevance to the query
 * (60/40), so generally useful lessons surface even for loosely related
 * queries while irrelevant ones stay out.
 *
 * @module @mem-os/procedural
 */

import type { LessonOutcome, ProceduralLesson } from "./types.js";

/** Neutral prior score for a freshly captured lesson. */
export const LESSON_INITIAL_SCORE = 0.5;
/** Success reinforcement step: `score += (1 - score) * STEP` (asymptote 1). */
export const LESSON_SUCCESS_STEP = 0.2;
/** Failure demotion step: `score -= score * STEP` (asymptote 0). */
export const LESSON_FAILURE_STEP = 0.3;
/** Half-life (days) of the read-time decay applied to lesson scores. */
export const LESSON_DECAY_HALF_LIFE_DAYS = 30;
/** Stored scores are clamped to this range. */
export const LESSON_SCORE_FLOOR = 0.01;
export const LESSON_SCORE_CAP = 0.99;
/** Weight of the (decayed) score vs query relevance in retrieval ranking. */
export const LESSON_SCORE_WEIGHT = 0.6;
export const LESSON_RELEVANCE_WEIGHT = 0.4;
/** Default number of lessons injected into a context pack. */
export const DEFAULT_LESSON_PACK_K = 3;

/** A procedural lesson with its read-time ranking signals attached. */
export interface RankedProceduralLesson extends ProceduralLesson {
  /** Score after read-time decay. */
  effectiveScore: number;
  /** Fraction of query tokens present in lesson + context (0..1). */
  relevance: number;
  /** Blended rank: 0.6 * effectiveScore + 0.4 * relevance. */
  rankScore: number;
}

/**
 * Apply an outcome to a lesson, returning the updated record. Pure —
 * no I/O, no clock beyond the `nowMs` parameter (tests pin it).
 */
export function applyLessonOutcome(
  lesson: ProceduralLesson,
  outcome: LessonOutcome,
  nowMs: number = Date.now(),
): ProceduralLesson {
  let score = lesson.score;
  if (outcome === "success") {
    score = Math.min(
      LESSON_SCORE_CAP,
      score + (1 - score) * LESSON_SUCCESS_STEP,
    );
  } else {
    score = Math.max(LESSON_SCORE_FLOOR, score - score * LESSON_FAILURE_STEP);
  }
  return {
    ...lesson,
    score: round3(score),
    successCount: lesson.successCount + (outcome === "success" ? 1 : 0),
    failureCount: lesson.failureCount + (outcome === "failure" ? 1 : 0),
    useCount: lesson.useCount + 1,
    updatedAt: nowMs,
    lastUsedAt: nowMs,
  };
}

/**
 * Read-time effective score: stored score decayed by a 30-day half-life
 * since the last update. Mild on purpose — a lesson used last month is
 * still worth ~50%, not forgotten.
 */
export function effectiveLessonScore(
  lesson: ProceduralLesson,
  nowMs: number = Date.now(),
): number {
  const days = Math.max(0, (nowMs - lesson.updatedAt) / 86_400_000);
  return lesson.score * Math.pow(0.5, days / LESSON_DECAY_HALF_LIFE_DAYS);
}

/** Clamp a score to the lesson score band [0.01, 0.99]. */
export function clampLessonScore(score: number): number {
  if (!Number.isFinite(score)) return LESSON_INITIAL_SCORE;
  return Math.min(LESSON_SCORE_CAP, Math.max(LESSON_SCORE_FLOOR, score));
}

/** Short display id for a lesson: first 8 hex chars of the uuid. */
export function lessonShortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Citable token for a lesson, e.g. `[lesson:a1b2c3d4]`. */
export function lessonCitationToken(id: string): string {
  return `[lesson:${lessonShortId(id)}]`;
}

function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const token of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length > 2) seen.add(token);
  }
  return [...seen];
}

/**
 * Rank lessons for a query. Relevance is the fraction of query tokens
 * (length > 2) found in the lesson text + context; the rank blends it
 * with the decayed score 40/60. Lessons with zero relevance are dropped
 * unless the query is empty (empty query = "top lessons by score").
 */
export function rankProceduralLessons(
  lessons: ProceduralLesson[],
  query: string,
  k: number,
  nowMs: number = Date.now(),
): RankedProceduralLesson[] {
  const tokens = queryTokens(query);
  const ranked: RankedProceduralLesson[] = [];
  for (const lesson of lessons) {
    const effectiveScore = effectiveLessonScore(lesson, nowMs);
    const haystack = `${lesson.lesson} ${lesson.context}`.toLowerCase();
    const hits = tokens.filter((t) => haystack.includes(t)).length;
    const relevance = tokens.length > 0 ? hits / tokens.length : 0;
    if (tokens.length > 0 && relevance === 0) continue;
    ranked.push({
      ...lesson,
      effectiveScore: round3(effectiveScore),
      relevance: round3(relevance),
      rankScore: round3(
        LESSON_SCORE_WEIGHT * effectiveScore +
          LESSON_RELEVANCE_WEIGHT * relevance,
      ),
    });
  }
  ranked.sort(
    (a, b) =>
      b.rankScore - a.rankScore ||
      b.effectiveScore - a.effectiveScore ||
      b.updatedAt - a.updatedAt,
  );
  return ranked.slice(0, Math.max(0, k));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
