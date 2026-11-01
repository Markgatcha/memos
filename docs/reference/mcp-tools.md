# MCP tools

Generated from `src/mcp.ts` by `npm run docs:reference`. The default
profile exposes the core set; `MEMOS_MCP_TOOLS=all` exposes every tool
listed here.

| Tool | Core | What it does | Hints |
| --- | --- | --- | --- |
| `memos_store` | yes | Store a durable local memory in MemOS. | — |
| `memos_ingest` | yes | Ingest a file or folder (Markdown, text, HTML, PDF) into memory. Incremental and idempotent. | idempotent |
| `memos_search` | yes | Search local memories by full-text query. Pass compact: true for token-lean output. | readOnly, idempotent |
| `memos_profile` | yes | One-call user profile: durable facts (static) plus recent activity (dynamic) — inject at session start so the agent knows who it is talking to before the first turn. | readOnly, idempotent |
| `memos_retrieve` | yes | Retrieve one memory by ID. | readOnly, idempotent |
| `memos_forget` | yes | Delete one memory by ID. | destructive, idempotent |
| `memos_forget_source` | — | Delete every memory from one source, with proof-of-forgetting certificates. | destructive, idempotent |
| `memos_deletion_status` | — | Check whether a memory is present, deleted (certificate), or unknown. | readOnly, idempotent |
| `memos_review` | — | List, approve, or reject inferred memories waiting for review. | destructive |
| `memos_link` | — | Create a typed edge between two memories. | — |
| `memos_quarantine_release` | — | Release a quarantined memory back into recall. | — |
| `memos_graph` | — | Return the current memory graph. | readOnly, idempotent |
| `memos_context` | — | Build graph-neighbour context around a memory. | readOnly, idempotent |
| `memos_context_pack` | yes | Build a token-budgeted, relevance-ranked slice of memories for injection into a prompt. This is the tool to use when you want everything the agent should remember about a topic in one call. | readOnly, idempotent |
| `memos_search_temporal` | — | Search memories that were valid at a specific point in time (unix ms). Superseded/historical memories stay queryable here. | readOnly, idempotent |
| `memos_set_validity` | — | Mark a memory's temporal validity window (unix ms). A validTo in the past makes the memory historical: excluded from default search, still queryable via memos_search_temporal. | idempotent |
| `memos_supersede` | — | Mark a memory as superseded (historical) and optionally link its replacement with a temporal_precedes edge. | — |
| `memos_set_trust` | — | Set the trust score [0,1] of a memory. High-trust memories rank higher in hybrid search. | — |
| `memos_extract_facts` | — | Rule-based local extraction of preferences, entities and facts from conversation messages, optionally storing them as memories. | — |
| `memos_diagnostics` | — | Health report: counts, embedding coverage, temporal stats, storage capabilities and database size. | readOnly, idempotent |
| `memos_reindex` | — | Re-embed every memory with the currently configured embedding model. Required after switching models. Can be slow on large stores; purgeStale also deletes vectors from other models. | idempotent |
| `memos_consolidate` | — | Offline maintenance pass ('dreaming'): merge near-duplicates, archive stale low-importance memories, supersede decayed ones (marked historical — never deleted), and distill cluster summary notes into the note pool. Run periodically or while idle. | destructive |
| `memos_usage` | — | Lifetime context-pack token telemetry for this server process: packs built, tokens injected, naive raw-JSON baseline, savings %. | readOnly, idempotent |
| `memos_history` | — | Audit timeline for one memory: supersedes, superseded by, derived notes. | readOnly, idempotent |
| `memos_revert` | — | Revert a memory to the version it superseded (command-driven belief revision). Closes the target's validity interval and reactivates the predecessor; the reverted-away version stays in history (add-only) and the revert is recorded as an audit event. Confirm scope first: call with dryRun=true (default) and show the would-be target, then call again with dryRun=false to execute. | destructive |
| `memos_reminders` | — | List scheduled event reminders (deterministic temporal event memory). Pass due=true for reminders due as of now; otherwise all scheduled reminders, earliest first. Poll on the harness's own schedule — MemOS surfaces due reminders but does not push-notify. | readOnly, idempotent |
| `memos_image_add` | — | Store an image as a durable memory. The image is written to a content-addressed blob next to the database and a caption becomes the memory's text. Requires vision: { enabled: true }. | idempotent |
| `memos_image_recall` | — | Resolve an [img:...] ref (or a node id) back to its bytes, as base64 plus MIME type. | readOnly, idempotent |
| `memos_image_search` | — | Search stored images by text query. Caption leg always; CLIP pixel leg only when vision.clip.enabled. | readOnly, idempotent |
| `memos_explain` | yes | Explain why memories were (or were not) recalled for a query: per-leg scores, lifecycle status, supersede chain, outcome utility, and the relevance-gate verdict. | readOnly, idempotent |
| `memos_feedback` | yes | Record which recalled memories the agent actually used and whether the task succeeded, so future ranking can learn from outcomes. | — |
| `memos_health` | yes | Hygiene and usefulness report with actionable findings and a heuristic grade. | readOnly, idempotent |
| `memos_overview` | yes | What this store knows: namespaces, types, top tags, provenance, freshness, trust, and graph size. Read-only session-start index. | readOnly, idempotent |
| `memos_handoff` | yes | Compact, citable handoff brief for another harness or session. | readOnly, idempotent |
| `memos_audit` | — | Tamper chain, provenance, quarantine, deletion certificates, health. | readOnly, idempotent |
| `memos_eval` | — | Retrieval eval: self-recall or a labelled query corpus, with Hit@K and token cost. | readOnly, idempotent |
| `memos_promote` | — | Review repeated successful recalls as procedures; apply=true writes lessons. | idempotent |
| `memos_trigger` | — | Before acting, recall relevant procedural lessons for a task and its entities. | readOnly, idempotent |
| `memos_brief` | — | Open/closed brief for a person, project, or topic; recomputed on read. | readOnly, idempotent |
| `memos_page` | — | Save or read a living knowledge page (query + pinned memories, re-rendered). | destructive |

