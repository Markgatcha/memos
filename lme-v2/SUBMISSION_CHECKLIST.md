# LME-V2 submission checklist

## Before any run

- [ ] `python data/validate_data.py --data-root "$DATA_ROOT" --tier small` passes.
- [ ] `python build_bundle.py` regenerated `memos_backend_bundled.py`.
- [ ] `python install_adapter.py --lme-root /path/to/LongMemEval-V2` copied the backend.
- [ ] `python lme-v2/smoke_test.py` prints `OK` (bridge + ingest + query).
- [ ] `python lme-v2/eval_retrieval.py ...` reproduces the expected retrieval numbers for the chosen profile (see the README table); site partitioning and neighbour steps are on by default.
- [ ] The bridge inserts benchmark evidence with `source: "user_input"` (trust 1.0), not the `external_data` import default.
- [ ] A resumed run is idempotent: duplicate deterministic node ids are skipped, not fatal.
- [ ] `--checkpoint-every` is set (25 is a good default); a crash leaves `checkpoint.db` in the workspace.
- [ ] `MEMOS_SDK_PATH` points at the exact MemOS build (or `@mem-os/sdk` is installed).
- [ ] `READER_BASE_URL` serves the official `Qwen/Qwen3.5-9B`.
- [ ] `OPENAI_API_KEY` can reach the `gpt-5.2` judge.
- [ ] `LME_EMBEDDING_BASE_URL` serves `Qwen/Qwen3-Embedding-8B` if you want the official baseline comparison; the leaderboard does **not** validate the embedding model.
- [ ] `curl "$LME_EMBEDDING_BASE_URL/models"` succeeds.
- [ ] The `Qwen/Qwen3.5-9B` processor/tokenizer is available locally (the harness uses it to count memory-context tokens).
- [ ] Disk space for the SQLite DB + screenshots (small tier: plan >5 GB free).

## Operating points

Run at least one full operating point; three are recommended for the LAFS
frontier:

- [ ] `fast` — web + enterprise, small tier.
- [ ] `balanced` — web + enterprise, small tier.
- [ ] `accurate` — web + enterprise, small tier.
- [ ] Latency is scored, not just accuracy: LAFS integrates over 1s–200s and
      the reference frontier is flat at 51% until 26.9s, so a point at ~2s is
      worth far more than a better point at 150s. Do not buy accuracy with
      seconds without checking the gain table in `README.md`.
- [ ] Each run writes `aggregated_metrics.json`, `per_question.jsonl`,
      `run_args.json`, and `runtime_inputs/`.
- [ ] `per_question.jsonl` covers every question in `runtime_inputs/questions.json`.
- [ ] Reader model string contains `qwen3.5-9b`.
- [ ] Judge model string contains `gpt-5.2`.
- [ ] The judge endpoint actually serves base `gpt-5.2` (not
      `gpt-5.2-chat-latest`, shut down 2026-08-10). `preflight.py` probes
      `/models` and fails if it is absent.

## Package

- [ ] Step 1 produced one folder per operating point under
      `leaderboard/submissions/<name>/operating_points/`.
- [ ] Step 2 used the **bundled** `memory_modules/memos_backend.py` as the
      single code artifact.
- [ ] `SYSTEM_DESCRIPTION.md` describes the pools, embeddings, profiles, and
      limitations.
- [ ] `submission_overview.json` shows the expected method/tier/LAFS values.
- [ ] `tar -tzf leaderboard/submissions/<name>.tar.gz | head` shows the code
      file, `SYSTEM_DESCRIPTION.md`, and every operating point.

## Red flags that invalidate a package

- Mixing domains or tiers across operating points.
- A different web/enterprise question or haystack set.
- Reader/judge models different from the official validation gates.
- Reporting retrieval-only accuracy as LME-V2 answer accuracy.
- Reusing a run folder after changing the memory config without rebuilding it.
- Shipping a `memory_backend.py` that references a local absolute path that is
  not installed in the submission environment.

## Current known gaps (be explicit in the description)

- CLIP pixel search is off; evidence is AXTree text plus screenshot paths.
- Procedure/gotcha notes are deterministic, not controller-LLM syntheses.
- The bridge is one process per memory instance and does not support multiple
  concurrent writers to the same SQLite DB.
