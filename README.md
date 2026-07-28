<p align="center">
      <img src="https://raw.githubusercontent.com/Markgatcha/memos/main/assets/memos-logo.svg" alt="MemOS" width="200" />
</p>

<h1 align="center">MemOS</h1>

<p align="center">
  <strong>Universal, local-first, persistent memory layer for AI agents.</strong><br>
  Give any LLM a memory that survives restarts — no cloud, no API keys, no vendor lock-in.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mem-os/sdk"><img src="https://img.shields.io/npm/v/@mem-os/sdk?style=flat-square&color=cb3837" alt="npm"></a>
  <a href="https://pypi.org/project/mem-os-sdk/"><img src="https://img.shields.io/badge/pypi-v1.6.26-3776ab?style=flat-square" alt="PyPI"></a>
  <a href="https://github.com/Markgatcha/memos/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Markgatcha/memos?style=flat-square&color=green" alt="License"></a>
  <a href="https://github.com/Markgatcha/memos/actions"><img src="https://img.shields.io/github/actions/workflow/status/Markgatcha/memos/ci.yml?style=flat-square" alt="CI"></a>
  <img src="https://img.shields.io/badge/100%25%20local-zero%20cloud%20deps-brightgreen?style=flat-square" alt="100% Local">
</p>

> **Release status:** The GitHub source is the canonical, always-current build (v1.6.26). The published npm package (`@mem-os/sdk`) and PyPI package (`mem-os-sdk`) are updated on each tagged release but may briefly lag the source. For the latest features, install [from source](#from-source).

---

## 🔗 Part of the AI Trio

MemOS is one of three sibling projects that compose into a complete agent memory + tooling stack:

| Project | Role |
| --- | --- |
| **[universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit)** | MCP protocol, server registry, and tool routing |
| **[memos](https://github.com/Markgatcha/memos)** | Graph-based persistent memory across agent sessions |
| **[llm-guardian](https://github.com/Markgatcha/llm-guardian)** | Token-cost guardian that compresses prompts and injects MemOS memory slices |

Together they cover transport + tools (UMT), memory + persistence (MemOS), and LLM inference cost control (llm-guardian). MemOS publishes the `@mem-os/sdk` MCP adapter, which pairs directly with UMT's `link memos` command and feeds memory slices into llm-guardian's prompt optimization.

## One-liner install

```bash
# TypeScript / Node.js (from source — always current)
npm install @mem-os/sdk
# The published npm package is updated on each tagged release but may briefly
# lag the GitHub source. For the absolute latest, clone and build from source
# (see Installation → From source below).
```

> **Note:** `@mem-os/sdk` is published to npm, but the live package can trail the
> main branch. If you need a feature that just landed on `main`, install from source.

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
| CrewAI adapter | ✅ |
| Import from JSON/Markdown/Obsidian | ✅ |
| Export to JSON/Markdown/Obsidian | ✅ |
| Memory TTL / Expiration | ✅ |
| Custom memory tags | ✅ |
| WebSocket API (real-time events) | ✅ |
| Docker Compose deployment | ✅ |
| Edge types (relates_to, contradicts, supports, ...) | ✅ |
| LRU eviction with configurable max | ✅ |
| Event system (node:created, eviction, ...) | ✅ |
| Custom storage adapter interface | ✅ |
| Backup and restore | ✅ |
| MCP adapter (stdio) | ✅ |
| Performance benchmarks | ✅ |
| Background embedding queue | ✅ v1.6.26 |
| AI Trio context pack (LLM Guardian compat) | ✅ v1.6.26 |
| MCP 2025-06-18 protocol | ✅ v1.6.26 |
| Memory consolidation ("dreaming") | ✅ v1.6.26 |
| HTTP+SSE MCP transport | ✅ v1.6.26 |
| Voyage / Cohere / FastEmbed providers | ✅ v1.6.26 |
| `memos repl` interactive shell | ✅ v1.6.26 |
| Retrieval-quality benchmark | ✅ v1.6.26 |
| Tag index (node_tags join table) | ✅ v1.6.26 |
| Access-count debounce | ✅ v1.6.26 |
| Cross-OS SQLite pragmas | ✅ v1.6.26 |
| Semantic search (embeddings) | ✅ v1.6.26 |
| Hermes-style retain pre-filter | ✅ v1.6.26 |
| Temporal knowledge graphs | ✅ v1.6.26 |
| Trust scoring & provenance | ✅ v1.6.26 |
| Fact extraction from conversations | ✅ v1.6.26 |
| Diagnostics & health monitoring | ✅ v1.6.26 |
| OpenAI SDK adapter | ✅ v1.6.26 |
| Anthropic SDK adapter | ✅ v1.6.26 |
| Trust-weighted hybrid search | ✅ v1.6.26 |
| Parallel hybrid retrieval | ✅ v1.6.26 |
| Multi-user isolation | 🔜 v3.0 |
| Plugin system for custom backends | 🔜 v3.0 |
| Admin dashboard | 🔜 v4.0 |

---

## Embedding-backed search

MemOS still works with zero setup through local keyword search and graph similarity. When `experimental.semanticSearch` is enabled, it can now persist embedding vectors and merge semantic similarity with SQLite FTS keyword results.

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS({
  experimental: { semanticSearch: true, namespaces: true },
  embeddings: {
    provider: "ollama",
    model: "nomic-embed-text",
    baseUrl: "http://127.0.0.1:11434",
  },
});

await memos.init();
await memos.store("User prefers dark mode in editors", { namespace: "demo" });

const hybrid = await memos.search({
  query: "favorite editor theme",
  namespace: "demo",
  limit: 5,
});
```

LM Studio and other no-key OpenAI-compatible embedding servers work by leaving `apiKey` unset:

```ts
const memos = new MemOS({
  experimental: { semanticSearch: true },
  embeddings: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "text-embedding-nomic-embed-text-v1.5",
    dimensions: 768,
  },
});
```

CLI and server deployments can use `MEMOS_EMBEDDING_PROVIDER`, `MEMOS_EMBEDDING_MODEL`, `MEMOS_EMBEDDING_BASE_URL`, `MEMOS_EMBEDDING_API_KEY`, and `MEMOS_EMBEDDINGS=false` to control embedding behavior. `MEMOS_EMBEDDING_API_KEY` is optional for local no-key endpoints.

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
import { MemOS } from "@mem-os/sdk";

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
requests.post(f"{BASE}/store", json={"content": "User prefers dark mode", "type": "preference"})

# Search
results = requests.post(f"{BASE}/search", json={"query": "dark mode", "limit": 5}).json()

# Get graph
graph = requests.get(f"{BASE}/graph").json()

# Import memories
requests.post(f"{BASE}/import", json={"source": "./memories.json"})

# WebSocket for real-time events
import websocket

ws = websocket.create_connection("ws://localhost:7400/ws")
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

### CrewAI Adapter (Python)

```python
from memos.adapters.crewai import MemOSTool, MemOSMemory

# Use as a tool for agents
tool = MemOSTool()
result = tool._run("store", content="User prefers dark mode")
result = tool._run("search", query="dark mode")

# Use as CrewAI memory backend
memory = MemOSMemory()
memory.save("User prefers dark mode", type="preference")
context = memory.get_context("What theme do I like?")
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

# Export memories
memos export --format markdown --output ./my-export

# Import memories
memos import ./my-export
memos import ./memories.json

# Start the HTTP server
memos serve

# Boot the full AI Trio (MemOS + LLM-Guardian + Universal-MCP-Toolkit)
memos trio            # print the compose plan
memos trio --up       # launch Guardian + UMT alongside this MemOS instance
```

### MCP Server

Expose MemOS directly to any MCP-compatible agent over stdio:

```bash
npx -y @mem-os/sdk mcp
```

Use a specific local database:

```bash
npx -y @mem-os/sdk mcp --db ~/.memos/memos.db
```

The MCP adapter provides tools for storing, searching, retrieving, deleting, graph inspection, and context injection. It is intentionally local-first: the server reads and writes the SQLite database you point it at and does not require cloud credentials.

### WebSocket API

Connect to the WebSocket endpoint for real-time memory events:

```javascript
const ws = new WebSocket("ws://localhost:7400/ws");

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(`${data.event}:`, data.data);
};

// Events: node:created, node:updated, node:deleted,
//         edge:created, edge:deleted, link:auto,
//         eviction, ttl:expired
```

---

## Advanced usage

### Temporal validity

Memories can carry a validity window. When `validTo` is in the past, a memory
becomes "historical" — excluded from default search but still queryable as-of a
point in time.

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

const { node } = await memos.store("User lives in Berlin", { type: "fact" });

// The user moves. Mark the old fact as historical…
await memos.setValidity(node.id, node.validFrom, Date.now());

// …and store the replacement, linking the two with a temporal_precedes edge.
const { node: moved } = await memos.store("User lives in Tokyo", { type: "fact" });
await memos.supersede(node.id, moved.id);

// Default search excludes superseded memories
const current = await memos.search("where does the user live");
// → "User lives in Tokyo"

// Temporal search: "What did we know at time T?"
const yesterday = Date.now() - 86_400_000;
const history = await memos.searchTemporal("where does the user live", yesterday);
// → "User lives in Berlin"
```

### Retain pre-filter (Hermes-style)

Not everything an agent says is worth storing. The retain filter scores candidate memories on length, signal density, action/preference verbs, and novelty against existing content — anything below `RETAIN_THRESHOLD` (0.3) is skipped before the write, keeping the graph clean and search fast. This mirrors the same technique llm-guardian uses on its read path, so the AI Trio applies consistent quality gating on both ends.

```ts
import { MemOS, MemorySkippedError, scoreRetain } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Greet-noise never reaches SQLite
try {
  await memos.store("Sure, I can help with that!", { filterRetain: true });
} catch (e) {
  if (e instanceof MemorySkippedError) {
    console.log(e.message); // → "memory skipped by retain filter (score 0.08 < 0.3)"
  }
}

// High-signal content passes through
await memos.store("User prefers TypeScript over JavaScript", { filterRetain: true });
// → stored, score 0.78

// Inspect the score without storing
scoreRetain({ content: "ok sounds good", existingContent: "" });
// → { retain: false, score: 0.05, reason: "low-signal" }
```

`filterRetain` is opt-in per call — plain `store()` is unchanged for callers that want to write everything and dedupe later. Tune the threshold or swap in a custom classifier with `setRetainClassifier()`.

### Trust scoring & provenance

Every memory carries a `source` (provenance) and a `trustScore` in `[0, 1]`.
Trust influences retrieval ranking — higher-trust memories rank above
lower-trust ones for the same relevance.

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

// Default trust comes from the provenance source:
//   user_input → 1.0, agent_inferred → 0.7, external_data → 0.5, system → 0.3
const { node } = await memos.store("Deploy is scheduled for Friday", {
  source: "agent_inferred",
});

await memos.trust(node.id);        // → 0.7
await memos.setTrust(node.id, 0.95);   // override explicitly
await memos.adjustTrust(node.id, -0.2); // nudge by a delta (clamped) → 0.75

// Trust-weighted search: rank by trust and filter out low-trust memories
const trusted = await memos.search({
  query: "deploy schedule",
  sortBy: "trustScore",
  sortOrder: "desc",
  minTrustScore: 0.8,
});
```

### Fact extraction

A local, rule-based extractor pulls candidate facts (preferences, entities,
context) out of a conversation and can auto-store the high-confidence ones.
No LLM API calls required. Near-duplicates are skipped automatically when
embeddings are available.

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

const conversation = [
  { role: "user", content: "I prefer dark mode in all my editors." },
  { role: "assistant", content: "Got it — I'll remember that." },
  { role: "user", content: "My name is Alice and I work at Acme Corp." },
];

const { facts, storedIds, duplicates } = await memos.extractFacts(conversation, {
  autoStore: true,
  minConfidence: 0.6,
  dedupe: true,
});

console.log(facts);      // → [{ content: "I prefer dark mode ...", type: "preference", confidence: 0.9 }, ...]
console.log(storedIds);  // → ["node-uuid-1", "node-uuid-2"]
console.log(duplicates); // → 0
```

### Diagnostics

Get a full health snapshot of the memory store — counts by source, type, and
namespace; temporal and trust statistics; embedding coverage; and DB size.

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

const diag = await memos.diagnostics();
console.log(diag);
// {
//   totalNodes: 42,
//   totalEdges: 17,
//   nodesWithEmbeddings: 42,
//   nodesWithValidity: 3,
//   historicalNodes: 1,
//   nodesWithTTL: 0,
//   expiredNodes: 0,
//   avgImportance: 0.51,
//   avgTrustScore: 0.83,
//   bySource: { user_input: 30, agent_inferred: 12 },
//   byType: { preference: 18, fact: 16, context: 8 },
//   byNamespace: { default: 42 },
//   dbSizeBytes: 106496,
//   embeddingQueue: { pending: 0, running: 0, total: 42, nodes: [...] },
//   storageCapabilities: { peekNode: true, evictLeastImportant: true, ... }
// }
```

### OpenAI adapter

The OpenAI adapter ships as a built-in subpath export — no separate install
beyond `@mem-os/sdk`. It prepares memories as tools, tool messages, and
system-prompt strings for your own `openai.chat.completions` calls.

```ts
import OpenAI from "openai";
import { createOpenAIMemory } from "@mem-os/sdk/openai";

const { memos, plugin } = await createOpenAIMemory({
  dbPath: "./my-app.db",
  plugin: { maxContextMemories: 6 },
});

const openai = new OpenAI();

// addMessages() extracts & stores facts automatically
await plugin.addMessages([
  { role: "user", content: "I prefer dark mode in all my apps." },
  { role: "assistant", content: "Got it — dark mode it is." },
]);

// Context-injection style: fold relevant memories into the system prompt
const systemCtx = await plugin.getMemoryContext([
  { role: "user", content: "What theme do I like?" },
]);

const completion = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: `You are a helpful assistant.\n\n${systemCtx}` },
    { role: "user", content: "What theme do I like?" },
  ],
});

