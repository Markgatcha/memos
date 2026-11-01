# Task 1 — Gemini 4 Argon: raise HotPotQA multi-hop recall in MemOS

**Model:** `google/gemini-4-argon`
**Repo:** `C:\Users\marki\memos`
**Branch:** create `bench/hotpot-twohop` before starting. Do not touch anything outside it.

---

You are working on MemOS, a local-first memory layer for AI agents (TypeScript, SQLite, no cloud).
Your job is one thing: raise **HotPotQA all-evidence@10 from 77.8%** without regressing any other
benchmark. This is a measurement-discipline task as much as an engineering one — read the rules
before the goal.

---

## 1. Non-negotiable rules

1. **The gain must come from `src/`.** The benchmark script may not post-process, re-rank, or
   "repair" results after `memos.search()` returns. If you change `scripts/bench-hotpot.ts` to
   improve the score, the work is rejected. (The harness may gain *instrumentation* only.)
2. **Do not widen K.** Scoring is at K=10. Returning more than 10 items, or evaluating at K=20
   "because it's better", is a rejection.
3. **No dataset leakage.** You may not read `supporting_facts` or `answer` at retrieval time, may
   not hardcode question types, and may not special-case specific question IDs. Any rule that only
   helps because this is a benchmark is cheating; if it would not help a real user asking a
   two-hop question, don't ship it.
4. **Measure, don't assume.** Every claim you make must be backed by a benchmark run you actually
   performed and can quote. If a change does not help, say so and revert it.
5. **Stop and report if blocked.** Guessing wastes the run.

---

## 2. The current state (already verified — do not re-derive)

Command:

```
npx tsx scripts/bench-hotpot.ts
```

Result (500 questions, deterministic title-ID matching, retrieval-only):

```
Hit@5   98.2% | EvRec@5  76.5% | AllEv@5  54.8% | MRR 0.879
Hit@10  99.6% | EvRec@10 88.7% | AllEv@10 77.8% | MRR 0.882 | nDCG@10 0.785
  bridge       Qs 404  Hit 99.5%  EvRec 86.9%  AllEv 74.3%  MRR 0.895
  comparison   Qs  96  Hit 100.0% EvRec 96.4%  AllEv 92.7%  MRR 0.829
```

Each question has exactly **2 gold Wikipedia paragraphs** hidden among ~10 hard distractors.
MemOS ingests every paragraph in the slice once (~4.9k paragraphs, deduplicated by title) and is
scored on retrieving **both** gold titles by `metadata.hotpot_title`.

**Key fact: retrieval is deterministic.** Three consecutive runs on the same corpus produced
identical numbers. So any change you observe is real signal, not noise. Use that.

### Failure analysis I already ran (this is your starting point)

- **111 questions fail all-evidence@10.**
- **109 of those are missing exactly ONE gold title**; only 2 miss both.
- **Zero** of the missing titles appear anywhere below the K=10 cut. This is not a ranking-depth
  problem, not a K problem, and not a fusion-weight problem.
- **103 of those 109** missing paragraphs share at least one content word with the question.
- The failures cluster in **bridge** questions: the classic two-hop case. Question asks about A;
  the paragraph that names A does not contain the answer, and the paragraph that contains the
  answer is reachable only through an entity named in the *first* paragraph.

Canonical example (question `5a8b57f25542995d1e6f1371`):

> Q: "What government position was held by the woman who portrayed Corliss Archer in the film
> Kiss and Tell?"
> Gold: **Kiss and Tell (1945 film)** + **Shirley Temple**
> Top-5 retrieved: Kiss and Tell (1945 film) | A Kiss for Corliss | Meet Corliss Archer (TV series)
> | Meet Corliss Archer | Charles Craft
> **Missing: Shirley Temple.**

The first hop is solved. The second hop — "which actress was in that film, and what did she do" —
is never expressed in the query, so no single-query retriever can find it by similarity alone.

---

## 3. A trap that already cost us a regression

