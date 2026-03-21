<p align="center">
  <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.png" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Universal, local-first, persistent memory layer for AI agents.</strong><br>
  Give any LLM a memory that survives restarts — no cloud, no API keys, no vendor lock-in.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@memos/sdk"><img src="https://img.shields.io/badge/npm-v0.1.0-cb3837?style=flat-square" alt="npm"></a>
  <a href="https://pypi.org/project/memos/"><img src="https://img.shields.io/pypi/v/memos?style=flat-square&color=3776ab" alt="PyPI"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <a href="https://github.com/Markgatcha/memos/actions"><img src="https://img.shields.io/github/actions/workflow/status/Markgatcha/memos/ci.yml?style=flat-square" alt="CI"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
</p>

---

<!-- PLACEHOLDER: Demo GIF — replace with actual recording -->
<!-- ![MemOS Demo](assets/demo.gif) -->

```
┌──────────────────────────────────────────────────────────┐
│  🎬  Demo GIF: Watch MemOS remember and recall context   │
│      across conversations in under 10 seconds.           │
│                                                          │
│      [Coming soon — star the repo to get notified]       │
└──────────────────────────────────────────────────────────┘
```

---

## One-liner install

```bash
# TypeScript / Node.js
npm install @memos/sdk

# Python
pip install memos
```

Start the HTTP server (Python):

```bash
memos-server
# → Listening on http://localhost:7400
```

---

## Why MemOS?

Every LLM forgets everything the moment a conversation ends. Frameworks like LangChain have memory modules, but they're tightly coupled, cloud-dependent, or stateless. Ollama has no memory at all.

**MemOS solves this with three principles:**

| Principle | What it means |
|-----------|---------------|
| **Local-first** | Your data never leaves your machine. SQLite-backed, zero cloud dependencies. |
| **Framework-agnostic** | Works with Ollama, LangChain, CrewAI, or raw HTTP. Write an adapter, plug it in. |
| **Graph-native** | Memories aren't flat logs — they're a graph of connected nodes with typed edges. Contradictions, derivations, and relationships are first-class citizens. |

**What makes MemOS different from `langchain.memory`:**

- **Persistent** — survives process restarts (SQLite WAL mode)
- **Searchable** — full-text search via FTS5, not just buffer retrieval
- **Graph-structured** — memories link to each other, enabling associative recall
- **Zero-config** — `new MemOS()` just works, no vector DB, no API keys
- **Privacy-first** — no telemetry, no analytics, no phone-home, ever

---

## Features

