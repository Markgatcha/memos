# Recall Inspector, Outcome Feedback, and Memory Health

Three related surfaces for answering questions that ordinary retrieval cannot:

| Question | Surface |
| --- | --- |
| "Why did I recall this — and why not that?" | `memos.explain()` / `memos_explain` |
| "Did the memories I injected actually help?" | `recordRecallFeedback()` / `memos_feedback` |
| "Is the memory store healthy and getting more useful?" | `memos.health()` / `memos_health` |

All three are local-first and deterministic. No LLM calls, no outbound network
requests, and no schema changes to `nodes` or `edges`. Feedback lives in two
new SQLite tables (`recall_batches`, `recall_feedback`) and is loaded into
memory once at `init()`.

---

## Feedback model

A **feedback batch** records one task outcome for one query:

- `query` — the query whose results were used;
- `used` — the ids of memories the agent actually used (may be empty);
- `outcome` — `success`, `partial`, or `failure`;
- `weight` — optional importance weight, default `1` (range `0.01`–`100`);
- `note` — optional free-form text.

Credit assignment is explicit. MemOS never guesses that the top-ranked result
was used: rank position is a prediction, and learning from predictions would
teach the store its own biases.

### Utility

For each memory, weighted counts become a Beta-smoothed success rate:

```text
successes = success + 0.5 x partial
failures  = failure + 0.5 x partial
utility   = (successes + 1) / (successes + failures + 2)
```

- no evidence → `0.5` (neutral);
- one success → `0.667`;
- one failure → `0.333`;
- `partial` pulls toward neutral rather than being ignored.

### Ranking multiplier

Outcome-conditioned ranking multiplies the fused score by:

```text
1 + weight x (utility - 0.5) x 2
```

With the default `weight = 0.2`, the multiplier is bounded to `0.8`–`1.2`, so
feedback can reorder close candidates but cannot bury a strong relevance match.
The stage is a no-op until feedback exists, which keeps historical ranking
byte-for-byte unchanged on an empty feedback store.

Configuration:

```ts
const memos = new MemOS({
  retrieval: {
    outcomeFeedback: {
      enabled: true,       // default true; no effect without feedback
      weight: 0.2,         // maximum +/-20% swing
      minObservations: 1,  // require repeated evidence before moving rank
    },
  },
});
```

Per-query ablation:

```ts
await memos.search({ query: "deploy", outcomeFeedback: false });
```

### Uplift (observational, not causal)

`recallUtility(id).uplift` compares the weighted mean outcome of batches that
used the memory against batches that did not:

```text
uplift = meanOutcome(used batches) - meanOutcome(unused batches)
```

It is `null` when either side has no samples. This is useful for spotting
memories that correlate with success, but it is **observational**: memories are
used when they look relevant, so topic difficulty and selection effects are
baked in. Do not present it as a treatment effect without a controlled
experiment.

### Persistence and deletion

- SQLite persists batches atomically with their attributions.
- Custom adapters can implement `saveRecallBatch`, `getRecallBatches`,
  `deleteRecallFeedback`, and `deleteAllRecallFeedback`; without them, feedback
  works for the current process only.
- `forget(id)` removes that memory's attributions from the cache and the
  database. Batch outcomes are retained because they remain valid evidence
  about the query.
- `clearRecallFeedback()` removes everything; `clear()` also clears feedback.

---

## Recall inspector

`explain()` runs the same hybrid pipeline as `search()` but stops **before** the
relevance gate and MMR, so an operator can see the full candidate set and what
the gate would do to it.

```ts
const report = await memos.explain({
  query: "where does the user live",
  memoryId: oldAddressId, // optional
  limit: 10,
  namespace: "project:alpha",
  pool: "event",
});
```

Result shape:

```ts
{
  query: string;
  generatedAt: number;
  gate: { enabled, abstained, trimmed, dropped };
  candidateCount: number;   // before the display limit
  candidates: ExplainCandidate[];
  focus?: ExplainFocus;
  notes: string[];
}
```

Each candidate includes:

