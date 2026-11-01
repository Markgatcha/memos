# HTTP API reference

Generated from the FastAPI OpenAPI document (MemOS 1.6.27).
The server mounts every route under `/api/mem`.

| Route | What it does |
| --- | --- |
| `DELETE /api/mem/mem/{mem_id}/tags/{tag}` | Remove a tag from a memory |
| `DELETE /api/mem/mem/{mem_id}/ttl` | Clear TTL on a memory |
| `GET /api/mem/count` | Memory count |
| `GET /api/mem/deletion-status/{node_id}` | Whether a memory is present, deleted, or unknown |
| `GET /api/mem/diagnostics` | Storage and retrieval diagnostics |
| `GET /api/mem/embedding-health` | Semantic search health |
| `GET /api/mem/export` | Export memories |
| `GET /api/mem/graph` | Get the full memory graph |
| `GET /api/mem/health-report` | Memory hygiene and usefulness report |
| `GET /api/mem/image/{ref}` | Retrieve image bytes |
| `GET /api/mem/overview` | What the memory store knows |
| `GET /api/mem/tags/{tag}` | List memories by tag |
| `GET /api/mem/usage` | Token-savings telemetry |
| `GET /health` | Health |
| `PATCH /api/mem/mem/{mem_id}/ttl` | Set TTL on a memory |
| `POST /api/mem/audit` | Auditable memory report |
| `POST /api/mem/brief` | Open/closed brief for one subject |
| `POST /api/mem/context-pack` | Token-budgeted context pack |
| `POST /api/mem/eval` | Retrieval evaluation |
| `POST /api/mem/forget-source` | Delete every memory from a source |
| `POST /api/mem/forget` | Forget (delete) a memory |
| `POST /api/mem/handoff` | Cross-harness handoff brief |
| `POST /api/mem/image/add` | Store an image memory |
| `POST /api/mem/image/search` | Search image memories |
| `POST /api/mem/ingest` | Ingest documents into memory |
| `POST /api/mem/link` | Link two memories |
| `POST /api/mem/mem/{mem_id}/tags` | Add tags to a memory |
| `POST /api/mem/neighbours` | Get neighbours of a memory |
| `POST /api/mem/profile` | One-call user profile |
| `POST /api/mem/promote` | Promote successful recall patterns |
| `POST /api/mem/retrieve` | Retrieve a memory by ID |
| `POST /api/mem/search` | Search memories |
| `POST /api/mem/store` | Store a new memory |
| `POST /api/mem/summarize` | Summarize all memories |
| `POST /api/mem/trigger` | Procedures to recall before acting |
| `POST /api/mem/update` | Update an existing memory |

### `POST /api/mem/store`

Store a new memory

Store a new memory node. Automatically generates a summary
and links related memories when auto-linking is enabled.

No parameters.

### `POST /api/mem/retrieve`

Retrieve a memory by ID

Retrieve a single memory node by its unique ID.

No parameters.

### `POST /api/mem/search`

Search memories

Search memories by text query and/or structured filters.

No parameters.

### `POST /api/mem/forget`

Forget (delete) a memory

Permanently remove a memory and all its connected edges.

No parameters.

### `POST /api/mem/forget-source`

Delete every memory from a source

Source-scoped erasure with proof-of-forgetting certificates.

No parameters.

### `GET /api/mem/deletion-status/{node_id}`

Whether a memory is present, deleted, or unknown

Return the deletion state and, when deleted, the certificate.

- `node_id` (required) (query)

### `POST /api/mem/summarize`

Summarize all memories

Generate an extractive summary of all stored memories.

No parameters.

### `POST /api/mem/link`

Link two memories

Manually create a link (edge) between two memory nodes.

No parameters.

### `GET /api/mem/graph`

Get the full memory graph

Return all nodes and edges in the memory graph.

No parameters.

### `POST /api/mem/neighbours`

Get neighbours of a memory

Get all nodes directly connected to the given node.

No parameters.

### `GET /api/mem/count`

Memory count

Return the total number of stored memories.

No parameters.

### `POST /api/mem/update`

Update an existing memory

Partially update an existing memory node.

- `node_id` (required) (query)

### `PATCH /api/mem/mem/{mem_id}/ttl`

Set TTL on a memory

Set a time-to-live on a memory node.

- `mem_id` (required) (query)

### `DELETE /api/mem/mem/{mem_id}/ttl`

Clear TTL on a memory

Clear the TTL on a memory node.

- `mem_id` (required) (query)

### `POST /api/mem/mem/{mem_id}/tags`

Add tags to a memory

Add tags to a memory node.

- `mem_id` (required) (query)

### `DELETE /api/mem/mem/{mem_id}/tags/{tag}`

Remove a tag from a memory

Remove a tag from a memory node.

- `mem_id` (required) (query)
- `tag` (required) (query)

### `GET /api/mem/tags/{tag}`

List memories by tag

List all memories that have a specific tag.

- `tag` (required) (query)

### `GET /api/mem/export`

Export memories

Export memories in the specified format. Returns JSON or a zip file.

- `format` (query)
- `tag` (query)

### `POST /api/mem/profile`

One-call user profile

Static durable facts plus recent activity, ready for a system prompt.

No parameters.

### `GET /api/mem/overview`

What the memory store knows

Counts, namespaces, tags, freshness, and trust — no memory contents.

- `namespace` (query)

### `POST /api/mem/trigger`

Procedures to recall before acting

Rank procedural lessons for an upcoming task and explain each match.

No parameters.

### `POST /api/mem/brief`

Open/closed brief for one subject

Maintained subject brief; closed items are dropped from the prompt.

No parameters.

### `POST /api/mem/context-pack`

Token-budgeted context pack

Retrieve a budgeted, citable slice of memory for prompt injection.

No parameters.

### `POST /api/mem/handoff`

Cross-harness handoff brief

Build a compact continue-here brief for another harness or session.

No parameters.

### `POST /api/mem/audit`

Auditable memory report

Tamper chain, provenance, quarantine, deletions, and search health.

No parameters.

### `POST /api/mem/eval`

Retrieval evaluation

Self-recall or labelled-corpus retrieval evaluation.

No parameters.

### `POST /api/mem/promote`

Promote successful recall patterns

Review or apply repeated successful recall patterns as procedures.

No parameters.

### `GET /api/mem/embedding-health`

Semantic search health

Probe the active embedding provider and report degraded/fallback state.

No parameters.

### `GET /api/mem/diagnostics`

Storage and retrieval diagnostics

Counts, embedding coverage, queue state, and vector-index status.

No parameters.

### `GET /api/mem/health-report`

Memory hygiene and usefulness report

Contradictions, TTL, confidence, quarantine, and recall outcomes.

No parameters.

### `GET /api/mem/usage`

Token-savings telemetry

Context-pack token and format counters for this server process.

No parameters.

### `POST /api/mem/ingest`

Ingest documents into memory

Ingest a file or folder (Markdown, HTML, PDF) incrementally.

No parameters.

### `POST /api/mem/image/add`

Store an image memory

Store an image with a caption; requires MEMOS_VISION=1.

No parameters.

### `POST /api/mem/image/search`

Search image memories

Caption search always works; CLIP pixel search needs MEMOS_VISION_CLIP=1.

No parameters.

### `GET /api/mem/image/{ref}`

Retrieve image bytes

Resolve an `img_...` ref or node id to its original bytes.

- `ref` (required) (query)

### `GET /health`

Health

Health check endpoint.

No parameters.