An earlier attempt added temporal neighbour expansion to the retrieval post-rank. It expanded from
**every node in the corpus** rather than only from memories the query returned, and it *lowered*
LongMemEval all-evidence from 97.8% to 97.0% by evicting sessions that had legitimately matched.

**Lesson to apply here:** any second-hop expansion must originate from evidence the first hop
actually returned, must be bounded, and must never displace a higher-scoring first-hop result.

---

## 4. The task

Design and implement **genuine second-hop retrieval**. Suggested direction (you may deviate if you
can justify it with numbers):

1. **First hop:** existing hybrid search returns its top candidates as today.
2. **Bridge extraction:** from the top few first-hop documents, identify candidate bridging
   entities — ideally the ones the query is reaching for but did not name. Title mentions, named
   entities, capitalised n-grams, and the existing `src/entity-index.ts` / `entity-extraction.ts`
   are all available and already built.
3. **Second hop:** issue a bounded number of follow-up retrievals using those bridge entities
   (single-query or a small RRF-fused set via the existing `fuseSessionLists`-style helpers).
4. **Fusion:** merge first and second hop, keeping first-hop ranking dominant, capped at the
   caller's `limit`.
5. **Expose it as an opt-in `SearchFilter` option** (e.g. `multiHop: { enabled, maxEntities }`),
   documented in `src/types.ts`, so callers choose the latency cost. Do **not** make it default if
   it costs meaningful latency — measure and report the p50 delta.

Relevant existing code to read first:

- `src/retrieval.ts`, `src/memory.ts` (`hybridSearch`, `applyRankingModulators`)
- `src/entity-extraction.ts`, `src/entity-index.ts`, `src/graph-expansion.ts`
- `scripts/bench-hotpot.ts` (harness; instrumentation only)
- `src/temporal-rerank.ts` (example of a well-scoped post-ranker with tests)

---

## 5. Acceptance tests (all must pass — report the exact output)

1. `npx tsx scripts/bench-hotpot.ts` → **all-evidence@10 > 77.8%** (and report bridge separately).
2. **No regression:** LongMemEval all-evidence@20 must stay **≥ 97.8%** and Hit@20 ≥ 99.4%.

   If a corpus DB already exists, reuse it (ingestion is skipped for populated namespaces):

   ```
   npx tsx scripts/bench-longmemeval.ts --topk=20 --retrieve-only --contextual \
     --keyword-weight=0.5 --semantic-weight=0.5 --provider=ollama --model=nomic-embed-text \
     --fast-ingest --no-relative-time --no-neighbour-guard \
     --db=C:\Users\marki\AppData\Local\Temp\opencode\lme-full-after.db
   ```

   **If that DB is not present** (fresh clone, different machine), do not spend hours rebuilding it
   and do not skip this check: run the objective subset instead, which is fast and still catches
   regressions — the multi-session and temporal-reasoning categories are where a badly-scoped
   expansion shows up first:

   ```
   npx tsx scripts/bench-longmemeval.ts --topk=20 --retrieve-only --contextual \
     --max-questions=100 --provider=ollama --model=nomic-embed-text --fast-ingest
   ```

   Report the subset figure and say explicitly that it is a subset. **Never** present a subset
   number as the full-set number.
3. `npx tsc --noEmit` clean.
4. `npm test` — all passing suites must still pass.
5. New unit tests covering: bounded entity count, no displacement of higher-ranked results,
   no leakage of gold data, and list length never exceeding `limit`.

---

## 6. Report format (be blunt)

- Before/after table for HotPotQA (overall + bridge + comparison) and LongMemEval.
- p50/p95 retrieval latency before and after.
- What you tried that **did not** work, and why. This section is as valuable as the wins.
- Anything you suspect would not generalise beyond HotPotQA.
- If you could not beat 77.8%, say so plainly, show what you learned, and leave the branch with
  only the instrumentation improvements — do not ship a non-improving default.
