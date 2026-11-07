# Open memory benchmark leaderboard

A reproducible leaderboard for AI memory systems. Two tracks, mandatory
disclosure, and a machine-checkable submission format.

The goal is not to declare a winner. It is to make every published number
reproducible from a committed artifact, so a reader can tell the difference
between a better memory system and a more generous judge.

## Why this exists

Public memory benchmarks are easy to game:

- LoCoMo has ~99 wrong golden answers in 1,540 questions (6.4%), so a perfect
  system caps out near **93.6%**, not 100%.
- The standard LoCoMo judge accepts **~63%** of intentionally wrong but
  topically adjacent answers.
- Judge-prompt changes alone have moved the same answers by **40+ points**.
- `top_k` larger than the number of sessions retrieves the whole corpus, which
  turns retrieval into reading comprehension.

A score without the harness is not evidence. This leaderboard requires the
harness.

## Tracks

### Track A — retrieval only (deterministic)

No reader model, no LLM judge. Score by evidence IDs.

| Metric | Definition |
| --- | --- |
| `hit_at_k` | Fraction of questions with at least one gold evidence item in the top *k* |
| `evidence_recall_at_k` | Fraction of gold evidence items retrieved in the top *k* |
| `all_evidence_at_k` | Fraction of questions where **every** gold evidence item is in the top *k* |

This is the honest floor. It measures memory, not generation.

### Track B — end to end (judged)

Reader model answers from the returned context; a judge scores the answer.
Track B submissions must disclose the reader model, judge model, judge prompt
(hash and full text), temperature, and number of runs.

Track B is reported **separately** and never merged into Track A.

## Rules

1. **Report the mean of at least 3 runs, with standard deviation.** Single-run
   point estimates are marked `provisional`.
2. **Disclose the judge.** Model, prompt text, and a SHA-256 of the prompt file.
   Undisclosed judges are rejected.
3. **Disclose ingestion.** Chunking, embedder, reranker, contextual headers,
   and whether ingestion used an LLM.
4. **`top_k` must be smaller than the corpus.** A submission with
   `top_k >= sessions_in_corpus` is rejected for that dataset.
5. **Publish artifacts.** Per-question results (JSONL) plus the command that
   produced them. A link to a private bucket is not an artifact.
6. **No post-pass score editing.** If a harness post-processes results, say so
   in `disclosures.post_processing`; unexplained deltas are rejected.
7. **Retractions are permanent.** A corrected submission replaces the score but
   the old row stays visible with a `retracted` note.

## Submission format

One JSON file per system per track:

```json
{
  "schema_version": "1.0",
  "system": "MemOS",
  "system_version": "1.6.27",
  "system_commit": "d0c3a52",
  "track": "retrieval",
  "dataset": "longmemeval-s",
  "dataset_version": "2026-01",
  "split": "full-500",
  "k": 20,
  "runs": 3,
  "metrics": {
    "hit_at_k": 0.994,
    "evidence_recall_at_k": 0.991,
    "all_evidence_at_k": 0.978
  },
  "stddev": {
    "hit_at_k": 0.0,
    "all_evidence_at_k": 0.0
  },
  "cost": {
    "tokens_per_query": null,
    "latency_p50_ms": 464,
    "index_build_seconds": 786
  },
  "config": {
    "embedder": "nomic-embed-text",
    "reranker": null,
    "chunking": "one node per session",
    "contextual_header": true,
    "top_k": 20
  },
  "disclosures": {
    "judge_model": null,
    "judge_prompt_sha256": null,
    "reader_model": null,
    "post_processing": "none",
    "known_limitations": "retrieval-only; no answer generation"
  },
  "artifacts_url": "https://github.com/Markgatcha/memos/tree/main/docs/artifacts",
  "reproduction_command": "pnpm bench:longmemeval:retrieve --db=... --k=20",
  "submitted_by": "Markgatcha",
  "submitted_at": "2026-11-04"
}
```

Field notes:

- `track`: `retrieval` or `end_to_end`.
- `k`: required for retrieval; `null` for end-to-end.
- `tokens_per_query`: measured, not estimated. `null` if not measured.
- `latency_p50_ms`: measured on the recorded run, not a vendor claim.
- `reproduction_command`: must run from a clean clone with documented env vars.

## Validation

A submission is accepted when:

1. It validates against `benchmarks/leaderboard.schema.json` (implementation tracked in [#83](https://github.com/Markgatcha/memos/issues/83)).
2. `reproduction_command` completes and regenerates `artifacts_url` results
   within 10% of the submitted metrics (or the maintainer records why not).
3. Disclosure fields are complete for the chosen track.
4. The dataset license allows redistribution of per-question results.

Rejected submissions stay in the PR with the reason, so the rejection is
auditable too.

## Current entries

| System | Track | Dataset | Score | Runs | Artifacts |
| --- | --- | --- | ---: | ---: | --- |
| MemOS 1.6.27 | retrieval | LongMemEval-S, full 500 | 99.4% Hit@20 / 97.8% all-evidence@20 | 3 | `docs/artifacts/` |
| MemOS 1.6.27 | retrieval | ConvoMem, 387 scored | 91.0% Hit@10 / 89.4% evidence recall@10 | 1 | `docs/artifacts/` |
| MemOS 1.6.27 | retrieval | LoCoMo, convs 0–1 | 79.8% Hit@10 / 75.9% evidence recall@10 | 3 | `docs/artifacts/` |

Unverified vendor claims belong in the [claims register](#claims-register),
not in the table above.

## Claims register

Numbers published without a runnable harness are listed here for context, not
ranked. This is where a 92.2% LoCoMo claim sits next to the 93.6% ceiling.

| System | Claim | Track | Harness disclosed? |
| --- | --- | --- | --- |
| Living Brain | 92.2% judged accuracy, LoCoMo 1,540 q | end-to-end | No — "internal evaluations" |
| Mem0 | 68.5% LoCoMo (published) | end-to-end | Partial |
| Supermemory | 97% Recall@20, LongMemEval-S | retrieval | Aggregation method disclosed |

## How to submit

1. Add `benchmarks/leaderboard/<system>-<track>.json`.
2. Add per-question artifacts under `benchmarks/leaderboard/artifacts/<system>/`.
3. Open a PR titled `leaderboard: <system> <track> <dataset>`.
4. The PR template asks for the reproduction command and the hardware used.

Corrections are welcome, including corrections to MemOS rows. If a number here
is wrong, the row gets marked `retracted` and the fix is recorded in
`CHANGELOG.md`.
