# MemOS Roadmap

Public milestone plan. Each phase has a clear scope, success criteria, and a target timeline based on community adoption.

---

## Phase 1 — Core Engine (v0.1) ✅ Current

**Goal:** A working, installable memory layer that any developer can use in 5 minutes.

### Deliverables

- [x] TypeScript SDK with `MemOS` class (store, retrieve, search, forget, summarize, link)
- [x] Graph-based memory model (nodes + typed edges + metadata)
- [x] SQLite storage backend with WAL mode and FTS5 full-text search
- [x] Auto-linking via bag-of-words text similarity
- [x] Extractive summarisation (fully local, no API calls)
- [x] Python HTTP server (FastAPI) with full REST API
- [x] CLI tool (`memos` command)
- [x] Ollama adapter (Python)
- [x] LangChain adapter (Python)
- [x] Docker Compose deployment
- [x] GitHub Actions CI (lint + test + typecheck)
- [x] Comprehensive documentation (README, CONTRIBUTING, API reference)

### Success criteria

- `npm install @memos/sdk` + 3 lines of code = working memory
- `pip install memos` + `memos-server` = HTTP server running
- All tests passing across Node 18/20/22 and Python 3.10-3.13
- Zero external dependencies for core functionality

---

## Phase 2 — Semantic Search & Export (v0.2)

**Goal:** Make memory retrieval smarter and enable knowledge base integration.

### Deliverables

- [ ] Embedding-based similarity search (local models via `@xenova/transformers`)
- [ ] Configurable embedding model (swap between local and API-based)
- [ ] Obsidian / Markdown export (`memos export --format obsidian`)
- [ ] Memory expiration (TTL) with automatic cleanup
- [ ] Memory tagging system (custom tags beyond `type`)
- [ ] Grafana-compatible metrics endpoint
- [ ] Performance benchmarks (10K, 100K, 1M memories)
- [ ] Backup / restore CLI commands

### Success criteria

- Semantic search returns better results than FTS5 for conceptual queries
- Obsidian export produces linked markdown files with bidirectional links
- <10ms search latency at 100K memories on consumer hardware

---

## Phase 3 — Multi-User & Plugin System (v0.3)

**Goal:** Enable production deployments with multiple users and custom backends.

### Deliverables

- [ ] Multi-user isolation (namespace per user/agent)
- [ ] Role-based access control (read/write/admin)
- [ ] Plugin system for custom storage adapters
- [ ] PostgreSQL storage backend
- [ ] Redis storage backend (hot cache layer)
- [ ] Qdrant storage backend (vector search)
- [ ] Memory access audit log
- [ ] Rate limiting per user
- [ ] WebSocket API for real-time memory updates
- [ ] CrewAI adapter
- [ ] Vercel AI SDK adapter

### Success criteria

- Multiple users can use the same MemOS server without data leakage
- Plugin authors can implement a storage backend in <100 lines
- PostgreSQL backend passes the same test suite as SQLite

---

## Phase 4 — Production Hardening (v1.0)

**Goal:** A battle-tested memory layer ready for production AI applications.

### Deliverables

- [ ] Stable public API (no breaking changes until v2.0)
- [ ] Comprehensive test suite (90%+ coverage)
- [ ] Load testing and performance tuning
- [ ] Memory compression (deduplication, merging near-duplicates)
- [ ] Conflict resolution for concurrent writes
- [ ] Schema migration system
- [ ] Admin dashboard (web UI)
- [ ] Kubernetes Helm chart
- [ ] Cloudflare Workers adapter (edge deployment)
- [ ] Comprehensive architecture documentation
- [ ] Security audit

### Success criteria

- 99.9% uptime in production deployments
- <5ms p99 latency for single-node reads
- Full backward compatibility for all 0.x APIs
- Published security best practices guide

---

## Community milestones

| Milestone | Target |
|-----------|--------|
| 100 GitHub stars | Week 1 |
| 500 stars | Month 1 |
| 2,000 stars | Month 2 |
| 5,000 stars | Month 3 |
| First community adapter merged | Month 1 |
| First blog post from a user | Month 2 |
| First production deployment story | Month 3 |

---

## How to influence the roadmap

1. **Star the repo** — signals demand, attracts contributors
2. **Open an issue** — feature requests, bug reports, use cases
3. **Start a discussion** — architecture proposals, integration ideas
4. **Submit a PR** — code speaks louder than issues
5. **Share your usage** — blog posts, tweets, conference talks

The roadmap is a living document. If your use case isn't covered, open an issue and let's talk.
