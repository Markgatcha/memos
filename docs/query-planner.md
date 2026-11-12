# Query planner

The planner classifies a query into one of five retrieval abilities and
switches on the parts of the pipeline that question actually needs.

```bash
memos plan "How many deployments did we do across sessions?"
# Intent: aggregation (confidence 0.67)
# Signals: how many, across, sessions
# Strategy: multi-hop, wider candidates
```

Before this, temporal anchoring, multi-hop expansion, and candidate depth
were per-call flags. The default path ran one fixed pipeline regardless of
whether the question was "when did X happen" or "how many X are there".

## Intents

| Intent | Example | Switches |
| --- | --- | --- |
| `temporal` | "When did we last deploy?" | temporal anchoring (already query-aware) |
| `knowledge-update` | "What is the current policy?" | recency bias signal |
| `aggregation` | "How many deployments in total?" | multi-hop, candidate depth ×2 |
| `multi-session` | "Compare what we discussed across sessions" | multi-hop |
| `abstention` | "Do you know my favorite editor?" | abstention hint |
| `general` | "deployment runbook" | none |

Classification is lexical: weighted regex rules, no model call, no network.
Signals are returned so you can see exactly which phrases fired.

## Integration

`search()` runs the planner by default when a query is present:

- **Aggregation** doubles the candidate pool (capped at 400) before ranking.
- **Multi-session** and **aggregation** enable second-hop entity expansion
  unless the caller pinned `filter.multiHop`.
- The chosen intent and signals are recorded on `RecallReceipt.intent` and
  `RecallReceipt.planSignals` when a receipt is requested.

Temporal anchoring is not duplicated here: `resolveRelativeTimeAnchor`
already activates on time expressions regardless of intent.

## API

```ts
const plan = memos.planQuery("How many deploys across sessions?");
// plan.intent, plan.confidence, plan.signals, plan.multiHop, ...

const { receipt } = await memos.searchWithReceipt({
  query: "When did we last deploy?",
});
// receipt.intent === "temporal"
```

Disable per query with `planner: false`:

```ts
await memos.search({ query, planner: false });
```

## CLI

```bash
memos plan "<query>" [--json]
```

## Limits

- English lexical cues only. Other languages fall through to `general`.
- Confidence is the share of matched weight won by the top intent, not a
  calibrated probability.
- The planner is advisory: `planner: false`, explicit `multiHop`, and
  `candidateDepth` all win over its recommendations.
- It does not change the relevance gate. An abstention hint is recorded but
  not acted on automatically, because enabling the gate changes result sets
  and should stay an explicit choice.
