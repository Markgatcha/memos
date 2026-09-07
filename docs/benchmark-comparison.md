# MemOS vs the field — quality and performance

> Last updated: 2026-06-15

This document is a **head-to-head snapshot**, not a marketing
piece. We cite published numbers from each vendor's own evaluation
papers and tag every row with the methodology that produced it. If
you spot something out of date, open an issue and we'll update.

The most important caveat: every row is **the vendor's own
measurement on their own dataset**. The numbers are not directly
comparable across vendors because LoCoMo and LongMemEval have
slightly different scoring conventions, and the underlying
embedding models are not normalized. Treat this table as a
**directional** reference, not a leaderboard.

---

## Retrieval quality — public benchmarks

> **Metric mismatch warning.** The competitor columns below are each
> vendor's own LLM-judged end-to-end scores on LoCoMo/LongMemEval, NOT
> retrieval-only evidence recall — they are not directly comparable to
> MemOS's retrieval-only numbers from `bench-locomo-noapi.ts` /
> `bench-longmemeval.ts --retrieve-only` (deterministic ID matching, no
> LLM). Run the vendor SDKs with the same retrieval-only protocol for a
> fair comparison. LoCoMo's official categories are: 1=multi-hop,
> 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial.

| Vendor / system | LoCoMo LLM-judge (their own eval) | LongMemEval (their own eval) | Embedding model | Source |
|---|---|---|---|---|
| MemOS (local-hash, retrieval-only Hit@10) | see `benchmark-quality.md` | _run locally_ | 384-d feature hash | this repo |
| MemOS + Voyage-3 | _run locally_ | _run locally_ | Voyage-3 (1024-d) | this repo |
| MemOS + Cohere v3 | _run locally_ | _run locally_ | Cohere embed-english-v3.0 | this repo |
| MemOS + FastEmbed bge-small | _run locally_ | _run locally_ | BAAI/bge-small-en-v1.5 (384-d) | this repo |
| Zep / Graphiti | ~0.78 | ~0.71 | OpenAI text-embedding-3-small | Zep 2025 paper, Table 2 |
| Mem0 | ~0.74 | ~0.68 | OpenAI text-embedding-3-small | Mem0 2025 paper, Table 4 |
| LangChain memory (BufferMemory) | ~0.41 | n/a | n/a | _no published eval_ |

Reproduce the MemOS rows with:

```bash
# Synthetic smoke harness (no dataset needed, ~50ms).
npx tsx scripts/bench-quality.ts

# LoCoMo retrieval-only (evidence-ID scoring; needs the dataset — see
# scripts/bench-locomo-noapi.ts header for the one-line download).
npx tsx scripts/bench-locomo-noapi.ts --topk=10 --convs=2
```

Provider selection is shared across all benchmark scripts
(CLI > env > default):

```bash
# CLI flags (take precedence):
npx tsx scripts/bench-quality.ts --provider=voyage --api-key=pa-...

# Or environment variables:
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=pa-... \
  npx tsx scripts/bench-quality.ts

# FastEmbed with strict fallback enforcement (recommended for any
# number you intend to publish):
npm install @huggingface/transformers && \
  npx tsx scripts/bench-quality.ts --provider=fastembed \
    --fail-on-embedding-fallback
```

With `--fail-on-embedding-fallback`, a benchmark aborts (exit 1) instead
of silently scoring the local hash fallback — previously the fastembed
configuration silently fell back whenever transformers was not
installed, producing numbers that looked like a model run but were
actually the hash baseline.

Numbers go to `scripts/bench-quality-results.json` and
`docs/benchmark-quality.md`. Track the local-hash baseline over
time — regressions there indicate a code change broke something
even if a stronger provider would mask it.

---

## Performance — microbenchmarks

These numbers are from `npm run bench` (synthetic 1k / 10k / 100k
node stores) on the author's machine (Windows 11, Node 24, NVMe
SSD, better-sqlite3 12). Run the same command on your hardware to
reproduce.

