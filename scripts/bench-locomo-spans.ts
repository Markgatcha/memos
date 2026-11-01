/**
 * LoCoMo span-aggregation experiment.
 *
 * Post-hoc, deterministic re-scoring of an existing retrieval artifact: take
 * the top-10 retrieved turns, merge adjacent turns into spans, expand each
 * span to include its interior (or its immediate neighbours), and measure
 * whether evidence now falls inside a retrieved span.
 *
 * No re-retrieval and no model calls — the retrieved list is fixed, so any
 * change is attributable to span formation alone.
 *
 * Usage:
 *   npx tsx scripts/bench-locomo-spans.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface PerQuestion {
  questionId: string;
  category: string;
  relevantIds: string[];
  retrievedIds: string[];
}

interface DatasetTurn {
  dia_id: string;
  speaker?: string;
  text?: string;
}

interface DatasetConversation {
  sample_id?: string;
  conversation: Record<string, unknown>;
}

const DATASET = resolve("scripts/dataset/locomo/data/locomo10.json");
const ARTIFACT = resolve("scripts/bench-locomo-noapi-results.json");
const OUT = resolve("docs/artifacts/locomo-span-aggregation.json");

type TurnIndex = Map<string, { session: string; turn: number }>;

function indexTurns(dataset: DatasetConversation[]): TurnIndex {
  const index: TurnIndex = new Map();
  for (const conversation of dataset) {
    for (const [key, value] of Object.entries(conversation.conversation)) {
      if (!/^session_\d+$/.test(key) || !Array.isArray(value)) continue;
      for (const turn of value as DatasetTurn[]) {
        if (typeof turn?.dia_id !== "string") continue;
        const [session, turnNumber] = turn.dia_id.split(":");
        if (!session || !turnNumber) continue;
        index.set(turn.dia_id, {
          session,
          turn: Number.parseInt(turnNumber, 10),
        });
      }
    }
  }
  return index;
}

function mergeSpans(ids: string[], index: TurnIndex): string[][] {
  const bySession = new Map<string, Set<number>>();
  for (const id of ids) {
    const info = index.get(id);
    if (!info) continue;
    const set = bySession.get(info.session) ?? new Set<number>();
    set.add(info.turn);
    bySession.set(info.session, set);
  }
  const spans: string[][] = [];
  for (const [session, turns] of bySession) {
    const sorted = [...turns].sort((a, b) => a - b);
    let start = sorted[0]!;
    let end = start;
    for (const turn of sorted.slice(1)) {
      if (turn === end + 1) {
        end = turn;
        continue;
      }
      spans.push(spanIds(session, start, end));
      start = turn;
      end = turn;
    }
    spans.push(spanIds(session, start, end));
  }
  return spans;
}

function spanIds(session: string, start: number, end: number): string[] {
  const ids: string[] = [];
  for (let turn = start; turn <= end; turn += 1) ids.push(`${session}:${turn}`);
  return ids;
}

function expandNeighbours(
  ids: string[],
  index: TurnIndex,
  radius: number,
): string[] {
  return expandTopNeighbours(ids, index, radius, ids.length);
}

function expandTopNeighbours(
  ids: string[],
  index: TurnIndex,
  radius: number,
  topN: number,
): string[] {
  const expanded = new Set(ids);
  for (const id of ids.slice(0, Math.max(0, topN))) {
    const info = index.get(id);
    if (!info) continue;
    for (let delta = 1; delta <= radius; delta += 1) {
      const before = `${info.session}:${info.turn - delta}`;
      const after = `${info.session}:${info.turn + delta}`;
      if (index.has(before)) expanded.add(before);
      if (index.has(after)) expanded.add(after);
    }
  }
  return [...expanded];
}

function score(
  rows: PerQuestion[],
  index: TurnIndex,
  transform: (ids: string[]) => string[],
): {
  hitRate: number;
  evidenceRecall: number;
  allEvidenceRecall: number;
  precision: number;
  avgRetrieved: number;
} {
  let hits = 0;
  let evidenceHits = 0;
  let evidenceTotal = 0;
  let allEvidence = 0;
  let retrievedTotal = 0;
  for (const row of rows) {
    const expanded = transform(row.retrievedIds);
    const set = new Set(expanded);
    retrievedTotal += expanded.length;
    const found = row.relevantIds.filter((id) => set.has(id)).length;
    if (found > 0) hits += 1;
    evidenceHits += found;
    evidenceTotal += row.relevantIds.length;
    if (found === row.relevantIds.length) allEvidence += 1;
  }
  return {
    hitRate: hits / rows.length,
    evidenceRecall: evidenceHits / Math.max(1, evidenceTotal),
    allEvidenceRecall: allEvidence / rows.length,
    precision: evidenceHits / Math.max(1, retrievedTotal),
    avgRetrieved: retrievedTotal / rows.length,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function main(): void {
  const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
    perQuestion: PerQuestion[];
    timestamp: string;
  };
  const dataset = JSON.parse(
    readFileSync(DATASET, "utf8"),
  ) as DatasetConversation[];
  const index = indexTurns(dataset);
  const rows = artifact.perQuestion;

  const baseline = score(rows, index, (ids) => ids);
  const interior = score(rows, index, (ids) => mergeSpans(ids, index).flat());
  const neighbour1 = score(rows, index, (ids) =>
    expandNeighbours(ids, index, 1),
  );
  const neighbour2 = score(rows, index, (ids) =>
    expandNeighbours(ids, index, 2),
  );
  const top1 = score(rows, index, (ids) =>
    expandTopNeighbours(ids, index, 1, 1),
  );
  const top3 = score(rows, index, (ids) =>
    expandTopNeighbours(ids, index, 1, 3),
  );
  const top5 = score(rows, index, (ids) =>
    expandTopNeighbours(ids, index, 1, 5),
  );
  const spansOnly = score(rows, index, (ids) => {
    // Keep only the span itself (adjacent retrieved turns collapse to one
    // representative) — a size-controlled comparison to baseline.
    return mergeSpans(ids, index).map((span) => span[0]!);
  });

  const out = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    source: {
      retrievalArtifact: "scripts/bench-locomo-noapi-results.json",
      retrievalTimestamp: artifact.timestamp,
      dataset: "scripts/dataset/locomo/data/locomo10.json",
      questions: rows.length,
    },
    method:
      "Post-hoc re-scoring of the recorded top-10 lists. Spans merge adjacent retrieved turns; interior fills gaps inside a span; neighbour-N expands each retrieved turn by N turns in the same session. No re-retrieval.",
    arms: {
      baseline: {
        hitRate: round(baseline.hitRate),
        evidenceRecall: round(baseline.evidenceRecall),
        allEvidenceRecall: round(baseline.allEvidenceRecall),
        precision: round(baseline.precision),
        avgRetrieved: round(baseline.avgRetrieved),
      },
      spansOnly: {
        hitRate: round(spansOnly.hitRate),
        evidenceRecall: round(spansOnly.evidenceRecall),
        allEvidenceRecall: round(spansOnly.allEvidenceRecall),
        precision: round(spansOnly.precision),
        avgRetrieved: round(spansOnly.avgRetrieved),
      },
      interiorFill: {
        hitRate: round(interior.hitRate),
        evidenceRecall: round(interior.evidenceRecall),
        allEvidenceRecall: round(interior.allEvidenceRecall),
        precision: round(interior.precision),
        avgRetrieved: round(interior.avgRetrieved),
      },
      neighbour1: {
        hitRate: round(neighbour1.hitRate),
        evidenceRecall: round(neighbour1.evidenceRecall),
        allEvidenceRecall: round(neighbour1.allEvidenceRecall),
        precision: round(neighbour1.precision),
        avgRetrieved: round(neighbour1.avgRetrieved),
      },
      neighbour2: {
        hitRate: round(neighbour2.hitRate),
        evidenceRecall: round(neighbour2.evidenceRecall),
        allEvidenceRecall: round(neighbour2.allEvidenceRecall),
        precision: round(neighbour2.precision),
        avgRetrieved: round(neighbour2.avgRetrieved),
      },
      neighbour1Top1: {
        hitRate: round(top1.hitRate),
        evidenceRecall: round(top1.evidenceRecall),
        allEvidenceRecall: round(top1.allEvidenceRecall),
        precision: round(top1.precision),
        avgRetrieved: round(top1.avgRetrieved),
      },
      neighbour1Top3: {
        hitRate: round(top3.hitRate),
        evidenceRecall: round(top3.evidenceRecall),
        allEvidenceRecall: round(top3.allEvidenceRecall),
        precision: round(top3.precision),
        avgRetrieved: round(top3.avgRetrieved),
      },
      neighbour1Top5: {
        hitRate: round(top5.hitRate),
        evidenceRecall: round(top5.evidenceRecall),
        allEvidenceRecall: round(top5.allEvidenceRecall),
        precision: round(top5.precision),
        avgRetrieved: round(top5.avgRetrieved),
      },
    },
    note: "Expansion changes precision and the size of the injected set; compare hit-rate gains against the extra turns. Baseline is the checked-in bge-small run.",
  };

  writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");

  console.log("LoCoMo span aggregation (post-hoc, same retrieved lists)");
  console.log(
    "arm           hit@10   evidence  all-evidence  precision  avg turns",
  );
  for (const [name, arm] of Object.entries(out.arms)) {
    console.log(
      `${name.padEnd(13)} ${(arm.hitRate * 100).toFixed(1).padStart(6)}%  ${(arm.evidenceRecall * 100).toFixed(1).padStart(7)}%  ${(arm.allEvidenceRecall * 100).toFixed(1).padStart(11)}%  ${(arm.precision * 100).toFixed(1).padStart(8)}%  ${arm.avgRetrieved.toFixed(2).padStart(8)}`,
    );
  }
  console.log(`\nwrote ${OUT}`);
}

main();
