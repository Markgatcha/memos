# LongMemEval-V2 adapter

This directory contains everything needed to run MemOS as a LongMemEval-V2
memory backend and package an operating point for the leaderboard.

## What is here

| File                    | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `memos_backend.py`      | Python `Memory` implementation; registers `memory_type="memos"` |
| `bridge.mjs`            | Persistent Node sidecar that owns the MemOS SQLite DB           |
| `build_bundle.py`       | Embeds `bridge.mjs` into a one-file `memos_backend_bundled.py`  |
| `install_adapter.py`    | Copies the backend into a LongMemEval-V2 checkout               |
| `run_memos.py`          | Runs the official harness with `memory_type=memos`              |
| `SYSTEM_DESCRIPTION.md` | Template for the leaderboard package                            |

## Model requirements

For an **official leaderboard package**, the packaging validator requires:

- reader `run_args.model` contains `qwen3.5-9b`
- evaluator `run_args.evaluator_model` contains `gpt-5.2`

Those are enforced by `leaderboard/submission_utils.py`, not just convention.
Any external evaluation or ablation can use other OpenAI-compatible reader and
judge models, but it will not be an official leaderboard package.

### Which `gpt-5.2`, and is it still callable?

Two different things share the name:

| Model | Status |
| --- | --- |
| `gpt-5.2-chat-latest` | **Shut down 2026-08-10** (OpenAI deprecations page) |
| `gpt-5.2` (snapshot `gpt-5.2-2025-12-11`) | Still listed as an available model: Chat Completions and Responses supported, no `shutdown_date` announced |

So the base model is not retired, but the retired `chat-latest` variant is what
most people remember. Two practical consequences:

1. **A gateway may not carry base `gpt-5.2` at all.** OpenAI-compatible proxies
   often expose only their newest models. Check before the run:

   ```bash
   curl -s "$EVALUATOR_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY" \
     | grep -o '"gpt-5\.2[^"]*"'
   ```

   An empty result means the judge will 404 mid-run.
2. **`preflight.py` now probes the judge endpoint** (`--judge-base-url`,
   defaulting to `EVALUATOR_BASE_URL` or `OPENAI_BASE_URL`) and fails if no
   served model contains `gpt-5.2`. Use `--skip-judge-model-probe` only when
   the endpoint has no `/models` route.

If your provider cannot serve base `gpt-5.2`, the options are: get an OpenAI key
for that model, ask the provider to enable it, or ask the LME-V2 organizers for
an approved substitution. Do **not** pass a different model under the `gpt-5.2`
name — the validator would accept the string while the reported scores would not
be reproducible.

**The embedding model is not validated.** It is part of your memory method.
The official embedding-based baselines use `Qwen/Qwen3-Embedding-8B`, so that is
the default recommendation for an apples-to-apples comparison. MemOS can use
Ollama, Model2Vec, or another provider instead; just disclose the choice in
`SYSTEM_DESCRIPTION.md` and expect different accuracy.

The harness's token-budget code loads the `Qwen/Qwen3.5-9B` processor, so that
processor/tokenizer must be available locally even if the reader is served
remotely.

## Prerequisites

- LongMemEval-V2 checked out and its Python environment installed
  (`pip install -e .` from the LME-V2 root).
- Node.js 20+.
- MemOS SDK available either as `@mem-os/sdk` in the LME-V2 environment or via
  `MEMOS_SDK_PATH=/abs/path/to/memos/dist/index.js`.
- The official reader endpoint (`READER_BASE_URL`, default
  `http://localhost:8023/v1`, model `Qwen/Qwen3.5-9B`).
- The official judge key (`OPENAI_API_KEY`, default evaluator `gpt-5.2`). Set
  `EVALUATOR_BASE_URL` when the judge is not OpenAI itself; the runner forwards
  it to the harness as `--evaluator-base-url`. Without it the OpenAI SDK uses
  `OPENAI_BASE_URL`, so a proxy key in `OPENAI_API_KEY` is routed to that proxy
  automatically.