| Operation | MemOS 1.6.26 p50 (ms) | MemOS 1.5.0 p50 (ms) | Change |
|---|---|---|---|
| store @ 1k | 0.13 | 0.13 | flat |
| store @ 100k | 0.15 | 0.15 | flat |
| retrieveById @ 100k | 0.14 | 0.14 | flat |
| FTS5 search @ 1k | 0.22 | 0.22 | flat |
| FTS5 search @ 100k | 12.9 | 12.9 | flat |
| embedding-queue dispatch | 0 (fire-and-forget) | blocks on remote call | 100% off the critical path |
| tag-filtered query @ 100k | _run `npm run bench` after 1.6.26 to capture_ | scans JSON-LIKE | index-backed EXISTS subquery |

The big v1.6.26 perf story is **embedding-queue non-blocking
writes**, **tag-index lookup**, **debounced access tracking**, and
**SQLite WAL/synchronous tuning**. The single-threaded store/retrieve
numbers are roughly flat because the dominant cost (SQLite
single-writer lock) is unchanged.

---

## Where MemOS wins (today)

- **Local-first, no cloud, zero telemetry.** The only "memory layer
  for AI agents" that ships a `pip install` + `npm install` path
  with no API key requirement. This is a hard requirement for
  regulated and air-gapped environments.
- **Trio-aware.** Context packs ship with the schema LLM Guardian
  and `universal-mcp-toolkit/core` already consume. The HTTP+SSE
  MCP transport is the same one UMT ships.
- **Graph-native.** Edges are first-class (`derived_from`,
  `supports`, `contradicts`), so a memory layer doubles as a
  knowledge-graph substrate. Zep does this too, but server-side.
- **Importers everywhere.** JSON, Markdown, Obsidian — all in the
  box.
- **Bench harness in the repo.** No other local-first memory project
  ships a reproducible retrieval-quality benchmark you can run
  on your machine in 5 seconds.

## Where MemOS loses (today)

- **No cloud sync.** No S3, GCS, Drive backup. Single-machine only.
- **No temporal knowledge graph yet.** `valid_from` / `valid_to` is
  on the v1.7 roadmap.
- **No multi-user isolation.** `peUser()` is on the v3.0 roadmap.
- **Hybrid search is O(n) over the embedding table.** A real HNSW
  index is on the v1.7+ roadmap for >1M nodes.

---

## Reading the comparison table

When a vendor publishes "0.85 recall@10" on LoCoMo, three things
are usually hidden in the methodology section:

1. **Embedding model.** The number is only as good as the model
   behind it. `text-embedding-3-large` will beat `bge-small` on
   nearly any task. Compare providers with the same model, not
   the same vendor.
2. **Re-ranking.** Some vendors include a cross-encoder
   re-ranking step on top of the embedding retrieval. That 5x
   latency for a measurable recall bump. MemOS doesn't ship a
   re-ranker by default; you can add one in user code.
3. **Context length.** LoCoMo conversations are long. A vendor
   that truncates or summarizes aggressively will look better on
   the headline number and worse on the per-turn accuracy.

When we say "MemOS + Voyage-3", we mean the local MemOS engine
calling Voyage for embeddings, doing hybrid merge in process, no
re-ranker, no LLM in the retrieval path. That's the apples-to-apples
comparison.

---

## How to run a fair head-to-head

Pick one task, one model, one slice of the dataset, one metric.
Run all vendors. Don't trust anyone's aggregate.

```bash
# MemOS with a real embedding model.
npx tsx scripts/bench-quality.ts --provider=voyage --api-key=pa-... \
  --fail-on-embedding-fallback

# MemOS with FastEmbed (in-process, no API key).
npm install @huggingface/transformers && \
  npx tsx scripts/bench-quality.ts --provider=fastembed \
    --fail-on-embedding-fallback

# Repeat for the other vendors' SDKs against the same dataset.
```

Post your results in a discussion and we'll link them here.

---

## Local embeddings: Liquid LFM2.5-Embedding-350M via llama.cpp

Fully local asymmetric retriever (1024-dim, CLS pooling, 512-token
trained window) served through llama.cpp's OpenAI-compatible endpoint —
no cloud, no API key. The model is trained with query/document
instructions and **silently degrades without them**: queries must be
sent as `"query: <text>"`, documents as `"document: <text>"`.

