# MemOS Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Application Layer                            │
│                                                                     │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│   │   OpenAI      │  │  Anthropic   │  │  Custom Agents / LLMs   │ │
│   │   Adapter     │  │   Adapter    │  │                         │ │
│   └──────┬───────┘  └──────┬───────┘  └────────────┬────────────┘ │
│          │                 │                        │              │
└──────────┼─────────────────┼────────────────────────┼──────────────┘
           │                 │                        │
           ▼                 ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Transport Layer                               │
│                                                                     │
│   ┌───────────────────────┐ ┌─────────────────┐ ┌────────────────┐ │
│   │ Python HTTP Server    │ │  MCP Server     │ │ TypeScript SDK │ │
│   │ (FastAPI — server/)   │ │  (src/mcp.ts)   │ │ (direct)       │ │
│   │                       │ │                 │ │                │ │
│   │ POST /api/mem/store   │ │ stdio (MCP 2026)│ │ memos.store()  │ │
│   │ POST /api/mem/retrieve│ │ tools: store,   │ │ memos.search() │ │
│   │ POST /api/mem/search  │ │ search, forget, │ │ memos.context- │ │
│   │ POST /api/mem/forget  │ │ contextPack ... │ │ Pack() ...     │ │
│   └───────────┬───────────┘ └────────┬────────┘ └───────┬────────┘ │
│               │                      │                  │          │
└───────────────┼──────────────────────┼──────────────────┼──────────┘
                │                      │                  │
                ▼                      ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Core Engine (TypeScript)                     │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                      MemOS (src/memory.ts)                  │   │
│   │                                                             │   │
│   │  Public API + orchestration. Validates input, delegates to  │   │
│   │  the retrieval pipeline, graph engine, and storage layer.   │   │
│   └──────────────────────────┬──────────────────────────────────┘   │
│                              │                                      │
│     ┌────────────┬───────────┼────────────┬───────────────┐        │
│     ▼            ▼           ▼            ▼               ▼        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌────────┐ │
│  │ Retrieval│ │  Graph   │ │ Context  │ │ Confidence │ │Lifecycle│ │
│  │ Pipeline │ │  Engine  │ │ Pack     │ │ Machine    │ │ Engine  │ │
│  │          │ │(graph.ts)│ │ Builder  │ │(confidence-│ │         │ │
│  │ hybrid   │ │          │ │(context- │ │ machine.ts)│ │ TTL,    │ │
│  │ search:  │ │ nodes,   │ │ pack.ts) │ │            │ │ temporal│ │
│  │ FTS5     │ │ edges,   │ │          │ │ evidence   │ │ validity│ │
│  │ keyword +│ │ traversal│ │ TOON +   │ │ → score    │ │ (valid- │ │
│  │ semantic │ │ clusters │ │ TOON-    │ │ state      │ │ From/To)│ │
│  │ + RRF    │ │          │ │ compact  │ │ machine    │ │ import- │ │
│  │ fusion   │ │          │ │ (77.6%   │ │            │ │ ance    │ │
│  │          │ │          │ │ savings) │ │            │ │ decay   │ │
│  └────┬─────┘ └──────────┘ └──────────┘ └────────────┘ └────────┘ │
│       │                                                             │
│       │            ┌────────────────────────────┐                   │
│       └───────────▶│  Embedding Queue           │                   │
│                    │  (embedding-queue.ts)      │                   │
│                    │  batched async embedding   │                   │
│                    │  writes; local hash or     │                   │
│                    │  transformer provider      │                   │
│                    └────────────────────────────┘                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Storage Layer                                │
│                                                                     │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │   StorageAdapter (interface — src/adapters/base.ts)          │  │
│   │                                                              │  │
│   │   init() | saveNode() | getNode() | deleteNode()             │  │
│   │   saveEdge() | getEdge() | deleteEdge()                      │  │
│   │   queryNodes() | queryEdges() | getGraph()                   │  │
│   │   saveEmbedding() | querySimilarEmbeddings()                 │  │
│   └───────────────────────────┬──────────────────────────────────┘  │
│                               │                                     │
│              ┌────────────────┴────────────────┐                    │
│              ▼                                 ▼                    │
│   ┌───────────────────┐           ┌─────────────────────┐          │
│   │   SQLiteStorage   │           │  (Future: Postgres,  │          │
│   │   (src/storage/   │           │   Redis, Qdrant...)  │          │
│   │    sqlite.ts)     │           └─────────────────────┘          │
│   │                   │                                            │
│   │   better-sqlite3  │                                            │
│   │   WAL mode        │                                            │
│   │   FTS5 keyword    │                                            │
│   │   embeddings tbl  │                                            │
│   └───────────────────┘                                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Retrieval Pipeline — hybrid search

`search()` with a query runs the hybrid pipeline (private `hybridSearch` in
`memory.ts`):

