---
description: "MemOS memory: store, search, and check status of local persistent memories"
---

Help me work with my MemOS persistent memory (the `memos` MCP server, all local SQLite).

1. Call `memos_diagnostics` and report: total memories, embedding coverage, and database size.
2. If I gave you a query with this command, call `memos_search` (limit 10) with it and summarize the top results with their IDs and scores.
3. If I asked you to remember something (`/memos <text>`), call `memos_store` with that text, a sensible `type` (fact | preference | context | entity | relationship), and confirm with the returned ID.

Guidelines:
- Never store secrets (API keys, passwords, tokens) — MemOS is plain SQLite on disk.
- If a stored fact is outdated, prefer `memos_supersede` + storing the corrected version over leaving contradictory memories.
- All data stays on this machine; nothing leaves it.
