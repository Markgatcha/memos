---
name: memos-maintenance
description: Use when MemOS memory needs hygiene — consolidating after a session that stored many facts, superseding outdated or contradictory facts, checking recall quality and embedding coverage with diagnostics, tuning trust or validity windows, reindexing after an embedding change, or forgetting and deleting memories. Assumes the local MemOS MCP server (memos_* tools).
---

# MemOS memory maintenance

Hygiene operations for a MemOS store. For *storing* and *recalling* facts, use
the **`memos-memory`** skill instead.

Rule of thumb: consolidation and supersede are **safe and reversible**
(superseded memories are kept as history, never deleted). `memos_forget` is
the only destructive operation here — confirm before running it.

## Consolidate

Consolidation merges near-duplicates, archives stale entries, supersedes
decayed ones, and distills cluster notes.

- Run it after a session that stored many facts, or when recall starts
  returning overlapping results.
- **Always preview first:** `memos_consolidate` with `dryRun: true`. Apply
  only if the preview looks sane.
- In Claude Code a `SessionEnd` hook does a fast pass automatically
  (`MEMOS_SKIP_SESSION_CONSOLIDATE=1` opts out). **In Hermes and other
  hook-less harnesses nothing runs automatically** — you have to call it.

## Supersede, don't overwrite

When a fact changes:

1. `memos_store` the corrected version.
2. `memos_supersede` the old one, optionally passing the new memory id as
   `replacementId`.

Historical versions stay queryable via `memos_search_temporal`, so superseding
never destroys information. `memos_history` (memory id) returns the full
version timeline: what it superseded, what superseded it, and derived notes.

**Contradictions:** if a new fact conflicts with existing search results,
surface the conflict to the user rather than silently storing both. Storing
both is how a memory store rots.

## Diagnose poor recall

Work through these in order — they are the usual causes:

1. `memos_diagnostics`. Low `nodesWithEmbeddings` coverage means the embedding
   provider is not configured, so search has fallen back to lexical matching.
   Set `MEMOS_EMBEDDING_*` env vars, or run
   `memos reindex-embeddings --purge-stale`.
2. After switching embedding models, run `memos_reindex` - embeddings from a
   different model are not comparable and silently degrade ranking.
   The same applies after turning on contextual embeddings
   (`MEMOS_CONTEXTUAL=1` / `embeddings.contextual`) or changing
   `embeddings.embedText`: old nodes carry vectors from the previous text
   recipe, so run `memos reindex-embeddings --purge-stale` once.
3. If results are noisy rather than missing, narrow the pool
   (`pool: ["note", "procedure"]`) instead of lowering the bar.
4. `memos_graph` on a memory id shows its edges (`derived_from`, `supports`,
   `contradicts`) — useful when recall misses something you know is linked.
5. `memos_explain` with `memoryId` is the direct answer to "why was this not
   recalled?": it reports namespace, pool, lifecycle (historical/expired/
   quarantined), embedding-model mismatch, and lexical-overlap checks.
   Without `memoryId`, it shows the per-leg score evidence and the
   relevance-gate verdict for a query.

## Close the loop (outcome feedback)

Predicted relevance is not usefulness. After you act on recalled memories,
tell MemOS which ones you actually used and whether the task worked:

- Success: `memos_feedback` with `query`, `used: [ids]`, `outcome: "success"`.
- Partial: same with `"partial"`.
- Failure: same with `"failure"` so those memories are demoted in future
  ranking.

Only report memories you actually used; never infer "used" from rank order.
The multiplier is bounded (default +/-20%) and is a no-op until feedback
exists, so this cannot bury a strong relevance match. Do not call it after
every turn; do call it after a task whose outcome is clear.

## Health check

`memos_health` returns a graded report: unresolved contradictions, TTL
backlog, low-confidence share, quarantine count, and useful-recall rate.
Run it when the user asks whether memory is working, or before a maintenance
pass. Treat `findings[].action` as the next step; the score itself is a
heuristic, not a benchmark.

## Trust, validity, and forgetting

- `memos_set_trust` — adjust confidence on a memory. Low-trust memories fall
  below the trust floor and stop being injected.
- `memos_set_validity` — bound a fact with `validFrom` / `validUntil`. Use it
  for things that stop being true ("the staging URL is X", "I have an exam
  tomorrow").
- `memos_forget` — the only destructive call. Confirm the id with the user
  before running it.

## Reporting

`memos_usage` reports lifetime token savings of context packs versus raw
JSON — quote it if the user asks what memory is costing or saving.
