// Normalize the repo's checked-in benchmark result JSONs into
// website/data/benchmarks.json — the single source the benchmarks page
// imports at build time.
//
// Run from the repo root (or anywhere): node website/scripts/sync-benchmarks.mjs
// The site never hardcodes result numbers it can prove: every metric below
// carries the source file, run timestamp, commit, and environment it came
// from, so the page's "verified runs" table regenerates whenever a benchmark
// script re-runs and commits new results.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(websiteDir, "..");
const scriptsDir = path.join(repoRoot, "scripts");

async function loadResult(file) {
  try {
    return JSON.parse(await readFile(path.join(scriptsDir, file), "utf8"));
  } catch {
    return null;
  }
}

function provenance(result, file) {
  if (!result) return null;
  return {
    source: `scripts/${file}`,
    timestamp: result.timestamp ?? null,
    gitSha: result.git?.sha ?? null,
    gitDirty: result.git?.dirty ?? null,
    os: result.os ? `${result.os.platform} ${result.os.release ?? ""}`.trim() : null,
    node: result.nodeVersion ?? null,
    model: result.embedding?.resolvedModel ?? null,
    dataset: result.dataset?.name ?? result.benchmark ?? null,
  };
}

const locomo = await loadResult("bench-locomo-noapi-results.json");
const beam = await loadResult("bench-beam-results-lfm2.5-350m.json");
const haystack = await loadResult("bench-haystack-results.json");
const hotpot = await loadResult("bench-hotpot-results.json");

const out = {
  generatedAt: new Date().toISOString(),
  locomo: {
    ...provenance(locomo, "bench-locomo-noapi-results.json"),
    questions: locomo?.questions ?? null,
    topK: locomo?.topK ?? null,
    at5: locomo?.metrics?.at5
      ? {
          hitRate: locomo.metrics.at5.hitRate,
          evidenceRecall: locomo.metrics.at5.evidenceRecall,
          mrr: locomo.metrics.at5.mrr,
          ndcg: locomo.metrics.at5.ndcg,
        }
      : null,
    at10: locomo?.metrics?.at10
      ? {
          hitRate: locomo.metrics.at10.hitRate,
          evidenceRecall: locomo.metrics.at10.evidenceRecall,
          allEvidenceRecall: locomo.metrics.at10.allEvidenceRecall,
          mrr: locomo.metrics.at10.mrr,
          ndcg: locomo.metrics.at10.ndcg,
        }
      : null,
  },
  beam: {
    ...provenance(beam, "bench-beam-results-lfm2.5-350m.json"),
    benchmark: beam?.benchmark ?? null,
    questions: beam?.questions ?? null,
    overallRecall: beam?.overallRecall ?? null,
    p50LatencyMs: beam?.p50LatencyMs ?? null,
  },
  haystack: {
    ...provenance(haystack, "bench-haystack-results.json"),
    benchmark: haystack?.benchmark ?? null,
    needleCount: haystack?.needleCount ?? null,
  },
  hotpot: {
    ...provenance(hotpot, "bench-hotpot-results.json"),
    questions: hotpot?.questions ?? null,
    topK: hotpot?.topK ?? null,
    at10: hotpot?.metrics?.at10
      ? {
          hitRate: hotpot.metrics.at10.hitRate,
          evidenceRecall: hotpot.metrics.at10.evidenceRecall,
          mrr: hotpot.metrics.at10.mrr,
          ndcg: hotpot.metrics.at10.ndcg,
        }
      : null,
  },
};

const outDir = path.join(websiteDir, "data");
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "benchmarks.json"),
  JSON.stringify(out, null, 2) + "\n",
  "utf8",
);

const parts = ["locomo", "beam", "haystack", "hotpot"].filter(
  (k) => out[k] && out[k].timestamp,
);
console.log(
  `sync-benchmarks: wrote data/benchmarks.json (${parts.length}/4 benchmarks with results: ${parts.join(", ")})`,
);
