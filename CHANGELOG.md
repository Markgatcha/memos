# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0-beta.1] - 2026-03-24

### Added

#### Stable Features

- **Memory TTL / Expiration** (STABLE-1)
  - Optional `ttl` field (seconds) on memory creation
  - `expires_at` stored as Unix timestamp in SQLite
  - Background sweep every 60 seconds, deletes expired nodes and orphaned edges
  - `memos.setTTL(id, seconds)` and `memos.clearTTL(id)` SDK methods
  - `--ttl <seconds>` flag on `memos store` CLI command
  - `PATCH /api/mem/{id}/ttl` and `DELETE /api/mem/{id}/ttl` REST endpoints
  - Python `memos-server backup` and `memos-server restore` CLI subcommands
  - Migration-safe column addition (checks column existence before ALTER TABLE)

- **Custom Memory Tags** (STABLE-2)
  - `tags` field (string array) on MemoryNode, stored as JSON in SQLite
  - `memos.tag(id, tags)`, `memos.untag(id, tags)`, `memos.listByTag(tag)` SDK methods
  - Tags filter on `search()` and `retrieve()` with AND logic
  - `memos tag <id> <tag1> [tag2...]`, `memos untag`, `memos list --tag <tag>` CLI commands
  - `POST /api/mem/{id}/tags`, `DELETE /api/mem/{id}/tags/{tag}`, `GET /api/mem/tags/{tag}` REST endpoints

- **Export Command** (STABLE-3)
  - `memos export` CLI command with `--format json|markdown|obsidian`
  - `--output <dir>` and `--tag <tag>` flags
  - JSON: single array file; Markdown: one .md per memory with YAML frontmatter
  - Obsidian format: linked memories become `[[wikilinks]]`
  - `memos.export(options)` SDK method
  - `GET /api/mem/export?format=...` REST endpoint (returns zip for markdown/obsidian)

- **Backup and Restore** (STABLE-4)
  - `memos backup [--output <path>]` copies DB with manifest.json
  - `memos restore <path>` validates manifest, replaces DB
  - Manifest includes: timestamp, version, nodeCount, edgeCount, dbSizeBytes
  - Python `memos-server backup` and `memos-server restore` CLI subcommands
  - Cross-platform path handling via Node `path` module

- **Performance Benchmark** (STABLE-5)
  - `scripts/bench.ts` ESM TypeScript benchmark script
  - Tests insert 1K / 10K / 100K nodes with inline lorem-ipsum content
  - Measures p50/p95/p99 latency for: store, retrieveById, FTS5 search, getNeighbours
  - Outputs table to stdout and writes `scripts/bench-results.json`
  - `tsx` added to devDependencies; `npm run bench` script

- **CHANGELOG** (STABLE-6)
  - This changelog file following Keep a Changelog 1.1.0

- **MCP Adapter** (STABLE-7)
  - `memos mcp` starts a stdio MCP server backed by the configured local SQLite database
  - Exposes `memos_store`, `memos_search`, `memos_retrieve`, `memos_forget`, `memos_graph`, and `memos_context`
  - Exported as `@mem-os/sdk/mcp` for programmatic hosts
  - Designed for direct use from `universal-mcp-toolkit` and other MCP-compatible clients

#### Experimental Features

All experimental features gated behind `experimental` config object:

- **Semantic Search** (EXPERIMENTAL-1)
  - `memos.semanticSearch(query, limit, threshold)` — bag-of-words similarity search
  - Enable with `experimental: { semanticSearch: true }`
  - `RPC: semanticSearch` in bridge

- **Graph Visualization** (EXPERIMENTAL-2)
  - `memos.graphViz()` — returns DOT-format graph string
  - Enable with `experimental: { graphViz: true }`
  - `RPC: graphViz` in bridge

- **Namespaces** (EXPERIMENTAL-3)
  - `namespace` field on MemoryNode for logical grouping
  - `memos.listNamespaces()`, `memos.namespaceCount(ns)` SDK methods
  - Namespace filter on `search()`
  - Enable with `experimental: { namespaces: true }`

- **Context Injection** (EXPERIMENTAL-4)
  - `memos.injectContext(id, depth, maxChars)` — walks graph to gather related context
  - Enable with `experimental: { contextInjection: true }`
  - `RPC: injectContext` in bridge

### Changed

- `MemoryNode` interface extended with `tags`, `expiresAt`, `namespace` fields
- `CreateMemoryInput` extended with `ttl`, `tags`, `namespace` options
- `SearchFilter` extended with `tags` and `namespace` filters
- `StorageAdapter` interface extended with `setTTL`, `clearTTL`, `sweepExpired`, `queryNodesByTag`
- `MemOSConfig` extended with `sweepInterval` and `experimental` options
- `MemOSEvent` union extended with `ttl:expired`
- CLI help text updated with all new commands
- Python server version bumped to 1.5.0-beta.1
- Node.js bridge script extended with all new RPC methods

### Fixed

- SQLite migration now uses `PRAGMA table_info` check instead of `IF NOT EXISTS` on ALTER TABLE (SQLite limitation)
- Directory creation in SQLiteStorage uses `path.dirname` for cross-platform compatibility

## [0.1.0] - 2026-03-22

### Added

- TypeScript SDK with `MemOS` class (store, retrieve, search, forget, summarize, link)
- Graph-based memory model with typed nodes, edges, and metadata
- SQLite storage backend with WAL mode and FTS5 full-text search
- Auto-linking via bag-of-words text similarity
- Extractive summarisation (fully local, no API calls)
- LRU eviction with configurable `maxMemories`
- Event system (node:created, node:updated, node:deleted, edge:created, edge:deleted, link:auto, eviction)
- Custom storage adapter interface (`StorageAdapter`)
- Python HTTP server (FastAPI) on port 7400 with full REST API
- CLI tool (`memos` command): store, retrieve, search, forget, graph, summarize, serve
- Ollama adapter (Python)
- LangChain adapter (Python)
- Docker Compose deployment
- GitHub Actions CI (lint + test + typecheck)
- README, LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY docs

[Unreleased]: https://github.com/Markgatcha/memos/compare/v1.5.0-beta.1...HEAD
[1.5.0-beta.1]: https://github.com/Markgatcha/memos/compare/v0.1.0...v1.5.0-beta.1
[0.1.0]: https://github.com/Markgatcha/memos/releases/tag/v0.1.0
