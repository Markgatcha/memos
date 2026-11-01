# Next 32 improvements — round 2

Second audit, **2026-11-01**. Round 1 (`ROADMAP-NEXT.md`) covered correctness,
MCP, ingestion and the first benchmark pass. This round looks outward: the live
site, the `universal-mcp-toolkit` monorepo, and what competing memory products
shipped in October 2026.

**How this was produced**

- **Computer use:** listed desktop apps and drove Explorer via CUA (no browser
  app was installed for CUA to bind, so page review used the in-app browser).
- **Live site:** `context-core.dev/memos`, `/playground`, `/benchmarks`,
  `/privacy`, `/terms`.
- **Toolkit:** `universal-mcp-toolkit` monorepo (41 server dirs, `plugin/`,
  `manifests/`, `registry-server.json`, CLI/core/router/bridge packages).
- **Web:** MCP registry/marketplace checklists (2026), agent-plugin manifests,
  and October 2026 memory-product changelogs (Databricks MemCurrent, MemHub,
  Retell, past.dev, Hindsight).

Effort: **S** ≤ half a day · **M** 1–3 days · **L** ≥ a week.
Impact: **★★★** differentiator · **★★** quality/trust · **★** hygiene.

---

## Ecosystem and distribution (UMT + plugins)

### 1. Ship MemOS as a `universal-mcp-toolkit` server
**Evidence:** UMT has 41 server directories and one CLI/router; MemOS is absent
from `servers/`. Users of UMT get GitHub, Drive and Slack but no memory.
**Do:** `servers/memos` implementing the UMT `ToolkitServer` contract, wired
into `registry-server.json` and `umt config --server memos`.
**Effort:** M · **Impact:** ★★★ (distribution)

### 2. One repo, several plugin manifests
**Evidence:** MemOS ships `.claude-plugin/` only. Marketplace guidance for 2026
says one repo should carry `.claude-plugin/plugin.json`, `.cursor-plugin/` +
`mcp.json`, and `gemini-extension.json`, sharing one `skills/` directory.
**Do:** add the Cursor and Gemini manifests; keep one skills source.
**Effort:** S · **Impact:** ★★★

### 3. `llms-install.md`
**Evidence:** Cline and several directories install from `llms-install.md`;
MemOS has `llms.txt` (docs map) but no install contract.
**Do:** a short agent-readable install file: prerequisites, `memos connect`
invocations per harness, verification command, rollback.
**Effort:** S · **Impact:** ★★

### 4. Publish to the official MCP registry
**Evidence:** `registry.modelcontextprotocol.io` is the upstream directory that
Glama, mcp.directory and PulseMCP crawl. Listing needs a `server.json` and a
DNS-verified namespace.
**Do:** publish `io.github.markgatcha/memos` (or a domain namespace), then
submit to downstream directories.
**Effort:** S · **Impact:** ★★★

### 5. Add privacy, terms and security pages
**Evidence:** `/privacy`, `/terms` and `/security` all return **404**. The 2026
marketplace checklists treat a privacy-policy URL as an automatic rejection
criterion.
**Do:** three short static pages that match actual behavior (local SQLite, no
telemetry by default, what `MEMOS_API_KEY` protects).
**Effort:** S · **Impact:** ★★★ (blocker for listings)

### 6. Directory submission packet
**Evidence:** reviewers need screenshots, a test plan, reviewer credentials and
five positive / three negative tests; none exist in the repo.
**Do:** `docs/marketplace/` with a test script, screenshots from the current
build, and a listing description written from the user's job.
**Effort:** M · **Impact:** ★★

### 7. UMT router: a `memory` category and defaults
**Evidence:** `packages/router` groups servers by category; memory is not one.
**Do:** add the category, make `memos` the default memory provider, and
document the combination.
**Effort:** S · **Impact:** ★★

### 8. Shared config and auth between UMT and MemOS
**Evidence:** UMT resolves server config centrally; MemOS reads
`~/.memos` and `MEMOS_*`. Two stores mean two setups.
**Do:** let UMT write MemOS config (db path, namespace, token) and reuse its
credential store.
**Effort:** M · **Impact:** ★★

### 9. Cross-tool memory skill
**Evidence:** UMT's `plugin/skills/` has task skills; none persist what a tool
returned. The natural job: "after a GitHub/Drive call that changes a decision,
store it; before the next call, recall it."
**Do:** a `memos-with-umt` skill with concrete store/recall triggers and
namespace conventions.
**Effort:** S · **Impact:** ★★★