| Feature | Status |
|---------|--------|
| Store / Retrieve / Search / Forget | ✅ |
| Graph-based memory (nodes + edges) | ✅ |
| Full-text search (SQLite FTS5) | ✅ |
| Auto-linking by text similarity | ✅ |
| Extractive summarisation (local) | ✅ |
| TypeScript SDK | ✅ |
| Python HTTP server (FastAPI) | ✅ |
| CLI tool (`memos` command) | ✅ |
| Ollama adapter | ✅ |
| LangChain adapter | ✅ |
| Docker Compose deployment | ✅ |
| Edge types (relates_to, contradicts, supports, ...) | ✅ |
| LRU eviction with configurable max | ✅ |
| Event system (node:created, eviction, ...) | ✅ |
| Custom storage adapter interface | ✅ |
| Semantic search (embeddings) | 🔜 v0.2 |
| Obsidian / Markdown export | 🔜 v0.2 |
| Memory expiration (TTL) | 🔜 v0.3 |
| Multi-user isolation | 🔜 v0.3 |
| Plugin system for custom adapters | 🔜 v0.3 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                      │
│  (Ollama chatbot · LangChain agent · Custom LLM app)    │
└────────────────────────┬────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   ┌─────────────┐              ┌──────────────┐
   │  TypeScript  │              │  Python HTTP  │
   │  SDK (local) │              │  Server       │
   │              │              │  (FastAPI)    │
   │  new MemOS() │              │  POST /api/*  │
   └──────┬───────┘              └──────┬───────┘
          │                             │
          └──────────┬──────────────────┘
                     ▼
          ┌─────────────────────┐
          │    Memory Engine     │
          │                     │
          │  • Graph (nodes +   │
          │    typed edges)     │
          │  • Auto-linking     │
          │  • Extractive       │
          │    summarisation    │
          │  • FTS5 search      │
          └──────────┬──────────┘
                     │
          ┌──────────┴──────────┐
          │   Storage Layer      │
          │                      │
          │  SQLite (WAL mode)   │
          │  ~/.memos/memos.db   │
          │                      │
          │  Interface for:      │
          │  Postgres, Redis,    │
          │  Qdrant adapters     │
          └──────────────────────┘
```

---

## Quick start

### TypeScript

```typescript
import { MemOS } from "@memos/sdk";

const memos = new MemOS();
await memos.init();

// Store memories
await memos.store("User prefers dark mode", { type: "preference" });
await memos.store("Project uses TypeScript and React", { type: "fact" });
await memos.store("User is in UTC+2 timezone", { type: "context" });

// Search
const results = await memos.search("dark mode");
// → [{ node: { content: "User prefers dark mode", ... }, score: 1.0 }]

// Get a summary
const summary = await memos.summarize();
// → "User prefers dark mode."

// Link memories manually
await memos.link(nodeA.id, nodeB.id, "supports");

// Explore the graph
const { nodes, edges } = await memos.getGraph();
const neighbours = await memos.getNeighbours(someNodeId);
```

### Python (HTTP Server)

```python
import requests

# Start server: memos-server
BASE = "http://localhost:7400/api/mem"

# Store
requests.post(f"{BASE}/store", json={
    "content": "User prefers dark mode",
    "type": "preference"
})

# Search
results = requests.post(f"{BASE}/search", json={
    "query": "dark mode",
    "limit": 5
}).json()

# Get graph
graph = requests.get(f"{BASE}/graph").json()
```

### Ollama Adapter (Python)

```python
from adapters.ollama import OllamaMemory

chat = OllamaMemory(model="llama3")
await chat.init()

# Memories are automatically injected and extracted
response = await chat.chat("I prefer dark mode in all my apps")
response = await chat.chat("What theme do I like?")
# → Model recalls "dark mode" from memory
```

### LangChain Adapter (Python)

```python
from langchain_openai import ChatOpenAI
from langchain.chains import ConversationChain
from adapters.langchain import MemOSMemory

memory = MemOSMemory()
chain = ConversationChain(llm=ChatOpenAI(), memory=memory)

chain.invoke({"input": "I prefer dark mode"})
chain.invoke({"input": "What theme do I like?"})
# → Chain recalls "dark mode" from MemOS
```

### CLI

```bash
# Store
memos store "User prefers dark mode" --type preference

# Search
memos search "dark mode" --limit 5

# View the graph
memos graph

# Get a summary
memos summarize

# Start the HTTP server
memos serve
```

---

## Configuration

```typescript
const memos = new MemOS({
  dbPath: "./my-app.db",         // SQLite file path (default: ~/.memos/memos.db)
  wal: true,                      // WAL mode for concurrent reads (default: true)
  maxMemories: 10000,             // LRU eviction limit (default: 0 = unlimited)
  autoLinkThreshold: 0.3,         // Auto-link similarity threshold (default: 0.3)
  storage: customAdapter,         // Custom StorageAdapter implementation
});
```

Environment variables (Python server):

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMOS_PORT` | `7400` | Server port |
| `MEMOS_HOST` | `0.0.0.0` | Server bind address |
| `MEMOS_DB_PATH` | `~/.memos/memos.db` | SQLite database path |
| `MEMOS_LOG_LEVEL` | `info` | Log verbosity |

---

## Adapter list

| Adapter | Language | Framework | Status |
|---------|----------|-----------|--------|
| [Ollama](adapters/ollama.py) | Python | Ollama | ✅ |
| [LangChain](adapters/langchain.py) | Python | LangChain | ✅ |
| CrewAI | Python | CrewAI | 🔜 Contrib welcome |
| OpenAI SDK | Python | OpenAI | 🔜 Contrib welcome |
| Vercel AI SDK | TypeScript | Vercel AI | 🔜 Contrib welcome |
| HuggingFace | Python | transformers | 🔜 Contrib welcome |

**Want to build an adapter?** See [CONTRIBUTING.md](CONTRIBUTING.md) — we actively support community adapter contributions and will list yours in this table.

---

## Docker

```bash
# Build and run
docker compose up -d

# Check health
curl http://localhost:7400/health

# View API docs
open http://localhost:7400/docs
```

---

## Privacy

MemOS is built on a strict privacy-first foundation:

- **Zero telemetry** — no analytics, no tracking, no phone-home
- **Zero cloud dependencies** — no API keys required for core functionality
- **100% local storage** — SQLite on your filesystem, your data stays with you
- **Open source** — every line of code is auditable
- **No data collection** — we don't know what you store, and we never will

---

## Contributing

We welcome contributions of all kinds — bug fixes, new adapters, documentation improvements, and feature proposals.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. The fastest way to contribute is to **build an adapter** for a framework we don't support yet.

---

## Roadmap

| Phase | Target | Highlights |
|-------|--------|------------|
| **v0.1** (current) | Core engine | Graph memory, SQLite FTS5, TypeScript SDK, Python server, Ollama + LangChain adapters, CLI |
| **v0.2** | Semantic search | Embedding-based similarity, Obsidian export, memory expiration, Grafana dashboard |
| **v0.3** | Multi-user | User isolation, RBAC, plugin system, Postgres/Qdrant backends |
| **v1.0** | Production-ready | Stable API, comprehensive test suite, performance benchmarks, enterprise features |

See [ROADMAP.md](ROADMAP.md) for the detailed milestone plan.

---

## License

[MIT](LICENSE) — use it anywhere, for any purpose, no attribution required.

---

<p align="center">
  <sub>Built with intent. Star the repo if MemOS solves a problem for you.</sub>
</p>