// Tool style: let the model call search_memories itself
const res = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What theme do I like?" }],
  tools: [plugin.memoryTool],
});
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
| [CrewAI](adapters/crewai.py) | Python | CrewAI | ✅ |
| [OpenAI SDK](src/adapters/openai.ts) | TypeScript | OpenAI | ✅ Built-in |
| [Anthropic SDK](src/adapters/anthropic.ts) | TypeScript | Anthropic | ✅ Built-in |
| Vercel AI SDK | TypeScript | Vercel AI | 🔜 Contrib welcome |
| HuggingFace | Python | transformers | 🔜 Contrib welcome |

**Want to build an adapter?** See [CONTRIBUTING.md](CONTRIBUTING.md) — we actively support community adapter contributions and will list yours in this table.

---

## Installation

MemOS works on **Windows**, **macOS**, and **Linux**. Choose your preferred method:

### npm (TypeScript/Node.js)

```bash
npm install @mem-os/sdk
```

### PyPI (Python)

```bash
pip install mem-os-sdk

# With optional dependencies
pip install "mem-os-sdk[langchain]"   # LangChain adapter
pip install "mem-os-sdk[ollama]"      # Ollama adapter
pip install "mem-os-sdk[crewai]"      # CrewAI adapter
pip install "mem-os-sdk[all]"         # All adapters
```

