# API Reference

Complete reference for the MemOS TypeScript SDK and Python HTTP API.

## HTTP API authentication

The Python server binds `127.0.0.1` by default. When `MEMOS_API_KEY` is set, every `/api/mem/*` route requires a bearer token; `/health`, `/docs` and `/openapi.json` stay public.

```bash
export MEMOS_API_KEY=change-me
curl -H "Authorization: Bearer $MEMOS_API_KEY" http://localhost:7400/api/mem/count
```

Requests without the header return `401 {"detail":"Unauthorized"}`.

## TypeScript SDK

### `new MemOS(config?)`

Create a new MemOS instance.

```typescript
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS({
  dbPath: "./my-app.db",        // SQLite path (default: ~/.memos/memos.db)
  wal: true,                     // WAL mode (default: true)
  maxMemories: 10000,            // LRU eviction limit (default: 0 = unlimited)
  autoLinkThreshold: 0.3,        // Auto-link similarity (default: 0.3)
});
```

### `memos.init(): Promise<void>`

Initialise the storage backend and hydrate the in-memory graph. Must be called before any other method.

```typescript
await memos.init();
```

### `memos.store(content, opts?): Promise<{ node, links }>`

Store a new memory. Automatically generates a summary and auto-links to related nodes.

```typescript
const { node, links } = await memos.store("User prefers dark mode", {
  type: "preference",          // MemoryType
  metadata: { source: "chat" },// Arbitrary metadata
  summary: "Custom summary",   // Optional (auto-generated if omitted)
  importance: 0.8,             // 0-1 (default: 0.5)
});
```

**Returns:**

```typescript
{
  node: MemoryNode;
  links: MemoryEdge[];  // Auto-created edges
}
```

### `memos.retrieve(id): Promise<MemoryNode | null>`

Retrieve a memory by ID. Increments access count.

```typescript
const node = await memos.retrieve("abc-123");
// → { id: "abc-123", content: "...", type: "preference", ... }
// → null if not found
```

### `memos.search(queryOrFilter): Promise<ScoredMemory[]>`

Search memories by text query and/or structured filters.

```typescript
// Text search
const results = await memos.search("dark mode");

// Structured filter
const results = await memos.search({
  query: "dark mode",
  type: "preference",
  minImportance: 0.5,
  maxImportance: 1.0,
  metadata: { source: "chat" },
  limit: 10,
  offset: 0,
  sortBy: "importance",       // "importance" | "createdAt" | "updatedAt" | "accessCount" | "relevance"
  sortOrder: "desc",
});
```

**Returns:**

```typescript
ScoredMemory[]  // Array of { node: MemoryNode, score: number }
```

**Precision knobs (per query):**

```typescript
// MMR diversification: reorder the head so near-duplicate memories stop
// crowding out distinct evidence. `true` = configured/default λ (0.5);
// a number sets λ (0 = maximum novelty, 1 = pure relevance).
const results = await memos.search({ query: "deploy", limit: 10, mmr: 0.6 });
```

Instance-level equivalents live under `retrieval` in the config
(`relevanceGate: { enabled, ratio, abstainSimilarity, minResults }`,
`mmr: { enabled, lambda }`) — both off by default because they change
how many memories a search returns.

### `memos.remember(content, opts?): Promise<{ node, links }>`

Friendly alias for `store()` — identical semantics, reads like English.

```typescript
await memos.remember("User prefers dark mode", { type: "preference" });
```

### `memos.profile(opts?): Promise<MemoryProfile>`

One-call user profile: the stable "who am I talking to" block (`static`)
plus recent activity (`dynamic`), ready to inject into a system prompt.
Cached (default 30s, cleared by any write).

```typescript
const { static: who, dynamic: recent } = await memos.profile({
  maxStatic: 25,      // durable items (preferences, entities, facts)
  maxDynamic: 10,     // recent-activity items
  recentDays: 7,      // recency window for the dynamic half
  query: "deploy",    // optional: bias the static half toward a topic
  scope: { user: "alice" },
});
// → { static: [{ content: "User prefers dark mode", ... }],
//     dynamic: [{ content: "Asked about the deploy", ... }],
//     generatedAt, cached, totalStatic, totalDynamic }
```