- `score` and `rank`;
- `components` — `keyword`, `semantic` / `semanticRaw`, `entity`, `entityLeg`,
  `graph`, `ppr`, `session`, `rerank`, `imageLeg`, `multiHop`,
  `provenance`, `contradictionDemotion`, `retrievalAnomaly`,
  `outcomeUtility`, and `hybrid`;
- `status` — `active`, `historical`, `expired`, or `quarantined`;
- `pool`, `namespace`, type, trust, confidence, importance, age, access stats;
- `utility` — the full feedback view;
- `history` — supersede chain from `temporal_precedes` edges;
- `reasons` — human-readable evidence and caveats.

### "Why wasn't my memory returned?"

Pass `memoryId`. If the memory is missing from the candidate window, `focus`
reports each check:

| Check | Meaning |
| --- | --- |
| `exists` | The id exists in this database. |
| `lifecycle` | Active, not historical/expired/quarantined. |
| `namespace` | Matches the query's namespace filter. |
| `pool` | Matches the query's pool filter. |
| `embedding` | A vector exists for the active model and dimensions. |
| `lexical-overlap` | Shares at least one content token with the query. |

If every check passes but the memory still was not retrieved, the reason says
so: it ranked outside the candidate window. Widen `limit` / `candidateDepth`,
or improve the embedding model/reranker.

### Score semantics

Component scores are **evidence, not additive shares**. Fusion normalizes and
combines the retrieval legs, then later stages multiply the fused score. `rank`
is the authoritative ordering; components explain which signals were present.

### Gate semantics

`gate.abstained` means `search()` would return an empty list. `gate.trimmed`
means tail-trimming would drop candidates; `gate.dropped` is how many. This is
computed with the same `applyRelevanceGate` function the search path uses, so
the inspector and the real query cannot drift.

---

## Memory health

`health()` scans the graph (like `diagnostics()`) and reports maintenance and
usefulness signals:

```ts
const report = await memos.health();
```

```ts
{
  score: number;          // 0-100 heuristic
  grade: "A" | "B" | "C" | "D";
  metrics: {
    totalNodes, activeNodes, historicalNodes,
    expiredActive, expiringSoon, quarantined,
    unresolvedContradictions, lowConfidence,
    historicalShare, staleRecallRisk,
    feedbackBatches, usefulRecallRate, memoriesWithFeedback,
  };
  findings: Array<{ id, severity, title, detail, action? }>;
}
```

### What moves the score

| Signal | Maximum penalty |
| --- | --- |
| Unresolved contradictions per active memory | 25 |
| Memories past TTL | 15 |
| Low-confidence share (confidence < 0.35) | 10 |
| Quarantined share | 5 |
| Useful-recall rate below 50% (at least 10 batches) | 15 |

Grades: `A` ≥ 90, `B` ≥ 75, `C` ≥ 60, otherwise `D`.

`staleRecallRisk` is a heuristic: unresolved contradictions divided by active
memories, clamped to `[0, 1]`. It is **not** the FAMA benchmark metric from
the personalized-agent memory literature; it is a maintenance signal.

The score is intentionally conservative and should not be used as a
benchmark. The actionable part is `findings`: each one names the condition and
a next command.

---

## CLI

```bash
memos explain "where does the user live" --id <memoryId> --limit 10
memos feedback --query "where does the user live" --used <id1,id2> \
  --outcome success --note "answered correctly"
memos health
memos health --json
```

## MCP

| Tool | Annotation | Purpose |
| --- | --- | --- |
| `memos_explain` | read-only | Query explanation + optional focus checks. |
| `memos_feedback` | write | Record used ids and task outcome. |
| `memos_health` | read-only | Hygiene + usefulness report. |

## Data model

```sql
CREATE TABLE recall_batches (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  query TEXT NOT NULL,
  outcome TEXT NOT NULL,   -- success | partial | failure
  weight REAL NOT NULL,
  note TEXT
);

CREATE TABLE recall_feedback (
  batch_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  PRIMARY KEY (batch_id, memory_id)
);
```

Inspect them with any SQLite client. Deleting rows from `recall_batches` makes
the corresponding attribution rows unreachable (the loader joins from batches),
but orphan rows are not garbage-collected automatically. Use
`memos.clearRecallFeedback()` for a clean reset.