### From source

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos

# TypeScript
npm install
npm run build

# Python
pip install -e ".[dev]"
```

### Docker

```bash
# Build and run
docker compose up -d

# Check health
curl http://localhost:7400/health

# View API docs
open http://localhost:7400/docs
```

### Docker image

```bash
docker pull ghcr.io/markgatcha/memos:latest
docker run -p 7400:7400 ghcr.io/markgatcha/memos:latest
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
| **v1.5** (current) | Core engine | Graph memory, SQLite FTS5, TypeScript SDK, Python server, Ollama + LangChain + CrewAI adapters, CLI, import/export, WebSocket API, MCP |
| **v2.0** | Semantic intelligence | Harden embedding search at scale, temporal knowledge graphs, memory consolidation, provenance tracking |
| **v3.0** | Multi-user | User isolation, RBAC, plugin system, Postgres/Redis/Qdrant backends |
| **v4.0** | Intelligence | Memory poisoning defense, graph dashboard, agent self-editing, benchmark suite |
| **v5.0** | Ecosystem | MCP 2026 compliance, cross-framework adapters, enterprise features, standards |

See [ROADMAP.md](ROADMAP.md) for the detailed milestone plan.


## Ecosystem — The Local-First AI Trio

MemOS is the **memory layer** of the local-first AI stack. It forms an **AI Trio** with two sibling projects:

