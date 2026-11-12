# Recall budgets

A recall budget lets a caller bound a search by wall-clock time and/or token
cost instead of always paying for the full retrieval pipeline.

```ts
const { results, receipt } = await memos.searchWithReceipt({
  query: "deployment runbook",
  budget: { maxMs: 50, maxTokens: 800 },
});
```

`search()` accepts the same `budget` field and returns results only; use
`searchWithReceipt()` when you want the account of what ran.

## Why

Retrieval quality and retrieval cost are usually discussed separately. In
practice the useful question is "what is the best answer I can get in 50ms?"
— the same trade-off LongMemEval-V2's LAFS metric rewards. Budgets make that
question a first-class part of the API, and the receipt makes the answer
auditable.

## Tiers

The budget chooses a starting tier:

| Tier | What runs | Typical use |
| --- | --- | --- |
| 0 | SQLite FTS5 keyword leg only | interactive autocomplete, tiny budgets |
| 1 | keyword + semantic + entity legs, fused | chat recall under ~80ms |
| 2 | tier 1 + graph, PPR, and session expansion | default agent recall |
| 3 | tier 2 + rerank, MMR, multi-hop | accuracy-first / offline |

Selection is deliberately coarse:

- `maxMs <= 25` → 0
- `maxMs <= 80` → 1
- `maxMs <= 250` → 2
- otherwise → 3
- `maxTokens <= 400` with no `maxMs` → 1

`minTier` and `maxTier` override the policy for benchmarks and ablations.

Once a call starts, the tier is a ceiling. Stages at tier 2 and above are
also skipped when the **soft deadline** (75% of `maxMs`) passes. Tier 0 and 1
legs are never interrupted mid-flight: a single slow leg can still overshoot
the budget, and the receipt shows the real elapsed time.

## Receipt

```ts
interface RecallReceipt {
  budget: RecallBudget | null;
  tier: RecallTier;            // 0-3
  elapsedMs: number;
  degraded: boolean;           // skipped anything, or token-capped
  stages: {
    stage: string;             // "fts", "semantic", "graph", "rerank", ...
    ms: number;
    ran: boolean;
    skippedReason?: "budget" | "tier" | "empty" | "disabled";
  }[];
  skipped: string[];
  resultCount: number;
  estimatedTokens: number;
  tokenCapped: boolean;
}
```

`degraded` is true when the tier is below 3, any stage was skipped, or the
result list was trimmed by `maxTokens`.

Token estimates use the same zero-dependency estimator as context packs
(`context-pack.ts`), which is within ~10% of tiktoken for English text.

## Token capping

`maxTokens` trims the best-first result list. One result is always kept, even
if it alone exceeds the cap: returning nothing because the first memory is
large is worse than exceeding the budget by one item. `tokenCapped` records
that trimming happened.

## CLI

```bash
memos search "deployment runbook" --budget-ms 50 --budget-tokens 800
memos search "deployment runbook" --budget-ms 50 --json
```

The receipt prints after the results. With `--json`, the output becomes
`{ "results": [...], "receipt": {...} }` when a budget was supplied.

## MCP

`memos_search` accepts `budget_ms` and `budget_tokens`. The response text
carries a one-line summary and `structuredContent.receipt` carries the full
object.

## Interaction with the Flight Recorder

Tracing takes precedence over budget degradation. `memos search --trace
--budget-ms 10` runs the full pipeline so the trace is meaningful, and the
receipt reports tier 3. This is intentional: a degraded trace is not a useful
trace. Run traced and budgeted searches separately when you need both.

## Cache

Budgeted searches bypass the query cache. The chosen tier depends on runtime
timing, so replaying a cached full-pipeline result would silently defeat the
budget.

## Extending

Stage gating is pure and lives in `src/recall-budget.ts`:

- `selectRecallTier(budget)` — policy
- `createRecallPlan(budget)` — tier + monotonic deadlines + receipt
- `planAllowsStage(plan, stage)` — tier ceiling and soft deadline
- `recordRecallStage` / `recordSkippedStage` — receipt bookkeeping
- `capResultsByTokens(results, maxTokens)` — token trim
- `finishRecallPlan(plan, ...)` — finalize elapsed/degraded

`memory.ts` owns the actual stage calls. To gate a new stage, add it to
`RecallStage` and `STAGE_MIN_TIER`, then wrap the call with
`planAllowsStage` and `recordRecallStage`.

## Limitations

- The budget is best-effort, not a hard scheduler: a single stage already in
  flight can overshoot `maxMs`.
- Tier thresholds are a policy default, not a fitted cost model. Use
  `minTier`/`maxTier` when you need a fixed pipeline.
- The token estimator is an approximation; pass a real tokenizer to context
  packs if exact accounting matters.
