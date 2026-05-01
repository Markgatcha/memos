MemOS is a local-first, graph-based persistent memory layer for AI agents and LLM apps. Give any LLM a memory that survives restarts — zero cloud dependencies, zero API keys, 100% local.



\### What's included



\*\*TypeScript SDK (`@mem-os/sdk`)\*\*

\- `MemOS` class with `store`, `retrieve`, `search`, `forget`, `summarize`, `link`

\- Graph-based memory model: typed nodes, typed edges, metadata

\- SQLite storage backend with WAL mode and FTS5 full-text search

\- Auto-linking via bag-of-words text similarity

\- Extractive summarization (fully local, no API calls)

\- LRU eviction with configurable `maxMemories`

\- Event system (`node:created`, `eviction`, etc.)

\- Custom storage adapter interface



\*\*Python Server\*\*

\- FastAPI HTTP server on port 7400

\- Full REST API for store / retrieve / search / forget / summarize / graph



\*\*CLI\*\*

\- `memos store`, `memos search`, `memos graph`, `memos summarize`, `memos serve`



\*\*Adapters\*\*

\- Ollama adapter (Python)

\- LangChain adapter (Python)



\*\*Infrastructure\*\*

\- Docker Compose deployment

\- GitHub Actions CI (lint + test + typecheck)

\- Tested: Node 18/20/22, Python 3.10–3.13



\### Quick start



\*\*TypeScript:\*\*

```typescript

import { MemOS } from "@mem-os/sdk";

const mem = new MemOS();

await mem.store("user prefers dark mode", { tags: \["preference"] });

const results = await mem.search("dark mode");

```



\*\*Python:\*\*

```bash

pip install memos

memos-server

\# → Listening on http://localhost:7400

```



\### Why MemOS

\- \*\*Persistent\*\* — SQLite WAL mode survives restarts; no vector DB or Redis needed

\- \*\*Private\*\* — zero telemetry, zero cloud deps, your data never leaves your machine

\- \*\*Graph-native\*\* — memories link to each other with typed edges, enabling associative recall



\### What's next (v0.2)

\- Semantic search via local embeddings

\- Obsidian / Markdown export

\- Memory expiration (TTL)

\- MCP adapter (Model Context Protocol)



\### Install

```bash

npm install @mem-os/sdk

pip install memos

```



\### Links

\- \[Repository](https://github.com/Markgatcha/memos)

\- \[ROADMAP.md](https://github.com/Markgatcha/memos/blob/main/ROADMAP.md)

\- \[universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) — sister project



