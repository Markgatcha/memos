# MemOS plugin for Claude Code

Local-first persistent memory for your agent. Installing this plugin registers
the MemOS MCP server (17 tools: store, search, retrieve, forget, graph,
context packs, temporal search, trust, fact extraction, diagnostics, …),
plus the `/memos`, `/recall`, `/forget`, and `/timeline` slash commands and
the `memos-memory` skill.

## Install

```text
/plugin marketplace add Markgatcha/memos
/plugin install memos@memos-marketplace
```

The MCP server runs via `npx -y @mem-os/sdk mcp` and stores everything in
`~/.memos/memos.db` on your machine — no cloud, no API keys.

## Commands

- `/memos <fact>` — store a durable fact
- `/recall <query>` — recall relevant memories
- `/forget <what>` — fuzzy-match a memory, confirm, delete it
- `/timeline [limit]` — show what MemOS has learned recently, newest first

## Hooks

- **SessionStart** — injects a compact summary of remembered context into new sessions.
- **SessionEnd** — session wrap-up bookkeeping.
- **UserPromptSubmit (auto-capture)** — notices explicit "remember this" /
  "don't forget" phrasing in your prompts and stores the fact automatically,
  no command needed. Conservative: only explicit requests trigger it, slash
  commands are skipped (no double-store with `/memos`), and anything shaped
  like a credential is never stored.

## Skill

`memos-memory` teaches the agent when to store (preferences, decisions,
environment facts, corrections) and when to recall (`memos_context_pack`
before answering questions that may depend on prior sessions), plus
hygiene rules (supersede instead of duplicating, forget only on request).
