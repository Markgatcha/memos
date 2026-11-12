# Retrieval Flight Recorder: Tracing, Explain, and Counterfactual Replay

When a search returns an unexpected ranking, `memos explain "<query>"` re-runs a live query against the current database, and `time-travel.ts` reconstructs historical node state. Neither tells you what a **past search call actually saw** or what a different fusion/gate/MMR configuration would have returned on those exact candidates.

The **Retrieval Flight Recorder** closes that gap with three local-first primitives:

1. **Opt-in trace capture** (`recall_traces` table in SQLite) — zero overhead when disabled (single boolean check on the hot path).
2. **`explain-recall`** (CLI, TypeScript SDK, and opt-in MCP tool `memos_explain_recall`) — inspects per-leg candidates, timings, stage deltas, and per-item score contributions.
3. **Counterfactual `replay`** (CLI and SDK) — recomputes rankings offline from stored candidate scores with **no re-embedding** and **no database re-queries**, producing byte-identical diffs.

---

## 1. Enabling Tracing

Tracing is **OFF by default**. Enable it per command, per query, or per `MemOS` instance.

### CLI & Environment Variables

```bash
# Enable via environment variable for any search
MEMOS_TRACE=1 memos search "deployment runbook"

# Or pass --trace directly on memos search
memos search "deployment runbook" --trace

# Include memory summary/content in the trace payload for human debugging
memos search "deployment runbook" --trace --capture-text --session debug-run-1
```

When tracing is active in non-JSON CLI mode, `memos search` prints the recorded trace ID at the end of the output:

```text
Trace ID: tr_9f4b2c1a-...
```

You can also list recent recorded traces at any time:

```bash
memos explain-recall --list --limit 10
```

### TypeScript SDK

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS({
  retrieval: {
    trace: {
      enabled: false,     // default false; override per query with trace: true
      captureText: false, // default false (IDs and numeric scores only)
      maxTraces: 500,     // retention cap; oldest rows pruned on write
      sessionId: "app-1", // optional default session_id
    },
  },
});
await memos.init();

const results = await memos.search({
  query: "deployment runbook",
  trace: true,
  captureText: false,
});

const traceId = memos.getLastTraceId();
```

### Privacy & Retention Defaults

- **No memory text by default**: `captureText` defaults to `false`. The `recall_traces` payload records candidate IDs, raw leg scores, numeric multipliers, exact-term-match booleans, and sparse numeric pairwise Jaccard floats for offline MMR replay — never memory `content` or `summary` unless `captureText: true` is explicitly set.
- **Bounded retention**: `saveRecallTrace` keeps the newest `N` traces (default `500`, configurable via `retrieval.trace.maxTraces` or `MEMOS_TRACE_MAX`) and prunes older rows atomically in the same SQLite transaction.

---

## 2. Reading `explain-recall` Output

Run `memos explain-recall <trace-id>` (or pass `latest` to inspect the newest trace):

```bash
memos explain-recall tr_9f4b2c1a-7d3e-4b0a-9f88-123456789abc
```

Example output:

```text
Trace:       tr_9f4b2c1a-7d3e-4b0a-9f88-123456789abc
Query:       "deployment runbook"
Created:     2026-11-11T18:30:00.000Z
Latency:     4.12 ms
Config hash: 8c2e1f904ab7d312

Configuration:
  Fusion mode:       convex (adaptive=true, rrfK=60)
  Configured weights: kw=0.800 sem=0.200 ent=0.100 clip=0.000
  Effective weights:  kw=0.769 sem=0.154 ent=0.077 clip=0.000
  Rerank:            off
  Relevance gate:    off
  MMR:               off

Per-leg candidates & timings:
  - fts      (enabled) 1.84 ms — 3 candidate(s)
      #1 cand_kw_strong  raw=-2.4120
      #2 cand_kw_dup  raw=-2.4120
      #3 cand_tail  raw=-0.8150
  - semantic (enabled [exact]) 0.62 ms — 4 candidate(s)
      #1 cand_sem_strong  raw=0.9996
      #2 cand_kw_strong  raw=0.6921
      #3 cand_kw_dup  raw=0.6921
      #4 cand_tail  raw=0.3310
  - entity   (disabled) 0.01 ms — 0 candidate(s)
  - graph    (enabled) 0.11 ms — 0 candidate(s)

Final ranking (3 item(s)):
  #1 cand_kw_dup  score=0.8519  introduced=fts  legs=[fts,semantic]
      contributions: fts=0.7692, sem=0.0827 (cos=0.692)
  #2 cand_kw_strong  score=0.8519  introduced=fts  legs=[fts,semantic]
      contributions: fts=0.7692, sem=0.0827 (cos=0.692)
  #3 cand_sem_strong  score=0.1538  introduced=semantic  legs=[semantic]
      contributions: sem=0.1538 (cos=1.000)
