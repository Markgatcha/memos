# Task 1b — Gemini 4 Argon: ship multi-hop correctly, not just effectively

**Model:** `google/gemini-4-argon`
**Repo:** `C:\Users\marki\memos`
**Branch:** continue on `bench/hotpot-twohop` (do not open a new one)

---

Your multi-hop work landed and it is verified. An independent check reproduced it exactly:

```
HotPotQA all-evidence@10   77.8% -> 93.8%   (bridge 74.3% -> 93.1%)
gained: 80 | lost: 0 | unchanged: 420
gold fields in artifact: 0 | lists over K: 0 | duplicates: 0
```

Nothing in this task asks you to raise that number. **The score is done.** This task fixes the
things that make it unsafe to ship as it currently stands, and it is deliberately small —
you have limited budget, so treat every item as required and do not explore.

---

## 1. Make the feature opt-in (highest priority)

Right now `resolveMultiHopOptions` in `src/memory.ts` ends with:

```ts
return { ...cfg, enabled: true };
```

so **every caller of `memory.search()` pays the cost whether they asked or not.** That is wrong for
a feature that:

- costs ~4% latency (measured p50 448ms -> 467ms),
- only helps corpora with encyclopedic/lead-subject structure,
- changes result ordering for everyone.

Do this:

1. Change the default to **`enabled: false`** when neither
   `config.retrieval.multiHop` nor `SearchFilter.multiHop` asks for it.
2. An explicit `multiHop: true` or `{ enabled: true }` still turns it on. `false` still turns it off.
3. **Remove the `process.env.MEMOS_MULTIHOP` escape hatch.** No other retrieval feature in this
   codebase is controlled by an environment variable read inside a hot path; a config field is the
   documented way. If you believe the env var should stay, say why in the report instead of keeping
   it silently.
4. Update the doc comment on `MultiHopOptions` in `src/types.ts` to state: what it does, that it is
   **off by default**, its measured cost, and that it assumes entity-centric documents.

## 2. Make the benchmark say what it measures

`scripts/bench-hotpot.ts` must not rely on a default to exercise the feature. Add an explicit
`--multi-hop` flag (default off) that passes `multiHop: true` into the search call, and record
`multiHop: true|false` in the results artifact alongside `retrieval` metadata.

This is instrumentation, not scoring: do not touch ranking or metrics.

## 3. Prove the default is off

Add a test to `__tests__/multi-hop.test.ts`:

- `search()` with **no** multi-hop option returns the same ordering as with `multiHop: false`.
- `search()` with `multiHop: true` still produces the second-hop promotion.
- A config-level `retrieval.multiHop.enabled = true` enables it without a per-call flag.

## 4. Acceptance (all must pass — paste exact output)

1. `npx tsx scripts/bench-hotpot.ts` (no flag) -> **77.8%** all-evidence@10, i.e. multi-hop off.
2. `npx tsx scripts/bench-hotpot.ts --multi-hop` -> **93.8%** all-evidence@10 (allow ±0.2pp from
   non-deterministic tie-breaks; state the exact figure you got).
3. LongMemEval unchanged with the **default** config:
   ```
   npx tsx scripts/bench-longmemeval.ts --topk=20 --retrieve-only --contextual \
     --keyword-weight=0.5 --semantic-weight=0.5 --provider=ollama --model=nomic-embed-text \
     --fast-ingest --no-relative-time --no-neighbour-guard \
     --db=C:\Users\marki\AppData\Local\Temp\opencode\lme-full-after.db
   ```
   -> Hit@20 **99.4%**, all-evidence@20 **97.8%**.
4. `npx tsc --noEmit` clean.
5. `npm test` — all suites green.
6. `grep -rn "MEMOS_MULTIHOP" src scripts` returns nothing.

## 5. Docs — state the limit as plainly as the win

Add a section to `docs/benchmark-comparison.md`:

- HotPotQA table rows: `all-evidence@10` **77.8% (off, default)** and **93.8% (multiHop enabled)**,
  with the exact command for each.
- Quote your own generalisation caveats from the previous report verbatim in spirit: the feature
  depends on a recognisable lead subject (`"Subject: ..."` header or an encyclopedic copula
  sentence) and on lexical surface-form matching, so it will not fire on free-form notes or
  conversational transcripts, and alias/acronym bridges are missed.
- One sentence stating the measured latency cost.

## 6. Report

- The exact before/after numbers from the two HotPotQA runs and one LongMemEval run.
- Confirmation that the default is now off, with the grep output proving the env var is gone.
- Anything you changed that a user could notice without reading the changelog.

**Do not** attempt to close the remaining gap to 100%. A heuristic tuned further against one
dataset is not worth the budget.