### 10. Guardian × MemOS: folded context
**Evidence:** the site's Playground runs Guardian's Semantic Folding engine; it
is not connected to MemOS. Recalled context is the largest prompt component.
**Do:** an option to fold memory packs through Guardian before injection, with
a measured accuracy/token trade-off.
**Effort:** M · **Impact:** ★★★

---

## Product features from the October 2026 scan

### 11. Procedural trigger endpoint
**Evidence:** MemHub ships `POST /v1/memories/trigger` so lessons arrive
*before* the agent acts; Databricks reports the same pattern. MemOS has
`listProceduralLessons` but no trigger.
**Do:** `POST /api/mem/trigger` (and `memos_trigger`) taking entities/task text
and returning relevant procedures plus a reason.
**Effort:** M · **Impact:** ★★★
**Source:** mem.xtrace.ai/changelog, 2026-10-29

### 12. Scheduled "dreaming" consolidation
**Evidence:** Databricks' MemCurrent runs an offline pipeline that merges
duplicates and resolves conflicts; MemOS has `consolidate` as a manual command.
**Do:** `memos dream --schedule daily` with a report (merged, superseded,
conflicts resolved) and a dry-run.
**Effort:** M · **Impact:** ★★★

### 13. Session-start memory index + `memos_overview`
**Evidence:** Databricks loads an index of what is known at session start.
`profile()` returns facts but not "what this store knows" (namespaces, counts,
topics, freshness).
**Do:** `memos_overview` MCP tool and `GET /api/mem/overview`.
**Effort:** S · **Impact:** ★★

### 14. Review queue for inferred memories
**Evidence:** Supermemory lets users approve inferred memories before they are
injected; MemOS writes with no approval step.
**Do:** `pending` state + `memos_review` tools; auto-approve rules per tag.
**Effort:** M · **Impact:** ★★★

### 15. Mental models / knowledge pages
**Evidence:** Hindsight's "mental models and knowledge pages" are living
documents agents read; MemOS has summaries but no user-editable knowledge page.
**Do:** a page = named query + curated facts, re-rendered on read, cited to
memories.
**Effort:** L · **Impact:** ★★

### 16. Delete by source + deletion status
**Evidence:** past.dev added `delete_memory` and `get_memory_deletion` for
source-scoped erasure. MemOS can only forget by node id.
**Do:** `forgetSource(sourceId)`, async deletion record, and MCP/HTTP parity.
**Effort:** M · **Impact:** ★★★ (compliance)

### 17. Per-user memory brief
**Evidence:** Retell keeps a short brief per contact that drops resolved items.
`profile()` is a flat list, not a maintained brief.
**Do:** `memos.brief(subject)` with open/closed items and a rewrite policy.
**Effort:** M · **Impact:** ★★

### 18. `@mem-os/ai-sdk` middleware
**Evidence:** past.dev ships `pastRecallMiddleware()` for the Vercel AI SDK.
MemOS has a `./vercel` export but no middleware.
**Do:** middleware that injects a pack before each call and offers ingest tools.
**Effort:** M · **Impact:** ★★★

### 19. Dify / n8n / LlamaIndex connectors
**Evidence:** past.dev shipped all three in one week; MemOS has Python
LangChain/CrewAI adapters only.
**Do:** start with a Dify plugin and an n8n community node; both are thin
wrappers over the HTTP API.
**Effort:** M · **Impact:** ★★

### 20. MCP deletion tools
**Evidence:** MemOS MCP has `memos_forget` but no source-scoped delete or
deletion-status tool; competitors now ship both.
**Do:** add them next to #16 and annotate destructive/idempotent correctly.
**Effort:** S · **Impact:** ★★

---

## Quality and benchmarks

### 21. Publish BEAM-10M (and close the gap)
**Evidence:** `bench-beam.ts` documents a 10M run at **48.6% overall**, but
the README and site publish only BEAM-1M (95.9%). Hindsight publishes 64.1%
at 10M. The script already accepts `--scale=10m` when the dataset exists.
**Do:** publish the 10M number with latency/tokens, and treat the 15-point
gap as the next scale target rather than hiding it.
**Effort:** M · **Impact:** ★★★ (trust + a real target)

### 22. Publish floor and ceiling arms
**Evidence:** the harness supports `--arm=no-memory|full-context|memory`, but
docs only show the memory arm. Databricks publishes all three.
**Do:** one table: floor, memory, full-context (gold-ish ceiling).
**Effort:** S · **Impact:** ★★★

### 23. Cost per correct answer
**Evidence:** the harness records tokens and "tokens per correct answer"; the
site shows accuracy only.
**Do:** add tokens and estimated cost per correct answer to the benchmark page
and artifacts.
**Effort:** S · **Impact:** ★★

