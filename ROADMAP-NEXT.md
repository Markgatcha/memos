# Next 36 improvements

An audit of the repo as of **2026-10-31**, cross-checked against the current
MCP specification, OpenTelemetry GenAI conventions, and the 2026 memory-SDK
market. Every item names the evidence that motivated it, so this is a backlog,
not a wishlist.

**How this was produced**

- Repo: 78 source files, 93 test suites, 30 docs pages, 59 CLI commands,
  33 MCP tools, 8 CI workflows, no uncommitted audit assumptions.
- Web: MCP `2026-07-28` changelog, OTel GenAI memory conventions,
  memory-SDK comparisons (Mem0/Zep/Supermemory/Cognee), docs-as-product
  guidance.

Effort: **S** ≤ half a day, **M** 1–3 days, **L** ≥ a week.
Impact: **★★★** user-visible differentiator, **★★** quality/trust,
**★** hygiene.

---

> **Round 2 is out:** [`ROADMAP-NEXT-2.md`](ROADMAP-NEXT-2.md) — 32 more
> items from the live site, the universal-mcp-toolkit repo, and the
> October 2026 product landscape.

## Status (2026-10-31)

- **Shipped:** #1 (HTTP bearer auth + loopback default), #6 (SDK 2.4.0,
  `server/discover` verified), #25 (generated `llms.txt`, 29 pages), #26
  (60-second ingestion tutorial), #35 (website sync now includes ConvoMem),
  #36 (benchmarks page renders from artifacts; the unreproducible 83.2% LoCoMo
  claim is now qualified).
- **Already shipped before the audit:** #7 (cache hints on `tools/list`) and
  #32 (Streamable HTTP transport) — verified, not missing.
- **Tested, partial:** #18. Three variants: bge-small +0.9pp, adjacent-turn
  grouping +1.1pp with worse MRR, contextual + previous-turn header **+1.7pp
  (65.8% Hit@10)**. Multi-hop evidence recall stays ~29%, so the gap is
  evidence aggregation, not chunking.
- **Done:** #21 (independent judge GLM-5.3 also scores 78.0%, matching the
  self-judged run).

---

## Security and correctness

### 1. Authenticate the Python HTTP server
**Evidence:** `memos/server/main.py` adds CORS only (line 285); no API-key
middleware. The server binds `0.0.0.0` by default and now exposes
`POST /api/mem/ingest`, which reads server-local files.
**Do:** require `Authorization: Bearer $MEMOS_API_KEY` when the env var is set;
bind `127.0.0.1` unless `MEMOS_HOST` is explicitly set; document the change.
**Effort:** S · **Impact:** ★★★ (security)

### 2. Rate-limit and cap request bodies
**Evidence:** no rate limiting in `memos/server/routes.py`; `IngestRequest`
accepts an arbitrary directory; `chunk_chars` is bounded but there is no limit
on files per call.
**Do:** per-IP token bucket, `MAX_INGEST_FILES`, and a 10 MB default cap with
clear 429/413 responses.
**Effort:** S · **Impact:** ★★

### 3. Symlink-escape tests for ingest
**Evidence:** `_safe_ingest_path` uses `realpath` + `commonpath`, but there is
no test for a symlink pointing outside the root.
**Do:** add a POSIX-only test (Windows symlinks need privileges) and a Windows
junction equivalent if feasible.
**Effort:** S · **Impact:** ★★

### 4. Surface ingestion screening in results
**Evidence:** `IngestResult` counts `added/updated/...` but not chunks the
write-gate quarantined. Ingested web pages are the most likely prompt-injection
vector.
**Do:** add `quarantined` to the result, expose it in CLI/HTTP/MCP, and a
`--skip-screen` flag for trusted corpora.
**Effort:** S · **Impact:** ★★

### 5. Key rotation for the encrypted store and sync bundles
**Evidence:** `memos encrypt` / `sync.ts` derive keys from a passphrase; there is
no rotation command or `key_version` metadata.
**Do:** `memos rotate-key`, re-encrypt in place, and record `keyVersion` in the
bundle header.
**Effort:** M · **Impact:** ★★

---

## MCP and integrations

