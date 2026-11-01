# Listing copy

## Name

MemOS

## Tagline (60 chars)

Local-first memory for AI agents. SQLite, no cloud.

## Short description (100 words)

MemOS gives any LLM a persistent memory that survives restarts without sending
data to a server. It stores facts, preferences, decisions, and ingested
documents in a single SQLite file, then recalls them with hybrid keyword and
semantic search, trust scoring, temporal validity, and citation-ready context
packs. It ships as a TypeScript SDK, a CLI, a Python HTTP server, and an MCP
server that works with Claude Code, Cursor, Windsurf, Cline, OpenCode, Codex,
and Gemini CLI. MIT licensed, no account, no API key, and no telemetry.

## Long description

Most agent memory is a hosted database with a monthly bill. MemOS is the
opposite: a local engine with a small surface area.

- **One file.** Every memory, edge, and supersede record lives in
  `~/.memos/memos.db`. Back it up with `cp`; delete it with `rm`.
- **Hybrid recall.** Keyword and embedding legs fuse with reciprocal rank
  fusion, then trust, recency, and outcome feedback adjust the ranking.
- **Provenance and time.** Memories carry a source tier, a trust score, and
  `validFrom`/`validTo` bounds, so corrections keep their history instead of
  overwriting it.
- **Token-budgeted packs.** `contextPack()` returns a citable slice that fits a
  budget, in JSON or compact TOON.
- **Agent-native.** 40 MCP tools, a `session-start` profile, procedural
  lessons, a review queue for inferred writes, and source-scoped deletion with
  proof-of-forgetting certificates.
- **No lock-in.** MIT license, no hosted control plane, no account.

## Categories

Primary: Developer Tools · AI / Machine Learning
Secondary: Databases · Productivity · Open Source

## Links

- Website: https://context-core.dev/memos
- Source: https://github.com/Markgatcha/memos
- npm: https://www.npmjs.com/package/@mem-os/sdk
- Docs: https://memos.readthedocs.io
- Changelog: https://context-core.dev/changelog
- Install contract: https://github.com/Markgatcha/memos/blob/main/llms-install.md
- Privacy: https://context-core.dev/privacy
- Terms: https://context-core.dev/terms
- Security: https://context-core.dev/security

## Pricing

Free. MIT licensed. No paid tier, no hosted plan, no usage metering.

## Platforms

macOS, Linux, and Windows. Node.js 20 or newer. Optional Python 3.10+ for the
HTTP server.

## What makes it different

Local-first is the product, not a deployment option. The same engine that
answers a query also proves a deletion, explains a ranking, and reports what
the store knows at session start — all without a network call.