### `memos_store`

Store a durable local memory in MemOS.

- `content` (required): string
- `type`: string
- `tags`: array
- `ttl`: number
- `namespace`: string
- `pool`: string
- `context`: string
- `metadata`: object
- `scope`: object
- `provenance`: string
- `filter_retain`: boolean

### `memos_ingest`

Ingest a file or folder (Markdown, text, HTML, PDF) into memory. Incremental and idempotent.

- `path` (required): string
- `namespace`: string
- `chunk_chars`: number
- `extensions`: array

### `memos_search`

Search local memories by full-text query. Pass compact: true for token-lean output.

- `query` (required): string
- `limit`: number
- `tags`: array
- `namespace`: string

### `memos_profile`

One-call user profile: durable facts (static) plus recent activity (dynamic) — inject at session start so the agent knows who it is talking to before the first turn.

- `query`: string
- `max_static`: number
- `max_dynamic`: number
- `recent_days`: number
- `namespace`: string

### `memos_retrieve`

Retrieve one memory by ID.

- `id` (required): string

### `memos_forget`

Delete one memory by ID.

- `id` (required): string

### `memos_forget_source`

Delete every memory from one source, with proof-of-forgetting certificates.

- `source` (required): string
- `field`: string
- `prefix`: boolean
- `namespace`: string
- `dryRun`: boolean

### `memos_deletion_status`

Check whether a memory is present, deleted (certificate), or unknown.

- `id` (required): string

### `memos_review`

List, approve, or reject inferred memories waiting for review.

- `action` (required): string
- `id`: string
- `namespace`: string

### `memos_link`

Create a typed edge between two memories.

- `sourceId` (required): string
- `targetId` (required): string
- `relation`: string
- `weight`: number

### `memos_quarantine_release`

Release a quarantined memory back into recall.

- `id` (required): string

### `memos_graph`

Return the current memory graph.

No parameters.

### `memos_context`

Build graph-neighbour context around a memory.

- `id` (required): string
- `depth`: number
- `maxChars`: number

### `memos_context_pack`

Build a token-budgeted, relevance-ranked slice of memories for injection into a prompt. This is the tool to use when you want everything the agent should remember about a topic in one call.

- `query` (required): string
- `tokenBudget`: number
- `namespace`: string
- `format`: string
- `includeSummary`: boolean
- `semanticDedup`: boolean

### `memos_search_temporal`

Search memories that were valid at a specific point in time (unix ms). Superseded/historical memories stay queryable here.

- `query` (required): string
- `atTime` (required): number
- `limit`: number
- `namespace`: string

### `memos_set_validity`

Mark a memory's temporal validity window (unix ms). A validTo in the past makes the memory historical: excluded from default search, still queryable via memos_search_temporal.

- `id` (required): string
- `validFrom`: number,null
- `validTo`: number,null

### `memos_supersede`

Mark a memory as superseded (historical) and optionally link its replacement with a temporal_precedes edge.

- `id` (required): string
- `replacementId`: string

### `memos_set_trust`

Set the trust score [0,1] of a memory. High-trust memories rank higher in hybrid search.

- `id` (required): string
- `score` (required): number

### `memos_extract_facts`

Rule-based local extraction of preferences, entities and facts from conversation messages, optionally storing them as memories.

- `messages` (required): array
- `autoStore`: boolean
- `minConfidence`: number
- `namespace`: string

### `memos_diagnostics`

