---
name: memos-memory
description: Use when the user shares durable facts worth persisting across sessions (preferences, project decisions, environment setup, corrections), asks to remember or recall something, or when a question may depend on prior sessions. Drives the local MemOS MCP server (memos_* tools, all data in local SQLite).
---

# MemOS persistent memory

MemOS gives you persistent, local-first memory across sessions. Everything
stays in a local SQLite database — never send secrets to it (it is a plain
file on disk).

## When to STORE (memos_store)

Store durable, reusable facts — not chatter. Store when the user:

- states a **preference** ("always use pnpm, never npm", "I like concise answers")
- makes a **project decision** ("we chose Postgres over Mongo because of JSONB")
- describes their **environment** ("Windows 11, RTX 5050 GPU, 16GB RAM")
- **corrects** something you did ("don't run tests with --watch")
- shares **facts about people/projects** ("the API base URL is staging.example.com")

Pick a sensible `type`: `preference`, `fact`, `context`, `entity`,
`relationship`. Confirm briefly after storing ("Remembered: …").

Do NOT store: secrets/keys, session-ephemeral details (file contents you
already see), task checklists, or anything the user asks you to forget later.

## When to RECALL

- Before answering questions like "why did we…", "what did I say about…",
  "how do I usually…" → call `memos_context_pack` with `tokenBudget` 2000.
  It returns a token-budgeted, relevance-ranked slice ready to use.
- For raw exploration → `memos_search` (limit 10).
- When the exact wording may have changed over time (renamed services,
  moved URLs) → `memos_search_temporal` with a past `atTime` to see what
  was true then.

## Keeping memory clean

- Outdated fact? Store the corrected version, then `memos_supersede` the old
  one (optionally passing the new memory id as `replacementId`). Historical
  versions stay queryable via `memos_search_temporal`.
- Contradiction check: if a new fact conflicts with search results, surface
  the conflict to the user instead of silently storing both.
- If tools feel slow or results look lexical-only, call `memos_diagnostics`:
  low `nodesWithEmbeddings` coverage means the embedding provider is not
  configured (set `MEMOS_EMBEDDING_*` env vars, or run
  `memos reindex-embeddings --purge-stale` after switching models).

## Namespaces

If the harness runs across several unrelated projects, keep memories
separated with `namespace` (e.g. the repo name). Ask once if unclear.
