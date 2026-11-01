# Accuracy roadmap — what is measured, what is next

> Last updated: 2026-10-28

This page separates **shipped accuracy work** from **runs that still need an
external model, dataset, or submission**. The goal is to make every number in
the README reproducible and to stop mixing retrieval-only scores with vendor
end-to-end scores.

## Shipped in this tree

| Change | What it fixes |
|---|---|
| Model-aware embedding prefixes | Nomic gets `search_query:` / `search_document:`, E5 gets `query:` / `passage:`, BGE gets its query instruction, EmbeddingGemma gets its task instruction. Explicit config still wins. |
| Prefix stored per vector | Switching prefixes or models can no longer silently mix incomparable vector spaces. `memos reindex-embeddings --purge-stale` is the migration. |
| Contextual headers on by default | The LongMemEval config used contextual headers; the SDK now matches it for semantic providers. `contextual: false` / `MEMOS_CONTEXTUAL=0` disables. |
| `--node-granularity=session\|turn\|fact` | LongMemEval now has three honest arms. Session-level is the easy arm; turn and fact are closer to real memory writes. |
| `--contextual` actually applied | Previously parsed and recorded but not forwarded into the LongMemEval MemOS config. |
| Precision@5 and tokens per correct answer | LLM-judge runs now report `tokensPerCorrectAnswer` alongside accuracy. |
| `memos eval` | Self-recall and labelled-corpus evaluation on the user's own store. |
| `semanticScan: "auto"` | Exact cosine up to 20k candidate vectors, bounded prefilter above. |
| `semanticScan: "ann"` | Optional `sqlite-vec` backend with per-model/prefix tables, backfill, delete hooks, and exact fallback. |
| LME-V2 adapter (`lme-v2/`) | Single-file Python `Memory` backend, persistent Node bridge, pools, context packs, screenshot evidence, preflight, runner, packaging. |

## Runs still required

### 1. End-to-end LongMemEval with a pinned answer + judge model

Retrieval-only scores are deterministic, but they are not comparable to the
vendor headlines (Mem0 94.4%, Mastra 94.87%, Supermemory 97% Recall@20). Run:

```bash
OPENAI_API_KEY=... \
  pnpm bench:longmemeval --topk=20 --arm=memory \
  --node-granularity=session --contextual
```

Then run the same question set with `--arm=full-context` and
`--arm=no-memory`, and publish all three with the answer model, judge model,
dataset SHA, and token cost. Never publish the memory arm without the two
baselines.

### 2. Three retrieval arms

```bash
pnpm exec tsx scripts/bench-longmemeval.ts --retrieve-only --topk=20 \
  --node-granularity=session
pnpm exec tsx scripts/bench-longmemeval.ts --retrieve-only --topk=20 \
  --node-granularity=turn
pnpm exec tsx scripts/bench-longmemeval.ts --retrieve-only --topk=20 \
  --node-granularity=fact
```

The 2026-10-28 smoke runs (2 questions each) only validate the harness; they
are not publishable. The fact arm ingests roughly 750 nodes per question, so
budget ingestion time accordingly.

### 3. Same-protocol vendor matrix

`scripts/bench-vendors.ts` already runs MemOS and Mem0 through the identical
LoCoMo retrieval protocol. The next engines to add are Graphiti/Zep, Basic
Memory, and MemTensor MemOS. Each must use the same embedder, corpus, K, and
evidence-ID scoring. A vendor that cannot boot is reported as `SKIPPED` with
the reason; it is never silently omitted.

### 4. LongMemEval-V2 / Agent Memory Leaderboard

LME-V2 measures five abilities that map directly to MemOS pools:

| LME-V2 ability | MemOS surface |
|---|---|
| Static state | `note` / `fact` memories |
| Dynamic state | `event` pool + temporal validity |
| Workflow | `procedure` pool + lessons |
| Gotchas | lessons with failure outcomes + reminders |
| Premise awareness | trust/provenance + abstention |

The adapter is shipped in `lme-v2/` (single-file Python backend + persistent
Node bridge + runner + packaging helpers). The leaderboard scores LAFS
(accuracy-latency frontier), not raw accuracy, so a fast local retriever is
competitive even without the top accuracy. The current submission window
closes **2026-10-31 23:59 UTC+8**; a full run still needs the LME-V2 dataset,
a reader model, and 115M-token haystacks. If that window is missed, publish the
run plan and target the next cycle rather than a partial number.

### 5. ANN index

`semanticScan: "ann"` now ships an optional `sqlite-vec` backend:

- one `vec0` table per model/prefix/dimension;
- backfill from the existing embeddings table on first use;
- update on every embedding write and explicit delete on node deletion;
- SQLite filters still run after ANN candidates, with an exact fallback when
  the seeded scan underfills the requested limit;
- `semanticScan: "auto"` remains the no-extension choice (exact up to 20k,
  prefilter above).

Still needed: a million-node recall-vs-latency benchmark and a packaged
`sqlite-vec` smoke test on every release platform.

### 6. Category tuning

In the committed LongMemEval artifact, the weakest all-evidence rows at K=10
are temporal (0.865) and multi-session (0.895). Session expansion, date
normalization, and temporal reranking should be tuned against those categories,
not just the headline average. Add `--category` to the harness before claiming a
win.
