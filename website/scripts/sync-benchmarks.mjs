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
    source: file.startsWith("docs/") ? file : `scripts/${file}`,
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
const toon = await loadResult("bench-toon-results.json");
const haystack = await loadResult("bench-haystack-results.json");
const hotpot = await loadResult("bench-hotpot-results.json");
const qa = await (async () => {
  try {
    return JSON.parse(
      await readFile(
        path.join(repoRoot, "docs/artifacts/qa-glm-judge-50.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
})();
const convomem = await (async () => {
  try {
    return JSON.parse(
      await readFile(
        path.join(repoRoot, "docs/artifacts/convomem-525-retrieval.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
})();
// The LongMemEval artifact is committed under docs/artifacts rather than
// scripts/ so the generated-results ignore rule does not hide it.
const longmemeval = await (async () => {
  try {
    return JSON.parse(
      await readFile(
        path.join(
          repoRoot,
          "docs/artifacts/longmemeval-s-full-500-retrieval.json",
        ),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
})();
const spans = await (async () => {
  try {
    return JSON.parse(
      await readFile(
        path.join(repoRoot, "docs/artifacts/locomo-span-aggregation.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
})();
const qaArms = await (async () => {
  try {
    return JSON.parse(
      await readFile(
        path.join(repoRoot, "docs/artifacts/qa-arms-50.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
})();

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
    topK: beam?.topK ?? null,
    skippedAbstention: beam?.skippedAbstention ?? null,
    categories: beam?.categories ?? null,
  },
  toon: {
    ...provenance(toon, "bench-toon-results.json"),
    benchmark: toon?.benchmark ?? null,
    fixtures: toon?.fixtures ?? null,
    searchResults: toon?.searchResults ?? null,
    contextPack: toon?.contextPack ?? null,
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
  convomem: {
    ...provenance(convomem, "docs/artifacts/convomem-525-retrieval.json"),
    questions: convomem?.scoredQuestions ?? null,
    topK: convomem?.topK ?? null,
    at5: convomem?.metrics?.at5
      ? {
          hitRate: convomem.metrics.at5.hitRate,
          evidenceRecall: convomem.metrics.at5.evidenceRecall,
          allEvidenceRecall: convomem.metrics.at5.allEvidenceRecall,
          mrr: convomem.metrics.at5.mrr,
        }
      : null,
    at10: convomem?.metrics?.at10
      ? {
          hitRate: convomem.metrics.at10.hitRate,
          evidenceRecall: convomem.metrics.at10.evidenceRecall,
          allEvidenceRecall: convomem.metrics.at10.allEvidenceRecall,
          mrr: convomem.metrics.at10.mrr,
        }
      : null,
  },
  qa: {
    ...provenance(qa, "docs/artifacts/qa-glm-judge-50.json"),
    questions: qa?.questions ?? null,
    answerModel: qa?.llmJudge?.answerModel ?? null,
    judgeModel: qa?.llmJudge?.judgeModel ?? null,
    overall: qa?.llmJudge?.overall ?? null,
    overallCI: qa?.llmJudge?.overallCI ?? null,
    perCategory: qa?.llmJudge?.perCategoryCI ?? null,
    tokens: qa?.llmJudge?.usage?.totalTokens ?? null,
    calls: qa?.llmJudge?.usage?.calls ?? null,
    correctAnswers: qa?.llmJudge?.efficiency?.correctAnswers ?? null,
    tokensPerCorrectAnswer:
      qa?.llmJudge?.efficiency?.tokensPerCorrectAnswer ?? null,
  },
  longmemeval: {
    ...provenance(
      longmemeval,
      "docs/artifacts/longmemeval-s-full-500-retrieval.json",
    ),
    questions: longmemeval?.questions ?? null,
    topK: longmemeval?.topK ?? null,
    atK: longmemeval?.metrics?.atK
      ? {
          k: longmemeval.metrics.atKDepth,
          hitRate: longmemeval.metrics.atK.hitRate,
          evidenceRecall: longmemeval.metrics.atK.evidenceRecall,
          allEvidenceRecall: longmemeval.metrics.atK.allEvidenceRecall,
          mrr: longmemeval.metrics.atK.mrr,
          ndcg: longmemeval.metrics.atK.ndcg,
        }
      : null,
  },
  spans: {
    source: "docs/artifacts/locomo-span-aggregation.json",
    timestamp: spans?.timestamp ?? null,
    questions: spans?.source?.questions ?? null,
    method: spans?.method ?? null,
    arms: spans?.arms ?? null,
  },
  qaArms: {
    source: "docs/artifacts/qa-arms-50.json",
    timestamp: qaArms?.timestamp ?? null,
    note: qaArms?.note ?? null,
    questions: qaArms?.questions ?? null,
    arms: qaArms?.arms ?? null,
  },
};

const outDir = path.join(websiteDir, "data");
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "benchmarks.json"),
  JSON.stringify(out, null, 2) + "\n",
  "utf8",
);

const parts = [
  "locomo",
  "beam",
  "haystack",
  "hotpot",
  "convomem",
  "qa",
  "longmemeval",
  "toon",
  "spans",
  "qaArms",
].filter(
  (k) => out[k] && out[k].timestamp,
);
console.log(
  `sync-benchmarks: wrote data/benchmarks.json (${parts.length}/10 benchmarks with results: ${parts.join(", ")})`,
);