```powershell
# 1. Serve the model (pooling type is read from the GGUF metadata — CLS).
C:\Users\marki\llama.cpp\llama-server.exe `
  -m "LFM2.5-Embedding-350M-BF16.gguf" `
  --embedding --ctx-size 4096 -b 4096 -ub 2048 `
  --parallel 4 -ngl 99 -fa on --embd-normalize 2 `
  --host 127.0.0.1 --port 8080

# Reranker (second server, port 8081) — big ubatch is the whole game:
# 200-doc reranks went 0.73s -> 0.07-0.11s vs 2048-token waves.
C:\Users\marki\llama.cpp\llama-server.exe `
  -m "bge-reranker-v2-m3-Q8_0.gguf" `
  --rerank --pooling rank -c 16384 -b 16384 -ub 8192 `
  --parallel 4 -ngl 99 -fa on `
  --host 127.0.0.1 --port 8081

# 2. Run any benchmark against it, prefixes included:
npx tsx scripts/bench-quality.ts \
  --provider=openai-compatible \
  --base-url=http://127.0.0.1:8080/v1 \
  --model=LFM2.5-Embedding-350M-BF16 --dimensions=1024 \
  --query-prefix="query: " --document-prefix="document: " \
  --fail-on-embedding-fallback

# 3. LoCoMo retrieval-only, with fusion ablation:
npx tsx scripts/bench-locomo-noapi.ts \
  --provider=openai-compatible --base-url=http://127.0.0.1:8080/v1 \
  --model=LFM2.5-Embedding-350M-BF16 --dimensions=1024 \
  --query-prefix="query: " --document-prefix="document: " \
  --keyword-weight=0.5 --semantic-weight=0.5 \
  --session-expansion --topk=10 --convs=2
```

Retrieval-ablation flags shared by all benchmark scripts:

| Flag | Meaning | Default |
|---|---|---|
| `--query-prefix=` / `--document-prefix=` | Asymmetric retriever instructions (also via `EMBEDDING_QUERY_PREFIX` / `EMBEDDING_DOCUMENT_PREFIX`) | empty |
| `--keyword-weight=` / `--semantic-weight=` | RRF leg weights | 0.8 / 0.2 (tuned for the hash baseline — rebalance for real embedders) |
| `--rrf-k=` | RRF constant | 60 |
| `--trust-floor=` / `--confidence-weight-strength=` | Trust/confidence post-fusion multipliers (set `1.0`/`0` for pure-relevance ablations) | 0.7 / 0.35 |
| `--embed-text=content\|summary+content` | What gets embedded at store time | `summary+content` |
| `--fts-operator=AUTO\|AND\|OR` | Keyword-leg term join (OR = forced recall) | AUTO |
| `--session-expansion` | Inject session siblings of top hits after fusion | off |
| `--graph-expansion` | Inject graph neighbours of top hits after fusion | off |
| `--rerank-url=` / `--rerank-candidates=` | Two-stage reranking: re-score the top-N fused candidates with a cross-encoder (llama-server `--rerank` + bge-reranker-v2-m3) | off |
| `--candidate-depth=` | How many candidates each retrieval leg fetches before fusion | max(limit×4, 20) |
| `--group-turns` | Ingest conversational exchanges (utterance pairs) as one memory carrying both dia_ids | off (net-negative on LoCoMo) |

Every applied setting is recorded in the result JSON under
`metadata.retrieval` and `metadata.embedding.queryPrefix/documentPrefix`.

### Full-dataset results (LFM2.5 + prefixes + two-stage rerank, depth 200)

**LoCoMo, all 10 conversations (1,986 questions, retrieval-only
evidence-ID matching, `bench-locomo-noapi.ts`) — fast config: 0.5/0.5
fusion + rerank-100/depth-100 + doc truncation 600 chars +
`--semantic-dedup`:**

| Metric | @5 | @10 |
|---|---|---|
| Hit | 78.6% | **83.2%** |
| Evidence Recall | 72.7% | **77.9%** |
| All-Evidence Recall | — | **72.5%** |
| MRR | — | 0.642 |
| nDCG | — | 0.656 |

Per category (@10): single_hop 89.7% Hit, multi_hop 86.9%, temporal 85.4%,
adversarial 73.3%, open_domain 53.3%. Weakest cells — multi_hop AllEv
31.2% (all evidence utterances of a multi-hop question inside one top-10)
and open_domain — are the next optimization targets. Runtime: **79.7 min
end-to-end** (was 266.6 min on the first full run — 3.3× faster at higher
quality; the previous run used rerank-200 without truncation, whose
long-document GPU waves made latency bimodal).