| Tool | Role | Works with MemOS |
|------|------|------------------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP transport & tool registry | ✅ Native MCP adapter (stdio + HTTP+SSE) |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | LLM cost guardian & prompt compression | ✅ Context pack contract (`ai.trio.memos.context-pack.v1`) |
| Ollama | Local LLM inference | ✅ Adapter included |
| OpenAI SDK | Cloud LLM + embeddings | ✅ Adapter included |
| Anthropic SDK | Claude integration | ✅ Adapter included |
| LangChain | Agent framework | ✅ Adapter included |
| CrewAI | Multi-agent orchestration | ✅ Adapter included |

### How the Trio works together

1. **MemOS** stores and retrieves memories locally via SQLite + embeddings
2. **llm-guardian** calls `memos.contextPack({ query, tokenBudget })` to get a token-budgeted, ranked memory slice
3. **universal-mcp-toolkit** exposes MemOS as MCP tools (`memos_store`, `memos_search`, `memos_extract_facts`, etc.) so any MCP-compatible agent (Claude, Hermes, etc.) gets persistent memory

> **Building with MCP?** The official MemOS MCP adapter works out of the box with [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit), giving every Claude, OpenClaw, and MCP-compatible agent persistent memory in one step. The HTTP+SSE transport is the same one UMT ships, so web-based MCP hosts work too.

