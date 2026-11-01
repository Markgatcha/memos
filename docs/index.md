# MemOS documentation

MemOS is a local-first memory layer for AI agents. It stores facts,
preferences, decisions, and ingested documents in a single SQLite file, then
recalls them through a TypeScript SDK, a CLI, an MCP server, or an HTTP API.

There is no account, no hosted control plane, and no API key in the core path.

## Choose your path

| If you want to... | Start here |
| --- | --- |
| Put memory behind an agent in five minutes | [Installation](installation.md) |
| Point MemOS at a folder of notes | [Ingest your notes in 60 seconds](quickstart-ingest.md) |
| Wire it into Claude Code, Cursor, Codex, Hermes, Kilo, or another harness | [Harness matrix](harness-matrix.md) |
| Understand nodes, trust, time, packs, and deletion | [Memory model](concepts.md) |
| Look up an exact command, tool, or route | [CLI reference](reference/cli.md) · [MCP tools](reference/mcp-tools.md) · [HTTP API](reference/http-api.md) |
| Run it on a server | [Remote MCP and OAuth](remote-mcp.md) |
| Operate a store over time | [Operations](operations.md) |

## The four surfaces

| Surface | Use it for | Start |
| --- | --- | --- |
| TypeScript SDK | Embed memory in a Node or Bun app | `npm install @mem-os/sdk` |
| CLI | Local work, scripts, maintenance | `npx @mem-os/sdk --help` |
| MCP server | Any MCP-capable coding agent | `npx -y @mem-os/sdk mcp` |
| HTTP API | Python, Dify, n8n, or a shared service | `python -m memos.server.main` |

All four read and write the same SQLite database. `MEMOS_DB_PATH` selects the
file; `MEMOS_NAMESPACE` selects the default namespace.

## What the docs cover

- **Concepts:** the memory graph, provenance, temporal validity, retrieval,
  context packs, procedural lessons, review, knowledge pages, and proof of
  forgetting.
- **Guides:** installation, ingestion, preferences, cross-harness sync, UMT,
  Guardian, remote deployment, troubleshooting.
- **Reference:** every CLI command, every MCP tool, and every HTTP route,
  generated from the source. See [coverage](coverage.md) for the current map.

## A note on claims

Benchmark numbers on this site come from checked-in artifacts. Where a result
is not reproducible, the docs say so and link to the artifact that does exist.
Start with [Benchmark results in plain English](benchmark-results.md) if you
want the short version.

## Repository

- Source: <https://github.com/Markgatcha/memos>
- Issues: <https://github.com/Markgatcha/memos/issues>
- Changelog: <https://context-core.dev/changelog>
- Install contract for agents:
  <https://github.com/Markgatcha/memos/blob/main/llms-install.md>