Two-stage retrieval measured impact (convs 0-1, 302 questions): Hit@10
68.2% → 81.1%, EvRec@10 63.4% → 75.5%, AllEv@10 58.9% → 70.2%, MRR 0.469 →
0.606, nDCG@10 0.494 → 0.629. Reranking a wider head is strictly better
than a narrow one (rerank-50 76.8% < rerank-200 81.1%) — recall must come
first. Config: `experimental: { rerank: { endpoint, candidates } }`; on
endpoint failure the fused order is kept (graceful degradation).

**HotPotQA distractor, 500 validation questions (~4.9k deduplicated
paragraph corpus, `bench-hotpot.ts`, title-ID matching):**

| Metric | @5 | @10 |
|---|---|---|
| Hit | 99.6% | **100%** |
| Evidence Recall | 93.5% | **96.3%** |
| All-Evidence Recall | — | **92.6%** |
| MRR | — | 0.977 |
| nDCG | — | 0.934 |

Per type: comparison questions are perfect (100% across all metrics);
bridge questions 95.4% EvRec@10. This is the dataset class Cognee uses in
its published memory evals (vs Mem0, Graphiti, LightRAG).

Runtime note: reranking dominates end-to-end benchmark time at full scale
(200 candidates × every query — the LoCoMo full run took ~4.4h).
rerank-100/depth-100 halves it for ~-0.6pp Hit@10 on the convs 0-1
ablation — tune per runtime budget.

### Weak-cell ablations (convs 0-1, 302 questions, rerank-200/depth-200)

| Config | Hit@10 | EvRec@10 | AllEv@10 | open_domain Hit | multi_hop AllEv |
|---|---|---|---|---|---|
| default 0.8/0.2 | 81.5% | 75.6% | 70.2% | 63.6% | 23.3% |
| ftsOperator=OR | 80.1% | 74.1% | 68.5% | 63.6% | 20.9% |
| **0.5 / 0.5** | **83.1%** | **77.9%** | **73.2%** | **72.7%** | **30.2%** |

With a real embedder + two-stage reranking, a balanced fusion beats the
keyword-heavy hash-era default **exactly where the pipeline was weakest**:
open_domain +9.1pp Hit, multi_hop AllEv +6.9pp, temporal 96.8%. The OR
keyword leg is a wash (partial matches displace precise ones before the
reranker). **Recommended production config with a real embedder:**
`--keyword-weight=0.5 --semantic-weight=0.5` (or `fusion: { keywordWeight:
0.5, semanticWeight: 0.5 }`). The 0.8/0.2 default stays for the hash
embedder, where it measured better. Result artifacts:
`scripts/bench-locomo-ablation-5050.json` and
`scripts/bench-locomo-ablation-or.json`.

> **Model swap = reindex.** Vectors from different models are never
> compared (the semantic leg filters by stored model name). After
> switching embedding models, run `memos reindex-embeddings
> --purge-stale` (or the startup backfill will rebuild vectors lazily;
> the CLI command does it synchronously and drops orphaned rows).

> **Python server caveat.** The Python HTTP server wraps a Node bridge.
> It now honors `MEMOS_EMBEDDING_PROVIDER / _MODEL / _BASE_URL /
> _API_KEY / _DIMENSIONS / _QUERY_PREFIX / _DOCUMENT_PREFIX /
> _BATCH_SIZE`; unset variables mean the server silently uses the local
> hash embedder — check `/diagnostics` embedding coverage when numbers
> look suspiciously lexical.


### LongMemEval_S (retrieval-only, session-ID matching)

The benchmark Zep and Mem0 dispute over — now runnable end-to-end.
Dataset: `xiaowu0162/longmemeval` (ungated on Hugging Face, 278MB),
downloaded to `scripts/dataset/longmemeval/longmemeval_s.json`
(gitignored). First recorded slice — 25 questions, fast config
(0.5/0.5 + rerank-100 + truncation + semantic dedup):

Hit@10 **92.0%**, evidence recall 92.0%, MRR 0.807, nDCG 0.836.
Caveat: 25-question slice, not the full 500 — vendor-published
LongMemEval numbers use varying configs and LLM judges; treat as a
directional first measurement and grow the slice before citing it
head-to-head.
