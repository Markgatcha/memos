# MemOS Documentation

**Universal, local-first, persistent memory layer for AI agents.**

MemOS gives any LLM, chatbot, or AI agent a memory that survives restarts. It runs 100% locally with SQLite — no cloud dependencies, no API keys, no vendor lock-in.

## Quick start

=== "TypeScript"

    ```bash
    npm install @memos/sdk
    ```

    ```typescript
    import { MemOS } from "@memos/sdk";

    const memos = new MemOS();
    await memos.init();

    await memos.store("User prefers dark mode", { type: "preference" });
    const results = await memos.search("dark mode");
    ```

=== "Python"

    ```bash
    pip install memos
    memos-server
    ```

    ```python
    import requests

    requests.post("http://localhost:7400/api/mem/store", json={
        "content": "User prefers dark mode",
        "type": "preference"
    })
    ```

## Core concepts

### Memory nodes

A **memory node** is a single unit of knowledge. It contains:

- `content` — the raw text
- `summary` — an extractive summary (auto-generated if not provided)
- `type` — semantic category (`fact`, `preference`, `context`, `relationship`, `entity`, `custom`)
- `metadata` — arbitrary JSON-serialisable data
- `importance` — a score from 0 to 1

### Memory edges

An **edge** connects two nodes with a typed relationship:

- `relates_to` — general association
- `contradicts` — the target contradicts the source
- `supports` — the target supports the source
- `derived_from` — the source was derived from the target
- `part_of` — the source is part of the target

Edges are created automatically (via text similarity) or manually (via `memos.link()`).

### The graph

Memories aren't stored as a flat list — they're a **graph**. When you store a new memory, MemOS automatically links it to related existing memories based on text similarity. This enables associative recall: searching for "theme" can surface a memory about "dark mode" because they're linked.

### Storage

By default, MemOS uses **SQLite** with WAL mode for concurrent reads and FTS5 for full-text search. The database file lives at `~/.memos/memos.db` (configurable). You can implement a custom `StorageAdapter` for Postgres, Redis, Qdrant, or any other backend.

## Architecture overview

```
Application → SDK/HTTP → Memory Engine → Graph → SQLite
                ↑
          Auto-linking
          Summarisation
          FTS5 Search
```

## Next steps

- [API Reference](api-reference.md) — full method documentation
- [Adapters](adapters.md) — framework integrations (Ollama, LangChain, custom)
- [GitHub](https://github.com/Markgatcha/memos) — source code and issues
