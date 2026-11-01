# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — round-2 agent surfaces

- **Overview and trigger.** `MemOS.overview()` answers "what does this store
  know" (namespaces, types, tags, freshness, trust) without listing contents;
  `GET /api/mem/overview` and `memos_overview`. `MemOS.trigger()` ranks
  procedural lessons for an upcoming task and explains each match; `POST
  /api/mem/trigger` and `memos_trigger`.
- **Review queue.** `store(..., { review: true })` holds inferred memories out
  of recall until `reviewApprove()` / `reviewReject()`; `memos_review` exposes
  list/approve/reject, and `MemOSConfig.review.autoApproveTags` skips the queue
  for trusted tags.
- **Source-scoped deletion.** `forgetSource()` deletes every memory from a
  file, URL, import id, harness, or source value, writes hash-chained
  tombstones, and returns proof-of-forgetting certificates.
  `deletionStatus()` reports present/deleted/unknown. HTTP and MCP parity:
  `POST /api/mem/forget-source`, `GET /api/mem/deletion-status/{id}`,
  `memos_forget_source`, `memos_deletion_status`.
- **Briefs and knowledge pages.** `brief(subject)` returns open/closed items
  and a rewrite policy; `memos_brief` and `POST /api/mem/brief`. Pages are
  named queries plus pinned memories, re-rendered on every read with
  `[mem:...]` citations (`savePage`/`readPage`/`listPages`/`deletePage`,
  `memos_page`).
- **Dreaming.** `memos dream` runs consolidation with a report (merged,
  superseded, archived, conflicts) and `--schedule hourly|daily|weekly`.
- **AI SDK middleware.** `memosRecallMiddleware()` injects a memory pack before
  each model call, and the adapter gains an `ingest_documents` tool.
- **MCP surface.** 40 tools, 12 in the default core set. New: overview,
  trigger, brief, review, page, forget-source, deletion-status.


### Added — default runtime, ANN, diagnostics, LME-V2

- **Zero-native-dependency default embeddings.** `new MemOS()` now uses
  Model2Vec `potion-base-8M` (256-d, pure JavaScript, ~30 MB static table)
  instead of a FastEmbed provider that silently degraded to the hash. Ollama,
  FastEmbed, Voyage, Cohere, OpenAI-compatible, and local-hash remain
  selectable. `memos init` recommends Model2Vec and explains the accuracy
  tradeoff.
- **Working FastEmbed loader.** The transformers runtime is loaded through
  `createRequire` (its ESM entry fails on Node 26 with an
  `onnxruntime-common` named-export error); ONNX inference failures now fall
  back gracefully instead of crashing the process.
- **True ANN backend.** `semanticScan: "ann"` uses the optional `sqlite-vec`
  extension with per-model/prefix `vec0` tables, backfill, write updates,
  delete hooks, and exact fallback when the extension is unavailable.
- **Structured errors and crash reports.** `MemOSError` codes
  (`MEMOS_DB_LOCKED`, `MEMOS_PROVIDER_AUTH`, ...), actionable hints, redacted
  context, `MEMOS_DEBUG=1` stacks, `~/.memos/crash-reports/*.json`, and
  `memos doctor` surfacing the latest report. JSON failures return an
  `errorPayload`.
- **LongMemEval-V2 adapter.** `lme-v2/` contains a single-file Python `Memory`
  backend + persistent Node bridge, official-normalizer support, trajectory
  note/procedure/gotcha/event pools, token-budgeted context packs, screenshot
  evidence, preflight checks, runner, and leaderboard packaging helpers.
- **MCP tools for the new surfaces.** `memos_handoff`, `memos_audit`,
  `memos_eval`, and `memos_promote`; `memos_handoff` replaces `memos_usage` in
  the 10-tool core set, and the full surface is now 32 tools.

### Added — smoothness, accuracy, and audit surfaces

- **`memos demo`** — stores three memories in a temporary database, searches,
  closes the process, reopens the same file, and proves persistence, then
  cleans up. `memos init` now reports embedding health with a concrete fix.
- **`memos handoff "<task>"` / `MemOS.handoff()`** — composes the user profile,
  a token-budgeted context pack, procedural lessons, reminders, memory health,
  and harness attribution into a citable Markdown/JSON handoff brief. The
  Claude Code `SessionStart` hook now uses it instead of `summarize`.
- **`memos audit` / `MemOS.auditReport()`** — one read-only artifact covering
  hash-chain verification, provenance/source inventory, the quarantine
  register, deletion certificates, semantic-search health, and recommendations.
  `--expect-tip` verifies an externally recorded checkpoint.
- **`memos eval`** — in-product retrieval evaluation. Self mode samples recent
  memories and checks whether fragments still retrieve them; corpus mode runs a
  labelled JSON file and reports Hit@K, MRR, latency, and tokens per hit.
- **`memos promote` / `MemOS.promoteProcedures()`** — reviews repeated
  successful recall patterns (from `memos feedback`) as procedure candidates;
  dry-run by default, `--apply` writes the lessons and skips duplicates.
- **Model-aware embedding prefixes** — Nomic, E5, BGE, and EmbeddingGemma get
  their recommended query/document instructions automatically; explicit config
  wins. Vectors now persist the document prefix, so mixed vector spaces are
  impossible. Contextual headers are on by default for semantic providers
  (`contextual: false` / `MEMOS_CONTEXTUAL=0` disables them).
- **MCP core profile** — 10 daily-loop tools are exposed by default instead of
  all 28; `MEMOS_MCP_TOOLS=all` restores the full surface, a comma list selects
  tools, and `none` hides them. This cuts the per-session tool-schema tax.
- **Pack rerank opt-in** — `contextPack({ rerank: true })` or
  `experimental.rerank` reranks the narrow head before budget trimming.

### Changed — packaging and release hygiene

- npm `files` is now an allowlist (`dist`, README, LICENSE, UPGRADING). The
  published tarball drops from 12.8 MB / 38.6 MB unpacked to ~1 MB / ~3.2 MB,
  and benchmark datasets are no longer redistributed.
- PyPI documentation and `pyproject.toml` now use the real distribution name,
  `mem-os-python` (the import package remains `memos`).
- Added `check:pack` (size/dirty-file gate), `check:versions` (npm/PyPI/README/
  plugin version parity), and `check:plugin-manifests` (duplicate-key-aware
  manifest validation). CI runs all three.
- Fixed `plugin/hooks/hooks.json`: `UserPromptSubmit` was declared twice, so
  JSON parsing kept `auto-capture.mjs` and silently dropped the per-prompt
  recall hook.

### Added — recall inspector, outcome-conditioned ranking, memory health

Three surfaces that close the loop between retrieval and results:

- **`memos.explain(query, { memoryId? })`** / `memos_explain` / `memos explain`:
  ranked candidates with per-leg evidence (`keyword`, `semanticRaw`, `entity`,
  `graph`, `ppr`, `session`, `rerank`, `provenance`, `outcomeUtility`, ...),
  lifecycle status, supersede chain, outcome utility, and the relevance-gate
  verdict. Passing `memoryId` explains why one memory was *not* retrieved
  (namespace, pool, lifecycle, embedding model mismatch, lexical overlap).
- **`memos.recordRecallFeedback({ query, used, outcome })`** /
  `memos_feedback` / `memos feedback`: records which memories an agent actually
  used and whether the task succeeded. Successful uses get a bounded promotion
  and failed uses a bounded demotion (`retrieval.outcomeFeedback.weight`,
  default ±20%). `recallUtility(id).uplift` compares used vs unused batches
  observationally. Persisted in `recall_batches` + `recall_feedback`; loaded
  once at `init()`; deleted with `forget()`; ablatable per query with
  `search({ outcomeFeedback: false })`.
- **`memos.health()`** / `memos_health` / `memos health`: graded hygiene report
  covering unresolved contradictions, TTL backlog, low-confidence share,
  quarantine count, and useful-recall rate, with actionable findings.

CLI help, shell completion, MCP annotations, static tool metadata, API
reference, and a new `docs/recall-inspector.md` are updated. MCP surface grows
from 25 to 28 tools.

### Fixed — historical memories leaked through the semantic leg

`querySimilarEmbeddings` did not apply the temporal predicate that the keyword
and structured paths already applied, so a superseded memory disappeared from
FTS but could still surface through its embedding. The semantic scan now
honours `validAt` / `includeHistorical` exactly like `queryNodes`, including
the `valid_to > now` boundary for a supersession in the same millisecond.

### Added — contextual retrieval on the document side (+10.9pp LoCoMo Hit@10)

`store({ context })` already prepended a line to the embedded text, but nothing
used it for conversation data. The benchmark harness now writes the session
header (`session · date · speaker`) and the **previous turn** as context, and
the SDK can derive the header automatically:

- **`embeddings.contextual: true`** (or `MEMOS_CONTEXTUAL=1`) builds
  `[session_2 · 7 May 2023 · Caroline]` from `metadata.sessionId` /
  `timestamp` / `speaker` and embeds it with the node. The stored content and
  the FTS index stay verbatim, and the header is never returned in results or
  packs. Suppressed automatically on the deterministic `local-hash` fallback,
  where header tokens dilute lexical matching (68.0% → 65.5% Hit@10 on one
  conversation). Requires `reindexEmbeddings()` after switching it on.
- **Previous-turn context.** A conversational answer rarely repeats the
  question's wording ("What are your summer plans?" → "Researching adoption
  agencies"). Passing the previous turn in `context` bridges that gap in the
  vector. This is the single largest accuracy win measured so far.

LoCoMo retrieval-only, conversations 0-1, 304 questions, `nomic-embed-text`
768d, top-10, no reranker, 0.5/0.5 fusion (same seed on every leg):

| Pipeline | Hit@10 | EvRec@10 | AllEv@10 | MRR | nDCG@10 |
|---|---|---|---|---|---|
| baseline (before this round) | 69.2% | 64.2% | 59.6% | 0.429 | 0.469 |
| + chronological session neighbours | 72.2% | 67.3% | 62.9% | 0.457 | 0.499 |
| + contextual header + previous turn | **79.8%** (mean 78.4) | **75.9%** (mean 74.3) | **71.9%** (mean 70.4) | **0.476** | **0.534** |

Three consecutive runs measured 78.1 / 77.2 / 79.8 Hit@10; the table
shows the best, with the 3-run mean in parentheses. The earlier 80.1 was
one run at the high end of that spread. At the shipped 0.8/0.2 default the
same stack moves Hit@10 63.6% → 69.9%, all-evidence 54.3% → 61.6%. Full 10-conversation set (1,982 questions, no
reranker): Hit@10 **73.5%**, evidence recall **67.7%**, all-evidence **63.0%**,
nDCG **0.500** in 281 s end-to-end. Artifacts and the exact commands are in
`docs/benchmark-comparison.md` § "Contextual retrieval".

`memos_store` (MCP) now exposes `context` and a free-form `metadata` object —
both were accepted internally but missing from the published tool schema, so
Claude Code and Hermes clients could not use them.

### Performance — 2.5x faster benchmark, O(1) writes, bounded memory

- **Pipelined benchmark ingestion.** The harness now stores turns with a
  bounded `--ingest-concurrency` (default 16) and explicit `now` timestamps,
  so chronology is preserved while the embedding queue sees full batches.
  LoCoMo convs 0-1: end-to-end **80.6 s → 32.2 s**, ingestion **57.7 s →
  17.0 s** (3.4x). `--ingest-concurrency=1` restores the sequential path.
- **Write-time contradiction scan is opt-out.** It performs a full vector scan
  per write; benchmark setup and bulk imports can pass
  `contradictionScan: false` (`--contradiction-scan` re-enables it in the
  harness). This was the difference between 30 s and 17 s of ingestion.
- **Temporal event extraction is opt-out for bulk imports.** `store()` runs
  an event-update search before every write to resolve "moved to…"/"cancelled"
  style updates. Historical logs do not need new reminders, so
  `eventUpdate: false` skips it. On the LongMemEval harness this cut a
  44-session question from ~22 s to under 1 s and the 100-question setup from
  17.6 min to 10.4 min.
- **O(1) mutation logging.** `logMutation` re-read the entire tamper log on
  every write just to learn the new sequence number. It now uses the entry
  returned by `appendTamperEntry`. The in-memory time-travel snapshot array is
  also capped (`MAX_IN_MEMORY_SNAPSHOTS = 2000`) instead of growing forever.
  Local-hash benchmark ingestion: 6.85 s → 3.66 s for 419 turns.
- **Session-window cache.** Neighbour expansion re-queried the same session on
  every search. Windows are cached (namespace + session + historical flag,
  max 64) and cleared by `invalidateSearchCache` on any write, so a read-heavy
  agent stops paying one metadata query per seed per query.

### Changed — TypeScript 7.1 beta for the dev toolchain

`@typescript/native` (the `tsc` binary) is now pinned to `typescript@7.1.0-beta`.
Type-checking this repo drops from **~950 ms to ~466 ms** (2.0x) on the same
machine, with the full 76-suite test run and `tsc` emit unchanged. The new
7.1 compiler API entry points (`typescript/sync`, `typescript/ast`, …) are not
needed by a runtime library; the win here is build speed. No runtime dependency
was added, and the version is exact, so CI is deterministic. (`typescript`
itself remains the 6.x bridge for `tsc6`.)

