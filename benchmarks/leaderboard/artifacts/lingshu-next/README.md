# Lingshu Next (灵枢 Next) — session retrieval

Track A, LongMemEval-S, original full-500 split. The submitted measurements come from the desktop product's normal, frozen MemoryStore import and retrieval path. The public replay uses the identical ranking module with a minimal SQLite adapter for fresh, isolated benchmark databases. Three runs rebuild each question's database from scratch. Every result row includes the ordered session ordinals and per-run measurements.

## Run from a clean checkout

Use Node.js 24.19.0 with built-in node:sqlite and Python 3.12. Put node on PATH and use your Python 3.12 interpreter to launch the replay. On Windows, python can be used in place of python3. There are no packages to install. From the checkout root:

```sh
curl -fL "https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/2ec2a557f339b6c0369619b1ed5793734cc87533/longmemeval_s" -o longmemeval_s
python3 benchmarks/leaderboard/artifacts/lingshu-next/replay.py longmemeval_s replay-output
```

The replay checks the SHA-256 of the original split, imports both conversation roles, queries the public ranker, recomputes hits against the dataset and verifies the exact ordered ranks for all 500 questions in each run. Use a fresh output directory. Scores and exact rank order are deterministic. Timing depends on hardware and the adapter. The product store SHA identifies the private production source used for timing. The published ranking module is byte-identical to the production ranker. The public adapter omits production features unrelated to this split, including editable saved facts, deletion journals and UI state. It is intended for fresh benchmark databases.

## Protocol

A fresh workspace receives only raw message text, roles and timestamps. Session and message IDs are derived from ordinals and contain no gold markers. Questions enter only at query time. A separate scorer maps the returned ordinals to the original evidence IDs. All 500 annotated questions are scored, including the 30 abstention examples, following the organizer's original evidence mapping. The harder question of whether to abstain from answering is outside this retrieval metric.

The desktop product indexes original user turns, supports Unicode word matching and CJK character and bigram matching. The new local ranker considers inflection variants, weights query terms by message and session frequency and discounts repeated hits from the same session. The permission filter runs before ranking. The product returns up to 64 source messages within a 24,000-character context. The harness keeps the first occurrence of each session, at most 20, and leaves unfilled places empty. There is no model, embedding service, reader, LLM judge or model-weight training in this track.

See measurement.json for same-dataset baseline, frozen product fingerprints, actual run hardware, latency, three individual scores and their variation. The independent development comparison used separately authored conversations. The ranking constants were frozen before the candidate evaluation. The public result rows contain IDs, ordinals, metrics and timings only. returnedSessionCount counts returned corpus positions; uniqueBenchmarkSessionIdCount counts distinct original benchmark IDs after mapping those positions. Duplicate original IDs are collapsed for evidence scoring. Each run's summary reports both counts separately.

## Credits and licensing

- Thanks to Di Wu and the LongMemEval authors for the dataset and evidence annotations. The [dataset card](https://huggingface.co/datasets/xiaowu0162/longmemeval) specifies MIT. The dataset is downloaded separately. [LongMemEval code and paper](https://github.com/xiaowu0162/LongMemEval).
- Thanks to Markgatcha and the MemOS contributors for the public retrieval protocol and the published comparator. The [leaderboard specification](https://memos.readthedocs.io/en/latest/benchmark-leaderboard/) and [upstream repository](https://github.com/Markgatcha/memos) define this submission track. Next supplies its own retrieval implementation.
- The runtime uses [Node.js](https://github.com/nodejs/node/blob/main/LICENSE) and its bundled [SQLite](https://sqlite.org/copyright.html). SQLite is public domain. SQLite's [FTS5 ranking documentation](https://sqlite.org/fts5.html) informed the lexical-weighting approach. The implementation uses regular SQLite postings, independent of the FTS5 compile option.
- The Lingshu Next ranking module, replay adapter and scripts supplied in this directory are available under the included MIT license. The scope of this release is the reproducible retrieval component.

## Second development round

A separately frozen ranker changed the ordered results of 53 of 500 questions. Across three fresh full-split runs, every question retained the same hit, evidence recall, and all-evidence outcome as the submitted version. Median product query time was 5.79 ms in this run and 3.97 ms in the original run under different host loads. The submitted ranker remains the first revision. The experiment and its component hashes are recorded in measurement.json.