```

### Key Fields

- **Configured vs. Effective weights**: In `convex` mode, short queries (`<= 3` tokens) and entity-dense queries (`>= 2` entities) adaptively rebalance and renormalize leg weights to sum to `1.0`. Both raw and post-routing weights are shown.
- **Per-leg candidates & timings**:
  - `fts` — SQLite FTS5 BM25 leg (more negative raw BM25 scores indicate stronger lexical matches; PRF-expanded hits are tagged `(prf)`).
  - `semantic` — embedding cosine leg (`[exact]`, `[prefilter]`, `[auto]`, or `[ann]`).
  - `entity` — inverted entity index leg (raw score = matched entity count).
  - `graph` — post-fusion neighbour, PPR (`(ppr)`), session (`(session)`), or multi-hop (`(multiHop)`) injections.
  - `clip` — shown when Track B CLIP visual search is enabled.
- **`introduced=<leg>` and `legs=[...]`**: `introduced` names the first leg in canonical pipeline order (`fts -> semantic -> entity -> clip -> graph`) that brought the item into the candidate pool; `legs` lists every leg that matched it.
- **`contributions`**: Additive leg terms (`fts`, `sem`, `entLeg`, `clip`), multiplicative boosts/penalties (`entBoost`, `trust`, `prov`, `conf`, `mod`), cross-encoder score (`rerank`), and rank shifts (`rerankRank`, `mmrRank`).

### MCP Tool (`memos_explain_recall`)

`memos_explain_recall` returns the same `ExplainRecallReport` as `structuredContent.explanation`. To keep default agent context lean, it is **excluded from the default core tool set**; enable it with:

```bash
MEMOS_MCP_TOOLS=all memos mcp
# or selectively alongside core tools:
MEMOS_MCP_TOOLS=memos_store,memos_search,memos_explain_recall memos mcp
```

---

## 3. Running Counterfactual Replay

`memos replay <trace-id> --config <file.json>` recomputes the ranking purely from the candidate scores stored in the trace — **zero re-embedding, zero SQLite node queries, and deterministic byte-identical output**.

Create an override file, e.g. `rrf-diverse.json`:

```json
{
  "fusionMode": "rrf",
  "keywordWeight": 0.4,
  "semanticWeight": 0.6,
  "mmrLambda": 0.35,
  "relevanceGateThreshold": 0.2,
  "rerank": false
}
```

Run the replay:

```bash
memos replay tr_9f4b2c1a-7d3e-4b0a-9f88-123456789abc --config rrf-diverse.json
```

Pass `--json` for machine-readable `ReplayRecallReport` JSON.

### Supported Config Overrides

Both flat keys and nested `MemOSConfig`-shaped blocks (`fusion.*`, `retrieval.mmr.*`, `retrieval.relevanceGate.*`) are accepted:

| Override field | Type | Effect |
| --- | --- | --- |
| `fusionMode` | `"convex" \| "rrf"` | Switch between min-max convex combination and Reciprocal Rank Fusion |
| `keywordWeight` / `semanticWeight` / `entityLegWeight` / `imageLegWeight` | `number` | Override per-leg fusion weights |
| `adaptiveWeighting` | `boolean` | Enable or disable query-shape adaptive leg routing in `convex` mode |
| `rrfK` | `number` | RRF rank smoothing constant (default `60`) |
| `mmrLambda` (or `mmr`) | `number \| boolean \| null` | Enable MMR diversification with `lambda` in `[0, 1)` (`0` = max novelty, `null`/`false` = off) |
| `relevanceGateThreshold` / `relevanceRatio` | `number \| null` | Trim candidates scoring below `topScore * ratio` |
| `abstainSimilarity` | `number \| null` | Abstain when max semantic/CLIP cosine is below floor and no candidate has an exact query-term match |
| `rerank` | `boolean` | Toggle cross-encoder reranking on/off using stored `rerankScore` values |
| `limit` | `number` | Change top-K cutoff |

---

## 4. Interpreting a Replay Diff

```text
Replay trace:  tr_9f4b2c1a-7d3e-4b0a-9f88-123456789abc
Query:         "deployment runbook"
Config hash:   8c2e1f904ab7d312 -> 31f09a4e7bc82019
Config overrides:
  - fusionMode: "convex" -> "rrf"
  - mmr.enabled: false -> true
  - mmr.lambda: 0.5 -> 0.35

Summary: +1 added, -1 removed, ~1 reordered, =1 unchanged

Added:
  + #3 cand_tail  score=0.0159 (orig=0.0510, delta=-0.0351)

Removed:
  - was #2 cand_kw_strong  orig=0.8519 -> 0.0162 (delta=-0.8357) [out_of_top_k]

Reordered:
  ~ #3 -> #2 (+1) cand_sem_strong  score=0.1538 -> 0.0098 (delta=-0.1440)

Unchanged rank:
  = #1 cand_kw_dup  score=0.8519 -> 0.0162 (delta=-0.8357)
```

- **`+ Added`**: Candidates from the recorded wider candidate pool (`candidateLimit`) that were previously below `limit` and rose into the top-K under the new config.
- **`- Removed`**: Candidates that left the top-K, tagged with `[out_of_top_k]`, `[gate_trimmed]`, or `[gate_abstained]`.
- **`~ Reordered`**: Candidates present in both rankings whose 1-based position moved (`+N` means promoted toward `#1`; `-N` means demoted).
- **`score` & `delta`**: Note that `convex` scores (`~0..1`) and `rrf` scores (`~w / (K + rank)`) live on different numeric scales, so switching `fusionMode` changes absolute scores (`delta`) even when an item stays at `#1`. Compare rank movements (`#old -> #new`) across fusion modes, and score deltas within the same fusion mode.