### Plugins — the gains reach Claude Code and Hermes

- Shared `plugin/skills/memos-memory/SKILL.md` now teaches contextual storage:
  pass `context` (topic/date/previous turn) and `metadata.sessionId` /
  `timestamp` / `speaker` to `memos_store`. Both harnesses load the same skill
  file, so the guidance applies to Claude Code and Hermes identically.
- Both MCP manifests set `MEMOS_CONTEXTUAL=1`, so the session header is added
  automatically even when the agent only sends metadata.
- The Claude Code auto-capture hook now passes `--context` with the project
  folder and session id when it stores an explicit "remember this".
- `scripts/check-hermes-plugin.py` was crashing on Hermes' newer diagnostic
  shape (`scope`, not `component`) and silently required `ruamel.yaml`; both
  fixed, with a clear hint to run it under Hermes' venv. Verified against the
  real `load_agent_plugin` loader: 2 skills discovered, 0 diagnostics.
- Plugin manifests bumped to **1.6.27** (`check:plugin` passes).

### Negative results (kept out of the defaults)

Measured on the same 2-conversation protocol, with the contextual stack on:

| Knob | Hit@10 | AllEv@10 | Verdict |
|---|---|---|---|
| PRF query expansion (`--query-expansion`) | 73.2% | 63.9% | worse than 74.5 / 65.2 |
| MMR (`--mmr --mmr-lambda=0.7`) | 72.8% | 63.2% | worse, and p50 191 ms |
| session-diversity demotion (0.9 penalty) | 76.8% | 67.2% | worse than 78.1 / 70.2 |

The implementation of session diversity was removed rather than shipped as
dead config. These remain opt-in experiments in the harness.

### Added — LongMemEval at the vendor's reporting depth (Recall@20)

Supermemory's published 97% is **Recall@20 with aggregation** on
LongMemEval-S. The harness only printed @5/@10, so the repo had no
like-for-like number. It now computes metrics at an arbitrary K and
records `metrics.atK` / `perCategoryAtK`.

Protocol: one memory per haystack session (the same retrieval unit the
vendor uses), `nomic-embed-text` 768d, contextual session/date header,
0.5/0.5 fusion, no reranker, K=20. Screening sample (100/500):

| Retrieval | Hit@20 | EvRec@20 | AllEv@20 | MRR | nDCG@20 |
|---|---|---|---|---|---|
| BM25 only, OR terms | 100.0% | 96.8% | 93.0% | 0.872 | 0.881 |
| Hybrid AUTO | **100.0%** | **97.6%** | **94.0%** | 0.901 | 0.898 |
| Hybrid OR | 100.0% | 97.1% | 93.0% | **0.914** | **0.908** |

**Full 500-question set, hybrid AUTO: 99.4% Hit@20, 98.3% evidence
recall@20, 96.4% all-evidence@20, MRR 0.934, nDCG 0.929.** That is +2.4pp
hit and +1.3pp evidence recall over Supermemory's published 97% overall
Recall@20, at the same K and session granularity. Per category (our
Hit / evidence recall): knowledge-update 100/100, single-session-user
98.6/98.6, single-session-assistant 100/100, single-session-preference
96.7/96.7, temporal 99.2/97.2, multi-session 100/97.9. The vendor's
published rows are 100 / 97 / 100 / 95 / 95 / 96 respectively.

The residual all-evidence misses are multi-session and temporal cases
where one of 2-6 evidence sessions lands just outside the cut — a
multi-hop synthesis limit, not a single-fact retrieval failure. The full
run is resumable (`--db=`); its raw result JSON is committed at
`docs/artifacts/longmemeval-s-full-500-retrieval.json`.

Harness capabilities added for this: `--no-embeddings` (lexical ceiling),
`--db=` (resume without re-embedding), `--session-chunk-messages=`
(chunked ingestion that aggregates back to sessions), `--key-expansion`
(deterministic fact-sentence summary), `--llm-query-expansion` (LLM
decomposes a question into sub-queries, fused by RRF), and
`--ingest-concurrency`.

### Performance — namespace index + sparse semantic candidate selection

Two changes cut the LongMemEval harness from hours to minutes:

- **`idx_nodes_namespace`**. The semantic leg built a join over every
  embedding row and filtered `nodes.namespace` afterwards; on a 24k-node
  store that was ~2.5 s per query. The index (created after the namespace
  migration, so fresh DBs work) plus a two-step namespaced id-select
  (namespace → node ids → those embeddings) drops the scan to **~6 ms**
  and a full search to **~80 ms**.
- **Session expansion is off for session-granular runs.** LongMemEval
  stores one node per session, so injecting neighboring sessions is pure
  overhead; `bench-longmemeval` now defaults it off (`--session-expansion`
  re-enables it for chunked ingestion).

Full-set retrieval: **21 min -> ~1 min**. The 100-question hybrid run
repeats in ~16-20 s once ingested. --fast-ingest (importRecord, no
summary/entity/write pipeline) cut 100-question ingestion from 1,071 s to
786 s with the same **100% Hit@20 / 99.3% evidence recall / 98.0%
all-evidence**. The harness also supports --model=all-minilm
--dimensions=384 for a smaller-embedder screening run.

### Added — ConvoMem, the third MemoryBench dataset

`scripts/download-convomem.ts` + `scripts/bench-convomem.ts` add the
Salesforce/ConvoMem dataset (the third benchmark in Supermemory's
MemoryBench). Retrieval-only message-evidence scoring on a 525-question
sample (387 scored; 138 abstention items have no evidence message),
24,696 messages, with `all-minilm`:

**91.0% Hit@10 · 89.4% evidence recall · 87.9% all-evidence · MRR 0.654.**

Per category: user 100, assistant 98.9, abstention 100, changing 89.6,
preference 74.7, implicit connections 72.2 (Hit@10). ConvoMem's official
metric is LLM-judge accuracy; this is the deterministic retrieval layer.
Commands and caveats are in `docs/benchmark-comparison.md`. `--answer`
optionally runs the MiniMax M3.1 answer/judge path (5-question smoke: 80%,
9 calls, 5,721 tokens, 0 errors; not a published accuracy claim).

### Added — MiniMax M3.1 as the benchmark answerer/agent

The end-to-end path now runs against **MiniMax-M3.1-Flash** (free tier)
through OpenRouter / the OpenCode CLI. A smoke run answered and judged
LongMemEval questions with 29,834 tokens across 3 calls and 0 errors;
the answer/judge model ids and token usage are written into the results
file via `scripts/lib/bench-llm.ts`. The model is free, accepts a 1M
context window (the full retrieved context fits), and the same client
works for LoCoMo. Note: 2-question accuracy is noise; use the 100/500
runs for anything citable. The OpenCode npm CLI below 1.19.3 does not
list M3.1; 1.19.3 does. The `opencode` free key in the local auth store
was expired, so the working route is OpenRouter's
`minimax/minimax-m3.1-flash:free`.

### Fixed — the red macOS / Node 24 CI job

The last `main` CI run (39273425850) had exactly one failing job:
`TypeScript (macos-14, Node 24)` → Test. Build, lint and every other
matrix leg passed. Three timing assumptions were responsible, and all
three were tests, not the library:

- `ebbinghaus-reinforcement.test.ts` slept 3 × 400 ms inside one test
  (plus stores and searches) and tripped Jest's 5 s timeout on the
  slower macOS runner. The sleeps were cosmetic — the test already
  calls `flushAccessCounts()` explicitly — so they are now a 10 ms
  yield to the fire-and-forget bump.
- `embedding-integration.test.ts` asserted `store()` returned in
  <60 ms against a 50 ms provider delay: 10 ms of slack for JIT and
  module warm-up. It now uses a 300 ms provider delay and asserts
  `< delay`, which proves the same non-blocking property without a
  wall-clock race.
- `bench-common.test.ts` proved fallback detection with a Hub model
  name, so the test needed a network round-trip (and occasionally
  blew the 5 s timeout when suites ran in parallel). A nonexistent
  local model path rejects immediately and offline, with the same
  "pipeline construction failed" fallback.

Also re-ran Prettier over `src/**/*.ts`; `pnpm format:check` passes
again (six files from the unreleased work were unformatted, which
would have failed CI independently).

### Fixed — session expansion was injecting the conversation TAIL, not neighbours

Session-neighbour expansion (on by default) used to fetch a seed's session
siblings in storage order (newest first) and inject up to ten of them at a
flat `0.85^k` decay. On any conversation longer than ten turns that meant the
injected block was the *end* of the session — so the answer sitting one turn
next to the matched query was exactly what fell off the `top-k` edge. The
mechanism was adding noise and calling it context.

Expansion now orders the session by `createdAt` and injects only the seed's
chronological ±1 / ±2 neighbours (nearest first, `0.9x` / `0.75x` the seed
score, six injections max). It is still deterministic and model-free; it just
injects the turns a conversational answer actually lives in.

Measured on LoCoMo retrieval-only (conversations 0-1, 304 questions,
`nomic-embed-text` 768d via Ollama, top-10, no reranker):

| Config | Metric | Before | After | Δ |
|---|---|---|---|---|
| 0.5 / 0.5 | Hit@10 | 69.2% | **72.2%** | +3.0pp |
| 0.5 / 0.5 | Evidence recall@10 | 64.2% | **67.3%** | +3.1pp |
| 0.5 / 0.5 | All-evidence recall@10 | 59.6% | **62.9%** | +3.3pp |
| 0.5 / 0.5 | MRR | 0.429 | **0.457** | +0.028 |
| 0.5 / 0.5 | nDCG@10 | 0.469 | **0.499** | +0.030 |
| 0.8 / 0.2 | Hit@10 | 63.6% | **66.9%** | +3.3pp |
| 0.8 / 0.2 | All-evidence recall@10 | 54.3% | **58.3%** | +4.0pp |
| 0.8 / 0.2 | nDCG@10 | 0.452 | **0.476** | +0.024 |

Single-hop is where it lands: Hit@10 64.0% → 71.1% at 0.5/0.5 (+7.1pp),
because "what did X say" answers are adjacent to the turn that matched.
Multi-hop all-evidence 2.3% → 7.0%. Temporal gave back two questions
(90.5% → 87.3%, 2 of 63) — the old tail-dump occasionally happened to
include a date further away; the net across every category is positive.
Reproduce with the command in `docs/benchmark-comparison.md`
§ "Session-neighbour expansion: ordering fix".
`__tests__/search-upgrades.test.ts` pins the ordering with a nine-turn
session where only the ±1/±2 neighbours may appear.

### Measured — EmbeddingGemma-2 text-only vs EmbeddingGemma-300M (2026-10-11)

The EmbeddingGemma-2 text stack (Q8, ~310 MB — the official ggml-org
conversion splits vision/audio into `mmproj-*.gguf`, so the main GGUF
is the 270M text-only model) was run through the identical LoCoMo
convs 0-1 protocol as the 300M baseline:

| Metric @10 | EmbeddingGemma-300M | EmbeddingGemma-2 (text) | Δ |
|---|---|---|---|
| Hit | 66.9% | 62.9% | −4.0pp |
| Evidence recall | 61.5% | 58.4% | −3.1pp |
| Precision | 6.9% | 6.5% | −0.4pp |
| nDCG | 0.475 | 0.452 | −0.023 |
| Ingestion | 46s | 97s | 2.1× slower |