CLI: `memos profile [--query <text>] [--max-static n] [--recent-days n] [--scope user:alice] [--json]`.
MCP tool: `memos_profile`. Defaults come from `MemOSConfig.profile`.

### `memos.explain(queryOrOptions): Promise<ExplainResult>`

Explain a ranking before the relevance gate. Returns per-leg score signals,
lifecycle status, supersede chain, outcome utility, and the gate verdict. Pass
`memoryId` to diagnose one memory that was not retrieved.

```typescript
const report = await memos.explain({
  query: "where does the user live",
  memoryId: oldAddressId,
  limit: 10,
  namespace: "project:alpha",
  pool: "event",
});
// → { query, generatedAt, gate, candidateCount, candidates, focus?, notes }
```

CLI: `memos explain "<query>" [--id <memoryId>] [--limit n] [--json]`.
MCP tool: `memos_explain`.

### `memos.recordRecallFeedback(input): Promise<RecallFeedbackResult>`

Record which recalled memories the agent actually used and whether the task
succeeded. Successful uses promote those memories in future ranking; failed
uses demote them. The ranking swing is bounded and off until feedback exists.

```typescript
await memos.recordRecallFeedback({
  query: "how do I deploy?",
  used: [id1, id2],
  outcome: "success",   // success | partial | failure
  weight: 1,            // optional
  note: "blue/green worked",
});
```

CLI: `memos feedback --query "<q>" --used <ids> --outcome success`.
MCP tool: `memos_feedback`.

### `memos.recallUtility(id): MemoryUtility`

Synchronous utility view for one memory: weighted success/partial/failure
counts, Beta-smoothed `utility`, observational `uplift`, and batch counts.

```typescript
const utility = memos.recallUtility(id);
// → { utility: 0.67, uplift: 0.42, observations: 1, usedBatches: 1, ... }
```

### `memos.clearRecallFeedback(): Promise<void>`

Remove every recorded recall outcome and invalidate the search cache.

### `memos.health(): Promise<MemoryHealth>`

Hygiene and usefulness report: contradiction pressure, TTL backlog,
low-confidence share, quarantine count, feedback coverage, and a heuristic
score/grade with actionable findings.

```typescript
const report = await memos.health();
// → { score, grade, metrics, findings, generatedAt }
```

CLI: `memos health [--json]`. MCP tool: `memos_health`.

### `memos.forget(id): Promise<boolean>`

Permanently delete a memory and all its connected edges.

```typescript
const deleted = await memos.forget("abc-123");
// → true if deleted, false if not found
```

### `memos.summarize(): Promise<string>`

Generate an extractive summary of all stored memories.

```typescript
const summary = await memos.summarize();
// → "User prefers dark mode. Project uses TypeScript."
```

### `memos.link(sourceId, targetId, relation?, weight?): Promise<MemoryEdge>`

Manually create a link between two memories.

```typescript
const edge = await memos.link(
  "node-a-id",
  "node-b-id",
  "supports",    // "relates_to" | "contradicts" | "supports" | "derived_from" | "part_of"
  0.8            // Weight 0-1
);
```

### `memos.update(id, input): Promise<MemoryNode | null>`

Partially update an existing memory.

```typescript
const updated = await memos.update("abc-123", {
  content: "Updated content",
  importance: 0.9,
});
```

### `memos.getGraph(): Promise<GraphSnapshot>`

Return all nodes and edges.

```typescript
const { nodes, edges } = await memos.getGraph();
```

### `memos.getNeighbours(nodeId): Promise<MemoryNode[]>`

Get nodes directly connected to the given node.

### `memos.getEdges(nodeId): Promise<MemoryEdge[]>`

Get all edges connected to the given node.

### `memos.clusters(minSize?): Promise<string[][]>`

Find clusters of related memories (BFS-based).

### `memos.count: number`

Total number of stored memories.

### `memos.clear(): Promise<void>`

