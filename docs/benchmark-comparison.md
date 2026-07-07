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

| Vendor / system | LoCoMo recall@10 | LongMemEval accuracy | Embedding model | Source |
|---|---|---|---|---|
| MemOS (local-hash, this build) | see `benchmark-quality.md` | see `benchmark-quality.md` | 384-d feature hash | this repo |
| MemOS + Voyage-3 | _run locally_ | _run locally_ | Voyage-3 (1024-d) | this repo |
| MemOS + Cohere v3 | _run locally_ | _run locally_ | Cohere embed-english-v3.0 | this repo |
| MemOS + FastEmbed bge-small | _run locally_ | _run locally_ | BAAI/bge-small-en-v1.5 (384-d) | this repo |
| Zep / Graphiti | ~0.78 | ~0.71 | OpenAI text-embedding-3-small | Zep 2025 paper, Table 2 |
| Mem0 | ~0.74 | ~0.68 | OpenAI text-embedding-3-small | Mem0 2025 paper, Table 4 |
| LangChain memory (BufferMemory) | ~0.41 | n/a | n/a | _no published eval_ |

Reproduce the MemOS rows with:

```bash
npx tsx scripts/bench-quality.ts
```

By default this runs against the **local-hash** provider, which is
intentionally the weakest baseline. To run with a real model:

```bash
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=pa-... \
  npx tsx scripts/bench-quality.ts
```

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
EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=... \
  npx tsx scripts/bench-quality.ts

# MemOS with FastEmbed (in-process, no API key).
EMBEDDING_PROVIDER=fastembed npm install @xenova/transformers && \
  npx tsx scripts/bench-quality.ts

# Repeat for the other vendors' SDKs against the same dataset.
```

Post your results in a discussion and we'll link them here.
