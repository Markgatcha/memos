# MemOS Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Application Layer                            │
│                                                                     │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│   │   Ollama      │  │  LangChain   │  │  Custom Agents / LLMs   │ │
│   │   Adapter     │  │   Adapter    │  │                         │ │
│   └──────┬───────┘  └──────┬───────┘  └────────────┬────────────┘ │
│          │                 │                        │              │
└──────────┼─────────────────┼────────────────────────┼──────────────┘
           │                 │                        │
           ▼                 ▼                        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Transport Layer                               │
│                                                                     │
│   ┌────────────────────────────┐  ┌──────────────────────────────┐  │
│   │   Python HTTP Server       │  │   TypeScript SDK (direct)    │  │
│   │   (FastAPI — server/)      │  │   (src/index.ts)             │  │
│   │                            │  │                              │  │
│   │   POST /api/mem/store      │  │   memos.store()              │  │
│   │   POST /api/mem/retrieve   │  │   memos.retrieve()           │  │
│   │   POST /api/mem/search     │  │   memos.search()             │  │
│   │   POST /api/mem/forget     │  │   memos.forget()             │  │
│   │   POST /api/mem/summarize  │  │   memos.summarize()          │  │
│   │   POST /api/mem/link       │  │   memos.link()               │  │
│   │   GET  /api/mem/graph      │  │   memos.getGraph()           │  │
│   └─────────────┬──────────────┘  └──────────────┬───────────────┘  │
│                 │                                │                  │
└─────────────────┼────────────────────────────────┼──────────────────┘
                  │                                │
                  ▼                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Core Engine (TypeScript)                     │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                      MemoryManager                         │   │
│   │                      (src/memory.ts)                        │   │
│   │                                                             │   │
│   │  Orchestrates all operations. Validates input, delegates    │   │
│   │  to graph engine and storage layer. Generates summaries.    │   │
│   └──────────────────────┬──────────────────────────────────────┘   │
│                          │                                          │
│          ┌───────────────┴───────────────┐                          │
│          ▼                               ▼                          │
│   ┌──────────────┐              ┌────────────────┐                  │
│   │   GraphEngine │              │  Summarizer    │                  │
│   │  (src/graph.ts)│              │  (extractive)  │                  │
│   │              │              └────────────────┘                  │
│   │  - Nodes     │                                                  │
│   │  - Edges     │                                                  │
│   │  - Traversal │                                                  │
│   │  - Clusters  │                                                  │
│   └──────┬───────┘                                                  │
│          │                                                          │
└──────────┼──────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Storage Layer                                │
│                                                                     │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │   StorageAdapter (interface — src/adapters/base.ts)          │  │
│   │                                                              │  │
│   │   init() | saveNode() | getNode() | deleteNode()            │  │
│   │   saveEdge() | getEdge() | deleteEdge()                     │  │
│   │   queryNodes() | queryEdges() | getGraph()                  │  │
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
│   │   FTS5 search     │                                            │
│   └───────────────────┘                                            │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Data Flow — store("user prefers dark mode", { type: "preference" })

```
  1. User calls memos.store("user prefers dark mode", { type: "preference" })
  2. MemoryManager validates input, generates UUID, sets timestamps
  3. MemoryManager calls extractive summarizer (local, no API call)
  4. MemoryManager calls GraphEngine.addNode(memoryNode)
  5. GraphEngine returns updated graph state
  6. MemoryManager calls StorageAdapter.saveNode(node)
  7. SQLiteStorage writes to memories table via prepared statement
  8. MemoryManager auto-links related nodes via text similarity
  9. Returns { id, node, links } to caller
```

## Data Model

```
MemoryNode {
  id:          string        (UUID v4)
  content:     string        (raw text)
  summary:     string        (extractive summary)
  type:        string        (fact | preference | context | relationship | entity)
  metadata:    Record<string, any>
  importance:  number        (0-1, auto-computed)
  createdAt:   number        (unix ms)
  updatedAt:   number        (unix ms)
  accessCount: number
  lastAccessed: number       (unix ms)
}

MemoryEdge {
  id:          string        (UUID v4)
  sourceId:    string        (MemoryNode.id)
  targetId:    string        (MemoryNode.id)
  relation:    string        (relates_to | contradicts | supports | derived_from | part_of)
  weight:      number        (0-1)
  metadata:    Record<string, any>
  createdAt:   number        (unix ms)
}
```

## Module Boundaries

| Module | Responsibility | Depends On |
|--------|---------------|------------|
| `types.ts` | All type definitions | Nothing |
| `storage/sqlite.ts` | Persistence via better-sqlite3 | `types.ts` |
| `adapters/base.ts` | Storage interface contract | `types.ts` |
| `graph.ts` | In-memory graph operations | `types.ts` |
| `memory.ts` | Public API, orchestration | `graph.ts`, `storage/sqlite.ts`, `types.ts` |
| `index.ts` | Package entry point | `memory.ts`, `types.ts` |
| `server/main.py` | HTTP server (FastAPI) | TS SDK via REST or subprocess |
| `adapters/*.py` | Framework bridges | `server` HTTP API |