Delete all memories and edges.

### `memos.close(): Promise<void>`

Shut down and release resources.

### Events

```typescript
memos.on("node:created", (node) => { /* ... */ });
memos.on("node:updated", (node) => { /* ... */ });
memos.on("node:deleted", (id) => { /* ... */ });
memos.on("edge:created", (edge) => { /* ... */ });
memos.on("link:auto", ({ node, edges }) => { /* ... */ });
memos.on("eviction", (node) => { /* ... */ });
memos.on("recall:feedback", ({ id, query, outcome, memoryIds, unknown }) => { /* ... */ });

memos.off("node:created", listener);
```

## Python HTTP API

All endpoints are under `/api/mem`.

### `POST /api/mem/store`

Store a new memory.

```json
{
  "content": "User prefers dark mode",
  "type": "preference",
  "metadata": {},
  "summary": "optional",
  "importance": 0.5
}
```

### `POST /api/mem/retrieve`

Retrieve a memory by ID.

```json
{ "id": "abc-123" }
```

### `POST /api/mem/search`

Search memories.

```json
{
  "query": "dark mode",
  "type": "preference",
  "min_importance": 0.5,
  "limit": 10,
  "offset": 0,
  "sort_by": "updated_at",
  "sort_order": "desc"
}
```

### `POST /api/mem/forget`

Delete a memory.

```json
{ "id": "abc-123" }
```

### `POST /api/mem/summarize`

Get a summary of all memories. No body required.

### `POST /api/mem/link`

Create a link between two memories.

```json
{
  "source_id": "node-a",
  "target_id": "node-b",
  "relation": "supports",
  "weight": 0.8
}
```

### `GET /api/mem/graph`

Return all nodes and edges.

### `POST /api/mem/neighbours`

Get neighbours of a node.

```json
{ "nodeId": "abc-123" }
```

### `GET /api/mem/count`

Return total memory count.

### `POST /api/mem/profile`

One-call user profile: durable facts plus recent activity.

```json
{ "query": "onboarding", "max_static": 20, "max_dynamic": 10 }
```

### `POST /api/mem/context-pack`

Token-budgeted, citable context slice. `format` is `json`, `toon`, or
`toon-compact`.

```json
{ "query": "deploy checklist", "token_budget": 1200, "format": "toon-compact" }
```

### `POST /api/mem/handoff`

Cross-harness handoff brief. `format` is `markdown` (default) or `json`.

```json
{ "task": "finish the auth refactor", "to_harness": "codex", "token_budget": 1200 }
```

### `POST /api/mem/audit`

Audit artifact: tamper chain, provenance, quarantine, deletions, health.

```json
{ "expect_tip": "optional-external-tip-hash", "limit": 100 }
```

### `POST /api/mem/eval`

Self-recall or labelled retrieval evaluation.

```json
{ "k": 5, "limit": 20, "cases": [{ "query": "deploy window", "relevantIds": ["..."] }] }
```

### `POST /api/mem/promote`

Review/apply repeated successful recall patterns as procedure lessons.

```json
{ "apply": false, "min_successes": 2, "max_failure_ratio": 0.2 }
```

### `GET /api/mem/embedding-health`

Probe the active embedding provider and report `ok` / `degraded` / `disabled`.

### `GET /api/mem/diagnostics`

Counts, embedding coverage, queue state, and vector-index status.

### `GET /api/mem/health-report`

Hygiene and usefulness report with findings.

### `GET /api/mem/usage`

Context-pack token and format telemetry for this server process.

### `POST /api/mem/ingest`

Ingest a server-local file or folder (Markdown, text, HTML, PDF). Incremental:
unchanged files are skipped, edited files replace their chunks, deleted files
remove theirs. Paths must stay inside the server working directory unless
`MEMOS_INGEST_ROOT` widens it.

```json
{ "path": "./notes", "namespace": "documents", "chunk_chars": 1200 }
```

```json
{"added": 12, "updated": 0, "unchanged": 0, "removed": 0, "skipped": 1, "errors": 0, "chunks": 34}
```