### 24. Cross-model judge matrix
**Evidence:** the QA number is 78.0% with DeepSeek and GLM judges; a single
answerer. Vendor scores move with both models.
**Do:** 2 answerers × 2 judges on 100 questions, publish the spread.
**Effort:** M · **Impact:** ★★★

### 25. LoCoMo span aggregation
**Evidence:** windowing and contextual headers both moved LoCoMo <2pp;
multi-hop evidence recall stays ~29%. The missing step is aggregating adjacent
hits into one evidence span at scoring time.
**Do:** merge adjacent retrieved turns into spans and score span coverage;
measure against the same 1,536 questions.
**Effort:** M · **Impact:** ★★

---

## Website and docs

### 26. A MemOS playground
**Evidence:** the site's `/playground` is Guardian's Semantic Folding demo.
There is no interactive memory demo anywhere on the site.
**Do:** a local-first demo: store three memories, "restart", recall them, show
the pack with citations. It can run entirely in the browser against a WASM
SQLite build or a recorded trace.
**Effort:** L · **Impact:** ★★★

### 27. Fix outdated MCP copy on the homepage
**Evidence:** the feature list says "MCP adapter (stdio + HTTP+SSE)"; the repo
serves **Streamable HTTP (2026-07-28)** and no longer uses HTTP+SSE.
**Do:** update the copy and link to the protocol section.
**Effort:** S · **Impact:** ★★

### 28. Methodology links beside benchmark claims
**Evidence:** the homepage says "On LoCoMo and LongMemEval the two are at
parity". The repo's LoCoMo artifact is 65.0% Hit@10 while Mem0's published
claim is 92.5% (self-reported), so "parity" needs the same-harness definition
spelled out or linked.
**Do:** link each claim to its artifact and to the vendor run it compares
against.
**Effort:** S · **Impact:** ★★★ (trust)

### 29. Per-harness install snippets
**Evidence:** `memos connect` supports Claude Code, Cursor, Windsurf, Codex and
Gemini, but the site/docs show only Claude. Marketplace guidance says every
host needs a copy-paste config.
**Do:** a single page with one snippet per harness, tested in each.
**Effort:** S · **Impact:** ★★

### 30. Changelog on the site
**Evidence:** the repo has `CHANGELOG.md`; the site has no release-notes page,
so visitors cannot see that ingestion, preferences and benchmarks shipped.
**Do:** render the changelog at `/changelog`, newest first.
**Effort:** S · **Impact:** ★★

---

## Operations

### 31. A remote MCP option with OAuth
**Evidence:** directory listings increasingly expect a reachable HTTPS endpoint
with OAuth; MemOS is local-only. Local-first is the differentiator, so this is
opt-in.
**Do:** document a self-hosted remote setup (Streamable HTTP + bearer, then
OAuth) or publish an explicit "local-only, no hosted endpoint" listing note.
**Effort:** L · **Impact:** ★★

### 32. MCP compatibility policy
**Evidence:** the 2026-07-28 spec added a formal 12-month deprecation window;
MemOS pins an SDK and supports one modern revision plus legacy fallback.
**Do:** document the supported versions and the upgrade cadence in
`docs/mcp-compatibility.md`.
**Effort:** S · **Impact:** ★★★ (enterprise trust)

---

## Suggested order

1. **#5, #27, #28** — public trust surface; cheap and currently wrong/missing.
2. **#1, #2, #4** — distribution through UMT, multi-manifest plugins, registry.
3. **#11, #12, #16** — the three product capabilities competitors shipped this
   month that users will ask for.
4. **#21, #22, #24** — benchmark depth and honesty.
5. **#26** — the playground; the one thing that makes a stranger *feel* the
   product.

## Sources

- MCP registry and listing checklist — <https://registry.modelcontextprotocol.io>, <https://linklyhq.com/blog/mcp-server-directories>
- Plugin/marketplace anatomy — <https://harnez.ai/posts/plugin-marketplace-architecture/>
- Databricks MemCurrent — <https://www.databricks.com/blog/memcurrent-designing-persistent-memory-production-agents>
- MemHub changelog (trigger endpoint) — <https://mem.xtrace.ai/changelog>
- Retell conversation memory — <https://www.retellai.com/changelog/conversation-memory>
- past.dev changelog (connectors, delete tools) — <https://past.dev/changelog>
- Hindsight Memlake (mental models, BEAM-10M) — <https://hindsight.vectorize.io/blog/2026/10/13/memlake>
