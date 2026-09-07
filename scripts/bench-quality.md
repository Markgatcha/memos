# MemOS Retrieval Quality — Local Run

> Generated 2026-09-06T00:15:10.594Z on this machine. Re-run with `npx tsx scripts/bench-quality.ts`.

## Setup

- Provider: `openai-compatible` (model: `LFM2.5-Embedding-350M-BF16`, 1024-d)
- Dataset: 30 synthetic conversation memories, 19 ground-truth queries
- Wall time: 389 ms

## Aggregate

| Metric | Value |
|---|---|
| recall@5 | 100.0% |
| recall@10 | 100.0% |
| MRR | 0.934 |

## Per category

| Category | Queries | recall@10 | MRR |
|---|---|---|---|
| factual | 11 | 100.0% | 0.955 |
| preference | 5 | 100.0% | 0.850 |
| temporal | 2 | 100.0% | 1.000 |
| entity | 1 | 100.0% | 1.000 |

## Per query

| Query | Category | hit@5 | hit@10 | RR |
|---|---|---|---|---|
| where does the user live | factual | ✓ | ✓ | 1.000 |
| what color does the user like | preference | ✓ | ✓ | 1.000 |
| tell me about Pixel the corgi | entity | ✓ | ✓ | 1.000 |
| where does the user work and what industry | factual | ✓ | ✓ | 1.000 |
| when did the user start at their company | temporal | ✓ | ✓ | 1.000 |
| dark mode preference editor | preference | ✓ | ✓ | 1.000 |
| what extensions on vscode | factual | ✓ | ✓ | 1.000 |
| instrument hobby and how long | factual | ✓ | ✓ | 1.000 |
| coffee preference and brand | preference | ✓ | ✓ | 1.000 |
| exercise routine | factual | ✓ | ✓ | 1.000 |
| favorite podcast | preference | ✓ | ✓ | 1.000 |
| last vacation destination and when | temporal | ✓ | ✓ | 1.000 |
| partner and their job | factual | ✓ | ✓ | 1.000 |
| book author preferences | preference | ✓ | ✓ | 0.250 |
| siblings and where they live | factual | ✓ | ✓ | 0.500 |
| transportation method and bike | factual | ✓ | ✓ | 1.000 |
| allergies and health restrictions | factual | ✓ | ✓ | 1.000 |
| online games and skill level | factual | ✓ | ✓ | 1.000 |
| language study tool and duration | factual | ✓ | ✓ | 1.000 |

## How to compare against competitors

The public LoCoMo and LongMemEval datasets are gated behind
academic-license agreements. MemOS does not vendor them.
This synthetic harness reproduces the *shape* of the task
(long conversation broken into discrete facts, paraphrased
queries, expected top-k relevance) without using the
original data.

To compare against Zep/Graphiti/Mem0:

1. Note the local recall@10 and MRR above.
2. Look up the same metrics in their published LoCoMo and
   LongMemEval papers (see `docs/benchmark-comparison.md`).
3. Note that published numbers typically use a stronger
   embedding model than the local hash baseline. The
   *Voyage* and *Cohere* providers are wired to give you
   apples-to-apples numbers against the same commercial
   models the competitors use.