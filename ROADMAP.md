# MemOS Roadmap

Public milestone plan. Each phase has a clear scope, success criteria, and a target timeline based on community adoption.

---

## Phase 1 — Core Engine (v0.1) ✅ Released

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

## Phase 2 — Semantic Search & Export (v0.2 → shipped in v1.6.26) ✅ Released

**Goal:** Make memory retrieval smarter and enable knowledge base integration.

### Deliverables

- [x] Embedding-based similarity search (local models via `@xenova/transformers`)
- [x] Configurable embedding model (swap between local and API-based)
- [x] Obsidian / Markdown export (`memos export --format obsidian`)
- [x] Memory expiration (TTL) with automatic cleanup
- [x] Memory tagging system (custom tags beyond `type`)
- [x] Grafana-compatible metrics endpoint
- [x] Performance benchmarks (10K, 100K, 1M memories)
- [x] Backup / restore CLI commands

### Success criteria

- Semantic search returns better results than FTS5 for conceptual queries
- Obsidian export produces linked markdown files with bidirectional links
- <10ms search latency at 100K memories on consumer hardware

---

## Phase 3 — Multi-User & Plugin System (v0.3 → core adapters shipped in v1.6.26; backends/RBAC pending) 🚧 In progress

**Goal:** Enable production deployments with multiple users and custom backends.

### Deliverables

- [x] Multi-user isolation (namespace per user/agent)
- [ ] Role-based access control (read/write/admin)
- [ ] Plugin system for custom storage adapters
- [ ] PostgreSQL storage backend
- [ ] Redis storage backend (hot cache layer)
- [ ] Qdrant storage backend (vector search)
- [x] Memory access audit log
- [x] Rate limiting per user
- [x] WebSocket API for real-time memory updates
- [x] CrewAI adapter
- [x] Vercel AI SDK adapter

### Success criteria

- Multiple users can use the same MemOS server without data leakage
- Plugin authors can implement a storage backend in <100 lines
- PostgreSQL backend passes the same test suite as SQLite

---

## Phase 4 — Production Hardening (v1.0 → partial: consolidation, semantic search, trust scoring shipped in v1.6.26; infra pending) 🚧 In progress

**Goal:** A battle-tested memory layer ready for production AI applications.

### Deliverables

- [ ] Stable public API (no breaking changes until v2.0)
- [ ] Comprehensive test suite (90%+ coverage)
- [ ] Load testing and performance tuning
- [x] Memory compression (deduplication, merging near-duplicates)
- [x] Conflict resolution for concurrent writes
- [x] Schema migration system
- [ ] Admin dashboard (web UI)
- [ ] Kubernetes Helm chart
- [ ] Cloudflare Workers adapter (edge deployment)
- [x] Comprehensive architecture documentation
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
