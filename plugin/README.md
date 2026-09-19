# MemOS plugin for Claude Code

Local-first persistent memory for your agent. Installing this plugin registers
the MemOS MCP server (17 tools: store, search, retrieve, forget, graph,
context packs, temporal search, trust, fact extraction, diagnostics, …),
plus the `/memos` and `/recall` slash commands and the `memos-memory` skill.

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

## Skill

`memos-memory` teaches the agent when to store (preferences, decisions,
environment facts, corrections) and when to recall (`memos_context_pack`
before answering questions that may depend on prior sessions), plus
hygiene rules (supersede instead of duplicating, forget only on request).
