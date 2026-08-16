# MemOS Retrieval Quality — Local Run

> Generated 2026-06-17T16:34:50.399Z on this machine. Re-run with `npx tsx scripts/bench-quality.ts`.

## Setup

- Provider: `bench-hash` (model: `bench-hash-v1`, 256-d)
- Dataset: 30 synthetic conversation memories, 19 ground-truth queries
- Wall time: 47 ms

## Aggregate

| Metric | Value |
|---|---|
| recall@5 | 47.4% |
| recall@10 | 78.9% |
| MRR | 0.309 |

## Per category

| Category | Queries | recall@10 | MRR |
|---|---|---|---|
| factual | 11 | 81.8% | 0.218 |
| preference | 5 | 80.0% | 0.472 |
| temporal | 2 | 50.0% | 0.500 |
| entity | 1 | 100.0% | 0.111 |

## Per query

| Query | Category | hit@5 | hit@10 | RR |
|---|---|---|---|---|
| where does the user live | factual | ✗ | ✗ | 0.000 |
| what color does the user like | preference | ✗ | ✓ | 0.111 |
| tell me about Pixel the corgi | entity | ✗ | ✓ | 0.111 |
| where does the user work and what industry | factual | ✗ | ✓ | 0.143 |
| when did the user start at their company | temporal | ✗ | ✗ | 0.000 |
| dark mode preference editor | preference | ✓ | ✓ | 1.000 |
| what extensions on vscode | factual | ✓ | ✓ | 0.250 |
| instrument hobby and how long | factual | ✓ | ✓ | 0.500 |
| coffee preference and brand | preference | ✓ | ✓ | 0.250 |
| exercise routine | factual | ✗ | ✗ | 0.000 |
| favorite podcast | preference | ✓ | ✓ | 1.000 |
| last vacation destination and when | temporal | ✓ | ✓ | 1.000 |
| partner and their job | factual | ✓ | ✓ | 0.333 |
| book author preferences | preference | ✗ | ✗ | 0.000 |
| siblings and where they live | factual | ✗ | ✓ | 0.125 |
| transportation method and bike | factual | ✓ | ✓ | 0.250 |
| allergies and health restrictions | factual | ✓ | ✓ | 0.500 |
| online games and skill level | factual | ✗ | ✓ | 0.167 |
| language study tool and duration | factual | ✗ | ✓ | 0.125 |

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