- For higher accuracy, an embedding endpoint serving Qwen3-Embedding-8B at
  `LME_EMBEDDING_BASE_URL` (default `http://localhost:8114/v1`). Without it the
  adapter uses MemOS's offline Model2Vec default.

## Install

From this directory:

```bash
python build_bundle.py
python install_adapter.py --lme-root /path/to/LongMemEval-V2
```

Or, for development (keeps `bridge.mjs` as a sibling file):

```bash
python install_adapter.py --lme-root /path/to/LongMemEval-V2 --unbundled
```

## Prepare data

Follow the official README:

```bash
cd /path/to/LongMemEval-V2
python data/download_data.py --data-root data/longmemeval-v2
export DATA_ROOT="$(pwd)/data/longmemeval-v2"
python data/prepare_data.py --data-root "$DATA_ROOT" --mode symlink
python data/validate_data.py --data-root "$DATA_ROOT" --tier small
```

## Smoke test (no reader/judge)

A 3-question retrieval smoke test catches ingestion/query breakage without
paying for the reader:

```bash
python /path/to/memos/lme-v2/run_memos.py \
  --lme-root /path/to/LongMemEval-V2 \
  --data-root "$DATA_ROOT" \
  --domain web --tier small --limit 3 \
  --profile fast \
  --embedding-provider model2vec \
  --output-dir runs/memos_smoke_web
```

This still invokes the official harness and reader; for a bridge-only test,
see `smoke_test.py`.

## Run all operating points and package

After preflight, the turnkey path is:

```bash
python /path/to/memos/lme-v2/run_all.py \
  --lme-root /path/to/LongMemEval-V2 \
  --data-root "$DATA_ROOT" \
  --tier small \
  --profiles fast,balanced,accurate \
  --submission memos_submission
```

It runs web + enterprise for each profile, skips existing run folders unless
`--force` is set, then calls the official step-1 and step-2 packaging scripts.
Use `--dry-run` to print the commands without executing them.

## Run one operating point

```bash
export MEMOS_SDK_PATH=/abs/path/to/memos/dist/index.js
export LME_EMBEDDING_BASE_URL=http://localhost:8114/v1
export LME_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
export MEMOS_EMBEDDING_DIMENSIONS=4096

python /path/to/memos/lme-v2/run_memos.py \
  --lme-root /path/to/LongMemEval-V2 \
  --data-root "$DATA_ROOT" \
  --domain web --tier small \
  --profile balanced \
  --output-dir runs/memos_balanced_web_small
```

Repeat for `--domain enterprise`, then run additional operating points
(`fast`, `accurate`) with distinct `--output-dir` values. The leaderboard
package needs web + enterprise runs for each operating point.

## Package the submission

Use the official packaging scripts on the completed run folders:

```bash
python leaderboard/build_submission_step_1_single_operating_point.py \
  runs/memos_balanced_web_small \
  runs/memos_balanced_enterprise_small \
  memos_submission balanced small --method memos

python leaderboard/build_submission_step_2_build_package.py \
  memos_submission SYSTEM_DESCRIPTION.md \
  /path/to/LongMemEval-V2/memory_modules/memos_backend.py \
  leaderboard/submissions/memos_submission/operating_points/balanced
```

The step-1 script validates the reader/judge models and run completeness. The
step-2 script validates tier/method/domain consistency and writes the tarball.

## Tuning knobs