### `POST /api/mem/image/add`

Store an image from a server-local path or base64 bytes. Requires
`MEMOS_VISION=1`; `MEMOS_VISION_CLIP=1` also enables pixel search.

```json
{ "path": "./diagram.png", "caption": "gateway to postgres", "kind": "diagram" }
```

### `POST /api/mem/image/search`

Search image memories by caption (and pixels when CLIP is enabled).

```json
{ "query": "the retry-loop diagram", "limit": 10 }
```

### `GET /api/mem/image/{ref}`

Return the original image bytes for an `img_...` ref or node id.

### `GET /health`

Health check.

## Governance, handoff, and evaluation

### `MemOS.handoff(opts)`

Builds a cross-harness handoff brief. `opts.task` is required; optional fields
are `namespace`, `scope`, `tokenBudget` (default 1200), `maxStatic`,
`maxDynamic`, `lessons` (default 5), `includeReminders`, `fromHarness`,
`toHarness`, and `format` (`"markdown"` default, or `"json"`). The brief
contains the durable profile, a citable context slice, procedural lessons,
reminders, memory health, and harness attribution. Read-only.

### `MemOS.auditReport(opts)`

Returns the `memos.audit.v1` artifact: tamper-chain verification, provenance
and source inventory, quarantine register, deletion certificates, semantic
search health, and recommendations. `opts.expectTip` verifies an externally
recorded chain tip; `opts.limit` caps the quarantine/deletion rows.

### `MemOS.promoteProcedures(opts)`

Reviews repeated successful recall patterns from `recordRecallFeedback()` as
procedure candidates. Dry-run by default; `apply: true` writes the lessons and
skips duplicates. Options: `minSuccesses` (default 2), `maxFailureRatio`
(default 0.2), `limit` (default 20), `namespace`, `scope`.

### `MemOS.probeEmbeddingHealth()`

Exercises the active embedding provider once and returns `EmbeddingHealth`.
Useful before reporting whether semantic search is actually working; FastEmbed
only knows whether its optional ONNX model loaded after the first embed, and
Model2Vec only loads its static table on first use.

### `usageStats()`

Returns `packsBuilt`, `packItems`, `packTokens`, `naiveBaselineTokens`,
`savedTokens`, `savedPct`, and `byFormat`. Counters are process-local.

## Types

### MemoryNode

```typescript
interface MemoryNode {
  id: string;            // UUID v4
  content: string;       // Raw text
  summary: string;       // Extractive summary
  type: MemoryType;      // "fact" | "preference" | "context" | "relationship" | "entity" | "custom"
  metadata: Record<string, unknown>;
  importance: number;    // 0-1
  createdAt: number;     // Unix ms
  updatedAt: number;     // Unix ms
  accessCount: number;
  lastAccessed: number;  // Unix ms
}
```

### MemoryEdge

```typescript
interface MemoryEdge {
  id: string;            // UUID v4
  sourceId: string;
  targetId: string;
  relation: EdgeRelation; // "relates_to" | "contradicts" | "supports" | "derived_from" | "part_of" | "custom"
  weight: number;        // 0-1
  metadata: Record<string, unknown>;
  createdAt: number;     // Unix ms
}
```

### StorageAdapter

```typescript
interface StorageAdapter {
  init(): Promise<void>;
  saveNode(node: MemoryNode): Promise<MemoryNode>;
  getNode(id: string): Promise<MemoryNode | null>;
  updateNode(id: string, input: UpdateMemoryInput): Promise<MemoryNode | null>;
  deleteNode(id: string): Promise<boolean>;
  saveEdge(edge: MemoryEdge): Promise<MemoryEdge>;
  getEdge(id: string): Promise<MemoryEdge | null>;
  deleteEdge(id: string): Promise<boolean>;
  queryNodes(filter: SearchFilter): Promise<ScoredMemory[]>;
  queryEdges(filter?: EdgeFilter): Promise<MemoryEdge[]>;
  getGraph(): Promise<GraphSnapshot>;
  close(): Promise<void>;
}
```
