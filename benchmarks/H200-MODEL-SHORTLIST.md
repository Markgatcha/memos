# H200 model shortlist for MemOS retrieval benchmarks

Practical shortlist for running MemOS retrieval sweeps on a Modal H200
(141 GB HBM3e, $0.001261/s = **$4.54/hr**). Quality ranks are the late-October
2026 MTEB snapshot; ranks move, so treat them as a starting order, not gospel.

The goal here is not "biggest model that loads". It is the best quality per
dollar that still leaves enough VRAM for large batches and 8K-token inputs.

## VRAM rule of thumb

- bf16 weights: ~2 GB per billion parameters.
- Leave 20-40% on top for activations, KV/attention workspace, and the serving
  framework's CUDA graphs.
- An H200 fits every 8B model with room to spare. A 27B model fits but is a
  quality ceiling, not a default. A 70B embedder (140 GB of weights) does not
  fit with usable batch sizes.

## Embedding models

| Model | Params | Dims | Context | bf16 weights | License | Snapshot | Role |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Qwen3-Embedding-8B** | 7.6B | 4096 (MRL to 32) | 32K | ~15 GB | Apache 2.0 | MTEB Eng #5, Multi #4 | **Primary quality pick** |
| Qwen3-Embedding-4B | 4.0B | 2560 (MRL) | 32K | ~8 GB | Apache 2.0 | Eng #7, Multi #6 | Quality/cost middle |
| Qwen3-Embedding-0.6B | 0.6B | 1024 (MRL) | 32K | ~1.2 GB | Apache 2.0 | Eng #27, Multi #20 | Fast baseline / ablation |
| Octen-Embedding-8B | 7.6B | 4096 | 32K | ~15 GB | Apache 2.0 | RTEB #3, Multi #7 | Retrieval-specialist alternative |
| Nemotron-3-Embed-8B | 8B | 4096 | 32K | ~16 GB | OpenMDW-1.1 | RTEB #2 open | Retrieval-only alternative |
| harrier-oss-v1-27b | 27B | 5376 | 32K | ~54 GB | MIT | Multi #1 | Quality ceiling; expensive vectors |
| harrier-oss-v1-0.6b | 0.6B | 1024 | 32K | ~1.2 GB | MIT | Multi #10 | Strong small-model control |
| BGE-M3 | 568M | 1024 | 8K | ~1.1 GB | MIT | older, no current v2 rank | Dense+sparse+multi-vector baseline |
| EmbeddingGemma 2 | 270M text | 768 (MRL) | 8K | ~0.5 GB | Apache 2.0 + Gemma policy | Eng #59 | Edge / latency control only |

Notes:

- Qwen3-Embedding is instruction-aware: queries should carry a task
  instruction, documents should not. Keep the exact instruction fixed across
  every run or the A/B is meaningless.
- 4096-d vectors cost 16 KB each in float32. LoCoMo's ~20k utterances is
  ~320 MB; LongMemEval's per-question namespaces are much larger. Use MRL
  truncation (1024-2048) if the store size or scan time becomes a problem.
- harrier-oss-v1-27b fits (54 GB + activations) and tops the multilingual
  board, but 5376-d vectors plus 27B inference buy little on short English
  utterances. Keep it as a ceiling check, not a first run.
- Skip Jina's v5 embedding/reranker weights for this repo: CC BY-NC 4.0 is a
  licensing problem for a public open-source project.

## Rerankers

| Model | Params | Context | bf16 weights | License | BEIR nDCG@10 | Role |
| --- | --- | --- | --- | --- | --- | --- |
| **bge-reranker-v2-m3** | 568M | 8K | ~1.1 GB | MIT | ~71.5 | **Cheap baseline; TEI-ready** |
| **Qwen3-Reranker-4B** | 4B | 32K | ~8 GB | Apache 2.0 | ~75.2 | **Quality step-up** |
| Qwen3-Reranker-8B | 8B | 32K | ~16 GB | Apache 2.0 | ~77.0 | Max open quality; slowest |
| Qwen3-Reranker-0.6B | 0.6B | 32K | ~1.2 GB | Apache 2.0 | ~71.4 | Throughput control |
| bge-reranker-v2-gemma | 9B | 8K? | ~18 GB | MIT | ~73.7 | Alternative quality point |
| mxbai-rerank-large-v2 | ~1.5B | 8K? | ~3 GB | Apache 2.0 | n/r | Latency-sensitive alternative |
| jina-reranker-v3 | 0.6B | 131K | ~1.2 GB | CC BY-NC 4.0 | listwise, fast | Skip (license) |

Latency context from public L40S numbers: bge-reranker-v2-m3 is roughly
3-4x the throughput of Qwen3-Reranker-8B per pair. On an H200 with batched
requests the absolute numbers improve, but the ordering holds. Reranking
top-50 for ~2k LoCoMo questions is 100k pairs; budget accordingly.

## Recommended stacks