| Flag                           | Default    | Effect                                       |
| ------------------------------ | ---------- | -------------------------------------------- |
| `--profile`                    | `balanced` | 40k/top-12/4k, 120k/top-20/6k, 200k/top-40/8k |
| `--token-budget`               | profile    | Context pack budget                          |
| `--top-k`                      | profile    | Seed count; neighbours ride on top of it      |
| `--state-chars`                | profile    | AXTree chars per state node                  |
| `--neighbor-radius`            | 1          | Steps included on each side of a seed         |
| `--no-env-filter`              | off        | Disable per-site partitioning                |
| `--no-ui-elements`             | off        | Skip per-state UI label nodes                |
| `--multi-query`                | off        | Two-variant fusion (2.5x latency, no gain)   |
| `--rescue`                     | off        | Extra states from selected trajectories      |
| `--low-confidence-note`        | off        | Premise note below a score threshold         |
| `--strip-preamble`             | off        | Drop the "I am working with ..." sentence    |
| `--embedding-provider`         | `auto`     | `openai-compatible`, `model2vec`, or `auto`  |
| `MEMOS_LME_INGEST_CONCURRENCY` | 8          | Parallel MemOS writes per trajectory         |
| `--checkpoint-every`           | 25         | Snapshot the DB every N trajectories         |
| `MEMOS_LME_RERANK`             | off        | Enable the cross-encoder rerank for packs    |
| `MEMOS_LME_DEDUP`              | on         | `0` disables semantic dedup (latency A/B)    |

## Controller (optional)

The benchmark fixes the **reader** (`qwen3.5-9b`) and the **judge**
(`gpt-5.2`), but not the model that builds or queries memory. A controller can
therefore do three jobs the deterministic adapter cannot:

| Flag | When | Cost |
| --- | --- | --- |
| `--controller-notes` | ingest | one call per trajectory, zero query latency |
| `--controller-decompose` | query | one call, then up to 3 packs |
| `--controller-premise` | query | one call over the top ~8k chars |

Defaults: endpoint `https://api.river.ai/v1`, model
`deepseek-ai/DeepSeek-V4.1-Flash-1017`, key from `MEMOS_CONTROLLER_API_KEY`,
`RIVER_API_KEY`, or `~/.config/opencode/river.key`. Check it with:

```bash
python lme-v2/controller_check.py
```

Every controller path fails closed: no key, a timeout, or malformed JSON falls
back to the deterministic behaviour, so a submission run never depends on the
endpoint being up.

**Do not use the controller as the reader for an official package.** The
packaging validator requires `run_args.model` to contain `qwen3.5-9b` and
`run_args.evaluator_model` to contain `gpt-5.2`. A different model is fine for
local measurement, not for a leaderboard submission.

### Controller results on the small tier

Measured on the web ablation (74 scored), against a 60.8% no-controller
baseline:

| Feature | Answer recall | Verdict |
| --- | --- | --- |
| `--controller-notes` | 60.8% (no change) | Notes are high quality (module paths, field names, URL patterns) but the text-presence metric cannot see a synthesis gain. Needs end-to-end measurement. |
| `--controller-decompose` | 58.1% | **Rejected.** Better ranking (top-5 41.9% vs 39.2%, MRR 0.44) but lower recall and 25s per query — that lands on the reference frontier, not above it. |
| `--controller-premise` | 66.2%* | **Rejected.** Precision 0.34: it labels 94 of 113 questions "unsupported", including 56% of answerable ones. The apparent gain is the note echoing UI labels, not better retrieval. |

\* After excluding the support note from scoring, the premise run is not a
retrieval gain at all. The evaluator now ignores any item starting with
`Support check:` so this cannot be miscounted again.

The premise idea is still right in principle — AgentRunbook-C improves
abstention by reporting contradictions — but it needs a stricter judge than a
single call over the top 8k characters. Until one is calibrated, the flag stays
off.

## Measured retrieval quality

The leaderboard score is end-to-end answer accuracy, which needs a reader model
and a judge. Both were unavailable, so retrieval was measured directly on the
public dataset (`xiaowu0162/longmemeval-v2`) with
`eval_retrieval.py`: same ingest path, same `query` call, then check whether
the reference answer text is actually in the returned context.

What that metric covers: 284 of 451 questions have an answer that can be
checked mechanically (phrase sets and multiple choice). The other 167
(abstention and gotchas) need the LLM judge and are excluded from every row
below, so no row is comparable to a leaderboard accuracy number.

