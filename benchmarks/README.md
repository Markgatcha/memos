# Benchmarks

Retrieval benchmarks for MemOS that need **no reader model and no LLM judge**.
They run the shipped SDK and score evidence IDs directly, so a number here is
reproducible with one command and does not move when someone swaps a judge.

## Why retrieval-only

Vendor claims mix two metric families:

- **Retrieval**: Hit@k / evidence recall / P@1 over sessions or turns.
  Deterministic. Supermemory's 97% LongMemEval-S headline is this family.
- **End-to-end QA**: an answerer model plus an LLM judge. Same system has swung
  20+ points across judges and answerers, so cross-vendor QA rows are not
  comparable.

Everything here is the first kind.

## Metric definitions (read this before comparing)

LongMemEval's standard retrieval metric is binary per question. Three different
numbers get called "recall", so this repo reports all three explicitly:

| Name here | Definition | Also called |
| --- | --- | --- |
| **Hit@k** | 1 if **any** gold evidence item is in the top k | Recall@k (LongMemEval convention, Supermemory's 97%) |
| **Evidence recall@k** | fraction of gold items retrieved, averaged per question | fractional recall |
| **All-evidence recall@k** | 1 only if **every** gold item is retrieved | recall-all |

So "Hit@20" and "Recall@20" are the same number under the convention the
benchmark and vendors use. The other two are strictly harder. Our LongMemEval
row is 100% / 99.0% / 98.0% — the claim does not depend on which definition you
pick.

## Runners

| Benchmark | Command | Data |
| --- | --- | --- |
| LongMemEval-S | `npx tsx scripts/bench-longmemeval.ts --provider=model2vec --retrieve-only --topk=20 --dataset=<path>` | [longmemeval_s](https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s) |
| LoCoMo | `npx tsx scripts/bench-locomo-noapi.ts --provider=model2vec --topk=20 --convs=10 --dataset=<path>` | [locomo10.json](https://github.com/snap-research/locomo/blob/main/data/locomo10.json) |
| ConvoMem | `npx tsx scripts/bench-convomem.ts` | repo-local fixtures |
| BEAM | `npx tsx scripts/bench-beam.ts` | see script header |

`--provider=model2vec` is the SDK default (256-d, zero native dependencies).
Before this was added, the harness silently measured `local-hash`, which is not
what users get.

## Results

Measured 2026-10-30, `model2vec` / `potion-base-8M`, no reranker.

### Summary

| Benchmark | Metric | MemOS | Reference claim |
| --- | --- | --- | --- |
| LongMemEval-S (100 q, stratified) | Hit@20 | **100.0%** | Supermemory 97% Recall@20 (500 q, with aggregation) |
| | Evidence recall@20 | 99.0% | |
| | MRR | 0.873 | |
| ConvoMem (525 q sample) | Hit@10 | 89.4% | (no public comparable) |
| | Evidence recall@10 | 88.0% | |
| LoCoMo (1,986 q, all cats) | Hit@10 | 64.1% | Mem0/Zep publish LLM-judge QA, not retrieval |
| | Evidence recall@10 | 58.8% | |
| LoCoMo (1,536 q, cats 1–4) | Hit@10 | 62.7% | |
| | MRR | 0.43 | |

### LoCoMo (10 conversations, 1,986 questions, top-k 20)

All categories, including the adversarial set:

| Metric | @5 | @10 |
| --- | --- | --- |
| Hit rate | 55.5% | 64.1% |
| Evidence recall (per-question avg) | 50.8% | 58.8% |
| All-evidence recall | 47.2% | 54.6% |
| Precision | 11.6% | 6.9% |
| MRR | 0.418 | 0.430 |
| nDCG | 0.424 | 0.452 |

Per category at @10:

| Category | Qs | Hit@10 | Evidence recall@10 | All-evidence@10 | MRR |
| --- | --- | --- | --- | --- | --- |
| single-hop | 841 | 67.3% | 66.1% | 65.0% | 0.466 |
| multi-hop | 282 | 53.2% | 27.2% | 8.5% | 0.285 |
| temporal | 321 | 66.7% | 63.6% | 60.4% | 0.512 |
| open-domain | 92 | 35.9% | 26.9% | 19.6% | 0.202 |
| adversarial | 446 | 68.8% | 67.9% | 67.0% | 0.441 |

Convention (Mem0, Zep) excludes adversarial. Over categories 1–4 (1,536
questions) that is **Hit@10 62.7%, evidence recall@10 56.1%, all-evidence@10
51.0%**, MRR 0.427.

Query latency p50/p95: 179/295 ms.

### ConvoMem (525-question sample, 387 scored)

Sample: one file per evidence category (`--files-per-category=1`), 19,859
messages, top-k 20. 138 questions have no evidence messages and are excluded,
as the harness does.

| Metric | @10 |
| --- | --- |
| Hit rate | 89.4% |
| Evidence recall | 88.0% |
| All-evidence recall | 86.6% |
| MRR | 0.600 |

| Category | Qs | Hit@10 | Evidence recall@10 |
| --- | --- | --- | --- |
| abstention | 64 | 100.0% | 100.0% |
| assistant facts | 87 | 98.9% | 98.9% |
| user evidence | 58 | 98.3% | 98.3% |
| changing evidence | 77 | 92.2% | 85.1% |
| preference | 83 | 68.7% | 68.7% |
| implicit connection | 18 | 61.1% | 61.1% |

### LongMemEval-S (100-question stratified sample)

`--retrieve-only --fast-ingest --topk=20`, 100 stratified questions (the
harness's default sampling), session-level scoring against
`answer_session_ids`.

| Metric | @5 | @10 | @20 |
| --- | --- | --- | --- |
| Hit rate (any gold session) | 95.0% | 98.0% | **100.0%** |
| Evidence recall (per question) | 87.8% | 95.4% | 99.0% |
| Evidence recall (micro) | 86.4% | 95.5% | 99.0% |
| All-evidence recall | 79.0% | 93.0% | 98.0% |
| MRR | 0.868 | 0.872 | 0.873 |

Ingestion 18 min, query latency p50/p95 302/465 ms.

This is the row that maps to Supermemory's headline: they report **97%
Recall@20 with aggregation** on all 500 questions; we measure **100% Hit@20**
on a 100-question stratified sample. With 100/100 hits the 95% lower bound is
~96.3%, so the honest claim is "at or above their published depth, on a
sample, without their aggregation step". Run the full 500 to remove the
sampling caveat.

## End-to-end QA (self-judged and independent judge)

Retrieval says the right evidence came back. QA says a model could answer
from it. Two runs: one where the answerer judges itself, and one with an
independent judge (GLM-5.3). Neither is comparable to vendor numbers that
use gpt-4o/gpt-5, but agreement between them shows the score is not
judge-inflated.

| Setting | Value |
| --- | --- |
| Answer model | `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Judge model (self) | same (DeepSeek) |
| Judge model (independent) | `GLM-5.3` — also 78.0%, 90k tokens because answer calls were cached |
| Reasoning | `reasoning_effort: high` |
| Questions | 50 (stratified), top-k 10 |
| Tokens | 1.37M (first run); 90k (independent judge, cached answers) |
| Tokens per correct answer | **2,306** (89,925 tokens / 39 correct) |
| Responses cached | yes — re-runs make zero calls |

| Category | Accuracy | n |
| --- | --- | --- |
| temporal-reasoning | 100% | 14 |
| single-session-assistant | 100% | 5 |
| knowledge-update | 85.7% | 7 |
| single-session-user | 85.7% | 7 |
| multi-session | 57.1% | 14 |
| single-session-preference | 0% | 3 |
| **Overall** | **78.0% [66.0–88.0]** | 50 |

Reproduce:

```bash
export OPENAI_API_KEY=...            # river.ai key
export OPENAI_BASE_URL=https://api.river.ai/v1
export BENCH_ANSWER_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017
export BENCH_JUDGE_MODEL=deepseek-ai/DeepSeek-V4.1-Flash-1017  # self-judge
# or an independent judge:
export BENCH_JUDGE_MODEL=GLM-5.3
export BENCH_LLM_REASONING_EFFORT=high
export BENCH_LLM_MAX_TOKENS=4096
export BENCH_LLM_CACHE_DIR=.bench-llm-cache

npx tsx scripts/bench-longmemeval.ts --max-questions=50 --topk=10 \
  --dataset=/path/to/longmemeval_s
```

The cache is keyed by model, messages and sampling parameters, so a repeat run
is free and deterministic. Provider-side prompt caching is reported separately
in `usage.cachedTokens`.

## Floor and ceiling arms

One accuracy number is not interpretable without its brackets. The harness
supports three arms with the same answerer, judge, and question sample:

| Arm | Answerer / judge | Accuracy | Tokens | Tokens / correct |
| --- | --- | --- | --- | --- |
| Floor (`--arm=no-memory`) | deepseek-v4-flash:free / deepseek-v4.1-flash:free | 2.0% [0–6] | 18,280 | 18,280 |
| Memory (`--arm=memory`) | DeepSeek V4.1 Flash / GLM-5.3 | 78.0% [66–88] | 89,925 | 2,306 |
| Ceiling (`--arm=full-context`) | deepseek-v4-flash:free / deepseek-v4.1-flash:free | 16.0% [6–28] | 2,070,185 | 258,773 |

The floor and ceiling are same-model (0 errors); the memory row is the paid
pair. **Do not subtract the rows** — they bracket the problem, they are not a
controlled ablation. The free-tier same-model memory run hit its daily rate
limit after 9 calls, so it is not published. Artifact:
[`docs/artifacts/qa-arms-50.json`](../docs/artifacts/qa-arms-50.json).

The ceiling is the useful shock: feeding every haystack session only reaches
16% and costs 23× more tokens than the memory pack, on this answerer. That is
the case for retrieval, not a claim that MemOS is 62 points better than
full-context.

The floor is the model answering from general knowledge; the ceiling is every
haystack session stuffed into the prompt (truncated at `fullContextChars`).
Publish all three or the memory number has no scale. Reproduce:

```bash
npx tsx scripts/bench-longmemeval.ts --arm=no-memory --max-questions=50 \
  --sample=stratified --topk=10 --dataset=/path/to/longmemeval_s
npx tsx scripts/bench-longmemeval.ts --arm=full-context --max-questions=50 \
  --sample=stratified --topk=10 --dataset=/path/to/longmemeval_s
```

### Cost per correct answer

The run recorded 89,925 answer+judge tokens and 39 correct answers: **2,306
tokens per correct answer**. Cost is that figure times your blended token
price:

```
cost_per_correct = tokens_per_correct × price_per_token
```

At $1/1M tokens that is $0.0023; at $15/1M it is $0.0346. The token side is
measured; the price is whatever your provider charges. The benchmark page shows
a small rate table rather than pretending one price is universal.

### Preferences did not move the QA number

We added `capturePreferences` / `searchPreferences` (see
[`docs/preferences.md`](../docs/preferences.md)) and ran the 15-question
preference subset with and without it:

| Run | Accuracy |
| --- | --- |
| Baseline | 13.3% (2/15) |
| With preference capture | 13.3% (2/15) |

Capture engaged — 251 preference statements across 754 sessions — but did not
change the score. The reason is the category, not the feature: LongMemEval's
`single-session-preference` answers describe **how the assistant should phrase
its reply** ("suggest resources tailored to Premiere Pro, not general video
editing resources"), not a fact to retrieve. That is answer-style adaptation,
which a memory pool cannot supply. The feature stays because it is useful for
real assistants; it is not a LongMemEval lever.

## How this compares

Only rows with the same metric family, dataset, and cutoff belong in the same
table. Sources are linked inline; every competitor number is vendor- or
author-reported, not re-run here.

### LongMemEval-S retrieval, k=20 (any-hit)

| System | Hit@20 | Evidence recall@20 | All-evidence@20 | Notes |
| --- | --- | --- | --- | --- |
| MemOS | **100%** | **99.0%** | **98.0%** | 100-question stratified sample |
| BM25 (pgmnemo) | 99.6% | – | – | full 500, no embeddings |
| Lint-AI heuristic | 100% | 98.3% | – | full 500, no embeddings |
| ContextCore | 99.4% | 98.3% | 96.4% | full 500, nomic-embed 768d |
| Supermemory | 97% | – | – | full 500, with aggregation |
| wizeme | 93.2% (Any@3) | – | – | k=3, not comparable |

This benchmark is **saturated at k=20**: plain BM25 reaches 99.6%. Being at
100% on a 100-question sample is a solid sanity check, not a differentiator.
The interesting LongMemEval number in 2026 is end-to-end QA accuracy
(Mem0 94.4, Mastra 94.87, Hindsight 91.4–94.6, Supermemory 85.2, Zep 71.2),
which needs a judge and is not measured here.

### LoCoMo retrieval

| System | Metric | Value |
| --- | --- | --- |
| wizeme | Any@3 | 71.2% |
| wizeme | Any@15 | 86.4% |
| wizeme | All@3 | 60.7% |
| Nano-Memory (Contriever) | Recall@10 | 86.5% |
| Contriever | Recall@10 | 71.8% |
| **MemOS** | **Hit@10** | **64.1% all / 62.7% cats 1–4** |
| **MemOS** | **All-evidence@10** | **54.6% / 51.0%** |

We are **mid-pack on LoCoMo**, below plain Contriever. We tested whether the
embedder explains it by fixing FastEmbed (see below) and rerunning with
`BAAI/bge-small-en-v1.5`: **63.5% Hit@10 / 52.0% all-evidence@10 / MRR 0.427**
over categories 1–4, versus 62.7% / 51.0% / 0.427 with Model2Vec. A trained
embedder bought **less than one point**, so the gap is not embedding quality —
it is how we chunk and score multi-turn evidence.

### What we tried on the multi-turn gap

LoCoMo's weakest category is multi-hop: evidence recall@10 around 29%, even
though the right session is often retrieved. Four configurations, same data:

| Variant | Hit@10 | All-evidence@10 | MRR |
| --- | --- | --- | --- |
| Model2Vec, one node per turn (default) | 64.1% | 54.6% | 0.430 |
| bge-small-en-v1.5, one node per turn | 65.0% | 55.8% | 0.430 |
| adjacent-turn grouping (`--group-turns`) | 65.2% | 55.6% | 0.386 |
| contextual + previous-turn header (`--contextual --prev-context`) | **65.8%** | **56.6%** | **0.436** |

The best variant gains **+1.7pp** and costs nothing at query time (the header
is embedded at ingest). It is not the fix: multi-hop evidence recall stays
around 29%, so the remaining gap is evidence aggregation across turns, not the
embedder or the window size.

### Span aggregation: the missing step, measured post-hoc

`scripts/bench-locomo-spans.ts` re-scores the recorded top-10 lists without
re-retrieval. It merges adjacent retrieved turns into spans (interior fill) and
expands retrieved turns to their immediate neighbours. Same 1,986 questions:

| Arm | Hit@10 | Evidence | All-evidence | Precision | Avg turns |
| --- | --- | --- | --- | --- | --- |
| Baseline | 64.9% | 49.6% | 55.8% | 7.0% | 10.0 |
| Collapse adjacent hits | 30.1% | 22.6% | 23.6% | 5.8% | 5.5 |
| Merge + fill interior | 64.9% | 49.6% | 55.8% | 7.0% | 10.0 |
| Expand top-1 by ±1 | **70.4%** | **54.1%** | **61.1%** | **7.2%** | 10.7 |
| Expand top-3 by ±1 | 73.4% | 56.8% | 64.3% | 6.8% | 11.9 |
| Expand top-5 by ±1 | 75.0% | 58.7% | 66.0% | 6.2% | 13.5 |
| Expand all 10 by ±1 | 78.6% | 62.3% | 69.4% | 4.5% | 19.5 |
| Expand all 10 by ±2 | 82.1% | 66.2% | 72.8% | 3.4% | 27.5 |

Interior fill is a no-op because the top-10 hits are already contiguous.
Expanding just the best hit buys **+5.5pp Hit@10 for 0.7 extra turns** and
slightly improves precision; expanding everything buys +13.7pp but nearly
doubles the injected context. Top-1 expansion is the recommended default,
top-3 when the budget allows. Artifact:
[`docs/artifacts/locomo-span-aggregation.json`](../docs/artifacts/locomo-span-aggregation.json).

### ConvoMem

No aligned public retrieval numbers to compare against; Supermemory runs the
dataset but publishes an aggregate we cannot map to these metrics. Our row:
Hit@10 89.4%, evidence recall 88.0% on a 525-question sample.

### FastEmbed was broken

Every earlier FastEmbed run silently scored `local-hash`: the installed
`onnxruntime-node` (1.24.3, a stale hoisted copy) did not match the
`onnxruntime-node@1.30.0` that `@huggingface/transformers@4.3.0` requires, and
inference failed with `Tensor.location must be a string`.

Fix: pin `onnxruntime-node` to `1.31.1` in `pnpm-workspace.yaml` overrides.
Verified with a real embed (`384` non-zero dimensions, no fallback), then with
the LoCoMo run above.

## Caveats

- **Vendor numbers use different metrics.** Supermemory's 97% is Recall@20
  *with aggregation* on LongMemEval-S; Mem0/Zep LoCoMo numbers are LLM-judge QA
  accuracy. Only the LongMemEval-S row here is directly comparable to a
  published retrieval claim; the LoCoMo rows are retrieval, not QA.
- **LoCoMo's own answer key is imperfect** (an audit found ~6.4% wrong), and ten
  conversations is a small sample.
- **Embedding model matters.** Model2Vec is the default; Qwen3-Embedding-8B or
  fastembed should raise recall. The harness supports both
  (`--provider=fastembed`, `--provider=openai-compatible`).
- **No reranker**, matching SDK defaults.
