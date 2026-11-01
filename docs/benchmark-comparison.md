# MemOS vs the field — quality and performance

> Last updated: 2026-10-21

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
pnpm exec tsx scripts/bench-quality.ts

# LoCoMo retrieval-only (evidence-ID scoring; needs the dataset — see
# scripts/bench-locomo-noapi.ts header for the one-line download).
pnpm exec tsx scripts/bench-locomo-noapi.ts --topk=10 --convs=2
```

Provider selection is shared across all benchmark scripts
(CLI > env > default):

```bash
# CLI flags (take precedence):
pnpm exec tsx scripts/bench-quality.ts --provider=voyage --api-key=pa-...

# Or environment variables:
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=pa-... \
  pnpm exec tsx scripts/bench-quality.ts

# FastEmbed with strict fallback enforcement (recommended for any
# number you intend to publish):
pnpm add @huggingface/transformers && \
  pnpm exec tsx scripts/bench-quality.ts --provider=fastembed \
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

These numbers are from `pnpm bench` (synthetic 1k / 10k / 100k
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
| tag-filtered query @ 100k | _run `pnpm bench` after 1.6.26 to capture_ | scans JSON-LIKE | index-backed EXISTS subquery |

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

- **No always-on cloud sync.** Encrypted export/import exists
  (`memos sync`), but there is no S3/GCS/Drive daemon. Single-machine
  by default.
- **Node-level temporal validity, not full bitemporal edges.**
  `validFrom` / `validTo`, `searchTemporal`, and supersede history
  are shipped; independent edge-level validity windows are not.
- **Multi-scope isolation, not multi-tenant auth.** `user` / `agent` /
  `run` scopes are shipped; RBAC and authenticated multi-tenant access
  are still on the v3.0 roadmap.
- **Exact hybrid search is O(n) over the embedding table.**
  `semanticScan: "auto"` keeps exact scoring up to 20k candidate
  vectors and switches to the bounded `prefilter` above that.
  `semanticScan: "ann"` uses the optional `sqlite-vec` extension
  (per-model/prefix `vec0` tables, delete hooks, exact fallback);
  it still needs a million-node recall/latency benchmark.

---

### EmbeddingGemma-2 (2026-10-11) — measured, and NOT better on this slice

The EmbeddingGemma-2 text-only stack was run through the identical
protocol (LoCoMo convs 0-1, 302 questions, 0.5/0.5 fusion, depth 100,
no reranker). Same size class as the 300M (~310 MB @ Q8 — the official
ggml-org repo splits the model as text main file + `mmproj` for the
vision/audio towers, so the main GGUF IS the text-only 270M stack):

| Metric @10 | EmbeddingGemma-300M-Q8 | EmbeddingGemma-2-Q8 (text) | Δ |
|---|---|---|---|
| Hit | 66.9% | 62.9% | **−4.0pp** |
| Evidence recall | 61.5% | 58.4% | −3.1pp |
| All-evidence recall | 56.6% | 54.3% | −2.3pp |
| Precision | 6.9% | 6.5% | −0.4pp |
| MRR | 0.447 | 0.428 | −0.019 |
| nDCG | 0.475 | 0.452 | −0.023 |
| Ingestion time | 46s | 97s | 2.1× slower |

Per-cature deficit is concentrated in multi_hop (55.8 → 41.9 hit@10);
adversarial −2.8pp, single_hop −3.6pp, temporal/open_domain tied. A
semantic-discrimination probe (relevant-vs-irrelevant cosine margin on
3 hand-built pairs) shows eg2's embeddings separate ~half as strongly
under the same task prompts (+0.157 vs +0.284 mean margin) — the model
works, its cosine geometry is just flatter on conversational text.

**What this does and does not contradict.** Google reports EmbeddingGemma-2
+14% over EmbeddingGemma-1 on MTEB **(Code)** — a code-retrieval suite.
This is conversational evidence recall from long dialogues. "Retains
accuracy on multilingual text" (their words) is not "beats on memory
benchmarks". The default recommended embedder stays
**EmbeddingGemma-300M** until a task-family-matched win appears; a code
index benchmark (MTEB-Code-style, or the repo's own cross-repo bench)
is the right next experiment for eg2 — not LoCoMo.

Verified facts while measuring (both matter if you re-run):

- The GGUFs ship `pooling_type = 1` = **MEAN** in llama.cpp's enum
  (UNSPECIFIED −1, NONE 0, MEAN 1, CLS 2, LAST 3) — matches Google's
  `1_Pooling/config.json` (`"pooling_mode": "mean"`), so no override
  is needed. (An earlier note in this file suspected CLS pooling; that
  was a misread of the enum and is retracted.)
- **`gemma-embedding2` needs llama.cpp newer than b11433.** The rolling
  master builds (`ggml-org/llama.cpp` releases `b11559`, 2026-10-11)
  load it; v0.6.0 (2026-10-05) and the local `llama-cpp-latest` build
  do not (`unknown model architecture: 'gemma-embedding2'`).
- Both engines and unsloth/ggml-org conversions of eg2 are text-only
  at ~310 MB Q8 despite the "740M" headline — the towers live in the
  separate `mmproj-*.gguf`.

Serve it with:

```bash
llama-server -m embeddinggemma-2-Q8_0.gguf --embedding --ctx-size 4096 \
  -b 4096 -ub 2048 --parallel 4 -ngl 99 -fa on --embd-normalize 2 \
  --port 8082 --host 127.0.0.1
npx tsx scripts/bench-locomo-noapi.ts --convs=2 --topk=10 \
  --provider=openai-compatible --base-url=http://127.0.0.1:8082/v1 \
  --model=embeddinggemma-2-Q8_0 --dimensions=768 \
  '--query-prefix=task: search result | query: ' \
  '--document-prefix=title: none | text: ' \
  --keyword-weight=0.5 --semantic-weight=0.5 --candidate-depth=100
```

---

## First same-protocol run: MemOS vs Mem0 (2026-10-11)

Run through `scripts/bench-vendors.ts`, LoCoMo convs 0-1, 304 questions,
top-10, **identical protocol**: both engines ingest raw utterances
(Mem0 with `infer=False` — no LLM fact extraction), both embed with the
**same model** (Ollama `nomic-embed-text`), both score by evidence-ID.
Vendor LLM slot for mem0's write-time decision step: local llama.cpp
minicpm5 (Q5_K_M + DSpark draft) at `127.0.0.1:8081`.

**Headline (@10):** Hit 65.6% both · Evidence recall 60.6 vs 61.2 ·
All-evidence 56.3 vs 56.6 · Precision 6.9 vs 7.0 — a statistical tie,
with mem0 marginally ahead on the recall family.

**Where it actually separates** (per-category @10):

| Category | n | MemOS | Mem0 | Δ |
|---|---|---|---|---|
| adversarial | 71 | **62.0%** | 45.1% | +16.9pp MemOS |
| single_hop | 114 | 59.6% | **67.5%** | −7.9pp MemOS |
| multi_hop | 43 | 58.1% | **60.5%** | −2.4pp MemOS |
| open_domain | 11 | 54.5% | **63.6%** | −9.1pp MemOS |
| temporal | 63 | 87.3% | 88.9% | ~tie |

Read: MemOS's trust/provenance/quarantine machinery earns its keep on
the **adversarial** category (+16.9pp) — exactly the failure mode
memory layers get blamed for. Mem0's pure dense retrieval is ahead on
the straightforward categories with a weak embedder, where MemOS's
keyword-hybrid fusion (tuned 0.5/0.5) is carrying a weaker semantic
leg. **MRR/nDCG favor MemOS** (0.426/0.457 vs 0.414/0.450).

Caveats, stated up front: one slice (2 of 10 conversations), one
embedder, no reranker on either side (same-protocol forbids it),
n=11 for open_domain means that row is noise. The full matrix —
full 10 conversations, the EmbeddingGemma-300M stack, and the
reranker ablation — is Kaggle Phase A work (see `KAGGLE_PHASE_A.md`).
Artifact: `~/bv-memos-mem0.json` (gitignored results are not committed).

### Reproduce

```bash
# 1. minicpm5 as mem0's LLM slot (spec decoding, local):
llama-server -m MiniCPM5-2B-Q5_K_M.gguf --model-draft MiniCPM5-2B-DSpark-Q8_0.gguf \
  --spec-type draft-dspark --ctx-size 32768 --reasoning off --port 8081
# 2. embedder (Ollama): ollama pull nomic-embed-text
# 3. the run:
npx tsx scripts/bench-vendors.ts --engines=memos,mem0 --convs=2 --topk=10 \
  --provider=ollama --model=nomic-embed-text --base-url=http://127.0.0.1:11434 \
  --keyword-weight=0.5 --semantic-weight=0.5 \
  --vendor-llm=openai --vendor-llm-url=http://127.0.0.1:8081/v1 --vendor-llm-model=minicpm5
```

The bridge needs `pip install mem0ai chromadb ollama` (the managed venv
already has them). Two mem0-2.2.1 traps the bridge handles, worth
knowing if you debug it: the pydantic config key is **`embedder`**, not
`embeddings` (a wrong key is silently ignored and falls back to
mem0's OpenAI default), and `search()` rejects top-level `user_id` —
it must go under `filters={"user_id": ...}`.

---

## Embedding stack swap: EmbeddingGemma-300M vs LFM2.5-350M (measured 2026-10-11)

Same protocol for both stacks: LoCoMo convs 0-1, 302 questions,
retrieval-only evidence-ID matching, 0.5/0.5 fusion, candidate depth 100,
**no reranker**, asymmetric prefixes applied on both stacks
(`task: search result | query: ` / `title: none | text: ` for Gemma,
`query: ` / `document: ` for LFM2.5), local GPU.

| Metric @10 | LFM2.5-350M-BF16 (711 MB) | EmbeddingGemma-300M-Q8 (328 MB) | Δ |
|---|---|---|---|
| Hit | 57.9% | **66.9%** | +8.9pp |
| Evidence recall | 54.0% | **61.5%** | +7.5pp |
| All-evidence recall | 50.7% | **56.6%** | +6.0pp |
| Precision | 5.9% | **6.9%** | +1.0pp |
| MRR | 0.398 | **0.447** | +0.049 |
| nDCG | 0.421 | **0.475** | +0.054 |

EmbeddingGemma-300M runs on the existing llama.cpp build (arch
`gemma-embedding`); the newer **EmbeddingGemma-2** family (740M
multimodal, released 2026-10-06) is modular — 270M text/code, 440M
+vision, 570M +audio, 740M all — and needs either Ollama ≥ 0.40.3
(`ollama pull embeddinggemma-2:270m`) or a llama.cpp build newer than
b11433 (arch `gemma-embedding2`; the v0.6.0 release predates it).
See `docs/KAGGLE_PHASE_A.md` Step 3 for the exact serve commands.

### Precision knob matrix (EmbeddingGemma-300M-Q8, same protocol as above)

| Config | Hit@10 | EvRec@10 | Prec@10 |
|---|---|---|---|
| fused only | 66.9% | 61.5% | 6.9% |
| + MMR (λ 0.5) | 66.6% | 61.4% | 6.9% |
| + semantic dedup | 67.5% | 62.1% | 7.0% |
| + relevance gate (ratio 0.25) | 67.9% | 62.1% | 7.1% |

Post-hoc diversification is a wash on this corpus — precision is won
upstream of the gate (reranker + ingestion grooming). MMR stays in the
presets because its value case is paraphrase crowding in long
conversational streams, which utterance-level LoCoMo ingestion barely
exhibits. Discovered while measuring: **the trailing space of
`--query-prefix=` dies to shell word-splitting** — pass the flags
through a bash array (`EMB=(...)` + `"${EMB[@]}"`), never a string, or
the asymmetric retriever silently degrades and the number is garbage.

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

**`scripts/bench-vendors.ts` does exactly this.** It runs MemOS and
third-party memory SDKs through the identical LoCoMo retrieval-only
protocol — same utterances, same evidence IDs, same deterministic
scoring; the only variable is the engine:

```bash
# MemOS vs Mem0, BOTH on the same embedder (Ollama nomic-embed-text):
npx tsx scripts/bench-vendors.ts --engines=memos,mem0 --convs=2 \
  --provider=ollama --model=nomic-embed-text \
  --base-url=http://127.0.0.1:11434 \
  --vendor-embedder=ollama --vendor-model=nomic-embed-text

# MemOS only (the harness doubles as a second runner for the MemOS arm):
npx tsx scripts/bench-vendors.ts --engines=memos --convs=2
```

Fairness rules the harness enforces:

- **Raw ingestion on both sides** — Mem0 runs with `infer=False`, its
  LLM fact extractor stays off, so a vendor is measured on retrieval,
  not on its write-time extractor.
- **One embedder or a loud warning** — the embedding stack each engine
  actually used is recorded per engine, and a mismatch raises a
  comparability warning in the report and the JSON.
- **Skip, don't crash** — a vendor whose SDK or server is missing is
  reported as SKIPPED with the reason; the run continues and the
  artifact records why.

Mem0 needs `pip install mem0ai` (the bridge tries the managed venv
python first, then `python`/`python3`/`py`; override with
`--vendor-python=`). The chroma-local vector store is the default (no
server); `--vendor-store=qdrant` uses local-path mode.

Results land in `scripts/bench-vendors-results.json` with per-engine
metadata + metrics. Post your table in a discussion and we'll link it.

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
pnpm exec tsx scripts/bench-quality.ts \
  --provider=openai-compatible \
  --base-url=http://127.0.0.1:8080/v1 \
  --model=LFM2.5-Embedding-350M-BF16 --dimensions=1024 \
  --query-prefix="query: " --document-prefix="document: " \
  --fail-on-embedding-fallback

# 3. LoCoMo retrieval-only, with fusion ablation:
pnpm exec tsx scripts/bench-locomo-noapi.ts \
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
| `--session-expansion` / `--no-session-expansion` | Inject the chronological ±1/±2 neighbours of top hits after fusion | on (engine default) |
| `--graph-expansion` | Inject graph neighbours of top hits after fusion | off |
| `--rerank-url=` / `--rerank-candidates=` | Two-stage reranking: re-score the top-N fused candidates with a cross-encoder (llama-server `--rerank` + bge-reranker-v2-m3) | off |
| `--candidate-depth=` | How many candidates each retrieval leg fetches before fusion | max(limit×4, 20) |
| `--contextual` | Derive a `session · date · speaker` header from metadata and embed it with each node | off |
| `--prev-context` | Prepend the previous turn to the embedded text (caller-supplied `context`) | off |
| `--ingest-concurrency=` | Turns stored concurrently during setup; explicit `now` preserves chronology | 16 |
| `--contradiction-scan` | Run the per-write contradiction vector scan during setup | off |
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

### Session-neighbour expansion: ordering fix (convs 0-1, 304 questions)

Session expansion injects a seed's conversation neighbours after fusion.
It used to select them in storage order (newest first) and cap at ten,
which on a long conversation injects the session tail and can push the
adjacent answer out of the top-k. It now walks the session in
`createdAt` order and injects only the ±1 / ±2 neighbours
(`0.9x` / `0.75x` the seed, max six). Protocol: `nomic-embed-text` 768d
via Ollama, top-10, no reranker, everything else at defaults.

| Fusion | Metric | Before | After | Δ |
|---|---|---|---|---|
| 0.5 / 0.5 | Hit@10 | 69.2% | **72.2%** | +3.0pp |
| 0.5 / 0.5 | Evidence recall@10 | 64.2% | **67.3%** | +3.1pp |
| 0.5 / 0.5 | All-evidence recall@10 | 59.6% | **62.9%** | +3.3pp |
| 0.5 / 0.5 | MRR / nDCG@10 | 0.429 / 0.469 | **0.457 / 0.499** | +0.028 / +0.030 |
| 0.8 / 0.2 | Hit@10 | 63.6% | **66.9%** | +3.3pp |
| 0.8 / 0.2 | All-evidence recall@10 | 54.3% | **58.3%** | +4.0pp |

Single-hop Hit@10 moves 64.0% → 71.1% at 0.5/0.5: a question about what
someone said is usually answered by the turn immediately beside the one
that matched. Multi-hop all-evidence goes 2.3% → 7.0%. Temporal loses two
questions (90.5% → 87.3%) because the old tail-dump sometimes carried a
distant date; every other category gains. Reproduce with
`scripts/bench-locomo-noapi.ts --provider=ollama --model=nomic-embed-text
--dimensions=768 --convs=2 --topk=10 --keyword-weight=0.5
--semantic-weight=0.5`.

### Contextual retrieval: session header + previous turn

Two document-side context signals, both embedded but never returned:

1. `embeddings.contextual` (or `MEMOS_CONTEXTUAL=1`) derives
   `[session_2 · 7 May 2023 · Caroline]` from `metadata.sessionId`,
   `timestamp` and `speaker`.
2. `store({ context })` can carry the **previous turn**. The answer to
   "What are your summer plans?" is often "Researching adoption agencies" —
   the answer does not contain the question's words.

Same protocol as above (convs 0-1, 304 questions, `nomic-embed-text`, top-10,
no reranker). The first row is the pre-round baseline, the second adds
chronological session neighbours, the third adds both context signals:

| Pipeline | Hit@10 | EvRec@10 | AllEv@10 | MRR | nDCG@10 |
|---|---|---|---|---|---|
| baseline | 69.2% | 64.2% | 59.6% | 0.429 | 0.469 |
| + session neighbours | 72.2% | 67.3% | 62.9% | 0.457 | 0.499 |
| **+ header + previous turn** | **79.8%** (mean 78.4) | **75.9%** (mean 74.3) | **71.9%** (mean 70.4) | **0.476** | **0.534** |

Three consecutive runs: 78.1 / 77.2 / 79.8 Hit@10. The table reports the
best and the 3-run mean — a single run is not a precision instrument.

At the shipped 0.8/0.2 fusion the same stack is 69.9% Hit@10 / 61.6%
all-evidence (from 63.6% / 54.3%). Full 10-conversation set (1,982 questions,
no reranker): **73.5% Hit@10, 67.7% evidence recall, 63.0% all-evidence,
0.500 nDCG**, 281 s end-to-end after the ingestion speedups. Reproduce with:

```bash
npx tsx scripts/bench-locomo-noapi.ts --provider=ollama \
  --model=nomic-embed-text --dimensions=768 --convs=10 --topk=10 \
  --keyword-weight=0.5 --semantic-weight=0.5 \
  --contextual --prev-context --ingest-concurrency=16
```

`--ingest-concurrency` pipelines stores with explicit timestamps (chronology
preserved), and `--contradiction-scan` opts back into the per-write vector
scan that benchmark setup skips. The three flags only change setup speed and
the embedded text; retrieval math is unchanged.

> **Python server caveat.** The Python HTTP server wraps a Node bridge.
> It now honors `MEMOS_EMBEDDING_PROVIDER / _MODEL / _BASE_URL /
> _API_KEY / _DIMENSIONS / _QUERY_PREFIX / _DOCUMENT_PREFIX /
> _BATCH_SIZE`; unset variables mean the server silently uses the local
> hash embedder — check `/diagnostics` embedding coverage when numbers
> look suspiciously lexical.


### LongMemEval_S (retrieval-only, session-ID matching)

The benchmark Zep, Mem0 and Supermemory report on. Dataset:
`xiaowu0162/longmemeval` (ungated, 278MB), stored at
`scripts/dataset/longmemeval/longmemeval_s.json` (gitignored).

Supermemory's headline is **97% Recall@20 with aggregation**. Recall@20
means the labelled evidence session must appear in the first 20 retrieved
results; an item is one haystack session. MemOS uses the same unit (one
memory node per session, `sessionId` metadata), so the comparison is
like-for-like at the retrieval layer. The harness now reports metrics at
an arbitrary K (`metrics.atK`, `perCategoryAtK`) instead of only the
legacy @5/@10 columns.

Protocol: stratified 100 of 500 questions (deterministic selection across
all six categories), `nomic-embed-text` 768d, contextual session/date
header, 0.5/0.5 hybrid fusion, no reranker, top-20.

| Retrieval | Hit@20 | EvRec@20 | All-evidence@20 | MRR | nDCG@20 |
|---|---|---|---|---|---|
| BM25 only, OR terms | 100.0% | 96.8% | 93.0% | 0.872 | 0.881 |
| Hybrid, AUTO terms | **100.0%** | **97.6%** | **94.0%** | 0.901 | 0.898 |
| Hybrid, OR terms | 100.0% | 97.1% | 93.0% | **0.914** | **0.908** |

Per category at @20 (hybrid AUTO): every category is 100% Hit; the only
non-perfect evidence-recall cells are multi-session (95.6% evidence,
88.9% all-evidence) and temporal-reasoning (95.6% / 88.9%). Knowledge
update, single-session user/assistant and preference are all 100%.

**Full 500-question set** (same protocol; resumable ingestion):

| Retrieval | Hit@20 | EvRec@20 | AllEv@20 | MRR | nDCG@20 |
|---|---|---|---|---|---|
| Hybrid AUTO (full 500) | **99.4%** | **98.3%** | **96.4%** | **0.934** | **0.929** |

That is **+2.4pp Hit@20 and +1.3pp evidence recall over Supermemory's
published 97% overall Recall@20**, with the caveat that their "97%" is one
aggregated recall figure while this run reports hit and evidence recall
separately. Per category (ours Hit / evidence recall; Supermemory's
published row in the last column):

| Category | Ours @20 | Supermemory |
|---|---|---|
| Single-session user | 98.6% / 98.6% | 97% |
| Single-session assistant | 100% / 100% | 100% |
| Single-session preference | 96.7% / 96.7% | 95% |
| Knowledge update | 100% / 100% | 100% |
| Temporal reasoning | 99.2% / 97.2% | 95% |
| Multi-session | 100% / 97.9% | 96% |
| **Overall** | **99.4% / 98.3%** | **97%** |

All-evidence recall@20 is 96.4% — the stricter "every labelled evidence
session is in the top 20" metric. The residual misses are multi-session
and temporal questions where one of 2-6 evidence sessions lands just
outside the cut. Full-run artifacts: 23,882 session memories, 103 min
ingestion, and **~1 min retrieval** after the namespace-index fix (the
recorded run predates the fix and took ~11 min). Raw result JSON is
committed at `docs/artifacts/longmemeval-s-full-500-retrieval.json`.

Reproduce the full set with:

```bash
npx tsx scripts/bench-longmemeval.ts --provider=ollama \
  --model=nomic-embed-text --dimensions=768 \
  --topk=20 --retrieve-only --keyword-weight=0.5 --semantic-weight=0.5 \
  --contextual --ingest-concurrency=16 \
  --db=/tmp/lme-full.db --out=/tmp/lme-full.json
```

`--db` makes the run resumable: questions whose namespace is already
fully populated are skipped, so a killed 500-question run does not
re-embed 23k sessions. `--max-questions=100` reproduces the screening
sample above. The retrieval step now defaults session expansion off
(one node per session); `--session-expansion` turns it back on for
chunked ingestion.

**Speed after the index fix.** The semantic leg used to join every
embedding row and filter namespace afterwards: ~2.5 s per query on the
24k-node store. `idx_nodes_namespace` plus a two-step namespaced
candidate select drops the scan to ~6 ms and full search to ~80 ms.
Retrieval for all 500 questions fell from ~21 min to ~1 min; a warm
100-question rerun is ~16-20 s. `--fast-ingest` writes benchmark sessions
through `importRecord` (no extractive summary, entity pass, or write
pipeline): on the same 100-question sample ingestion dropped from 1,071 s
to 786 s with **identical 100% Hit@20 / 99.3% evidence recall / 98.0%
all-evidence**. The smaller `all-minilm` 384d model is a viable screening configuration at that same accuracy.

`--no-embeddings --fts-operator=OR` measures the lexical ceiling;
`--session-chunk-messages=N`, `--key-expansion`, and
`--llm-query-expansion` are measured ablations. The last one uses the
same OpenAI-compatible client as the answer/judge path (MiniMax M3.1 via
OpenRouter in the recorded runs) to decompose a multi-session question
into sub-queries and fuse the session lists by reciprocal rank.

### ConvoMem (retrieval-only, message evidence)

The third dataset in Supermemory's MemoryBench: **Salesforce/ConvoMem**,
personalization and preference learning across a single extended
conversation. The sample downloads one JSON file per evidence category:
525 questions. Of those, **387 have annotated message evidence** and are
scored; 138 are abstention/no-answer items that a retrieval-only metric
cannot score. The recorded run ingested all 525 (24,696 messages); future
runs skip the unscored items. Each message is a memory node; scoring
checks whether the annotated `message_evidences` appear in the top 10.

Protocol: `all-minilm` 384d, contextual speaker/conversation header,
0.5/0.5 fusion, top-10, no judge.

| Metric | @10 |
|---|---|
| Hit | **91.0%** |
| Evidence recall | **89.4%** |
| All-evidence recall | **87.9%** |
| MRR | 0.654 |

Per category (Hit@10 / evidence recall@10): user 100/100,
assistant 98.9/98.9, abstention 100/100, changing 89.6/82.5,
preference 74.7/74.7, implicit connections 72.2/69.4.

The weak cells are the same ones the benchmark is designed to isolate:
preference and implicit multi-message connections. ConvoMem's official
metric is LLM-judge answer accuracy, so this table is an intermediate
retrieval signal, not a vendor-comparable accuracy claim. Raw result:
`docs/artifacts/convomem-525-retrieval.json`. Reproduce:

```bash
npx tsx scripts/download-convomem.ts --files-per-category=1
npx tsx scripts/bench-convomem.ts --provider=ollama --model=all-minilm \
  --dimensions=384 --topk=10 --keyword-weight=0.5 --semantic-weight=0.5 \
  --contextual
```

`--answer` switches on the end-to-end path through
`scripts/lib/bench-llm.ts` (answer + judge; MiniMax M3.1 Flash via
OpenRouter). A 5-question smoke scored 80% with 9 calls, 5,721 tokens, and
0 errors ? too small to publish as an accuracy number, but it validates the
same answer/judge path used by the LongMemEval harness.

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
OPENAI_API_KEY=$OPENROUTER_API_KEY \
BENCH_ANSWER_MODEL=minimax/minimax-m3.1-flash:free \
BENCH_JUDGE_MODEL=minimax/minimax-m3.1-flash:free \
npx tsx scripts/bench-convomem.ts --provider=ollama --model=all-minilm \
  --dimensions=384 --topk=10 --contextual --answer
```

---

### HotPotQA second-hop entity-bridge retrieval (`multiHop`, local-hash baseline)

On HotPotQA distractor (500 validation questions, ~4.9k deduplicated Wikipedia paragraphs, deterministic title-ID matching at K=10 with the default local-hash embedder and no external LLM or reranker), single-hop hybrid retrieval misses the second supporting paragraph on bridge questions where the bridging entity is only named inside the first retrieved paragraph. Opting into `multiHop` (`SearchFilter.multiHop` or `retrieval.multiHop.enabled`) extracts candidate bridging entities from the top first-hop seeds, resolves candidate memories via the namespace lead-subject index and entity inverted index, and promotes verified second-hop evidence into weak tail slots (`5..9`) without displacing higher-scoring first-hop hits.

| Configuration | Command | Overall Hit@10 | Overall EvRec@10 | Overall `all-evidence@10` | Bridge `all-evidence@10` (404 Qs) | Comparison `all-evidence@10` (96 Qs) | MRR@10 | nDCG@10 |
|---|---|---|---|---|---|---|---|---|
| **Off (default)** | `npx tsx scripts/bench-hotpot.ts` | 99.6% | 88.7% | **77.8%** | 74.3% | 92.7% | 0.881 | 0.785 |
| **`multiHop` enabled** | `npx tsx scripts/bench-hotpot.ts --multi-hop` | 99.6% | 96.7% | **93.8%** | **93.1%** | **96.9%** | 0.881 | 0.813 |

**Measured latency cost:** Enabling `multiHop` adds ~3–6 ms per query in isolated expansion time (~6 ms / ~5.9% p50 end-to-end `search()` latency overhead on the 4,937-node HotPotQA store, from 102 ms to 108 ms p50).

**Generalisation limits (why `multiHop` is opt-in and off by default):**
- **Requires entity-centric lead subjects:** `extractLeadSubject` depends on documents having a recognisable lead subject — either a `"Subject: ..."` header prefix (standard for titled notes, wiki pages, and entity cards) or an encyclopedic copula lead sentence (`"Shirley Temple was an American actress..."`). It will not fire on free-form notes or conversational transcripts where facts about an entity are buried mid-paragraph without a lead subject header.
- **Requires lexical surface-form matching:** Bridge verification checks whether the seed's body mentions the candidate's lead subject (forward bridge) or the candidate's body mentions the seed's lead subject (backward bridge), with middle-initial and regular plural normalisation. If a seed refers to the bridging entity only via an alias, acronym, or pronoun not shared with the target document's lead subject, lexical bridge verification will miss it.