Its ceiling is 79%, not 100%: 60 of the 284 answers never appear in the
indexed text at all, so text-presence cannot see them.

Small tier, all 451 questions (284 scored), `balanced` profile:

| Configuration                          | Answer in context | Coverage | MRR   | In top-5 | Context tokens | Query latency |
| -------------------------------------- | ----------------- | -------- | ----- | -------- | -------------- | ------------- |
| Baseline (3k states)                   | 44.0%             | 47.6%    | –     | –        | 15.2k          | 2.61s         |
| + site partition, + neighbour steps     | 47.9%             | 52.0%    | 0.341 | 34.5%    | 24.9k          | 2.23s         |
| **+ UI nodes (web only, shipped)**     | **57.0%**         | **60.2%**| 0.373 | 37.7%    | 34.3k          | 3.05s         |

Per category, baseline → shipped: static 62.2% → 72.4%, dynamic 23.2% → 48.8%,
procedure 35.1% → 39.2%.

Ablation on the web domain only (74 scored), where the site partition has
three sites to choose between:

| Configuration                        | Answer in context | MRR   | In top-5 | Context tokens | Latency |
| ------------------------------------ | ----------------- | ----- | -------- | -------------- | ------- |
| Baseline (3k, 20 seeds)              | 46.0%             | 0.371 | 31.1%    | 12.8k          | 4.16s   |
| + neighbour steps                    | 50.0%             | 0.367 | 31.1%    | 19.9k          | 4.14s   |
| + site partition                     | 51.4%             | 0.382 | 33.8%    | 23.4k          | 1.23s   |
| + 6k states                          | 56.8%             | 0.430 | 39.2%    | 39.8k          | 1.83s   |
| + procedure notes (bug fix)          | 58.1%             | 0.410 | 37.8%    | 37.1k          | 1.98s   |
| **+ UI element nodes (web, shipped)** | **60.8%**        | **0.424** | **39.2%** | **28.5k**  | 2.64s   |
| + 40 seeds                           | 64.9%             | 0.426 | 37.8%    | 85.1k          | 3.60s   |
| neighbour radius 2 instead of 1      | 58.1%             | 0.429 | 35.1%    | 53.6k          | 1.90s   |
| + multi-query fusion (rejected)      | 60.8%             | 0.413 | 36.5%    | 28.2k          | 4.99s   |
| keyword-only query (rejected)        | 59.5%             | 0.367 | 29.7%    | 26.3k          | 2.47s   |

Query latency in those rows was measured under concurrent load, so only the
relative order is meaningful. A controlled sequential measurement (same 10
questions, same process, no neighbours) is **2.24s unpartitioned vs 0.71s
site-partitioned**, a 3.2x reduction with no accuracy cost.

Three changes produced the gain, in order of contribution:

1. **Longer state nodes (3k → 6k chars).** Of the answers that do appear in the
   accessibility tree, 27% begin past the 3,000-character cut; at 6,000 that
   drops to 9%. This is the largest single win (+8pp) and costs only context
   budget.
2. **Neighbour steps (radius 1).** Each retrieved state brings the step before
   and after it, mirroring the official baseline's `raw_state_slice_radius: 1`.
   Dynamic-state questions improve most (23.2% → 46.3%) because a state change
   is only visible across adjacent steps.
3. **Site partition.** Questions name their site ("our ServiceNow portal",
   "our reddit-based custom forum"), and the web corpus mixes three WebArena
   sites. Tagging nodes by `start_url` port and filtering to the named site
   cuts the candidate set ~3x, which is where the 3.2x latency win comes from.
4. **Procedure notes were never created.** The public trajectories store
   actions per state, but the fallback normalizer read a top-level `actions`
   list that does not exist, so every procedure node was skipped. Deriving the
   list from the states (as the official normalizer already does) restores
   them; dynamic questions gain ~5pp from having the action sequence in
   context.
