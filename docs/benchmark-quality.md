# MemOS Retrieval Quality Benchmark

> Methodology: evidence-ID matching (deterministic). Re-run with `npx tsx scripts/bench-quality.ts`.

## What this benchmark is — and is not

This is a **synthetic regression harness**, not a leaderboard number.
It measures that retrieval quality does not regress between builds, on a
small fixed dataset that ships in the repo. It is **not** comparable to
official LoCoMo or LongMemEval results and must never be cited as such.
(Priority for the honest comparison: `scripts/bench-locomo-noapi.ts` and
`scripts/bench-longmemeval.ts --retrieve-only`, which score by direct
evidence-ID matching against the official datasets.)

## Commands

```bash
# Synthetic smoke test (30 nodes / 19 queries, no network, ~50ms).
npm run bench:quality

# Same synthetic dataset, scored with the full shared metric set:
npx tsx scripts/bench-quality.ts
```

### Provider selection (shared across ALL benchmark scripts)

```bash
# Out-of-the-box provider (deterministic local hash, synonym lexicon):
npx tsx scripts/bench-quality.ts --provider=local-hash

# In-process model (requires installing an optional peer dep):
npm install @huggingface/transformers
npx tsx scripts/bench-quality.ts --provider=fastembed \
  --model=Xenova/gemma-300m-e5-it-v1 --dimensions=768 \
  --fail-on-embedding-fallback

# HTTP providers (API key required):
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=pa-... npx tsx scripts/bench-quality.ts
npx tsx scripts/bench-quality.ts --provider=ollama --base-url=http://127.0.0.1:11434
```

Flag precedence: **CLI > environment variables > default (`local-hash` for
the dataset benches; the synthetic smoke keeps its historical `bench-hash`
default when no provider is requested)**.

### `--fail-on-embedding-fallback` (strict benchmark mode)

`FastEmbedEmbeddingProvider` falls back to a deterministic local feature
hash when the transformers package is missing (resilient default for SDK
use). In benchmark mode this fallback is reported — and with this flag,
**fatal**: the run terminates with exit code 1 rather than silently
scoring a different backend. Every result JSON records:

- requested provider / resolved provider
- requested model / resolved model
- requested / observed dimensions
- fallback status + reason

## Metrics (v2 — deterministic, ID-based)

All metrics compare retrieved source IDs directly against ground-truth
evidence IDs. **No fuzzy text matching is used for scoring.**

| Metric | Definition |
|---|---|
| Hit@K | fraction of questions with ≥1 relevant item in top-K |
| Evidence Recall@K (per-Q) | mean over questions of (relevant retrieved in top-K / total relevant) |
| Evidence Recall@K (micro) | Σ relevant retrieved in top-K / Σ total relevant |
| All-Evidence Recall@K | fraction of questions where EVERY relevant item was in top-K |
| Precision@K (per-Q) | mean over questions of (relevant retrieved in top-K / K actually returned) |
| Precision@K (micro) | Σ relevant in top-K / Σ scored depth |
| MRR | mean reciprocal rank of the first relevant item |
| nDCG@K | discounted-cumulative-gain ranking quality (binary relevance) |

Conventions:

- A multi-evidence question is **not** complete when only one evidence
  item is retrieved — that's what All-Evidence Recall measures.
- Questions with an empty evidence list (LoCoMo has 4) are excluded from
  recall-family aggregates and never count as successes.
- Per-category rows are macro averages; the headline numbers are
  per-question means (micro variants are reported alongside).
- Latency p50/p95 use the nearest-rank percentile.

## Current synthetic baseline (local machine, deterministic)

| Metric | Value |
|---|---|
| recall@5 (= Hit@5) | 89.5% |
| recall@10 (= Hit@10) | 89.5% |
| MRR | 0.754 |

Historical note: an earlier commit of this file reported 100% recall via
the `--provider=local` (local-hash) provider. That provider ships a
manually curated synonym lexicon whose entries overlap with this
benchmark's queries (see the SYNONYMS table in `src/embeddings.ts`) —
a benchmark-leakage issue tracked separately. The synthetic harness
remains a regression gate, but the honest baseline for the *out-of-the-box*
provider on THIS dataset is the table above; the 100% figure should not
be read as generalization.

## Reproducibility metadata

Every result JSON (v2 schema) includes: schema version, timestamp, git
commit SHA + dirty flag, dataset name/path/SHA-256, provider + exact
model + fallback status + dimensions, Node version, OS, and benchmark
duration + latency percentiles.

## Where the numbers go

- `scripts/bench-quality-results.json` — synthetic smoke (this harness)
- `scripts/bench-locomo-noapi-results.json` — LoCoMo retrieval-only
- `scripts/bench-locomo-llmjudge-results.json` — LoCoMo LLM-judge (API tier)
- `scripts/bench-longmemeval-results.json` — LongMemEval (retrieval-only or LLM-judge)

Each benchmark writes its own file; none overwrite another.