> **Building with LLM Guardian?** The `contextPack()` method implements the `ai.trio.memos.context-pack.v1` contract — Guardian consumes it directly, no adapter needed. Trust scores and provenance flow through the pack so Guardian can make cost-aware decisions about which memories to fold into the prompt.

### MemOS vs. Mem0

| Feature | MemOS | Mem0 |
|---------|-------|------|
| **Local-first** | ✅ SQLite, no server required | ❌ Cloud-first, self-host needs Docker |
| **Temporal validity** | ✅ `validFrom`/`validTo`, `searchTemporal()` | ✅ Time-aware retrieval (Apr 2026) |
| **Trust & provenance** | ✅ `source`, `trustScore`, trust-weighted search | ❌ Not available |
| **Memory consolidation** | ✅ `dedupe()`, `archive()`, `summarizeCluster()` | ❌ ADD-only (no UPDATE/DELETE) |
| **Fact extraction** | ✅ Local rule-based (`extractFacts()`) | ✅ LLM-based (requires API calls) |
| **MCP native** | ✅ stdio + HTTP+SSE | ❌ |
| **Graph edges** | ✅ First-class (`derived_from`, `temporal_precedes`, etc.) | ✅ Entity linking (Apr 2026) |
| **Embedding providers** | ✅ 6 (local-hash, Ollama, OpenAI, Voyage, Cohere, FastEmbed) | ✅ OpenAI, Qwen |
| **Background queue** | ✅ Bounded concurrency, retry, backpressure | ❌ |
| **CLI** | ✅ Full REPL + 20+ commands | ✅ Basic add/search |
| **Privacy** | ✅ 100% local, zero network calls | ❌ Cloud calls by default |
| **Diagnostics** | ✅ `diagnostics()` with source/type/namespace breakdown | ❌ |

---

---

## License

[MIT](LICENSE) — use it anywhere, for any purpose, no attribution required.

---

<p align="center">
  <sub>Built with intent. Star the repo if MemOS solves a problem for you.</sub>
</p>
