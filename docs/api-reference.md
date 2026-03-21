# API Reference

Complete reference for the MemOS TypeScript SDK and Python HTTP API.

## TypeScript SDK

### `new MemOS(config?)`

Create a new MemOS instance.

```typescript
import { MemOS } from "@memos/sdk";

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

### `GET /health`

Health check.

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
