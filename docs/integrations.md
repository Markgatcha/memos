# MemOS in any agentic harness

MemOS ships as a **plain stdio MCP server** — the one integration surface
that Claude Code, Cursor, Windsurf, Cline, OpenCode, Codex CLI, Gemini CLI,
and every other MCP-capable harness already speak. One command, all 14
tools, all data in local SQLite.

```
npx -y @mem-os/sdk mcp
```

The server speaks MCP `2026-07-28` (with a legacy-2025 handshake fallback)
and starts with `semanticSearch`, `namespaces` and context injection
enabled. Registration is one line everywhere:

| Harness | Command / file |
|---|---|
| **Claude Code** | `claude mcp add memos -s user -- npx -y @mem-os/sdk mcp` — or `memos connect claude-code --write` to check a project `.mcp.json` into the repo — or install as a plugin (below) |
| **Cursor** | `memos connect cursor --write` → writes `~/.cursor/mcp.json` |
| **Windsurf** | `memos connect windsurf --write` → writes `~/.codeium/windsurf/mcp_config.json` |
| **Cline** | merge the `mcpServers` entry into Cline's MCP settings JSON |
| **OpenCode** | `memos connect opencode --write` → writes `./opencode.json` |
| **Codex CLI** | `memos connect codex --write` → appends to `~/.codex/config.toml` |
| **Gemini CLI** | `memos connect gemini --write` → writes `~/.gemini/settings.json` |
| **Anything else** | `memos connect generic` — prints the `mcpServers` JSON shape |

`memos connect <target>` always *prints* the exact config first; add
`--write` to write the file (add `--force` to overwrite). A custom store
location travels as `--db <path>` / `MEMOS_DB_PATH`; embedding settings
travel as `MEMOS_EMBEDDING_*` env vars and are forwarded into the config
entry automatically.

## `memos doctor`

One command health-check for the whole stack — run it before blaming
retrieval:

```bash
memos doctor
```

It reports: store counts and DB size, per-model embedding counts (mixed
models mean the semantic leg is only seeing a subset), partial embedding
coverage (→ `memos reindex-embeddings`), whether the configured embedding
endpoint is reachable, a live semantic-search probe, and rerank endpoint
health when `MEMOS_RERANK_URL` is set. `--json` emits the full report.

## Token budget

The MCP server is token-lean by default:

- `memos_context_pack` serializes as **toon-compact** (~70% fewer tokens
  than JSON, identical information). Pass `format: "json"` for
  human-readable output.
- `memos_search` accepts **`compact: true`** — trimmed results
  (id, content, score, type, tags) instead of full node objects.
- Context packs additionally elide summaries that restate their content
  and can drop paraphrase duplicates (`semanticDedup: true`).

## Memory tuning

The SQLite adapter keeps parsed vectors in an in-process cache (default
25,000 vectors ≈ 100MB at 1024 dims) so repeat queries skip the BLOB
fetches entirely. Constrain it on memory-tight hosts:

```json
{ "storageOptions": { "vectorCacheEntries": 5000 } }
```

## Claude Code plugin

This repo is also a **Claude Code plugin marketplace**. Inside Claude Code:

```
/plugin marketplace add Markgatcha/memos
/plugin install memos@memos-marketplace
```

The plugin bundles:

- the **MCP server** (`.mcp.json` — the same `npx -y @mem-os/sdk mcp`
  stdio server; tools appear as `mcp__memos__*`),
- `/memos` and `/recall` **slash commands** (status + token-budgeted
  recall),
- the **memos-memory skill** that teaches the agent when to store durable
  facts, when to recall before answering, and how to supersede outdated
  memories instead of duplicating them.

Prefer no plugin? `claude mcp add` gives you the same server without the
commands and skill.

## Full capability surface (14 MCP tools)

| Tool | What it does |
|---|---|
| `memos_store` | Persist a durable memory (type, tags, TTL, namespace) |
| `memos_search` | Hybrid FTS + semantic search with RRF fusion |
| `memos_retrieve` / `memos_forget` | Fetch or delete one memory by ID |
| `memos_graph` | Full node + edge graph |
| `memos_context` | Graph-neighbour context around one memory |
| `memos_context_pack` | **Token-budgeted, relevance-ranked slice for prompt injection** (TOON / TOON-compact output, semantic dedup) |
| `memos_search_temporal` | Query memories valid at a past point in time |
| `memos_set_validity` / `memos_supersede` | Time-window a fact, mark it historical, link its replacement |
| `memos_set_trust` | Weight a memory's trust (affects hybrid ranking) |
| `memos_extract_facts` | Local rule-based fact extraction from conversation messages |
| `memos_diagnostics` | Coverage / counts / embedding health report |
| `memos_reindex` | Re-embed the whole store after a model switch |

## Optional: real embeddings

Out of the box the MCP server uses the deterministic local-hash embedder
(zero deps). To run the Liquid LFM2.5-Embedding-350M model locally through
llama.cpp (see `docs/benchmark-comparison.md` for the full recipe):

```bash
llama-server -m LFM2.5-Embedding-350M-BF16.gguf --embedding \
  -c 2048 -b 2048 -ub 1024 --parallel 4 -ngl 99 -fa on --port 8080
```

```bash
export MEMOS_EMBEDDING_PROVIDER=openai-compatible
export MEMOS_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
export MEMOS_EMBEDDING_MODEL=LFM2.5-Embedding-350M-BF16
export MEMOS_EMBEDDING_DIMENSIONS=1024
export MEMOS_EMBEDDING_QUERY_PREFIX="query: "
export MEMOS_EMBEDDING_DOCUMENT_PREFIX="document: "
```

Then restart the harness. Existing memories keep working; new and updated
ones get 1024-d vectors. To rebuild vectors for everything, run
`memos reindex-embeddings --purge-stale` against the same database.