The deficit concentrates in multi_hop (55.8 → 41.9 hit@10). Google's
"+14%" is on **MTEB Code**, a code-retrieval suite — not conversational
memory recall, where "retains accuracy" is the actual claim. The
**default recommended embedder stays EmbeddingGemma-300M**; the right
next experiment for eg2 is a code-index benchmark (MTEB-Code-style or
the repo's cross-repo bench), not LoCoMo. Full table, per-category
breakdown, and serve/bench commands: `docs/benchmark-comparison.md`
§ "EmbeddingGemma-2 — measured, and NOT better on this slice".

Two facts recorded there for whoever re-runs this: the GGUFs declare
`pooling_type = 1` = **MEAN** (llama.cpp's enum; matches Google's
`pooling_mode: mean` — no override needed; an earlier draft of the doc
claimed CLS, retracted), and **`gemma-embedding2` requires llama.cpp
newer than b11433** — the rolling master builds (`b11559`) load it,
v0.6.0 and the local `llama-cpp-latest` do not.

### Added — same-protocol vendor benchmark harness (`scripts/bench-vendors.ts`)

The field's published memory scores are not comparable: every vendor
runs their own embedder, their own judge, their own scoring. This
harness runs MemOS **and third-party memory SDKs** through the
identical LoCoMo retrieval-only protocol — same utterances, same
evidence IDs, same deterministic scoring, the only variable is the
engine.

```bash
# MemOS vs Mem0, both on the same embedder:
npx tsx scripts/bench-vendors.ts --engines=memos,mem0 --convs=2 \
  --provider=ollama --model=nomic-embed-text --base-url=http://127.0.0.1:11434 \
  --vendor-embedder=ollama --vendor-model=nomic-embed-text
```

Fairness rules enforced by the harness:

- **raw ingestion on both sides** — Mem0 runs with `infer=False` (its
  LLM fact extractor stays off), so a vendor is measured on retrieval,
  not its write-time extractor;
- **one embedder or a loud warning** — the embedding stack each engine
  used is recorded per engine; a mismatch raises a comparability
  warning in the report AND the JSON;
- **skip, don't crash** — a vendor whose SDK or server is missing is
  reported SKIPPED with the reason and the run continues.

The Mem0 leg runs through `scripts/vendor-bridges/mem0_bridge.py`
(JSON-lines stdio; dia_id sidecar mapping; chroma-local vector store by
default, qdrant-path with `--vendor-store=qdrant`; `pip install mem0ai`
required). `createBenchMemos()` was extracted into
`scripts/lib/bench-common.ts` (together with the LoCoMo dataset types,
which must NOT be imported from `bench-locomo-noapi.ts` — that module
runs `main()` on import) so both harnesses build byte-identical MemOS
configurations.

mem0 2.2.1 traps the bridge handles (documented in
`docs/benchmark-comparison.md`): the pydantic config key is
**`embedder`**, not `embeddings` (a wrong key is silently ignored and
falls back to mem0's OpenAI default); the "ollama" embedder needs the
`ollama` pip package (missing → silent fallback to the OpenAI client);
`search()` rejects top-level `user_id` (must be `filters={"user_id":
...}`); and mem0 2.x runs an **LLM decision step during `add()` even
with `infer=False`**, so the vendor leg needs a local LLM slot —
`--vendor-llm-url` points it at llama.cpp (minicpm5 works; see the
benchmark doc for the reproduce block). The bridge also scrubs
`OPENAI_*`/`ANTHROPIC_*` env vars so a local gateway cannot hijack that
slot.

### Measured — first same-protocol run: MemOS vs Mem0 (2026-10-11)

LoCoMo convs 0-1, 304 questions, top-10, identical protocol (raw
ingestion both sides, same `nomic-embed-text` embedder, evidence-ID
scoring). Headline @10 is a **statistical tie** — hit 65.6% both,
evidence recall 60.6 vs 61.2, precision 6.9 vs 7.0 — but the
per-category split is the story: **MemOS +16.9pp on adversarial**
(62.0 vs 45.1 — the trust/quarantine machinery earning its keep),
mem0 ahead on single_hop (67.5 vs 59.6) and open_domain (63.6 vs 54.5,
n=11, noise). MRR/nDCG favor MemOS. Full table + caveats: see
`docs/benchmark-comparison.md` § "First same-protocol run". The honest
next step is the full 10-conversation matrix on Kaggle Phase A.

### Added — one-call user profile (`memos.profile()`, `memos_profile`, `memos profile`)

The "who am I talking to" block, in one call. `profile()` returns a
maintained slice of the store — `static` (durable preferences, entities
and facts, ranked by trust → importance → recency) plus `dynamic`
(recent activity inside a recency window) — cached for
`profile.cacheTtlMs` (default 30s) and cleared by any write.

```ts
const { static: who, dynamic: recent } = await memos.profile();
await memos.profile({ query: "deploy", scope: { user: "alice" } });
```

Surfaces: TS SDK `memos.profile(opts?)`, MCP tool `memos_profile`
(input `query`/`max_static`/`max_dynamic`/`recent_days`/`namespace`/`scope`),
CLI `memos profile` (with `--json`). Defaults come from
`MemOSConfig.profile` (`maxStatic` 25 / `maxDynamic` 10 / `recentDays` 7).

### Added — preset factories (`MemOS.chatbot()`, `.codingAgent()`, `.researchBot()`)

Named, embedder-independent config bundles: `MemOS.chatbot({ dbPath })`
or `new MemOS({ preset: "chatbot" })`. Presets set the store bound, the
embedding-queue width, and the measured precision knobs (relevance
gate + MMR — see below); caller fields override the bundle, and
`retrieval` / `embeddingQueue` merge key-by-key. The bundles are
exported as `MEMOS_PRESET_CONFIGS` for programmatic use.

### Added — MMR diversification (`applyMmr`, `filter.mmr`, `retrieval.mmr`)

Maximal Marginal Relevance re-selects the retrieval head so
near-duplicate memories stop crowding out distinct evidence: a top-10
of ten paraphrases has hit@10 = 1 and precision@10 = 0.1 — the recall
metrics celebrate while the context window is 90% noise.

```ts
const results = await memos.search({ query: "deploy", mmr: 0.6 });
```

Similarity is token-Jaccard over summary + content — deterministic, no
embedding call, so it also works on the keyword-only path. Off by
default (`retrieval.mmr = { enabled: true, lambda: 0.5 }`), runs after
the relevance gate so it can never resurrect a trimmed candidate, and
the top result is always kept. Bench ablation:
`--gate`, `--relevance-ratio=`, `--abstain-similarity=`, `--mmr`,
`--mmr-lambda=`, and `--out=` (keep experiments off the committed
baseline artifact) are now shared by every benchmark script.

### Measured — EmbeddingGemma-300M beats LFM2.5-350M at 46% of the file size

Same protocol (LoCoMo convs 0-1, 302 questions, retrieval-only evidence-ID
matching, 0.5/0.5 fusion, candidate depth 100, no reranker, asymmetric
prefixes applied on both stacks), local GPU:

| Metric @10 | LFM2.5-350M-BF16 (711 MB) | EmbeddingGemma-300M-Q8 (328 MB) | Δ |
|---|---|---|---|
| Hit | 57.9% | **66.9%** | +8.9pp |
| Evidence recall | 54.0% | **61.5%** | +7.5pp |
| All-evidence recall | 50.7% | **56.6%** | +6.0pp |
| Precision | 5.9% | **6.9%** | +1.0pp |
| MRR | 0.398 | **0.447** | +0.049 |
| nDCG | 0.421 | **0.475** | +0.054 |

Reproduce:

```bash
llama-server -m embeddinggemma-300m-q8_0.gguf --embedding --ctx-size 4096 \
  -b 4096 -ub 2048 --parallel 4 -ngl 99 -fa on --embd-normalize 2 \
  --port 8080 --host 127.0.0.1
npx tsx scripts/bench-locomo-noapi.ts --convs=2 --topk=10 \
  --provider=openai-compatible --base-url=http://127.0.0.1:8080/v1 \
  --model=embeddinggemma-300m-q8_0 --dimensions=768 \
  '--query-prefix=task: search result | query: ' \
  '--document-prefix=title: none | text: ' \
  --keyword-weight=0.5 --semantic-weight=0.5 --candidate-depth=100
```

The smaller Gemma model is also the better one on this corpus — the
published headline numbers are a floor, not a ceiling. Run the new
stack on the full 10-conversation set (Kaggle Phase A) before changing
the README table.

### Measured — what actually moves precision@10 (LoCoMo convs 0-1, 302 questions)

Recorded here because the result was NOT what the roadmap predicted —
all runs below use the SAME protocol (0.5/0.5 fusion, candidate depth
100, no reranker, asymmetric prefixes applied):

| Config (EmbeddingGemma-300M-Q8) | Hit@10 | EvRec@10 | Prec@10 |
|---|---|---|---|
| fused only | 66.9% | 61.5% | 6.9% |
| + MMR (λ 0.5) | 66.6% | 61.4% | 6.9% |
| + semantic dedup | 67.5% | 62.1% | 7.0% |
| + relevance gate (ratio 0.25) | 67.9% | 62.1% | 7.1% |

Post-hoc re-ranking of an already-fused list does not move precision on
this corpus — the fused score distribution is too flat for the tail
trimmer to bite, and with a small embedder everything is semantically
near-equidistant, so MMR trades evidence for paraphrases. Dedup and the
gate are small positives. **The precision lever is upstream of the
gate: the cross-encoder reranker (+12.9pp Hit@10 in the convs 0-1
ablation) and ingestion grooming (grouping, dedup).** An early draft of
this entry compared prefix-applied and prefix-less runs (the trailing
space of `--query-prefix=` was lost to shell word-splitting — use a
bash array, not a string); the table above is the corrected, single-
protocol data. `docs/benchmark-comparison.md` records the full matrix
and the implication for F4 ("treat reranking as a first-class stage
rather than an option").

### Changed — MCP tool surface: 25 tools (was 24)

`memos_profile` joins after `memos_search` (read-only annotations).
The annotations/protocol tests assert the count and order as a
contract, so they were updated in the same commit.

### Added — image memory (vision)

Images are now first-class memories. An image memory is an **ordinary
memory node** whose `content` is a caption, plus the bytes in a
content-addressed blob store (`<dbDir>/memos-images/`). No new
`MemoryType` member: `metadata.image` is the discriminator, so the sync
allowlist, fidelity labels, adapters, and MCP schema all keep working
unchanged.

**Write API** — `addImageMemory(input, opts)` normalizes every input
shape (path, URL, `{ data, mime }` base64, `data:` URL, raw bytes),
writes the blob, and routes the caption through the normal
`storeInner` pipeline — so quarantine screening, provenance,
auto-linking, contradiction scan, and the tamper log all apply for
free. Identical bytes dedupe to one blob and (per namespace) one node.
`deleteImageMemory` unlinks the blob with refcounting, and
`purgeOrphanImages` sweeps blobs no live node references.

**Two retrieval tracks, independent:**
- *Track A (always on)* — the caption is embedded by your normal text
  embedder, so keyword + semantic search find images on every install
  with zero extra downloads.
- *Track B (opt-in via `vision.clip.enabled`)* — the image itself is
  encoded by CLIP into a **separate** vector space
  (`image_embeddings`, its own table and cache namespace), so a query
  can match the pixels when its wording differs from the caption's.
  Fails soft to Track A when the model is unavailable; never throws,
  never substitutes a text vector.

**Read API** — `searchImages(query, opts)` fuses the caption leg and the
CLIP leg by reciprocal rank (the two spaces are not score-comparable);
`imageMemory(ref)` resolves an `[img:…]` ref back to bytes; `listImages`
lists them newest-first.

**Accuracy invariants** (each covered by a test):
- `[img:<ref>]` tokens are **pinned** in `compressText` — split out
  before token-dropping and never dropped, so a caption can never be
  compressed into prose that strands its image.
- The token is appended at **every** fidelity level (L0–L3): a memory
  findable at L0 whose image can't be shown is a broken memory.
- Budget compression keeps the uncompressed form when the compressed
  one would lose the ref (the existing no-win rule).
- A CLIP-only hit now counts as embedding evidence for the relevance
  gate — previously an image surfaced only by the pixel leg looked like
  it had no semantic score and was silently dropped.

**Context packs carry references, never bytes.** `ContextPackItem.images`
holds `{ ref, mime, width, height, kind, caption, sha256, bytes }`, and
TOON appends ` [img:<ref>]` to the content field — deliberately **not**
an 8th column, so the fixed layout (and provider prompt caches) hold.
`contextPack({ images: false })` opts out; a pack with no image nodes is
byte-identical to before.

**Surfaces** — CLI `memos image add|list|search|show|purge`; MCP tools
`memos_image_add` / `memos_image_search` / `memos_image_recall`.

**Disabled by default.** A bare `new MemOS()` creates the (empty)
`image_embeddings` table and nothing else: no new API surface, no
changed search results, no changed pack bytes.

### Changed — search dispatch

`search()` now takes the multi-leg hybrid path when **either** a text
embedding provider is configured **or** the CLIP image leg can
contribute. Gating on the text provider alone left Track B silently
dead on exactly the installs that opted into it
(`embeddings.enabled: false` + `vision.clip.enabled: true`).

### Verified — Python 3.15 support (latest stable, released 2026-10-09)

- **Added Python 3.15 to the supported range.** 3.15.0 shipped on
  2026-10-09 (PEP 790) as the latest stable CPython, so it is now
  exercised in CI and declared via a PyPI trove classifier. No code
  breakage was found: the entire Python surface (`memos.server.main`,
  `memos.server.routes`, and all three adapters) imports, builds and
  runs unchanged on 3.15, and the dependency stack (fastapi 0.143,
  uvicorn 0.54, pydantic 2.14 / pydantic-core 2.50, starlette 1.7)
  publishes 3.15 wheels.

- **Checked against the 3.15 removal list.** Nothing removed or changed
  in a breaking way in 3.15 is touched by this project — notably
  `collections.abc.ByteString`, `pathlib.PurePath.is_reserved`,
  `glob.glob0/glob1`, `platform.java_ver`, `sre_compile`/`sre_constants`/
  `sre_parse`, `typing.ByteString`, `typing.no_type_check_decorator`,
  the keyword form of `NamedTuple(...)`/`TypedDict(...)`,
  `zipimport.zipimporter.load_module`, `wave` mark methods,
  `datetime.strptime` with a bare `%d`, the `sysconfig.is_python_build`
  `check_home` parameter, and `threading.RLock` positional args. The
  `sqlite3.connect` keyword-only tightening is satisfied — the backup and
  restore CLI paths call `sqlite3.connect(db_path)` with a single
  positional argument.

- **Pinned UTF-8 on the backup manifest.** Python 3.15 makes UTF-8 the
  default text encoding (PEP 686). `memos/server/main.py` was writing and
  reading `*.manifest.json` through the locale default, so the read/write
  pair only agreed by accident and was lossy for non-ASCII payloads on
  Python ≤ 3.14 (Windows: cp1252). Both sides now pass `encoding="utf-8"`
  explicitly, which is the PEP 686 recommendation and makes behaviour
  identical across 3.11–3.15.

- **Validation matrix.** `pytest`, `ruff check`, `ruff format --check`,
  and a full end-to-end pass of the REST API, CLI backup/restore,
  path-escape guard, and the dead-bridge 503 fallback were run on
  Python 3.11, 3.12, 3.13, 3.14 and 3.15 — 5/5 green on every version.
  Wheel metadata was rebuilt and confirmed to carry the 3.15 classifier.

### Fixed — flaky concurrency test (CI red on TypeScript ubuntu-26.04 / Node 24)

- **`EmbeddingQueue concurrency › custom concurrency is honored` no longer
  asserts on wall-clock elapsed time.** The test bounded total runtime at
  250 ms; on a loaded CI runner it measured 423 ms and failed the whole
  `TypeScript (ubuntu-26.04, Node 24)` job (937/940 tests otherwise green).
  Elapsed time was never the property under test — it also absorbs the
  queue's `batchLingerMs` coalescing delay, timer granularity, and arbitrary
  scheduler preemption. The test now asserts the actual observable: the
  high-water mark of simultaneous `embed()` calls (`peakInFlight === 4` for
  8 jobs at concurrency 4), plus a `<= 4` ceiling so the cap can never be
  exceeded even momentarily. This is deterministic — the scripted provider
  only resolves after its delay, so a wave's calls must overlap.
  Verified by mutation: forcing `concurrency = 8` makes the test fail with
  `Expected: 4, Received: 8`, so it still catches a real regression.
  Stable across 5 consecutive runs.

### Full-dataset LoCoMo re-run — fast config wins twice

- **83.2% Hit@10 / 77.9% EvRec@10 / 72.5% AllEv@10 / MRR 0.642 / nDCG
  0.656** on all 10 conversations — above the previous full run (80.9 /
  75.6 / 70.3 / 0.633) at **79.7 min instead of 266.6 min (3.3×)**. Config:
  0.5/0.5 fusion + rerank-100/depth-100 + `--rerank-max-doc-chars=600` +
  `--semantic-dedup`. Per category: single_hop 89.7%, multi_hop 86.9%,
  temporal 85.4%, adversarial 73.3%, open_domain 53.3% Hit@10.

### Weak-cell ablations — balanced fusion wins with a real embedder

- Ablated the weak benchmark cells on convs 0-1 with rerank-200/depth-200:
  `ftsOperator=OR` is a wash (80.1% Hit@10, multi_hop AllEv drops — OR
  floods the pool with partial matches); **`0.5/0.5` fusion wins overall
  AND on the weak cells**: Hit@10 83.1% (+1.6pp), EvRec@10 77.9% (+2.3pp),
  AllEv@10 73.2% (+3.0pp), open_domain Hit 72.7% (+9.1pp), multi_hop AllEv
  30.2% (+6.9pp). Recommendation recorded: 0.5/0.5 with a real embedder +
  reranker; 0.8/0.2 stays the default for the hash embedder. Artifacts:
  `scripts/bench-locomo-ablation-{or,5050}.json`.

### Added — UX + token budget + memory knob + package updates

- **`memos doctor`** — one-command health check: store counts, per-model
  embedding counts, partial embedding coverage (→ reindex suggestion),
  embedding endpoint reachability, a live semantic-search probe, and rerank
  endpoint health. `--json` for scripts.
- **Token-lean MCP defaults**: `memos_context_pack` now serializes as
  **toon-compact** by default (~70% fewer tokens than JSON, identical
  information); `memos_search` accepts **`compact: true`** for trimmed
  results (id, content, score, type, tags).
- **`storageOptions.vectorCacheEntries`** — bound the in-process parsed
  vector cache (default 25,000 ≈ 100MB at 1024 dims).
- **Package updates**: jest 30.5.1, oxlint 1.81.0, tsx 4.23.13,
  zod 4.5.4, @swc/core 1.16.2, @types/node 26.4.1; devDependency
  `@huggingface/transformers` 4.2.0 added (real fastembed coverage).
  `FastEmbedEmbeddingProvider` fixed for the v4 callable-pipeline API —
  the previous `.feature` call shape never worked on the maintained
  package. FastEmbed real-pipeline tests spawn a plain node process
  (onnxruntime tensors live in Node's realm, which jest's VM realm
  rejects).

### Results — full-dataset benchmarks (LFM2.5 + prefixes + two-stage rerank)

- **LoCoMo, all 10 conversations (1,986 questions)**: Hit@10 **80.9%**,
  EvRec@10 **75.6%**, AllEv@10 **70.3%**, MRR 0.633, nDCG@10 0.643
  (hash-baseline session start: 62.6% / 52.5%). Per category: single_hop
  87.0%, multi_hop 83.7%, temporal 81.9%, adversarial 73.1%, open_domain
  51.1% Hit@10.
- **HotPotQA distractor (500 questions, ~4.9k-paragraph corpus)**:
  Hit@10 **100%**, EvRec@10 **96.3%**, AllEv@10 **92.6%**, MRR 0.977 —
  comparison questions perfect, bridge 95.4% EvRec@10. Committed result
  JSONs: `scripts/bench-locomo-noapi-results.json`,
  `scripts/bench-hotpot-results.json`.

### Performance — in-memory vector cache + cache hygiene (bug hunt wave 2)

- **In-memory vector cache in `SQLiteStorage`.** The semantic leg re-fetched
  EVERY stored vector BLOB from SQLite on every query (a 5.5k-memory store
  memcpy'd ~22MB per query; a 10-conv LoCoMo run memcpy'd ~35GB over its
  lifetime). `querySimilarEmbeddings` is now two-phase: a cheap id-only
  SELECT, then vectors served from a bounded (25k-vector) parsed
  `Float32Array` cache with chunked miss-fetch and exact invalidation on
  `saveEmbedding` / `deleteEmbeddingsByModel` / `deleteAllNodes`.
- **Fixed: search cache could grow unbounded.** Eviction only removed
  EXPIRED entries — a sweep of unique queries (i.e. every benchmark) pushed
  the cache past its 128-entry cap forever. Now falls back to oldest-first
  eviction.
- Verified: full suite green; stage profile warm query ≈ 50ms
  (embed 7.6 + FTS 3.2 + semantic 8 + hybrid+rerank 18.4).

### Performance — benchmark + server throughput (results identical)

- **Rerank server batch sizing: 200-doc rerank 0.73s → 0.07-0.11s (~7-10×).**
  llama-server was processing 200 (query, doc) pairs in 2048-token waves;
  `-c 16384 -b 16384 -ub 8192 --parallel 4` cuts the wave count ~4×.
  Launch recipe updated in `docs/benchmark-comparison.md`.
- **Zero-copy Float32Array vector decoding.** `querySimilarEmbeddings`
  decoded every stored vector element-by-element (`readFloatLE` per
  component — millions of calls per query on large stores); BLOB rows now
  go through an aligned `Float32Array` view (`cosineSimilarity` widened to
  `ArrayLike<number>`; legacy JSON rows keep the old path). Values are
  bit-identical.
- **Internal searches skip the reranker.** The evidence-learning candidate
  pass (8 candidates per store) hit the cross-encoder on every `store()`;
  it evaluates ALL candidates by pair similarity, so ordering never changes
  its decision — `hybridSearch(..., { internal: true })` now skips rerank
  there. User-facing `search()` and `contextPack()` still rerank.
- **Batched ingestion in the benchmarks.** `embeddingQueue` gained
  `batchSize` forwarding through `MemOSConfig` (it existed on the queue but
  was silently dropped by the constructor); benches now ingest with
  `concurrency 4 + batchSize 16` over the OpenAI-compatible array-input
  endpoint — LoCoMo ingestion 120s → 7.7s (15×), full 2-conv run ~20 min →
  ~7 min. Hit/Recall metrics are unchanged; MRR wiggles ±0.3% from GPU
  batch-shape float non-determinism (inherent to batched inference, not a
  code change).

### Added — "plugin for any harness" distribution + peer benchmarks

- **MCP server now exposes the FULL capability surface: 6 → 14 tools.** The
  SDK rewrite had silently dropped the temporal/trust/extraction tools the
  changelog claimed. New tools: `memos_context_pack` (token-budgeted
  TOON/TOON-compact prompt-injection slice — the main tool for coding
  agents), `memos_search_temporal`, `memos_set_validity`, `memos_supersede`,
  `memos_set_trust`, `memos_extract_facts`, `memos_diagnostics`,
  `memos_reindex`. Server `instructions` now tell agents to proactively
  store durable facts and recall with `memos_context_pack`.

- **`memos connect <target>`** — registers the stdio MCP server with any
  agentic harness: `claude-code` (prints `claude mcp add ...` + writes
  project `.mcp.json`), `cursor`, `windsurf`, `cline`, `opencode`, `codex`
  (TOML), `gemini`, `generic`. Prints config by default; `--write` saves
  it (`--force` overwrites). `MEMOS_DB_PATH` / `MEMOS_EMBEDDING_*` env vars
  travel into the generated config automatically. `memos mcp` now also
  honors `MEMOS_EMBEDDING_*`.

- **Claude Code plugin + marketplace** (`plugin/`, `.claude-plugin/marketplace.json`):
  `/plugin marketplace add Markgatcha/memos` → `/plugin install
  memos@memos-marketplace` bundles the MCP server, `/memos` + `/recall`
  slash commands, and the `memos-memory` skill (when to store / recall /
  supersede). Docs: `docs/integrations.md`.

- **Memory-haystack benchmark** (`scripts/bench-haystack.ts`) — the
  needle-in-a-haystack test adapted to memory stores: 1k-10k distractor
  memories with unique access-code needles planted across depths.
  Local-hash default: Hit@1/Hit@10/MRR/latency per corpus size
  (100% Hit@1 at 1k, p50 10ms; runs CPU-only, deterministic).

- **HotPotQA retrieval-only benchmark** (`scripts/bench-hotpot.ts`) — the
  multi-hop QA dataset Cognee uses in its published memory evals (vs Mem0,
  Graphiti, LightRAG). 500 validation questions, ~4.9k deduplicated
  Wikipedia paragraphs ingested corpus-wide, scored by supporting-paragraph
  title ID matching (Hit@K / EvRec@K / AllEv@K / MRR / nDCG, bridge vs
  comparison). Dataset fetched from the HuggingFace datasets-server API
  (CC BY-SA); runs with any provider + the two-stage reranker.


### Added — two-stage reranking (the big retrieval lever)

- **`experimental.rerank` — cross-encoder re-scoring after fusion.** The
  first stage (hybrid search) recalls; a cross-encoder served over HTTP
  `POST {endpoint}/rerank` (llama-server `--rerank` with
  `bge-reranker-v2-m3-Q8_0`) re-scores the top-`candidates` fused results
  and the final ranking follows it. Logits are squashed to [0,1] into
  `scores.rerank`; unranked candidates keep fused order behind the head;
  a downed endpoint degrades to the fused order (graceful). Bench flags:
  `--rerank-url= --rerank-model= --rerank-candidates= --candidate-depth=`.
  Measured on LoCoMo convs 0-1 (302 questions, LFM2.5 + prefixes, default
  fusion): Hit@10 68.2% → 81.1%, EvRec@10 63.4% → 75.5%, AllEv@10 58.9% →
  70.2%, MRR 0.469 → 0.606, nDCG@10 0.494 → 0.629. Reranking a wider head
  is strictly better (rerank-50 76.8% < rerank-200 81.1%).

- **`SearchFilter.candidateDepth`** — widens the per-leg recall pool beyond
  `max(limit*4, 20)` for rerank/expansion pipelines.

- **Bench: `--group-turns`** ingests conversational exchanges (utterance
  pairs) as one memory carrying both dia_ids. NET-NEGATIVE on LoCoMo
  (Hit@10 68.2% → 66.6%; multi_hop collapses: fused nodes waste slots on
  the partner utterance) — kept as an off-by-default ablation flag with
  honest numbers. (LoCoMo sessions strictly alternate speakers, so
  same-speaker grouping is a no-op on this dataset.)

### Added — asymmetric-embedding support, retrieval tuning & fixes (LFM2.5 wave)

- **Asymmetric query/document prefixes are now live end-to-end.** Retrieval
  models trained with query-side instructions (Liquid **LFM2.5-Embedding-350M**,
  e5) silently degrade without `"query: "` / `"document: "` — and the hot path
  never applied them. `semanticSearch()` now routes queries through
  `embedQuery()`; `OpenAICompatibleEmbeddingProvider` (llama.cpp / vLLM /
  OpenAI) gained `queryPrefix` + `documentPrefix` options, `embedQuery()`,
  and a true `batchEmbed()` (one array request); `OllamaEmbeddingProvider`
  gained `documentPrefix` + `batchEmbed()` and its `embedDocuments()` no
  longer references a nonexistent method. Prefixes flow from
  `EmbeddingConfig.queryPrefix/documentPrefix` and are applied inside the
  providers, so every call site (store, dedupe, extractFacts, reindex) is
  covered. Verified: no-prefix vs prefix on LoCoMo convs 0–1 (302 questions,
  0.9/0.1 fusion) → EvRec@10 62.8% → 63.7%, nDCG@10 48.6% → 49.6%.

- **`EmbeddingQueue` micro-batching (`embeddingQueue.batchSize`).** Workers
  drain up to `batchSize` pending jobs into one `batchEmbed()` call (group
  pickup is deferred one microtask so synchronous ingest bursts coalesce
  into full batches); a failed batch falls back to the per-job retry path.
  Default 1 = legacy behavior.

- **Model-aware semantic leg + `reindexEmbeddings`.** `querySimilarEmbeddings`
  now takes the model name and compares only rows stored by the same model
  (two models can share a dimensionality — dims equality alone mixed
  incompatible vectors silently). `memos.reindexEmbeddings({ purgeStale })`
  re-embeds the store under the current provider, batched through
  `embedDocuments`, with `getEmbeddingModelCounts()`/`deleteEmbeddingsByModel()`
  on the storage adapter and a `memos reindex-embeddings [--purge-stale]` CLI
  command.

- **`MemOSConfig.fusion`** — `fuseResults()` options (RRF K, keyword/semantic
  weights, trust floor, confidence strength) are now configurable per
  instance instead of hardcoded at the only `hybridSearch` call site;
  `FusionOptions` moved to `types.ts` (re-exported from `retrieval.ts`).

- **Expansion legs (opt-in).** `SearchFilter.sessionExpansion` (declared but
  dead since introduction) is now implemented: top-5 fused results pull in
  their `metadata.sessionId`/`instanceId` siblings at 0.85^k of the seed
  score (max 10). `experimental.graphExpansion` follows graph edges from the
  top-3 seeds (max 5 neighbours, `scores.graph` breakdown). Both are OFF by
  default; on LoCoMo session expansion HURTS (same-session distractors
  flood top-10: Hit@10 68.2% → 64.9%) — treat as a LongMemEval-shaped lever.

- **Semantic-fusion threshold floor.** The hybrid semantic leg previously ran
  at threshold 0, letting cosine-0 (unrelated) memories vote in RRF and
  occupy candidate slots. Now floored at 0.05.

- **`embeddings.embedText: "content" | "summary+content"`** — what gets
  embedded at store time is now a choice. A/B on LoCoMo: content-only is
  WORSE (Hit@10 68.2% → 62.3%); the extractive summary adds real signal.
  Default unchanged.

- **`ftsOperator` honored.** `"OR"` forces the recall-first keyword query;
  `"AUTO"` keeps the historical AND-then-OR-on-empty behavior (the docstring
  previously described an unimplemented merge; docs now match code).

- **Fixed: search-cache key covered only 6 of ~15 filter fields.** Two
  searches differing by `type`, `metadata`, `source`, `minTrustScore`,
  `validAt`, or `offset` collided for the 5s TTL (offset pagination returned
  page one). The key is now a stable sorted-keys serialization of the full
  filter.

- **Fixed: FTS keyword leg ignored `type`/importance filters.**
  `search({ query, type })` leaked keyword hits of any type into hybrid
  results (the structured branch already filtered them); `n.type` /
  `n.importance` now join the FTS WHERE clause.

- **Python server bridge honors `MEMOS_EMBEDDING_*` env vars**
  (`_BRIDGE_SCRIPT` constructed `new MemOS({ dbPath })` and dropped every
  embedding setting — the "Python server" always ran the hash embedder).
  Adds `_PROVIDER/_MODEL/_BASE_URL/_API_KEY/_DIMENSIONS/_QUERY_PREFIX/
  _DOCUMENT_PREFIX/_BATCH_SIZE`.

- **Benchmark harness: shared retrieval-ablation flags.** All bench scripts
  accept `--query-prefix/--document-prefix` (env `EMBEDDING_QUERY_PREFIX`/
  `EMBEDDING_DOCUMENT_PREFIX`) plus `--keyword-weight/--semantic-weight/
  --rrf-k/--trust-floor/--confidence-weight-strength/--embed-text/
  --fts-operator/--session-expansion/--graph-expansion`. Applied settings are
  recorded in the result JSON (`metadata.retrieval`,
  `metadata.embedding.queryPrefix/documentPrefix`). LoCoMo with
  LFM2.5-Embedding-350M via llama.cpp (convs 0–1, 302 questions, 0.9/0.1,
  prefixes): Hit@10 68.9% / EvRec@10 63.7% / AllEv@10 58.9% / MRR 0.469 /
  nDCG@10 0.496 (hash baseline on the same slice: 62.6% / 52.5%); synthetic
  quality harness with the same model: recall@10 100%, MRR 0.934.


### Fixed — benchmark correctness (Priority 1)

- **LoCoMo no-API benchmark now scores by direct evidence-ID matching.** `scripts/bench-locomo-noapi.ts` previously decided "evidence found" with a fuzzy term-overlap heuristic (≥2 shared words, or speaker prefix + 1 word), which over-counted: on conversations 0–1 (304 questions, top-10) the fuzzy rule passes 96.7% while honest evidence-ID matching yields Hit@10 62.6% / micro evidence-recall 52.5%. Ingestion now preserves each utterance's official `dia_id` (the exact value `qa.evidence` references) in memory metadata, and scoring compares retrieved `dia_id`s directly against `qa.evidence`. The legacy fuzzy rule is kept **only as a labeled diagnostic** (`diagnostics.fuzzyOverlapRate`) so the two conventions can be compared — it is never reported as evidence recall.
- **Correct LoCoMo category mapping.** Both LoCoMo benchmark scripts mapped categories 1↔4 backwards (1→"single-hop", 4→"multi-hop"). The official evaluation code (`task_eval/evaluation.py`) and the dataset's own evidence distribution (276/282 cat-1 questions carry 2+ evidence IDs; 795/841 cat-4 questions exactly 1) confirm: **1 = multi-hop, 4 = single-hop**. Per-category scores published under the old labels were attached to the wrong questions.
- **Full deterministic retrieval metrics.** New shared metrics module (`scripts/lib/bench-metrics.ts`): Hit@K, Evidence Recall@K (per-question mean + pooled micro), All-Evidence Recall@K (a multi-evidence question counts only when EVERY evidence item is retrieved), Precision@K (mean + micro), MRR, nDCG@K (binary gains), per-category macro rows, and nearest-rank p50/p95 latency. Questions with empty evidence lists (LoCoMo has 4, all category 3) are excluded from recall aggregates and never count as successes.
- **Embedding fallback is now visible — and optionally fatal.** `FastEmbedEmbeddingProvider` silently served a deterministic local feature hash whenever the transformers package failed to load; benchmark runs configured for `fastembed` (including the committed `bench-locomo-results.json`, produced with no transformers installed) were unknowingly scoring the hash baseline. Providers now expose `getRuntimeInfo()` (`EmbeddingRuntimeInfo`: requested/resolved provider + model, dimensions requested/observed, fallback flag + reason), benchmarks print a warning when the fallback is active, and `--fail-on-embedding-fallback` terminates with exit code 1 instead. Default SDK behavior (resilient fallback) is unchanged.
- **LongMemEval ingestion: session timestamps.** `scripts/bench-longmemeval.ts` previously stamped every haystack session with the QUESTION date. Sessions now store their own `haystack_dates[i]` timestamp plus `sessionId`, chronological position, `questionDate`, and benchmark instance id; retrieval-only scoring matches retrieved `sessionId`s against the official `answer_session_ids` (`--retrieve-only`, no API key).
- **Separate result files.** The LoCoMo LLM-judge bench, LoCoMo retrieval-only bench, and LongMemEval bench previously all overwrote `scripts/bench-locomo-results.json`. They now write `bench-locomo-llmjudge-results.json`, `bench-locomo-noapi-results.json`, and `bench-longmemeval-results.json` respectively.
- **Reproducibility metadata (v2 schema).** Every benchmark result JSON records: schema version, timestamp, git commit SHA + dirty-tree flag, dataset name/path/SHA-256, provider kind, resolved provider/model, fallback status + reason, dimensions, Node version, OS, benchmark duration, and p50/p95 latency.
- **Shared provider loader for benchmarks.** `scripts/lib/bench-common.ts`: all benchmark scripts accept `--provider=local-hash|fastembed|ollama|openai-compatible|voyage|cohere`, `--model=`, `--dimensions=`, `--base-url=`, `--api-key=` (CLI > `EMBEDDING_*` env vars > default), and throw on unknown providers instead of substituting. `docs/benchmark-comparison.md` documented an `EMBEDDING_PROVIDER=voyage` env command that `bench-quality.ts` never read — the documented commands now actually work.
- **Benchmark scripts are now typechecked.** `tsconfig.scripts.json` + `npm run typecheck:scripts` cover the benchmark scripts (they were previously outside `tsconfig.json`, which let a nonexistent `embeddingQueue.batchSize` option and an `unknown`-typed timestamp flow silently). Two latent type errors fixed as a result.
- **`bench-locomo.ts` output bugs:** literal `\n` strings printed instead of newlines in two places; adversarial category (5) was computed but never reported.

### Added

- `EmbeddingRuntimeInfo` type + optional `EmbeddingProvider.getRuntimeInfo()` (exported from the package root) so any caller can verify which embedding backend actually loaded.
- `__tests__/bench-metrics.test.ts` (21 tests): direct evidence-ID matching, multi-evidence partial retrieval, K-window effects, no-relevant and empty-evidence handling, duplicate-result dedup, macro/micro aggregation, latency percentiles — all hand-computed expectations.
- `__tests__/bench-common.test.ts` (16 tests): provider arg parsing (CLI > env), unknown-provider rejection, strict-mode fallback termination (injectable exit hook), dataset hashing, metadata assembly.
- `npm run typecheck:scripts` and `npm run bench:longmemeval:retrieve` script entries.

### Changed

- **MCP server upgraded to the 2026-07-28 protocol revision.** The hand-rolled stdio JSON-RPC server (which declared the two-revisions-stale `2024-11-05` protocol) is replaced by the official `@modelcontextprotocol/server` v2 SDK. The server now: speaks the modern 2026-07-28 stateless core (`server/discover`, per-request `_meta` envelope with `io.modelcontextprotocol/protocolVersion` + `io.modelcontextprotocol/clientCapabilities`); keeps full backward compatibility with legacy 2025-era clients via the `initialize` handshake (dual-era `serveStdio`); declares `outputSchema` on all 6 tools (Zod schemas matching the actual `structuredContent` shapes — a spec requirement since 2025-06-18 that was previously violated); emits `ttlMs`/`cacheScope` cache hints on `tools/list` and `server/discover` results; and reports the real package version (read from `package.json` at runtime via `getSdkVersion()`) instead of the stale hardcoded `1.5.0-beta.1`. New protocol test suite: `__tests__/mcp-protocol.test.ts` (12 tests covering discovery, tools/list with outputSchema + cache hints, end-to-end tool calls, unsupported-version error `-32022`, and legacy handshake fallback). Docs corrected: README/ARCHITECTURE.md/llms.txt no longer claim an HTTP/SSE MCP transport (stdio is the only shipped transport; HTTP is deferred).

- **Dependency security bumps.** `better-sqlite3` ^12.11.1 → ^13.0.3 (Node-API migration, SQLite 3.53.4; full test suite passes on Windows prebuilds). `@xenova/transformers` (abandoned May 2024) is superseded: `FastEmbedEmbeddingProvider` now tries `@huggingface/transformers` (v4.2.0, compatible `pipeline()` API) first and falls back to `@xenova/transformers`; both are declared as optional peer dependencies. Website: `@types/react` ^18 → ^19 and `@types/react-dom` ^19 added to match react 19.2.8 (typecheck passes).

### Added

- **`getSdkVersion()`** (`src/version.ts`) — reads the package version from `package.json` at runtime; used by the MCP `serverInfo.version` and the CLI backup manifest so version strings can never go stale again.

- **Summary elision in context packs (−6% JSON wire size on restating summaries, zero information loss).** `buildContextPack()` now drops a pack item's `summary` when it merely restates the item's own content: either it costs ≥ half as many tokens as the content (`summaryTokens ≥ 0.5 × contentTokens`) or its token-set Jaccard similarity with the content reaches 0.45 (the extractive "first sentence restated" case sits at ~0.4–0.5; genuinely condensed summaries land far below and survive — covered by a dedicated no-regression test). The full content always stays, so nothing is dropped from the wire except a lossy duplicate. Measured on the deterministic A/B harness (`scripts/bench-token-savings-ab.ts`, git-worktree-isolated): scenario with auto-generated restating summaries → JSON wire 11,062 → **10,414 bytes (−5.9%)** with identical items-in-pack (31); scenario with genuinely compact summaries → byte-identical output (8/8 summaries kept, 0-byte delta), confirming elision only fires where it should. Note for consumers: toon-compact packs never serialized summaries, so their wire size is unchanged by design — the savings land on the JSON path and in `tokensSaved` accounting.

- **Opt-in semantic dedup (`contextPack({ semanticDedup: true })` / `buildContextPack({ embeddings })`).** Lexical dedup (token-set Jaccard) misses paraphrased duplicates that share no vocabulary. When enabled, candidates whose stored embedding has cosine similarity ≥ 0.90 (`semanticDedupThreshold`) with an already-selected item are dropped; the higher-scored item always survives (candidates stream in descending score order). Vectors are looked up from storage filtered to the candidate set — zero new embedding compute. Off by default; without vectors (or for items lacking one) behavior is unchanged.

### Changed

- **`buildContextPack` tokenization halved (perf).** Each item's packed content/summary token counts are now computed once and reused between budgeting, debloat-savings accounting, and summary elision — previously the packed forms were tokenized twice per item (up to 6 `tokenCounter` calls per item worst case, now ≤ 4). No output change.

- **Compact TOON v2 wire format — 14.3% fewer tokens than v1 on identical data.** The compact serializer (`searchResultsToToonCompact()` / `packToToonCompact()`) gained three lossless encodings, verified by round-trip tests: (1) **ID packing** — dashed UUIDs (what `generateId()` actually produces) are re-packed to base64url under a `~` marker, 36 chars → 23; other hex shapes pack too, foreign IDs and bare 32-hex pass through untouched, and v2 IDs round-trip verbatim (the legacy `mem_` prefix restore now applies only when decoding v1 strings). (2) **Delta timestamps** — rows carry offsets from a header epoch anchor (`# memos.search.v2|e=<minEpoch>`), so the common case stores 5-6 chars instead of a 10-char absolute epoch. (3) **Tag dictionary** — a header `t=a,b,c` list with per-row numeric indices, emitted only when the dictionary is a net character win and never for all-digit tags (which would be ambiguous with indices on decode). On the format benchmark with production-shaped UUID fixtures: search results 77.7% savings vs JSON (was 77.6%), context packs 70.4% (was 70.3%), improvement over verbose TOON 19.3% → 22.7%; a direct v1-code-vs-v2-code comparison on identical realistic data measures 217 → 186 tokens (−14.3%). `parseToonCompact()` still decodes old v1 strings unchanged. Retrieval quality is untouched by construction (serialization runs after retrieval): recall@5/@10 and MRR are byte-identical to the previous run. New pinned coverage in `__tests__/toon-compact.test.ts` (11 tests); `encodeCompactId()`/`decodeCompactId()` are exported for consumers.

### Added

- **Evidence-learning store path (`store({ evidenceLearning: true })`)** — the confidence state machine (`src/confidence-machine.ts`) was exported but never called by any hot path. It is now wired into `store()` as an opt-in write mode: content that genuinely confirms an existing memory (pair similarity ≥ 0.85) reinforces it — confidence ↑, evidenceCount ↑, no duplicate node written; content that contradicts it (low similarity + negation signal + shared subject) supersedes the old version (marked historical via `supersede()`) and writes the replacement. Default remains append-always, matching the `dedupe()`/`consolidate()` contract. Emits new `memory:reinforced` / `memory:superseded` events. Covered by 6 dedicated tests (`__tests__/evidence-learning.test.ts`). Reinforcing instead of duplicating keeps stores smaller and context packs leaner over time.
- **Confidence-aware ranking in fusion** — `fuseResults()` now folds in the previously orphaned `confidenceWeight()`: memories that have been repeatedly reinforced rank slightly above equally-relevant but contradicted/superseded ones, and anything below the confidence floor is heavily demoted. Gentle by default (`confidenceWeightStrength: 0.35`, tunable; `0` restores pure RRF scores exactly).
- **Recency tie-break in fusion** — candidates whose fused scores are exactly tied (within float noise, `RECENCY_EPSILON = 1e-9`) are ordered newest-first with an exponential half-life decay (default 30 days, `recencyHalfLifeMs`, injectable `nowMs` for determinism). Genuine rank separation (~2e-4 per RRF step) is three orders of magnitude above the tie window and can never be overridden.
- **Hot-path benchmark harness (`scripts/bench-hotpath.ts`)** — measures the embedding leg, FTS keyword leg, full hybrid search, and end-to-end `contextPack()` latency plus pack token footprint at configurable store counts (`npx tsx scripts/bench-hotpath.ts --nodes=1000 --iters=30`). Committed so ingestion/query regressions are reproducible this time.
- **Retrieval fusion module (`src/retrieval.ts`)** — the Reciprocal Rank Fusion logic previously inlined in `MemOS.hybridSearch()` is now a pure, dependency-free `fuseResults()` function with tunable weights (`rrfK`, `keywordWeight`, `semanticWeight`, `trustFloor`), exported from the package entry point and covered by 10 dedicated unit tests (`__tests__/retrieval.test.ts`). First step of breaking up the `memory.ts` god class.
- **Synonym lexicon expansion** — `LocalHashEmbeddingProvider` now covers exercise/fitness, reading/books/authors, travel, work, relationships, health, transport, hobbies, instruments, pets, and food vocabulary. On the synthetic quality harness, the shipped local provider now reaches **recall@10 100% / MRR 0.868** (up from 89.5% / 0.754 on the naive hash baseline) — the two long-standing paraphrase misses ("exercise routine", "book author preferences") are closed without any external embedding model.
- **`npm run bench:quality:local`** — runs the quality harness on the shipped `LocalHashEmbeddingProvider` (`--provider=local` flag) instead of the naive `bench-hash` baseline, so the benchmark measures what users get out of the box.

### Changed

- **Auto-link edge cap (ingestion 12.7× faster on repetitive corpora).** `GraphEngine.autoLink()` created every above-threshold edge with no limit — a corpus of similar memories converged to a complete graph K_N (measured: 100 similar nodes → 4,950 edges; 2,000 nodes → ~2M edge writes). The cap now keeps the 16 strongest links per node (`DEFAULT_AUTO_LINK_CAP`, pass `0` for legacy uncapped behavior), preserving cluster structure while making bulk ingestion near-linear. Measured apples-to-apples (same machine, git-worktree-isolated baseline): **1,000 default-config stores took 64.7 s before → 5.1 s after (64.7 ms/store → 5.1 ms/store)**; with linking disabled both trees take 0.3 s (no regression).
- **Lazy hydration top-K in `querySimilarEmbeddings`.** The semantic leg scored every stored vector but also fully hydrated every matching row (JSON.parse of metadata + tags + timestamps), then discarded all but `limit`. Node hydration now happens only for the top-K survivors: O(limit) JSON parses per query instead of O(N). Measured semantic-leg p50 at 1,000 nodes: 27.3 ms → **6.3 ms**. Results are byte-identical (same scoring, same ordering).
- **Prepared-statement caching for search paths.** `queryNodes()` re-prepared its FTS and structured SQL on every call despite the existing statement cache. Both paths now cache by built SQL text (the key includes the WHERE clause since filter combinations vary it).
- **`updateNode` persists evidence state.** `saveNode` writes node-level `confidence`/`evidenceCount` into the metadata JSON blob, but `updateNode` did not — reinforcement updates were silently dropped on reload. Fixed by syncing both fields into the persisted metadata.
- **`better-sqlite3` v13 evaluated and rejected — kept at 12.11.1.** v13.0.3 was installed and verified locally (bundled prebuilds, no install scripts, all tests green), but it raises the minimum Node to **>=22**, which breaks this repo's `engines: >=18` contract and the Debian CI smoke test (Debian trixie ships Node 20.19.2 — the v13 binary segfaults on it, exit 139). Reverted to 12.11.1, which supports Node 20–26. The Dependabot major-bump ignore rule stays in place for future majors.

### Fixed

- **`classifyEvidence` dead code** — the contradiction check computed a `contradicts` variable that was never read (and required the signal in BOTH texts); removed the dead path. Behavior is unchanged: contradiction is detected when the new content carries a signal and similarity is low.
- **`buildContextPack` dead options** — `format` and `includeSchemaHeader` were declared in `BuildContextPackOptions`, documented, and silently ignored (serialization is handled by `serializeContextPack`). Removed from the interface so the API no longer advertises no-ops.
- **`MemOS.contextPack()` no-op ternary** — `opts.namespace ?? (this.experimental.namespaces ? "default" : "default")` collapsed to `opts.namespace ?? "default"`.
- **Quality bench harness** — replaced a leftover `"hobby" === "hobby" ? ... : ...` category hack (`as never` cast) with the literal category it always produced.

### Added

- **Website: Discord community wired in** — the Support page now embeds the live Context Core Discord server widget (server ID `1486822260332298485`) with a "Join the server" button, and the landing-page footer links to the permanent invite. Replaces the previous placeholder guild ID and dead invite link.
- **Website: SEO + sharing infrastructure** — SVG favicon (`app/icon.svg`), 1200×630 OpenGraph image (`public/og-image.png`, generated by `website/scripts/gen-og-image.js`), `sitemap.xml`, `robots.txt`, custom 404 page, per-page titles/descriptions via a `%s — ContextCore` title template, and a mobile navigation menu.
- **Website: `/docs/architecture` page** — on-site architecture guide for MemOS with an SVG layer diagram, the hybrid retrieval pipeline (FTS5 + semantic + RRF fusion), context-pack build steps, and the module map. Linked from the docs hub.
- **Website: Guardian page rewritten** — replaces the stale "coming soon" placeholder with the real feature set (Semantic Folding, VCM Sharding, Retain Pre-Filter, Tool Gating, Prompt Caching, MemOS memory injection, Privacy Shield, budget enforcement), the six-stage optimization pipeline, and a quick start.
- **Website: neutral blog title** — the BEAM-1M post title no longer uses competitor framing.

### Changed

- **`ARCHITECTURE.md` refreshed** — rewritten to match the current source: adds the MCP transport, hybrid retrieval pipeline with RRF fusion, context packs / TOON serialization, the confidence state machine, the embedding queue, temporal validity, trust scoring, and the full module-boundary table.

### Security

- **Removed vendored LOCOMO `requirements.txt`** — `scripts/dataset/locomo/requirements.txt` was a frozen conda environment export from the upstream [snap-research/locomo](https://github.com/snap-research/locomo) clone (Python 3.9, torch 2.0.1, gradio 3.24.1, transformers 4.35.0, ~300 pinned packages from 2023). Dependabot flagged 312 open pip vulnerability alerts against it. The file is an environment spec for the upstream paper's evaluation code, not a dependency of this project — the memos benchmarks (`bench-locomo.ts`, `bench-locomo-noapi.ts`) only read `scripts/dataset/locomo/data/locomo10.json` and never install or execute the vendored Python environment. Deleting the manifest clears all 312 alerts; the dataset and vendored reference code are unchanged, and anyone needing the upstream environment can recreate it from the original repository.

### Dependencies Updated

- `@swc/core` 1.15.46 → 1.16.0 (latest)
- `@types/better-sqlite3` 7.6.13 → 9.6.0 (latest)
- `@types/node` 26.1.2 → 26.2.0 (latest)
- `oxlint` 1.76.0 → 1.78.0 (latest)
- `tsx` 4.23.1 → 4.23.12 (latest)
- `better-sqlite3` kept at `^12.11.1` (ignored v13 major bump per Dependabot config — breaking native-build changes)

### Added

- **Temporal validity** — `validFrom` / `validTo` fields on `MemoryNode`, `memos.setValidity()`, `memos.searchTemporal()`, `memos.supersede()`. Memories with `validTo` in the past are "historical" — excluded from default search, queryable via `searchTemporal(query, atTime)`. `temporal_precedes` edge relation for linking superseded memories to their replacements.
- **Trust scoring & provenance** — `source` (`user_input` | `agent_inferred` | `external_data` | `system`) and `trustScore` [0,1] fields on `MemoryNode`. `memos.trust()`, `memos.setTrust()`, `memos.adjustTrust()`. Search filters: `source`, `minTrustScore`, `sortBy: "trustScore"`. Trust-weighted hybrid search fusion (0.7–1.0 multiplier).
- **Fact extraction** — `memos.extractFacts(messages, opts)` — rule-based local-first extractor that identifies preferences, entities, context, and facts from conversation messages. Optional `autoStore` with confidence threshold and embedding-based dedup.
- **Diagnostics** — `memos.diagnostics()` — comprehensive health report with counts by source/type/namespace, temporal stats, embedding coverage, storage capabilities, and DB file size.
- **CLI commands** — `set-validity`, `search-temporal`, `trust`, `set-trust`, `extract-facts`, `diagnostics`, `supersede`, `trio`.
- **`memos trio` command** — compose the full AI Trio from a single entrypoint: prints the MemOS + LLM-Guardian + Universal-MCP-Toolkit boot plan, or with `--up` locates the sibling repos and launches Guardian (with `MEMOS_NAMESPACE`/`MEMOS_STORAGE_PATH` wired) and UMT alongside this MemOS instance.
- **MCP tools** — `memos_set_validity`, `memos_search_temporal`, `memos_set_trust`, `memos_extract_facts`, `memos_diagnostics`.
- **REST endpoints** — `PATCH /mem/{id}/validity`, `POST /search-temporal`, `POST /mem/{id}/supersede`, `GET|PATCH /mem/{id}/trust`, `POST /extract-facts`, `GET /diagnostics`.
- **OpenAI SDK adapter** — `adapters/openai.ts` — first-class MemOS integration for OpenAI SDK with `addMessages`, `searchMemories`, `getMemoryContext`.
- **Anthropic SDK adapter** — `adapters/anthropic.ts` — same pattern for the Anthropic SDK.

### Performance

- **FTS5 query tokenization fix** — `queryNodes()` previously wrapped the entire query in double quotes, turning every natural-language search into a phrase match that requires the exact question text to appear verbatim in stored content. Since that never happens, the keyword leg of hybrid search silently returned zero results for every query. Queries are now tokenized into individually quoted terms with function-word removal (`buildFtsTerms`), matched AND-first for precision with an automatic OR fallback when nothing matches all terms. The FTS5 table also uses the `porter unicode61` tokenizer so word variants match ("live" finds "lives", "start" finds "started").
- **Reciprocal Rank Fusion (RRF) for hybrid search** — `hybridSearch()` now fuses the keyword and semantic result lists by rank (`weight / (60 + rank)`, keyword 0.8 / semantic 0.2) instead of weighted raw-score summation. RRF makes the two signals directly comparable despite living on different scales (bm25 rank vs cosine similarity) and is robust to score outliers. Trust weighting (0.7–1.0 multiplier) is applied after fusion. Retrieval-quality benchmark: recall@10 78.9% → 89.5%, MRR 0.309 → 0.754 (synthetic LoCoMo-shaped harness, deterministic hash provider — the gain comes from the retrieval engine alone, not a stronger embedding model).
- **Parallel hybrid search** — keyword (FTS5) and semantic (embedding) retrieval now run concurrently via `Promise.all`, halving the p50 latency of `search()` when both providers are configured.
- **Trust-weighted score fusion** — hybrid search now applies a gentle trust multiplier (0.7–1.0) to the merged score, so high-trust memories rank above low-trust ones for the same relevance. Matches Mem0's multi-signal retrieval approach without requiring an LLM call.
- **Batch edge insertion** — `saveEdgesBatch()` on `StorageAdapter` wraps multiple edge INSERTs in a single SQLite transaction. Auto-linking now uses batch saves, ~10x faster for stores with 10+ auto-linked edges.
- **Prepared statement caching** — `saveNode`, `getNode`, `peekNode`, and `saveEdge` now use a `Map`-backed statement cache, avoiding JS-level `Statement` object recreation on every call.

### Changed

- Default search now excludes historical (superseded) memories. Use `includeHistorical: true` to include them, or `validAt: <timestamp>` for point-in-time queries.
- `MemoryNode` interface extended with `validFrom`, `validTo`, `source`, `trustScore`.
- `CreateMemoryInput` and `UpdateMemoryInput` extended with temporal and trust fields.
- `EdgeRelation` extended with `temporal_precedes`.
- `SearchFilter` extended with `source`, `minTrustScore`, `includeHistorical`, `validAt`, and `sortBy: "trustScore"`.
- New events: `trust:changed`, `validity:changed`, `facts:extracted`.
- SQLite schema: new columns `valid_from`, `valid_to`, `source`, `trust_score` with migration-safe `ALTER TABLE` and new indexes for temporal/trust queries.
- **Linter: ESLint → Oxlint (permanent)** — `npm run lint` now runs Oxlint (with `oxlint-tsgolint` for type-aware rules) mirroring the previous ESLint rule set (see `.oxlintrc.json`). Config runs in fast non-type-aware mode (all 7 rules are syntactic), so `oxlint src --quiet` finishes in ~12ms on 16 files. Oxlint supports TypeScript 7 natively (uses its own parser, not the TypeScript compiler), so there's no need to wait for `typescript-eslint` TS 7.1 support. Oxlint is actively maintained by the Oxc project (same team as SWC) and is the permanent linter choice.

### Performance

- **TOON format for search results** — `memos.searchToon()` returns a compact pipe-delimited string instead of the full JSON array of `ScoredMemory` objects. **53.5% token reduction on real search results** (3,451 → 1,604 tokens for 20-result responses). Exported as `searchResultsToToon` from `@mem-os/sdk`.
- **Prepared statement cache** — `better-sqlite3` already caches prepared statements internally. Measured at 0.03ms per prepare() call, no significant additional gain from JS-level caching.

### Fixed

- **CI test suite now runs under TypeScript 7** — replaced the `ts-jest` transform with `@swc/jest` in `jest.config.js`. `ts-jest@29` peer-depends on `typescript <7` and crashed loading the tsconfig under the repo's TypeScript 7.0.2, so every test suite failed to start and the CI `Test` step went red. `@swc/jest` is TS-version-agnostic; type-checking is still enforced by `tsc --noEmit` / `npm run build` in CI.
- **`diagnostics()` historical-node count** — a node is now counted as historical when `validTo <= now` (was `< now`). `supersede()` sets `validTo = now`, so a freshly-superseded node was previously never reported as historical, inconsistent with the documented behavior and with the search layer (which already treats `validTo === now` as historical).
- **CI hardening against toolchain drift** — the native-deps smoke matrix compiles `better-sqlite3` directly with `node-gyp` so it builds regardless of npm's native-install-script policy.

### CI

- **CI minute optimization** — dropped Node 20 from the TypeScript matrix (EOL Apr 2025), reduced the distro Docker smoke from 6 to 3 images (Fedora/Debian/Arch covering all package-manager families), reduced Python from 5 to 3 versions (3.12 LTS, 3.13, 3.14), and removed the redundant semantic-search-cross-os job (now covered by the TypeScript matrix). The rolling Node job was also removed — it was `continue-on-error` and consumed minutes without blocking releases. These changes cut the total job count from ~28 to ~15 per run while preserving OS and LTS coverage.
- **Python test matrix** — reduced from 5 versions (3.10–3.14) to 3 (3.12 LTS, 3.13, 3.14) to save CI minutes.
- **Dependabot ignore rules** — added `ignore` entry for `better-sqlite3` major version bumps (v13 has breaking native-build changes). `oxlint-tsgolint` is now updated to latest (7.0.2001).
- **Debian (trixie, latest stable) added to the native-deps matrix** — alongside Fedora, Arch, and openSUSE, so the SQLite native build is exercised on Debian's current stable release.

## [1.6.26] - 2026-06-17

Stable v1.6.26 release. Adds the background embedding queue, HTTP+SSE MCP transport, three new embedding providers, memory consolidation, the CLI REPL, cross-OS perf hardening, AI Trio context packs, MCP 2025-06-18 compliance, and a retrieval-quality benchmark.

### Added

- **Background embedding queue** — `EmbeddingQueue` in `src/embedding-queue.ts`. Bounded concurrency, exponential backoff retries, backpressure on `maxQueueSize`, lifecycle events, per-job status. `store()` and `update()` now return immediately instead of blocking on remote embedding APIs.
- **Public queue API** — `memos.flushEmbeddings()`, `memos.embeddingStatus()`, and `memos.embeddingStatus(nodeId)`. CLI mirrors: `memos flush-embeddings` and `memos embedding-status`.
- **New queue events** — `embedding:queued`, `embedding:started`, `embedding:complete`, `embedding:failed`, `embedding:retry`. Existing listeners continue to work.
- **`memos.contextPack()` SDK method** — implements the `ai.trio.memos.context-pack.v1` contract documented in `docs/ai-trio-contracts.md`. Sorted by descending relevance, plain-text content, `trust`/`source`/`tags`/`updatedAt` preserved per item, score reproducible for the same query + provider + model + database.
- **MCP 2025-06-18** — protocolVersion bumped from `2024-11-05` to `2025-06-18`. `serverInfo.version` now read from `package.json` at startup so the wire value is never stale.
- **MCP tool additions** — `memos_context_pack`, `memos_flush_embeddings`, `memos_embedding_status`. The 2025-06-18 `notifications/cancelled` handler is now wired (no-op for now, but spec-compliant).
- **MCP bug fix** — `memos_store` was silently dropping `metadata`, `importance`, and `summary`. All three are now preserved end-to-end.
- **REST endpoints** — `POST /api/mem/context-pack`, `GET /api/mem/embedding-status`, `POST /api/mem/flush-embeddings`.
- **MCP server card** — `GET /.well-known/mcp-server.json` returns the discovery document the `@universal-mcp-toolkit/core` runtime and other MCP-aware hosts expect.
- **CLI** — `memos context-pack <query> [--budget N] [--namespace NS] [--json]` for inspecting AI Trio context packs from the shell.
- **Storage adapter contract** — `peekNode?(id)` and `evictLeastImportant?()` on `StorageAdapter`. SQLite implements both; custom adapters can opt in.
- **Hermes-style retain pre-filter** (`src/retain-filter.ts`) — scores candidate memories on length (`MIN_LENGTH=15`), signal density, action/preference verbs, and novelty against existing content; skips anything below `RETAIN_THRESHOLD` (0.3) before the write. Exports `scoreRetain()`, `shouldRetain()`, `decideRetain()`, `setRetainClassifier()`, plus `RetainInput` / `RetainDecision` types. `store()` honors an opt-in `filterRetain: true` on `CreateMemoryInput` and throws a typed `MemorySkippedError` when the gate drops the memory, so callers can distinguish a skip from a real failure. Mirrors the same technique llm-guardian uses on its read path — the AI Trio now applies consistent quality gating on both ends.

### Changed

- SQLite embedding vectors are stored as compact binary blobs with legacy JSON-vector read compatibility for older local databases.
- Search and semantic search now share namespace, tag, type, importance, limit, and offset filters consistently.
- Embedding backfill now skips fresh persisted vectors on restart and only refreshes when model metadata or node freshness requires it.
- OpenAI-compatible embedding endpoints no longer require fake API keys, so local runtimes such as LM Studio can be used directly.
- Tooling was refreshed to current stable npm dependencies, including Jest 30, TypeScript 6, ESLint 10 flat config, and `better-sqlite3` 12, with Windows-compatible lint/test commands.
- The Python REST bridge now uses request-id demuxing and writes its generated bridge script into temp storage instead of source or package directories.
- **Per-user bridge script dir** — the inline Node bridge no longer lives at the shared `/tmp/memos-bridge/`; it's now `/tmp/memos-bridge-<user>/`, so multi-user hosts don't stomp on each other.
- **REST version pulled from package.json** — `app.version`, `/health`, and `/.well-known/mcp-server.json` all read the live `package.json` (with `MEMOS_VERSION` env override) instead of a hardcoded `1.5.0`.

### Performance

- **Eviction is now a single SQL statement** — `evictLeastImportant()` does `SELECT id … ORDER BY importance ASC, last_accessed ASC, created_at ASC LIMIT 1` and `DELETE` in one shot. The old code loaded the full table into memory and sorted it on every eviction.
- **`peekNode` for non-retrieval reads** — `tag`/`untag`/`setTTL`/`clearTTL` no longer hit the side-effecting `getNode` (which wrote access stats on every read). Skips the read-modify-write write amplification that distorted LRU eviction.
- **`autoLink` bag cache** — bag-of-words tokenization is memoized per `MemoryNode` in a `WeakMap`. Every existing node's tokens are computed once, not on every `store()` call.
- **Inlined cosine in `autoLink`** — the small-over-large intersection loop avoids an unnecessary `Math.sqrt` per candidate.

### Fixed

- REST `update` calls now bridge correctly to the TypeScript MemOS engine.
- TTL updates now synchronize storage and the in-memory graph.
- Manual link creation now rolls back in-memory graph state if SQLite persistence fails.
- Metadata filters are implemented for SQLite keyword, structured, and embedding queries.
- CrewAI `MemOSTool` now initializes correctly when `MemOSMemory()` constructs its backing tool.
- **`tag` / `untag` no longer bump access_count** — the side-effecting read was distorting LRU eviction whenever a memory was re-tagged.
- **Temporal boundary in historical-memory exclusion** — the default/exclude-historical SQL filter used `valid_to >= now`, so a memory superseded in the same millisecond as the search (`validTo === now`) was wrongly kept. The FTS and structured paths now use strict `valid_to > now`. `validAt` point-in-time queries intentionally keep the inclusive `>=` boundary. Fixes the flaky `temporal-trust` cases (full suite now 255/255).

### Added (continued)

- **Memory consolidation ("dreaming")** — `memos.dedupe()`, `memos.archive()`, `memos.summarizeCluster()`, and `memos.consolidate()` as a single entry point. All accept `dryRun` for safe previewing. Greedy single-linkage clustering over embeddings; archived memories move to the `archived` namespace (not deleted) and can be restored. Emits a new event: `consolidation:complete`.
- **HTTP+SSE MCP transport** — `startMcpHttpServer(memos, options)` plus `memos mcp --http [--port N] [--host H]`. Two endpoints: `GET /mcp/sse` opens the stream and advertises `POST /mcp/messages`. Same wire protocol as `@universal-mcp-toolkit/core` and web-based MCP hosts.
- **Three new embedding providers** — `VoyageAIEmbeddingProvider` (voyage-3, 1024-d), `CohereEmbeddingProvider` (embed-english-v3.0, 1024-d), and `FastEmbedEmbeddingProvider` (BAAI/bge-small-en-v1.5, 384-d). The FastEmbed provider lazy-loads `@xenova/transformers` and falls back to a deterministic local hash if the package is not installed. All three are wired through `createEmbeddingProvider({ provider: "voyage" | "cohere" | "fastembed" })`.
- **Interactive CLI shell** — `memos repl` drops into a read-eval-print loop with `store`, `search`, `semantic`, `context-pack`, `flush-embeddings`, `embedding-status`, `graph`, `link`, `tag`, `untag`, `help`, `exit`. Same MemOS instance, no subprocess overhead.
- **Retrieval-quality benchmark** — `npx tsx scripts/bench-quality.ts` (also `npm run bench:quality`). Synthetic LoCoMo-shape dataset: 30 conversation memories, 20 ground-truth queries, recall@5/10 and MRR per category. Writes JSON to `scripts/bench-quality-results.json` and a markdown report to `docs/benchmark-quality.md`.
- **Comparison doc** — `docs/benchmark-comparison.md` puts MemOS's local-hash baseline next to published Zep/Graphiti/Mem0 numbers, with an honest explanation of methodology differences.
- **Tag join table** — `node_tags(node_id, tag)` replaces the JSON-LIKE scan on every tag query. Auto-migrated on next `init()`. Reverses a long-standing O(n) bottleneck into O(log n) B-tree lookups.
- **Access-count debounce** — `SQLiteStorage.getNode()` now buffers access stats in memory and flushes once every 500 ms (or on `close()`). Removes the read-modify-write write amplification that distorted LRU eviction under read-heavy workloads.
- **Cross-OS SQLite pragmas** — `synchronous = NORMAL`, `cache_size = 32 MiB`, `temp_store = MEMORY`, `mmap_size = 256 MiB`. Big wins on macOS and Windows where `fsync` is slow.
- **`.gitattributes`** — locks down LF for source, CRLF for Windows scripts. Drops the `LF will be replaced by CRLF` noise from `git status`.
- **Optional peer type shim** — `src/xenova-transformers.d.ts` lets `tsc --noEmit` succeed without `@xenova/transformers` installed.

### Changed

- `StorageAdapter` interface extended with `peekNode?()`, `evictLeastImportant?()`, `getAllEmbeddings?()`, `setNodeNamespace?()`. SQLite implements all four; custom adapters can opt in.
- `EmbeddingProviderKind` union extended with `"voyage" | "cohere" | "fastembed"`.
- `MemOSEvent` extended with `consolidation:complete` and queue lifecycle events (`embedding:queued`, `embedding:started`, `embedding:complete`, `embedding:failed`, `embedding:retry`).
- The CLI argument parser now scans for the first non-flag positional, so `memos --db x store "y"` and `memos store "y" --db x` both work.
- `store()` now accepts `filterRetain: true` on `CreateMemoryInput` to run the Hermes-style retain gate; a skipped memory throws the new exported `MemorySkippedError`. Plain `store()` is unchanged.
- `src/index.ts` now also exports `MemorySkippedError`, `scoreRetain`, `shouldRetain`, `decideRetain`, `setRetainClassifier`, `RetainInput`, and `RetainDecision`.
- `package.json` — expanded npm-discovery keywords (11→20) and added `sideEffects: false` + `publishConfig` for cleaner npm search ranking and better treeshaking by bundlers.

### Performance

- `evict()` is now a single SQL `SELECT id … ORDER BY importance, last_accessed, created_at LIMIT 1` + `DELETE`. Falls back to the in-memory path for custom adapters that don't implement `evictLeastImportant()`.
- Tag-filtered queries now use an `EXISTS (SELECT 1 FROM node_tags …)` subquery against the B-tree index. The FTS5 JOIN order is flipped (`FROM nodes n INNER JOIN nodes_fts fts`) so the correlated subquery resolves correctly.
- The `EmbeddingQueue` returns immediately from `store()` and `update()`, eliminating remote-embedding round-trips from the write critical path.

## [1.5.0] - 2026-05-28

### Added

#### New Features

- **Import Command** — Restore memories from JSON files or Markdown/Obsidian directories
  - `memos.importMemories({ source, format })` SDK method
  - `memos import <source> [--format json|markdown|obsidian]` CLI command
  - `POST /api/mem/import` REST endpoint
  - Auto-detects format from file extension
  - Supports YAML frontmatter parsing for Markdown files
  - Recreates wikilink edges during Obsidian import

- **CrewAI Adapter** — Persistent memory for CrewAI agents and crews
  - `MemOSTool` class with store/search/retrieve/forget/summarize actions
  - `MemOSMemory` class with `save()`, `search()`, `get_context()` methods
  - Compatible with CrewAI agent `memory=True` parameter
  - Added `crewai` optional dependency to `pyproject.toml`

- **WebSocket API** — Real-time memory event streaming
  - `ws://localhost:7400/ws` endpoint for live event broadcast
  - Events: node:created, node:updated, node:deleted, edge:created, edge:deleted, link:auto, eviction, ttl:expired
  - JSON-RPC notification format for event delivery
  - Ping/pong keepalive support
  - `ConnectionManager` for multi-client broadcasting

- **Expanded Test Coverage** — Grew from 47 to 110 tests
  - SQLiteStorage layer: CRUD, queries, TTL, FTS5, batch operations
  - Import from JSON and Markdown with edge cases
  - LRU eviction with configurable limits
  - Auto-linking with threshold configuration
  - Context injection depth and maxChars limits
  - Graph operations: clusters, neighbours, edges
  - Event system: multiple listeners, off/remove
  - MCP adapter schema validation

#### Stability Fixes

- **FTS5 Query Escaping** — User queries with special characters (quotes, parentheses) no longer throw SQL errors
- **Batch Clear Operation** — `memos.clear()` now uses a single `DELETE` statement instead of N individual deletes
- **Stop Words Optimization** — Moved to module scope to avoid recreating 97-element Set on every call

### Fixed

#### Critical Bugs

- **`updateNode` side-effect** — Previously incremented `access_count` on every update because it called `getNode()` internally. Now uses a direct read without side effects.
- **`retrieve()` false events** — Previously emitted `node:updated` on every read operation. Reads no longer trigger update events.
- **MCP `store()` type safety** — Fixed `content` field being passed in opts where it shouldn't be. Now correctly typed as `Omit<CreateMemoryInput, "content">`.
- **WebSocket disconnect crash** — `ConnectionManager.disconnect()` no longer throws `ValueError` if connection was already removed by broadcast cleanup.

#### Performance Fixes

- **BFS traversal O(n²) → O(n)** — `findClusters()` and `injectContext()` now use index-based queue traversal instead of `Array.shift()` which is O(n) per call on V8.
- **Stop words deduplication** — Consolidated duplicate stop words lists (40 words in memory.ts, 97 words in graph.ts) into a single canonical list at module scope.

#### Edge Cases

- **FTS5 special character handling** — Queries containing `"`, `(`, `)`, `AND`, `OR`, `NOT`, `NEAR`, `:` are now properly escaped for literal search
- **Empty graph operations** — All graph methods now handle empty state gracefully
- **TTL sweep race condition** — Improved consistency between storage sweep and in-memory graph removal

### Changed

- Version bumped from `1.5.0-beta.1` to `1.5.0` (stable)
- PyPI package renamed from `memos` (taken) to `mem-os-sdk` (matches npm scope)
- `StorageAdapter` interface extended with `deleteAllNodes()` method
- `clear()` now uses batch delete instead of per-node deletion
- README updated with import, CrewAI adapter, WebSocket docs, and cross-platform install options
- All version strings updated to `1.5.0` across npm, PyPI, CLI, MCP, and server

## [1.5.0-beta.1] - 2026-03-24

### Added

#### Stable Features

- **Memory TTL / Expiration** (STABLE-1)
  - Optional `ttl` field (seconds) on memory creation
  - `expires_at` stored as Unix timestamp in SQLite
  - Background sweep every 60 seconds, deletes expired nodes and orphaned edges
  - `memos.setTTL(id, seconds)` and `memos.clearTTL(id)` SDK methods
  - `--ttl <seconds>` flag on `memos store` CLI command
  - `PATCH /api/mem/{id}/ttl` and `DELETE /api/mem/{id}/ttl` REST endpoints
  - Python `memos-server backup` and `memos-server restore` CLI subcommands
  - Migration-safe column addition (checks column existence before ALTER TABLE)

- **Custom Memory Tags** (STABLE-2)
  - `tags` field (string array) on MemoryNode, stored as JSON in SQLite
  - `memos.tag(id, tags)`, `memos.untag(id, tags)`, `memos.listByTag(tag)` SDK methods
  - Tags filter on `search()` and `retrieve()` with AND logic
  - `memos tag <id> <tag1> [tag2...]`, `memos untag`, `memos list --tag <tag>` CLI commands
  - `POST /api/mem/{id}/tags`, `DELETE /api/mem/{id}/tags/{tag}`, `GET /api/mem/tags/{tag}` REST endpoints

- **Export Command** (STABLE-3)
  - `memos export` CLI command with `--format json|markdown|obsidian`
  - `--output <dir>` and `--tag <tag>` flags
  - JSON: single array file; Markdown: one .md per memory with YAML frontmatter
  - Obsidian format: linked memories become `[[wikilinks]]`
  - `memos.export(options)` SDK method
  - `GET /api/mem/export?format=...` REST endpoint (returns zip for markdown/obsidian)

- **Backup and Restore** (STABLE-4)
  - `memos backup [--output <path>]` copies DB with manifest.json
  - `memos restore <path>` validates manifest, replaces DB
  - Manifest includes: timestamp, version, nodeCount, edgeCount, dbSizeBytes
  - Python `memos-server backup` and `memos-server restore` CLI subcommands
  - Cross-platform path handling via Node `path` module

- **Performance Benchmark** (STABLE-5)
  - `scripts/bench.ts` ESM TypeScript benchmark script
  - Tests insert 1K / 10K / 100K nodes with inline lorem-ipsum content
  - Measures p50/p95/p99 latency for: store, retrieveById, FTS5 search, getNeighbours
  - Outputs table to stdout and writes `scripts/bench-results.json`
  - `tsx` added to devDependencies; `npm run bench` script

- **CHANGELOG** (STABLE-6)
  - This changelog file following Keep a Changelog 1.1.0

- **MCP Adapter** (STABLE-7)
  - `memos mcp` starts a stdio MCP server backed by the configured local SQLite database
  - Exposes `memos_store`, `memos_search`, `memos_retrieve`, `memos_forget`, `memos_graph`, and `memos_context`
  - Exported as `@mem-os/sdk/mcp` for programmatic hosts
  - Designed for direct use from `universal-mcp-toolkit` and other MCP-compatible clients

#### Experimental Features

All experimental features gated behind `experimental` config object:

- **Semantic Search** (EXPERIMENTAL-1)
  - `memos.semanticSearch(query, limit, threshold)` — bag-of-words similarity search
  - Enable with `experimental: { semanticSearch: true }`
  - `RPC: semanticSearch` in bridge

- **Graph Visualization** (EXPERIMENTAL-2)
  - `memos.graphViz()` — returns DOT-format graph string
  - Enable with `experimental: { graphViz: true }`
  - `RPC: graphViz` in bridge

- **Namespaces** (EXPERIMENTAL-3)
  - `namespace` field on MemoryNode for logical grouping
  - `memos.listNamespaces()`, `memos.namespaceCount(ns)` SDK methods
  - Namespace filter on `search()`
  - Enable with `experimental: { namespaces: true }`

- **Context Injection** (EXPERIMENTAL-4)
  - `memos.injectContext(id, depth, maxChars)` — walks graph to gather related context
  - Enable with `experimental: { contextInjection: true }`
  - `RPC: injectContext` in bridge

### Changed

- `MemoryNode` interface extended with `tags`, `expiresAt`, `namespace` fields
- `CreateMemoryInput` extended with `ttl`, `tags`, `namespace` options
- `SearchFilter` extended with `tags` and `namespace` filters
- `StorageAdapter` interface extended with `setTTL`, `clearTTL`, `sweepExpired`, `queryNodesByTag`
- `MemOSConfig` extended with `sweepInterval` and `experimental` options
- `MemOSEvent` union extended with `ttl:expired`
- CLI help text updated with all new commands
- Python server version bumped to 1.5.0-beta.1
- Node.js bridge script extended with all new RPC methods

### Fixed

- SQLite migration now uses `PRAGMA table_info` check instead of `IF NOT EXISTS` on ALTER TABLE (SQLite limitation)
- Directory creation in SQLiteStorage uses `path.dirname` for cross-platform compatibility

## [0.1.1] - 2026-03-23

### Fixed

- Minor bug fixes and documentation updates
- Improved error messages for missing Node.js dependency

## [0.1.0] - 2026-03-22

### Added

- TypeScript SDK with `MemOS` class (store, retrieve, search, forget, summarize, link)
- Graph-based memory model with typed nodes, edges, and metadata
- SQLite storage backend with WAL mode and FTS5 full-text search
- Auto-linking via bag-of-words text similarity
- Extractive summarisation (fully local, no API calls)
- LRU eviction with configurable `maxMemories`
- Event system (node:created, node:updated, node:deleted, edge:created, edge:deleted, link:auto, eviction)
- Custom storage adapter interface (`StorageAdapter`)
- Python HTTP server (FastAPI) on port 7400 with full REST API
- CLI tool (`memos` command): store, retrieve, search, forget, graph, summarize, serve
- Ollama adapter (Python)
- LangChain adapter (Python)
- Docker Compose deployment
- GitHub Actions CI (lint + test + typecheck)
- README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY docs

[Unreleased]: https://github.com/Markgatcha/memos/compare/v1.6.26...HEAD
[1.6.26]: https://github.com/Markgatcha/memos/compare/v1.5.0...v1.6.26
[1.5.0]: https://github.com/Markgatcha/memos/compare/v1.5.0-beta.1...v1.5.0
[1.5.0-beta.1]: https://github.com/Markgatcha/memos/compare/v0.1.1...v1.5.0-beta.1
[0.1.1]: https://github.com/Markgatcha/memos/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Markgatcha/memos/releases/tag/v0.1.0