Health report: counts, embedding coverage, temporal stats, storage capabilities and database size.

No parameters.

### `memos_reindex`

Re-embed every memory with the currently configured embedding model. Required after switching models. Can be slow on large stores; purgeStale also deletes vectors from other models.

- `purgeStale`: boolean

### `memos_consolidate`

Offline maintenance pass ('dreaming'): merge near-duplicates, archive stale low-importance memories, supersede decayed ones (marked historical — never deleted), and distill cluster summary notes into the note pool. Run periodically or while idle.

- `namespace`: string
- `dryRun`: boolean
- `summarize`: boolean
- `decay`: boolean
- `decayHalfLifeDays`: number
- `minRetentionScore`: number
- `olderThanDays`: number

### `memos_usage`

Lifetime context-pack token telemetry for this server process: packs built, tokens injected, naive raw-JSON baseline, savings %.

No parameters.

### `memos_history`

Audit timeline for one memory: supersedes, superseded by, derived notes.

- `id` (required): string
- `threshold`: number
- `limit`: number

### `memos_revert`

Revert a memory to the version it superseded (command-driven belief revision). Closes the target's validity interval and reactivates the predecessor; the reverted-away version stays in history (add-only) and the revert is recorded as an audit event. Confirm scope first: call with dryRun=true (default) and show the would-be target, then call again with dryRun=false to execute.

- `text`: string
- `id`: string
- `last`: boolean
- `about`: string
- `dryRun`: boolean
- `reason`: string
- `actor`: string
- `namespace`: string

### `memos_reminders`

List scheduled event reminders (deterministic temporal event memory). Pass due=true for reminders due as of now; otherwise all scheduled reminders, earliest first. Poll on the harness's own schedule — MemOS surfaces due reminders but does not push-notify.

- `due`: boolean
- `namespace`: string

### `memos_image_add`

Store an image as a durable memory. The image is written to a content-addressed blob next to the database and a caption becomes the memory's text. Requires vision: { enabled: true }.

- `path`: string
- `url`: string
- `data`: string
- `mime`: string
- `caption`: string
- `kind`: string
- `tags`: array
- `namespace`: string
- `conversationId`: string

### `memos_image_recall`

Resolve an [img:...] ref (or a node id) back to its bytes, as base64 plus MIME type.

- `ref` (required): string

### `memos_image_search`

Search stored images by text query. Caption leg always; CLIP pixel leg only when vision.clip.enabled.

- `query` (required): string
- `limit`: number
- `namespace`: string
- `kind`: string

### `memos_explain`

Explain why memories were (or were not) recalled for a query: per-leg scores, lifecycle status, supersede chain, outcome utility, and the relevance-gate verdict.

- `query` (required): string
- `memoryId`: string
- `limit`: number
- `namespace`: string
- `pool`: string

### `memos_feedback`

Record which recalled memories the agent actually used and whether the task succeeded, so future ranking can learn from outcomes.

- `query` (required): string
- `used` (required): array
- `outcome` (required): string
- `weight`: number
- `note`: string

### `memos_health`

Hygiene and usefulness report with actionable findings and a heuristic grade.

No parameters.

### `memos_overview`

What this store knows: namespaces, types, top tags, provenance, freshness, trust, and graph size. Read-only session-start index.

- `namespace`: string

### `memos_handoff`

Compact, citable handoff brief for another harness or session.

- `task` (required): string
- `tokenBudget`: number
- `namespace`: string
- `scope`: value
- `lessons`: number
- `includeReminders`: boolean
- `fromHarness`: string
- `toHarness`: string
- `format`: string

### `memos_audit`

Tamper chain, provenance, quarantine, deletion certificates, health.

- `expectTip`: string
- `limit`: number

### `memos_eval`

Retrieval eval: self-recall or a labelled query corpus, with Hit@K and token cost.

- `k`: number
- `limit`: number
- `fromSessions`: boolean
- `namespace`: string
- `cases`: array

### `memos_promote`

Review repeated successful recalls as procedures; apply=true writes lessons.

- `apply`: boolean
- `minSuccesses`: number
- `maxFailureRatio`: number
- `limit`: number
- `namespace`: string

### `memos_trigger`

Before acting, recall relevant procedural lessons for a task and its entities.

- `task` (required): string
- `entities`: array
- `namespace`: string
- `limit`: number

### `memos_brief`

Open/closed brief for a person, project, or topic; recomputed on read.

- `subject` (required): string
- `namespace`: string
- `limit`: number
- `includeClosed`: boolean

### `memos_page`

Save or read a living knowledge page (query + pinned memories, re-rendered).

- `action` (required): string
- `name`: string
- `title`: string
- `query`: string
- `pinnedIds`: array
- `maxItems`: number
- `namespace`: string
