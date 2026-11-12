# LAFS harness

Measures the recall/latency frontier of budgeted retrieval instead of
reporting a single accuracy number.

```bash
node --import tsx scripts/bench-lafs.ts
node --import tsx scripts/bench-lafs.ts --budgets=5,25,50,100,250,0
node --import tsx scripts/bench-lafs.ts --json --out=scripts/eval/lafs-results.json
```

## Output

```text
LAFS harness — 24 queries / 36 facts · local-hash-384 · 3× · 11e6dfb

| budget | tier(s) | recall@5 | mrr | hit@1 | p50 ms | p95 ms | pipe p50 | tokens | degraded | frontier |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| 5ms | 0×72 | 0.9583 | 0.9722 | 0.958 | 1.64 | 2.62 | 1.69 | 114.4 | 100% | |
| 25ms | 0×72 | 0.9583 | 0.9722 | 0.958 | 1.50 | 3.07 | 1.54 | 114.4 | 100% | yes |
| 50ms | 1×72 | 0.9792 | 0.9722 | 0.958 | 3.68 | 6.95 | 3.88 | 166.4 | 100% | yes |
| 100ms | 2×72 | 0.9792 | 0.9722 | 0.958 | 3.76 | 5.69 | 3.95 | 165.7 | 100% | |
| 500ms | 3×72 | 0.9792 | 0.9722 | 0.958 | 3.81 | 6.41 | 3.97 | 165.7 | 0% | |
| none | 3×72 | 0.9792 | 0.9722 | 0.958 | 3.80 | 6.60 | 3.95 | 165.7 | 0% | |

Frontier area (AUF, log-latency): 0.9687
```

`×72` is 24 queries × 3 repeats. Each latency is the median over repeats.

## Reading it

- **Frontier** marks Pareto-optimal rows: no other budget has both higher
  recall and lower p50. A row without the mark is dominated — you are paying
  latency for nothing.
- **degraded** is the share of calls where the receipt reported any skipped
  stage or token cap. Tiers below 3 are `degraded` by definition, even when
  accuracy is unchanged.
- **pipe p50** is `receipt.elapsedMs` (pipeline only); **p50 ms** is
  wall-clock around `searchWithReceipt`, including call overhead.
- **AUF** is the normalized area under the frontier in log-latency space.
  It is this harness's summary, **not** the official LongMemEval-V2 LAFS
  metric.

In the run above the useful conclusion is: 97.9% recall is available at
50ms, and tiers 2-3 add cost without accuracy on this corpus. That is the
kind of decision a single "recall@5 0.9792" line cannot support.

## Methodology

- Corpus: `scripts/eval/corpus.json` (the committed 36-fact / 24-query
  golden set used by the retrieval regression eval).
- Embedder: `local-hash`, so runs are deterministic and offline. Swap in a
  real provider only if you change the baseline too.
- Store: throwaway SQLite file in a temp directory, rebuilt per run.
- Warmup: every query runs once unbudgeted before measurement, so the first
  call does not pay for lazy vector-cache population.
- Order: budgets are rotated per query and per repetition
  (`(queryIndex + offset + rep) % n`) so cache warmth is spread evenly
  instead of favouring whichever budget runs last.
- Repeats: each query/budget pair runs `--repeat` times (default 3);
  reported latencies are medians over the pooled samples.
- Cache: every call passes a budget object, including the "no budget" row
  (`budget: {}`). A budget object bypasses the query cache, so repeats
  measure retrieval instead of a cached array.
- Latency: `performance.now()` around the full `searchWithReceipt` call.

## Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--budgets=` | `5,25,50,100,250,500,0` | Comma-separated `maxMs` values; `0` = unbudgeted. |
| `--repeat=` | `3` | Repetitions per query/budget pair (1–20). |
| `--corpus=` | `scripts/eval/corpus.json` | Same `{facts, queries}` schema. |
| `--json` | off | Print the report as JSON. |
| `--out=` | none | Write the JSON report to a path. |
| `--help` | | Usage. |

## Using it for a real comparison

The golden corpus is small and saturates quickly — it verifies the harness
and catches regressions, but it is not a leaderboard. To compare against a
public benchmark, convert its queries into the same schema:

```json
{
  "facts": [{ "id": "f1", "content": "…" }],
  "queries": [{ "query": "…", "expects": ["f1"] }]
}
```

Then run with `--corpus=path/to/benchmark.json`. Keep the report JSON so
the frontier is reproducible and diffable between commits.

## Caveats

- `recall@5` on 24 queries moves in coarse steps; do not read 0.9583 vs
  0.9792 as a precise difference.
- `local-hash` embeddings are deterministic but weak; a real embedding
  provider will shift both accuracy and latency.
- Latency here is single-process warm; cold-start and disk contention are
  not modelled.
- A budget is a ceiling, not a delay: a 25ms row can measure faster than a
  5ms row because both may finish in ~1.5ms and the difference is noise.
  Compare recall at similar latency, not by budget label.
