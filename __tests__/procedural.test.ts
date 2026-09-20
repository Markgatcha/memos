/**
 * Tests for procedural memory (self-editing instructions).
 *
 * Covered:
 *   - capture: `memorizeProcedural` round-trips through storage with the
 *     neutral 0.5 prior, context, tags, and namespace;
 *   - scoring math: success reinforces with diminishing returns,
 *     failure demotes proportionally, floor/cap clamps hold, counts
 *     increment, and the 30-day read-time decay behaves;
 *   - retrieval ordering: `recallProcedural` blends decayed score (60%)
 *     with query relevance (40%), honors k, and drops zero-relevance
 *     lessons for non-empty queries;
 *   - pack integration: `contextPack({ lessons })` injects an
 *     "operating instructions" section in JSON + TOON output, off by
 *     default.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  applyLessonOutcome,
  clampLessonScore,
  effectiveLessonScore,
  lessonCitationToken,
  lessonShortId,
  rankProceduralLessons,
  DEFAULT_LESSON_PACK_K,
  LESSON_DECAY_HALF_LIFE_DAYS,
  LESSON_SCORE_CAP,
  LESSON_SCORE_FLOOR,
} from "../src/procedural";
import { packToToon, packToToonCompact } from "../src/context-pack";
import type { ProceduralLesson } from "../src/types";

const NOW = 1_718_452_800_000; // fixed clock for math tests

function lesson(overrides: Partial<ProceduralLesson> = {}): ProceduralLesson {
  return {
    id: "lesson-1",
    lesson: "Check rate limits before batch API calls.",
    context: "when calling third-party APIs",
    tags: ["api"],
    score: 0.5,
    successCount: 0,
    failureCount: 0,
    useCount: 0,
    namespace: "default",
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: 0,
    ...overrides,
  };
}

function makeMemos(): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    embeddings: { enabled: false },
  });
}

describe("scoring math (pure)", () => {
  test("success reinforces with diminishing returns", () => {
    const once = applyLessonOutcome(lesson(), "success", NOW);
    expect(once.score).toBeCloseTo(0.6, 5); // 0.5 + 0.5*0.2
    const twice = applyLessonOutcome(once, "success", NOW);
    expect(twice.score).toBeCloseTo(0.68, 5); // 0.6 + 0.4*0.2
    expect(twice.successCount).toBe(2);
    expect(twice.failureCount).toBe(0);
    expect(twice.useCount).toBe(2);
    expect(twice.updatedAt).toBe(NOW);
    expect(twice.lastUsedAt).toBe(NOW);
  });

  test("failure demotes proportionally", () => {
    const once = applyLessonOutcome(lesson(), "failure", NOW);
    expect(once.score).toBeCloseTo(0.35, 5); // 0.5 - 0.5*0.3
    expect(once.failureCount).toBe(1);
    expect(once.useCount).toBe(1);
  });

  test("scores clamp at floor and cap", () => {
    let l = lesson();
    for (let i = 0; i < 100; i++) l = applyLessonOutcome(l, "success", NOW);
    expect(l.score).toBeLessThanOrEqual(LESSON_SCORE_CAP);
    l = lesson();
    for (let i = 0; i < 100; i++) l = applyLessonOutcome(l, "failure", NOW);
    expect(l.score).toBeGreaterThanOrEqual(LESSON_SCORE_FLOOR);
    // cap/floor are strict bounds, never exactly 0/1
    expect(l.score).toBeGreaterThan(0);
  });

  test("clampLessonScore guards garbage", () => {
    expect(clampLessonScore(2)).toBe(LESSON_SCORE_CAP);
    expect(clampLessonScore(-1)).toBe(LESSON_SCORE_FLOOR);
    expect(clampLessonScore(Number.NaN)).toBe(0.5);
  });

  test("read-time decay: mild 30-day half-life", () => {
    const l = lesson({ score: 0.8, updatedAt: NOW });
    expect(effectiveLessonScore(l, NOW)).toBeCloseTo(0.8, 5);
    const halfLife = NOW + LESSON_DECAY_HALF_LIFE_DAYS * 86_400_000;
    expect(effectiveLessonScore(l, halfLife)).toBeCloseTo(0.4, 5);
    const quarter = NOW + 2 * LESSON_DECAY_HALF_LIFE_DAYS * 86_400_000;
    expect(effectiveLessonScore(l, quarter)).toBeCloseTo(0.2, 5);
  });

  test("lesson id helpers", () => {
    expect(lessonShortId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "a1b2c3d4",
    );
    expect(lessonCitationToken("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "[lesson:a1b2c3d4]",
    );
  });
});

describe("retrieval ranking (pure)", () => {
  const lessons = [
    lesson({
      id: "l1",
      lesson: "Check rate limits before batch API calls.",
      context: "when calling third-party APIs",
      score: 0.9,
    }),
    lesson({
      id: "l2",
      lesson: "Write tests before pushing to main.",
      context: "",
      score: 0.95,
    }),
    lesson({
      id: "l3",
      lesson: "Retry API calls with backoff on 429s.",
      context: "",
      score: 0.4,
    }),
  ];

  test("query-relevant lessons rank above higher-scored irrelevant ones", () => {
    const ranked = rankProceduralLessons(lessons, "API rate limits", 3, NOW);
    // l1 matches "api"+"rate"; l3 matches "api"; l2 matches nothing.
    expect(ranked.map((r) => r.id)).toEqual(["l1", "l3"]);
  });

  test("k limits the result", () => {
    const ranked = rankProceduralLessons(lessons, "API", 1, NOW);
    expect(ranked).toHaveLength(1);
  });

  test("empty query ranks by effective score alone", () => {
    const ranked = rankProceduralLessons(lessons, "", 3, NOW);
    expect(ranked.map((r) => r.id)).toEqual(["l2", "l1", "l3"]);
  });

  test("rank carries the blended signals", () => {
    const [top] = rankProceduralLessons(lessons, "rate limits", 3, NOW);
    expect(top!.effectiveScore).toBeGreaterThan(0);
    expect(top!.relevance).toBeGreaterThan(0);
    expect(top!.rankScore).toBeCloseTo(
      0.6 * top!.effectiveScore + 0.4 * top!.relevance,
      3,
    );
  });
});

describe("storage round-trip", () => {
  test("save / get / update / list", async () => {
    const storage = new SQLiteStorage(":memory:", true);
    await storage.init();
    const saved = await storage.saveProceduralLesson({
      lesson: "Always pin dependency versions.",
      context: "when editing package.json",
      tags: ["deps"],
      namespace: "default",
    });
    expect(saved.score).toBe(0.5);
    expect(saved.tags).toEqual(["deps"]);

    const fetched = await storage.getProceduralLesson(saved.id);
    expect(fetched?.lesson).toBe("Always pin dependency versions.");

    const updated = await storage.updateProceduralLesson(saved.id, {
      ...saved,
      score: 0.7,
    });
    expect(updated?.score).toBe(0.7);

    expect(await storage.getProceduralLesson("missing")).toBeNull();
    expect(
      await storage.updateProceduralLesson("missing", { score: 0.1 }),
    ).toBeNull();

    const listed = await storage.listProceduralLessons("default");
    expect(listed).toHaveLength(1);
    expect(await storage.listProceduralLessons("other")).toHaveLength(0);
    await storage.close();
  });
});

describe("MemOS API", () => {
  test("capture → outcome → recall ordering", async () => {
    const memos = makeMemos();
    await memos.init();

    const a = await memos.memorizeProcedural(
      "Check rate limits before batch API calls.",
      { context: "third-party APIs", tags: ["api"] },
    );
    expect(a.score).toBe(0.5);
    expect(a.context).toBe("third-party APIs");

    const b = await memos.memorizeProcedural("Write tests before pushing.", {
      tags: ["workflow"],
    });
    // b gets reinforced twice; a gets one failure.
    await memos.recordLessonOutcome(b.id, "success");
    await memos.recordLessonOutcome(b.id, "success");
    const aAfter = await memos.recordLessonOutcome(a.id, "failure");
    expect(aAfter.score).toBeCloseTo(0.35, 5);
    expect(aAfter.failureCount).toBe(1);

    const ranked = await memos.recallProcedural("API calls", 3);
    expect(ranked.map((l) => l.id)).toEqual([a.id]);

    const listed = await memos.listProceduralLessons();
    expect(listed).toHaveLength(2);
    // highest score first
    expect(listed[0]!.id).toBe(b.id);

    await expect(memos.recordLessonOutcome("nope", "success")).rejects.toThrow(
      "No procedural lesson",
    );
    await expect(memos.memorizeProcedural("  ")).rejects.toThrow(
      "non-empty lesson",
    );
    await memos.close();
  });

  test("namespaces isolate lessons", async () => {
    const memos = makeMemos();
    await memos.init();
    await memos.memorizeProcedural("Lesson one.", { namespace: "team-a" });
    expect(
      await memos.listProceduralLessons({ namespace: "team-a" }),
    ).toHaveLength(1);
    expect(
      await memos.listProceduralLessons({ namespace: "team-b" }),
    ).toHaveLength(0);
    expect(
      await memos.recallProcedural("", 3, { namespace: "team-b" }),
    ).toHaveLength(0);
    await memos.close();
  });
});

describe("context-pack integration", () => {
  test("lessons inject as an operating-instructions section", async () => {
    const memos = makeMemos();
    await memos.init();
    await memos.store("The user likes dark mode.", { type: "preference" });
    const saved = await memos.memorizeProcedural(
      "Check rate limits before batch API calls.",
      { context: "third-party APIs" },
    );
    await memos.recordLessonOutcome(saved.id, "success");

    const pack = await memos.contextPack({
      query: "API rate limits",
      tokenBudget: 2000,
      lessons: true,
    });
    expect(typeof pack).not.toBe("string");
    if (typeof pack === "string") throw new Error("expected pack object");
    expect(pack.lessons).toHaveLength(1);
    expect(pack.lessons![0]!.lesson).toContain("rate limits");

    const toon = packToToon(pack);
    expect(toon).toContain("# operating-instructions: learned lessons");
    expect(toon).toContain("[lesson:");
    expect(toon).toContain("Check rate limits before batch API calls.");

    const compact = packToToonCompact(pack) as string;
    expect(compact).toContain("[lesson:");

    // Custom k: lessons: 5 still caps at available lessons.
    const pack5 = await memos.contextPack({
      query: "API rate limits",
      tokenBudget: 2000,
      lessons: 5,
    });
    if (typeof pack5 === "string") throw new Error("expected pack object");
    expect(pack5.lessons).toHaveLength(1);
    await memos.close();
  });

  test("packs without lessons are unchanged (additive)", async () => {
    const memos = makeMemos();
    await memos.init();
    await memos.store("The user likes dark mode.", { type: "preference" });
    await memos.memorizeProcedural("Check rate limits.");

    const pack = await memos.contextPack({
      query: "dark mode",
      tokenBudget: 2000,
    });
    if (typeof pack === "string") throw new Error("expected pack object");
    expect(pack.lessons).toBeUndefined();
    const toon = packToToon(pack);
    expect(toon).not.toContain("operating-instructions");
    await memos.close();
  });

  test("default pack k is 3", () => {
    expect(DEFAULT_LESSON_PACK_K).toBe(3);
  });
});
