# Welcome to MemOS

**The memory layer your AI agent has been missing.**

You know that feeling — you tell your AI assistant something important, close the app, and next time it's back to square one. Every conversation starts with "so, what were we working on?" MemOS fixes that. It gives any LLM, chatbot, or agent a memory that **survives restarts**, stored as a plain SQLite file on your own machine.

No cloud. No API keys. No account. No monthly bill. Just memory that stays yours.

!!! tip "Five minutes to your first memory"
    If you're new here, start with the [Installation guide](installation.md) — it walks you through everything step by step, and we'll wait right here.

## The 30-second version

=== "TypeScript"

    ```bash
    npm install @mem-os/sdk
    ```

    ```typescript
    import { MemOS } from "@mem-os/sdk";

    const memos = new MemOS();
    await memos.init();

    // Remember something
    await memos.store("User prefers dark mode", { type: "preference" });

    // Recall it later — even in a brand-new process
    const results = await memos.search("dark mode");
    ```

=== "Python"

    ```bash
    git clone https://github.com/Markgatcha/memos.git
    cd memos
    pip install -e .
    memos-server   # → http://localhost:7400
    ```

    ```python
    import requests

    requests.post(
        "http://localhost:7400/api/mem/store",
        json={"content": "User prefers dark mode", "type": "preference"},
    )
    ```

That's genuinely it. Store a memory, kill the process, start a new one, search — it's still there.

## Why people pick MemOS

- **It's actually local.** Your memories live in one SQLite file you can open, copy, back up, or delete. Nothing phones home.
- **It's a graph, not a list.** New memories auto-link to related ones, so searching "theme" can surface your "dark mode" preference.
- **It understands time.** Memories carry validity windows (`validFrom`/`validTo`), so "user lives in Berlin" can gracefully stop being true.
- **It's cheap to feed to an LLM.** The compact TOON format cuts context tokens by ~77% versus JSON.
- **It's free.** MIT license, no paid tier, no "graph memory costs extra." Fork it, modify it, ship it.

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

## Where to next?

- [Installation](installation.md) — step-by-step setup for every platform (start here)
- [API Reference](api-reference.md) — full method documentation
- [Adapters](adapters.md) — framework integrations (Ollama, LangChain, CrewAI)
- [Benchmarks](benchmark-comparison.md) — how MemOS measures up (spoiler: 95.9% recall on BEAM-1M)
- [GitHub](https://github.com/Markgatcha/memos) — source code, issues, and the star button ⭐