| Tier | Embedder | Reranker | VRAM | Why |
| --- | --- | --- | --- | --- |
| **First sweep** | Qwen3-Embedding-8B | bge-reranker-v2-m3 | ~16 GB | One strong, well-supported embedder plus a cheap reranker baseline; isolates the embedder gain |
| **Quality** | Qwen3-Embedding-8B | Qwen3-Reranker-4B | ~24 GB | Best quality-per-VRAM that is still Apache 2.0 and fits with batch 128 |
| **Ceiling** | harrier-oss-v1-27b | Qwen3-Reranker-8B | ~70 GB | Fits, but vector storage and latency make it a one-off check |
| **Throughput** | Qwen3-Embedding-0.6B | bge-reranker-v2-m3 | ~2.3 GB | Ablation control; tells you how much of the gain is "any real embedder" |

Do **not** run a 70B embedder: 140 GB of bf16 weights leaves no room for
activations at useful batch sizes.

## Serving on Modal

Use the Hopper TEI image for embeddings and the TEI-supported rerankers:

```text
ghcr.io/huggingface/text-embeddings-inference:hopper-1.9
```

- TEI 1.9 supports Qwen3-Embedding 0.6B/4B/8B, BGE-M3, and
  bge-reranker-v2-m3. One process per model.
- Qwen3-Reranker is a causal-LM scorer, not a sequence-classification head.
  TEI does not list it; serve it with vLLM:

```bash
vllm serve Qwen/Qwen3-Reranker-4B --task score \
  --hf_overrides '{"architectures":["Qwen3ForSequenceClassification"],"classifier_from_token":["no","yes"],"is_original_qwen3_reranker":true}'
```

- The harness already speaks both contracts: `--provider=openai-compatible`
  for `/v1/embeddings`, `--rerank-url` for `/rerank`. vLLM and TEI both expose
  the expected response shape (`results[].index`, `results[].relevance_score`).
- Keep one H200 per served model. Loading an 8B embedder and a 4B reranker in
  one container is possible, but Modal bills the whole container while either
  model is idle; scale-to-zero per phase is cheaper.
- Set the idle/scaledown window to a few seconds; the default 60 s keep-alive
  is billable. Do not use GPU fallbacks for published runs — a silent H100
  downgrade invalidates the hardware label.

## Cost sketch

At $4.54/hr:

| Work | Estimate |
| --- | --- |
| H200 cold start + 8B model load | ~1-2 min, ~$0.10 |
| Embed LoCoMo's ~20k utterances, 8B | ~1-3 min, ~$0.10-0.25 |
| Rerank 100k pairs, bge-reranker-v2-m3 | ~3-5 min, ~$0.25-0.40 |
| Rerank 100k pairs, Qwen3-Reranker-4B | ~8-15 min, ~$0.60-1.15 |
| 3 embedders x 3 runs + 2 rerankers x 3 runs | ~$10-15 |

That fits the $25 credit with room for mistakes, provided idle keep-alive is
short and runs write artifacts to a volume instead of being repeated.

## Harness changes that make this practical

The benchmark harness now supports the pieces a GPU sweep needs:

- `--embedding-cache=<path>`: SQLite vector cache keyed by provider, model,
  dimensions, endpoint, prefixes, role, and text. Warm runs do zero embedding
  calls.
- `--query-prewarm`: batch all question embeddings before retrieval. Opt-in
  because the published LoCoMo latency percentiles include cold query embed.
- `--embed-batch=N`, `--embed-concurrency=N`: raise the queue for TEI/vLLM.
  Defaults (4/16) are unchanged so published runs stay comparable.
- `--query-concurrency=N`: overlaps reranker HTTP calls during a sweep.
- `--wal`: WAL for the temp DB. Not used by published runs.
- `--valid-at=<epoch-ms|ISO>`: freezes relative-time anchoring.

Two correctness fixes landed with the speed work:

1. `createBenchMemos` was spreading `retrievalConfig()` after the embeddings
   block. Because `contextual` is always present, that replaced the whole
   embeddings config with `{ contextual: false }` and silently fell back to
   model2vec. Every `--provider` run in the LoCoMo/ConvoMem/vendor harnesses
   measured model2vec regardless of the flag. Fixed and covered by a test.
2. Random UUID node ids and `Date.now()` fallbacks for LoCoMo's
   `"1:56 pm on 8 May, 2023"` timestamps made identical runs rank ties
   differently. LoCoMo now uses `store({ id })` with the dataset's `dia_id`
   and a UTC timestamp parser; two identical runs now produce identical
   per-question IDs and metrics.

Measured locally with a mock OpenAI-compatible embedder adding 30 ms per
request, LoCoMo conversation 0 (419 utterances, 199 questions):

| Configuration | Total | Ingestion | Retrieved IDs vs baseline |
| --- | --- | --- | --- |
| Default path | 15.5 s | 4.8 s | — |
| Prewarm + batch 64 + cache, cold | 10.4 s | 2.3 s | identical |
| Same, warm cache | 15.8 s | 8.0 s | identical (619/619 cache hits) |

The cold run is the useful number: batching and query prewarm cut end-to-end
time by roughly a third with byte-identical results. The warm-cache run showed
no wall-clock win on this laptop because SQLite ingestion dominates once
embedding calls disappear; the win is that it issues zero GPU requests, so
retrieval/rerank ablations can run with the GPU off.

Published artifacts should be regenerated after the determinism fixes: the
headline model2vec LoCoMo row is still model2vec, but tie ordering and
timestamps are now stable, so exact per-question rows may move.