```
  query
    ├── keyword leg ──▶ SQLite FTS5 (BM25 ranking)
    ├── semantic leg ─▶ embeddings table, cosine similarity
    │                   (vectors from the EmbeddingQueue's provider)
    └── fusion ───────▶ Reciprocal Rank Fusion (RRF, K=60)
                        keyword + semantic legs weighted, then
                        trust-weighted and temporal-validity filtered
```

Both legs run against the same SQLite database in one process — no external
vector store, no network calls.

## Context Packs — feeding LLMs on a token budget

`contextPack()` builds a token-budgeted slice of memory for prompt injection:

```
  1. Hybrid search for the query (above)
  2. debloatContent() strips filler from each candidate
  3. buildContextPack() ranks by relevance × trust, cuts at the token budget
  4. serializeContextPack() emits JSON, TOON, or TOON-compact
     (compact TOON: ~77.6% smaller than JSON for a 20-entry pack)
  5. Envelope: schema "ai-trio.memos.context-pack.v1"
```

LLM Guardian (sibling repo) consumes this envelope directly — it injects the
pack as a high-relevance system shard before its own compression pipeline.

## Data Flow — store("user prefers dark mode", { type: "preference" })

```
  1. User calls memos.store("user prefers dark mode", { type: "preference" })
  2. MemOS validates input, generates UUID, sets timestamps + provenance
  3. Extractive summarizer runs (local, no API call)
  4. Confidence machine initialises the score (0.5 start, floor 0.3, cap 1.0)
  5. GraphEngine.addNode(memoryNode); auto-links via text similarity
  6. StorageAdapter.saveNode(node) → SQLite prepared statement (WAL mode)
  7. EmbeddingQueue enqueues the node for batched embedding
  8. Returns { id, node, links } to caller
```

## Data Model

```
MemoryNode {
  id:          string        (UUID v4)
  content:     string        (raw text)
  summary:     string        (extractive summary)
  type:        string        (fact | preference | context | relationship | entity)
  metadata:    Record<string, unknown>
  importance:  number        (0-1 base; effective score adds recency decay
                             + access reinforcement — src/importance.ts)
  createdAt:   number        (unix ms)
  updatedAt:   number        (unix ms)
  accessCount: number
  lastAccessed: number       (unix ms)
  tags:        string[]
  namespace:   string        (grouping / multi-tenant isolation)
  expiresAt:   number | null (TTL, unix seconds)
  validFrom:   number | null (temporal validity start, unix ms)
  validTo:     number | null (temporal validity end; superseded memories
                             keep it so history stays queryable)
  provenance:  user_input | agent_inferred | ...
                             (drives trust scoring)
  confidence:  number        (state machine: evidence up/down, floor 0.3)
}

MemoryEdge {
  id:          string        (UUID v4)
  sourceId:    string        (MemoryNode.id)
  targetId:    string        (MemoryNode.id)
  relation:    string        (relates_to | contradicts | supports | derived_from | part_of)
  weight:      number        (0-1)
  metadata:    Record<string, unknown>
  createdAt:   number        (unix ms)
}
```

## Module Boundaries

| Module | Responsibility | Depends On |
|--------|---------------|------------|
| `types.ts` | All type definitions | Nothing |
| `storage/sqlite.ts` | Persistence via better-sqlite3 (WAL, FTS5, embeddings table) | `types.ts` |
| `adapters/base.ts` | Storage interface contract | `types.ts` |
| `graph.ts` | In-memory graph operations, text similarity, clustering | `types.ts` |
| `memory.ts` | Public API (`MemOS`), orchestration, hybrid search + RRF | `graph.ts`, `storage/`, `context-pack.ts`, `confidence-machine.ts`, `embedding-queue.ts`, `importance.ts` |
| `context-pack.ts` | Context pack builder, TOON / TOON-compact serialization | `types.ts` |
| `confidence-machine.ts` | Confidence score state machine | `types.ts` |
| `embedding-queue.ts` | Batched async embedding writes | `embeddings.ts` |
| `embeddings.ts` | Embedding providers (local hash default, transformers optional) | `types.ts` |
| `importance.ts` | Effective importance (recency decay + access reinforcement) | `types.ts` |
| `retain-filter.ts` | Low-signal content filtering | `types.ts` |
| `mcp.ts` | MCP server exposing MemOS tools (stdio, MCP 2026-07-28 spec) | `memory.ts` |
| `cli.ts` / `repl.ts` | Command-line interface and REPL | `memory.ts` |
| `index.ts` | Package entry point | `memory.ts`, `types.ts` |
| `server/main.py` | HTTP server (FastAPI) | TS SDK via REST or subprocess |
| `adapters/*.py` | Framework bridges (top-level `adapters/`) | `server` HTTP API |
