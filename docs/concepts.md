# Memory model

MemOS is not a chat log with a search box. It is a small graph of durable
memories with provenance, time bounds, and an explicit deletion path. This page
explains the objects you will see in the API and the CLI.

## Nodes

A **memory node** is one unit of knowledge:

| Field | Meaning |
| --- | --- |
| `content` | The text the agent stored |
| `summary` | Extractive summary, generated if omitted |
| `type` | `fact`, `preference`, `context`, `relationship`, `entity`, or `custom` |
| `tags` | Free-form labels used by filters and reviews |
| `namespace` | Isolation boundary (`default` unless set) |
| `importance` | Base score in `[0, 1]` |
| `trustScore` | Channel trust in `[0, 1]` |
| `provenance` | `user-verified`, `user`, `tool-output`, `chat`, or `imported` |
| `source` | `user_input`, `agent_inferred`, `tool_output`, `external_data`, or `system` |
| `validFrom` / `validTo` | Event-time validity window |
| `quarantined` | Write-gate flag; excluded from recall until released |

The `summary` and `content` are separate on purpose: lists and profiles can
show the short form while a context pack still carries the full sentence.

## Edges

Edges are typed and directional:

- `relates_to` - general association
- `supports` - target supports source
- `contradicts` - target contradicts source
- `derived_from` - target was derived from source
- `part_of` - target is a component of source
- `temporal_precedes` - ordering; supersede history uses this edge
- `custom`

`link()` creates an edge manually. Auto-linking runs on write when the
similarity threshold is met.

## Trust and provenance

Every write carries a provenance tier. The tier sets the initial trust score
and decides how much the retrieval ranker trusts the row:

| Tier | Typical source | Default trust |
| --- | --- | --- |
| `user-verified` | Explicit confirmation | 1.0 |
| `user` | `user_input` | 1.0 |
| `tool-output` | A tool result | 0.5 |
| `chat` | Model inference | 0.7 |
| `imported` | External bulk data | 0.5 |

Trust is not a boolean. `setTrust()` adjusts it, feedback can move it within a
bounded range, and low-trust rows are marked `untrustedSource` in context
packs so the host can ask before acting.

## Time

Two clocks matter:

1. **Event time** - `validFrom` / `validTo`. When the fact was true.
2. **Transaction time** - `createdAt` / `updatedAt`. When MemOS learned it.

Superseding a memory sets `validTo` on the old row instead of deleting it, so
`searchTemporal()` and the explorer's as-of scrubber can reconstruct the past.
The default search excludes historical rows.

## Retrieval

Default recall fuses two legs:

- **Keyword** - SQLite FTS5 with BM25 ranking.
- **Semantic** - cosine similarity over the configured embedding provider.

Reciprocal rank fusion merges the lists; trust, recency, importance, and
outcome feedback adjust the final order. Optional stages include MMR
diversification, a relevance gate that can abstain, and a cross-encoder
reranker.

`explain()` returns the score components for every candidate, including rows
that were filtered out. Use it when a result is surprising.

## Context packs

`contextPack()` turns search results into a prompt-ready block with a token
budget. It can serialize as JSON, TOON, or compact TOON, and can include
citations (`[mem:xxxxxxxx]`), summaries, lessons, and image references.
`resolveCitation()` maps a token back to the memory.

## Procedural lessons

Lessons are behavioral instructions, not facts: "check the rate limit before a
bulk import." They have their own store, a success/failure score with a 30-day
half-life, and can be recalled by `trigger()` before a task. `promote` turns
repeated successful recall patterns into lesson candidates.

## Review queue

Writes made with `review: true` are stored but quarantined with reason
`review:pending`. They do not appear in search or context packs until
`reviewApprove()` or `reviewReject()`. `MemOSConfig.review.autoApproveTags`
skips the queue for trusted tags.

## Knowledge pages

A page is a saved query plus pinned memory IDs. Reading it runs retrieval again
and renders Markdown with citations; the rendered text is never stored. That
keeps a page from drifting away from the underlying memories.

## Deletion

- `forget(id)` deletes one node.
- `forgetSource(source)` deletes every node from a file, URL, import id,
  harness, or source value.
- Both write a hash-chained tombstone.
- `proveForget(id)` returns a deletion certificate; `verifyForget()` checks it
  against the tamper log.
- `deletionStatus(id)` reports `present`, `deleted`, or `unknown`.

## Namespaces and scopes

A namespace is a string boundary. `scope` composes a namespace from
`user` / `agent` / `run` components in a fixed order. Scoped reads can include
the shared `default` namespace; writes always go to the composed namespace.

## What MemOS is not

- Not a vector database. Embeddings are one leg, not the storage model.
- Not a hosted service. The HTTP server is optional and local by default.
- Not an LLM. Extraction, summarization, and folding are local heuristics
  unless you configure a model hook.