### 6. Move to the MCP 2026-07-28 specification
**Evidence:** `@modelcontextprotocol/server@2.3.0`; the 2026-07-28 revision is a
breaking change: stateless requests, `server/discover`, MRTR instead of
server-initiated elicitation/sampling, `subscriptions/listen`.
**Do:** upgrade the SDK, implement `server/discover`, verify tool calls carry
protocol version in `_meta`, and test against two clients.
**Effort:** L · **Impact:** ★★★ (compatibility)
**Source:** modelcontextprotocol.io/specification/2026-07-28/changelog

### 7. Add cache hints and deterministic tool order
**Evidence:** the spec now requires `ttlMs` + `cacheScope` on list results and
deterministic `tools/list` order; our `TOOL_METADATA` order is stable but we do
not emit cache hints.
**Do:** emit `ttlMs`/`cacheScope`, keep alphabetical or fixed order, and add a
test that fails on reordering.
**Effort:** S · **Impact:** ★★ (prompt-cache hit rate)

### 8. OpenTelemetry GenAI memory spans
**Evidence:** OTel now defines `gen_ai.operation.name` values `create_memory`,
`search_memory`, `update_memory`, `delete_memory` plus `gen_ai.memory.*`
attributes. We have no tracing.
**Do:** opt-in OTLP exporter; span per store/search/pack with store id, record
count, and query text behind content-capture opt-in; propagate `traceparent`
through MCP `_meta`.
**Effort:** M · **Impact:** ★★★ (production adoption)
**Source:** github.com/open-telemetry/semantic-conventions-genai

### 9. Preference tools on every surface
**Evidence:** `capturePreferences` / `searchPreferences` exist in the TS SDK,
but `src/mcp.ts` has zero references and the Python API has no endpoint.
**Do:** `memos_preferences` MCP tool, `POST /api/mem/preferences/capture` and
`GET /api/mem/preferences/search`.
**Effort:** S · **Impact:** ★★ (parity)

### 10. Editor integrations beyond Claude
**Evidence:** `.claude-plugin/marketplace.json` exists; Supermemory ships
plugins for Claude Code, Cursor, Windsurf, VS Code and OpenCode.
**Do:** add Cursor/Windsurf/VS Code MCP manifests and a one-line installer.
**Effort:** M · **Impact:** ★★★ (distribution)

### 11. Framework wrappers for JS agents
**Evidence:** exports are `./openai`, `./anthropic`, `./vercel`; 2026 comparisons
list LangGraph, Mastra, Agno, OpenAI Agents SDK as table stakes.
**Do:** add `./langgraph`, `./mastra`, `./agno` thin adapters with examples.
**Effort:** M · **Impact:** ★★★

### 12. Connectors: GitHub + export-folder imports
**Evidence:** Supermemory ingests Drive, Gmail, Notion, OneDrive and GitHub. We
have folder ingestion but no source connectors.
**Do:** start without OAuth: GitHub repo/issues via token, Notion export ZIP,
Drive takeout folder. Each becomes `ingestPath` with a manifest.
**Effort:** L · **Impact:** ★★★ (biggest competitive gap)

### 13. Agent onboarding scaffolding
**Evidence:** docs explain MCP setup, but there is no generated `AGENTS.md` /
`CLAUDE.md` snippet describing the memory conventions (when to store, when to
search, trust floor).
**Do:** `memos init --agent` writes a short, tool-aware instructions block.
**Effort:** S · **Impact:** ★★

---

## Ingestion and retrieval quality

### 14. OCR for scanned PDFs
**Evidence:** PDF text comes from `unpdf` only; image-only PDFs yield empty
chunks (`ingest.ts`). No OCR dependency exists.
**Do:** optional `tesseract.js` fallback when extracted text is < 40 chars/page,
reported in the ingest result.
**Effort:** M · **Impact:** ★★

### 15. Markdown-aware chunking
**Evidence:** `chunkText` splits on paragraphs and character count; it does not
keep fenced code blocks or tables intact, and headings are not used as
boundaries.
**Do:** heading-aware splitter with code-fence protection and a per-chunk
heading path in metadata.
**Effort:** M · **Impact:** ★★★ (retrieval quality on docs)