5. **UI element nodes (web only).** Each state also emits a short label-only
   node (`link 'SALES'`, `button 'System Messages: 2'`, ...). These embed far
   better than a 6k-character tree, survive truncation, and *reduce* context
   tokens because short nodes displace long state dumps. Web: +1.4pp answer
   recall and -25% context tokens. Enterprise: -4.9pp, where the answer text
   sits deep in long record pages, so the runner enables them for web only.

### What the data rejected

- **Multi-query fusion** (full question + keyword variant, reciprocal rank
  fusion). No gain in answer recall (60.8% either way) and 2.5x the latency
  (2.6s → 5.0s). On LAFS, which integrates accuracy over log latency, that is
  strictly worse. Kept behind `--multi-query` for other corpora.
- **Keyword-only queries.** Slightly worse recall (59.5%) and much worse
  ranking (MRR 0.37 vs 0.42, top-5 29.7% vs 39.2%). The full question carries
  useful structure; the boilerplate is not the problem.
- **Low-confidence note for abstention questions.** Two candidate signals both
  fail to separate the 128 `-abs` questions from answerable ones: top fused
  score AUC 0.55, question-term coverage AUC 0.48 (chance). The note is
  implemented (`--low-confidence-note`) but off by default; enabling it at any
  useful threshold would fire on answerable questions just as often.

### Where the remaining loss is

Decomposing the 129 misses on the 284 scorable questions:

| Bucket | Count | Fixable? |
| --- | --- | --- |
| Answer never appears as text anywhere | 64 (22.5%) | No — needs screenshots or synthesis |
| Right trajectory retrieved, wrong state | 46 (16.2%) | Yes — state selection inside a known trajectory |
| Right trajectory never retrieved | 19 (6.7%) | Partly — reranking/query expansion |

The middle bucket is the target. A within-trajectory rescue was implemented two
ways (walking state ids, then a `traj:<id>` tag-filtered search). Both work
conceptually but cost 30s+ per query on the small tier, because every extra
search re-scans the corpus for candidates. It stays behind `--rescue`, off by
default: at 30s it would sit on the reference frontier instead of above it.

Making it viable needs a cheaper primitive (an ANN or primary-key-bounded
search), not a different prompt.

### Why latency is part of the objective

The leaderboard ranks by LAFS gain over a fixed accuracy-latency frontier
(1s to 200s, log scale). The reference frontier is flat at 51.0% until 26.9s,
so a point at ~2s is worth much more than a slightly better point at 150s:

| Accuracy | gain @ 2s | gain @ 5s | gain @ 150s |
| -------- | --------- | --------- | ----------- |
| 53%      | +0.98     | +0.64     | ~0.00       |
| 55%      | +1.96     | +1.27     | ~0.00       |
| 58%      | +3.43     | +2.22     | ~0.02       |
| 60%      | +4.78     | +3.23     | ~0.05       |
| 70%      | +12.32    | +9.03     | ~0.21       |

(Computed with the official `leaderboard/compute_lafs.py` against the
released small-tier frontier.) This is why the adapter refuses changes that buy
accuracy with seconds: at 2s the marginal value of a second is large.

Reproduce any row:

```bash
python lme-v2/eval_retrieval.py --data-root /path/to/lme-v2 \
  --profile balanced --env-filter --neighbor-radius 1 --state-chars 6000 \
  --json-out runs/eval.json
```

## Honest limits

- The adapter stores text AXTree evidence plus screenshot paths; CLIP pixel
  search is off by default.
- The numbers above are retrieval recall on the public small tier, not
  end-to-end accuracy. 60 of the 284 scored answers never appear verbatim in
  the text, and the 167 abstention/gotcha questions need the judge, so the
  proxy cannot rank a submission on its own.
- Procedure/gotcha notes are deterministic summaries. An LLM-written variant is
  the next ablation and likely the largest remaining accuracy gain on those
  categories.
- A full small-tier run is 25M+ tokens and hundreds of trajectories. Validate
  ingestion on one trajectory before launching the full run.
- The bridge is one process per memory instance. Do not point multiple Python
  workers at the same DB.
