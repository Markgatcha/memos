# Upgrading to MemOS v1.6.26

This guide covers everything you need to migrate an existing MemOS database and
integration to **v1.6.26**. The upgrade is designed to be automatic for existing
SQLite databases — open your old database with the new SDK and the schema is
migrated in place.

## Automatic database migration

v1.6.26 adds four columns to the `nodes` table to support temporal validity,
provenance, and trust scoring:

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `valid_from` | INTEGER | NULL | Temporal validity start (Unix ms) |
| `valid_to` | INTEGER | NULL | Temporal validity end (Unix ms) |
| `source` | TEXT | `'user_input'` | Provenance source |
| `trust_score` | REAL | `1.0` | Trust score in [0, 1] |

On `init()`, MemOS runs `ALTER TABLE ... ADD COLUMN` for any of these that are
missing. This is non-destructive — existing data is preserved, and the new
columns are populated with their defaults:

- **`source`** defaults to `'user_input'` for all pre-existing memories.
- **`trust_score`** defaults to `1.0` for all pre-existing memories.
- **`valid_from`** and **`valid_to`** default to `NULL` (always valid).

No manual SQL, no export/import step, no downtime. Just update the package and
restart.

```bash
npm install @mem-os/sdk@1.6.26
```

## Search behaviour: historical memories are now excluded

The single most important behavioural change: **default search now excludes
historical (superseded) memories.** A memory is "historical" when its `validTo`
timestamp is in the past.

Before v1.6.26, every stored memory was returned by `search()`. Now, memories
whose `validTo < now` are filtered out by default so stale/superseded facts no
longer pollute results.

If you relied on seeing every memory (including superseded ones), opt back in
per-query:

```ts
const all = await memos.search({
  query: "where the user lives",
  includeHistorical: true,
});
```

Temporal "as-of" queries use the dedicated `searchTemporal()` method or the
`validAt` filter:

```ts
// "What did we know at time T?"
const history = await memos.searchTemporal("where the user lives", someTimestamp);

// …equivalently, via the validAt filter:
const history2 = await memos.search({
  query: "where the user lives",
  validAt: someTimestamp,
});
```

## New MemoryNode fields

Every `MemoryNode` now carries:

| Field | Type | Description |
|-------|------|-------------|
| `validFrom` | `number \| null` | Temporal validity start (Unix ms). `null` = always valid. |
| `validTo` | `number \| null` | Temporal validity end (Unix ms). `null` = no expiry. A past value marks the memory as historical. |
| `source` | `MemorySource` | Provenance: `user_input`, `agent_inferred`, `external_data`, `system`. |
| `trustScore` | `number` | Trust score in [0, 1]. Influences retrieval ranking. |

Pre-existing memories get `source = 'user_input'` and `trustScore = 1.0`.

You can set these at creation time:

```ts
await memos.store("Inferred the user likes Go", {
  source: "agent_inferred", // → default trustScore 0.7
  trustScore: 0.8,          // override the source default
  validFrom: Date.now(),
});
```

…and update them later:

```ts
await memos.setValidity(nodeId, validFrom, validTo);
await memos.setTrust(nodeId, 0.95);
```

## New SearchFilter fields

`SearchFilter` gains five fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `source` | `MemorySource` | — | Filter by provenance source. |
| `minTrustScore` | `number` | — | Only return memories with `trustScore >=` this value. |
| `includeHistorical` | `boolean` | `false` | Include superseded (`validTo` in the past) memories. |
| `validAt` | `number` | — | Only return memories valid at this time (Unix ms). |
| `sortBy` | `'trustScore'` (new option) | — | Sort by trust score. Added to the existing sort options. |

`sortBy` now also accepts `'trustScore'` alongside `'importance'`, `'createdAt'`,
`'updatedAt'`, `'accessCount'`, and `'relevance'`.

Example — trust-weighted search:

```ts
const trusted = await memos.search({
  query: "deploy schedule",
  sortBy: "trustScore",
  sortOrder: "desc",
  minTrustScore: 0.8,
  source: "user_input",
});
```

## New SDK methods

v1.6.26 introduces these methods (see the [API reference](docs/api-reference.md)
for full signatures):

**Temporal validity**

- `setValidity(id, validFrom, validTo)` — set/clear a memory's validity window.
- `searchTemporal(query, atTime, opts?)` — search memories valid at a point in time.
- `supersede(id, replacementId?)` — mark a memory historical and link its replacement.

**Trust & provenance**

- `trust(id)` — read a memory's trust score.
- `setTrust(id, score)` — set the trust score (clamped to [0, 1]).
- `adjustTrust(id, delta)` — nudge the trust score by a delta.

**Fact extraction**

- `extractFacts(messages, opts?)` — local, rule-based fact extraction with optional auto-store.

**Diagnostics**

- `diagnostics()` — full health snapshot (counts by source/type/namespace, trust stats, embedding coverage, DB size).

**Memory consolidation ("dreaming")**

- `dedupe(opts?)` — merge near-duplicate memories.
- `archive(opts?)` — move stale, low-importance memories to the `archived` namespace.
- `summarizeCluster(opts?)` — generate summary nodes for clusters of similar memories.
- `consolidate(opts?)` — run dedupe + archive + summarize in one pass.

**Retrieval & embeddings**

- `semanticSearch(query, limit?, threshold?, filter?)` — embedding-only retrieval.
- `contextPack(opts)` — token-budgeted, ranked context pack (AI Trio contract).
- `flushEmbeddings()` — wait for all pending embedding jobs to finish.
- `embeddingStatus(nodeId?)` — per-node / aggregate embedding queue status.

## New events

The following events are now emitted (in addition to the existing ones):

- `validity:changed` — a memory's validity window changed.
- `trust:changed` — a memory's trust score changed.
- `facts:extracted` — facts were extracted from a conversation.
- `consolidation:complete` — a consolidation pass finished.
- `embedding:queued` / `embedding:started` / `embedding:complete` / `embedding:failed` / `embedding:retry` — embedding queue lifecycle.

## Adapter subpath exports

The OpenAI and Anthropic TypeScript adapters are now built-in and published as
subpath exports. Update any imports:

```ts
// Before (adapters lived at the repo root)
import { createOpenAIMemory } from "./adapters/openai.js";

// After (built-in subpath exports)
import { createOpenAIMemory } from "@mem-os/sdk/openai";
import { createAnthropicMemory } from "@mem-os/sdk/anthropic";
```

## Need help?

If the automatic migration doesn't cover your case, or you hit any issues,
please [open an issue](https://github.com/Markgatcha/memos/issues).