### 16. `.memosignore` and resumable large imports
**Evidence:** `collectFiles` skips fixed directories only; no user excludes and
no resume marker. Re-running a 100k-file tree rehashes everything.
**Do:** gitignore-style `.memosignore`, a manifest of file hashes, and
`--resume`.
**Effort:** M · **Impact:** ★★

### 17. Cross-file chunk deduplication
**Evidence:** identical text in two files produces two memories; only
within-file state is tracked.
**Do:** index `contentHash` and skip duplicate chunks (or link them to both
sources).
**Effort:** S · **Impact:** ★★

### 18. Fix LoCoMo multi-turn evidence
**Evidence:** measured 63.5% Hit@10 / 52.0% all-evidence on cats 1–4; multi-hop
evidence recall is 27.5%. Switching to bge-small changed < 1 point, so the
bottleneck is chunking/scoring, not embeddings.
**Do:** index overlapping session windows (radius 1) for LoCoMo and score
evidence spans after aggregating adjacent turns; rerun.
**Effort:** M · **Impact:** ★★★ (benchmark credibility)

### 19. Preference answer policy
**Evidence:** 13.3% on the preference subset with and without preference
capture; those answers grade reply style ("suggest resources tailored to
Premiere Pro"), not recall.
**Do:** when `isPreferenceQuestion`, add a short answer-policy instruction
derived from stored preferences; measure with the same harness.
**Effort:** S · **Impact:** ★★

### 20. ANN by default above a size threshold
**Evidence:** `sqlite-vec` is optional and `semanticScan` defaults to exact
scan. Exact scan is fine at 3k nodes and will not be at 1M.
**Do:** auto-enable ANN when the namespace exceeds N nodes, with fallback and a
latency benchmark at 100k.
**Effort:** M · **Impact:** ★★★ (scale)

---

## Evaluation

### 21. Neutral-judge QA run
**Evidence:** the 78% end-to-end number is DeepSeek judging DeepSeek. Vendor
numbers use gpt-4o/gpt-5.
**Do:** run 100+ LongMemEval questions with a neutral judge, publish both
numbers with the judge named, keep the response cache.
**Effort:** M · **Impact:** ★★★ (credibility)

### 22. Benchmark smoke in CI
**Evidence:** `ci.yml` has no benchmark job; regressions in retrieval would only
show up manually.
**Do:** 10-question LME retrieval + 1 LoCoMo conversation on PRs, fail on >2pp
drop against a committed baseline.
**Effort:** S · **Impact:** ★★★

### 23. Add PersonaMem and MemoryAgentBench harnesses
**Evidence:** repo covers LME, LoCoMo, ConvoMem, BEAM; 2026 comparisons also
cite PersonaMem (multiple-choice) and MemoryAgentBench (incremental).
**Do:** retrieval/QA harnesses following `benchmarks/README.md` conventions.
**Effort:** L · **Impact:** ★★

### 24. Publish BEAM numbers
**Evidence:** `scripts/bench-beam.ts` exists but no result is in
`benchmarks/README.md`.
**Do:** run and document, including the 1M/10M tiers.
**Effort:** S · **Impact:** ★★

---

## Documentation and developer experience

### 25. Generate a real `llms.txt`
**Evidence:** `llms.txt` is 34 lines, while docs contain 30 pages. Agents read
`llms.txt` before crawling.
**Do:** generate it from `mkdocs.yml` nav with one-line summaries and links.
**Effort:** S · **Impact:** ★★★ (AI discoverability)

### 26. "Ingest your notes in 60 seconds" tutorial
**Evidence:** `docs/ingestion.md` documents flags but has no end-to-end
walkthrough with expected output.
**Do:** a single page: install → `memos ingest ./notes` → search → verify.
**Effort:** S · **Impact:** ★★★

### 27. Generate the HTTP API reference from OpenAPI
**Evidence:** `docs/api-reference.md` is hand-written; FastAPI already serves
`/openapi.json`, so it can drift.
**Do:** generate the endpoint tables at docs build time and fail CI on drift.
**Effort:** M · **Impact:** ★★

### 28. Validate docs and website builds on PRs
**Evidence:** `deploy-website.yml` builds only on push to `main` under
`website/**`; the mkdocs docs build (readthedocs) is not exercised on PRs at
all.
**Do:** a PR job running `mkdocs build --strict`, `website` typecheck/build,
and a link check on changed pages.
**Effort:** S · **Impact:** ★★

### 29. Dashboard: ingestion and benchmark panels
**Evidence:** `dashboard.ts` serves a local UI for memories; ingestion status
and benchmark numbers are invisible.
**Do:** show last ingest per namespace, chunk counts, screening results, and the
latest benchmark table.
**Effort:** M · **Impact:** ★★

---

## Release and operations

### 30. `py.typed` plus type checking
**Evidence:** no `py.typed` anywhere in `memos/`; downstream mypy treats the
package as untyped.
**Do:** add `py.typed`, ship it in the wheel, and run mypy/pyright in CI.
**Effort:** S · **Impact:** ★★

### 31. Changesets and CODEOWNERS
**Evidence:** no `.changeset/` and no `CODEOWNERS`; version is still `1.6.27`
after a large unreleased batch.
**Do:** adopt changesets, require a changeset on PRs, add CODEOWNERS.
**Effort:** S · **Impact:** ★★

### 32. Streamable HTTP transport for the MCP server
**Evidence:** `src/mcp.ts` runs over stdio only (the transport comment at
line 2481 is the sole reference); the 2026-07-28 spec centers stateless HTTP
with `Mcp-Method`/`Mcp-Name` headers and cacheable list results.
**Do:** `memos mcp --http --port`, bearer auth, the spec headers, and an
integration test with a real client.
**Effort:** M · **Impact:** ★★★ (remote/hosted use)

### 33. Versioned schema migrations
**Evidence:** `sqlite.ts` migrates with ad-hoc `migrateAddColumn` calls and no
`PRAGMA user_version`.
**Do:** a migration registry keyed by `user_version`, with forward-only
migrations and a dry-run.
**Effort:** M · **Impact:** ★★★ (upgrade safety)

### 34. Scheduled backups with retention
**Evidence:** `memos backup` is manual; no retention policy or scheduler
guidance.
**Do:** `memos backup --keep 7` plus documented cron/Task Scheduler recipes.
**Effort:** S · **Impact:** ★★

### 35. Sync the website's benchmark data with the current artifacts
**Evidence:** `website/data/benchmarks.json` still carries the 2026-09-06
LoCoMo run and has no ConvoMem entry, while `scripts/bench-*-results.json` now
hold the 2026-10-30 runs (LoCoMo model2vec + bge, ConvoMem, preferences).
**Do:** extend `website/scripts/sync-benchmarks.mjs` with ConvoMem and the
preference QA result, rerun it, and let the page show the new provenance.
**Effort:** S · **Impact:** ★★★ (credibility)

### 36. Audit comparison and blog pages against current numbers
**Evidence:** `website/app/compare/*` and
`website/app/blogs/beating-supermemory-longmemeval` predate the retrieval-only
methodology and the 2026-10-29 leaderboard update (nine entries, OPS at
81.37%).
**Do:** re-read every numeric claim, link each to its artifact, and remove or
qualify anything that is not reproducible.
**Effort:** S · **Impact:** ★★★ (trust)

---

## Suggested order

1. **#1, #2** — the server is now a file-reading endpoint; close that first.
2. **#6, #7** — MCP compatibility is a moving target and cheap to stay ahead of.
3. **#25, #26** — make the new ingestion feature discoverable.
4. **#18, #21** — the two numbers a sceptic will ask about.
5. **#35, #36** — the website currently publishes stale benchmark data and
   comparison claims; fix before promoting it.
6. **#10, #11, #12** — distribution; the gap to Supermemory is plugins and
   connectors, not retrieval.

## Sources

- MCP 2026-07-28 changelog — <https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- OTel GenAI memory conventions — <https://github.com/open-telemetry/semantic-conventions-genai>
- Agent memory SDK comparison (2026) — <https://www.opensourceaireview.com/blog/agent-memory-sdk-comparison-2026>
- Memory API comparison, connectors and pricing — <https://membase.com/blog/best-memory-apis-for-ai-agents>
- Docs for OSS projects — <https://www.getpagemark.com/blog/docs-for-open-source-projects>
- LLM-first documentation — <https://github.com/fra00/llm-first-documentation>
