# MemOS 1.6 — Embedding Queue + AI Trio Compatibility Hardening

> **For Hermes:** This is a single in-flight working-tree edit. NO commits
> until the user explicitly approves the final state.

**Goal:** Finish the background-embedding-queue item from the Phase 2 roadmap,
harden MemOS for compatibility with the AI Trio siblings (Universal-MCP-Toolkit
and LLM-Guardian), pick up the obvious perf wins, and document everything in
the changelog. Single release at the end.

**Architecture:**
- `EmbeddingQueue` runs in-process on the same Node loop as `MemOS`. Bounded
  concurrency, non-blocking enqueue, optional synchronous fallback for
  callers that need read-after-write semantics. Best-effort crash recovery by
  scanning the `embeddings` table on init.
- MCP server bumps to protocol `2025-06-18`, gains a Zod-validated input
  layer, exposes `memos_context_pack` for the AI Trio v1 contract, and serves
  `.well-known/mcp-server.json` discovery metadata. The version string is
  pulled from `package.json` instead of being hardcoded.
- Perf changes are internal-only — no public API shifts. `cosineSimilarity`
  becomes 1-pass; `querySimilarEmbeddings` uses a top-k heap; `evict` does a
  single SQL delete; `getNode` access-tracks are debounced/batched; the
  in-memory graph gets a reverse adjacency index for O(1) neighbours.

**Tech Stack:** TypeScript 6, Node 18+, Jest 30, FastAPI (Python 3.10+),
SQLite (WAL), better-sqlite3 12.

---

## Workstreams (sequential, each is a small batch of TDD tasks)

### Workstream A — Background Embedding Queue

1. **A1.** Add `src/queue.ts` types: `EmbeddingJob`, `QueueOptions`,
   `QueueStatus`. Default options: `concurrency=2`, `maxQueue=10_000`,
   `timeoutMs=30_000`, `retries=2`. Failures after retries → drop + emit
   `embedding:failed` event.
2. **A2.** Add `src/queue.ts` `EmbeddingQueue` class with:
   - `enqueue(node)` — non-blocking, returns `void`
   - `flush(timeoutMs?)` — resolves when queue drains (or throws on timeout)
   - `drain()` — same as `flush` but waits indefinitely
   - `status()` — `{ pending, inFlight, completed, failed, oldest }`
   - `close()` — refuses new jobs, awaits in-flight, resolves
3. **A3.** Add `MemOS.flushEmbeddings()`, `MemOS.embeddingStatus()`,
   `MemOS.close()` waits for queue drain.
4. **A4.** Wire into `store()` and `update()`: replace direct
   `await persistEmbedding` with `queue.enqueue`. Add `embedding:queued`,
   `embedding:complete`, `embedding:failed` events. Add a config flag
   `embeddings.async` (default `true`) so users can opt into the old
   behaviour for tests.
5. **A5.** Backfill on init becomes "enqueue if not fresh" rather than
   "await persist".
6. **A6.** Crash recovery: on `init()`, scan for nodes with no `embeddings`
   row whose `updatedAt > 0` and enqueue them. No new persistence needed.
7. **A7.** Tests: enqueue order, concurrency cap, retry on transient,
   drop on permanent, flush blocks until empty, close refuses new jobs,
   events fire in correct order, async=false preserves old behaviour.

### Workstream B — MCP Compatibility (UMT + Guardian)

8. **B1.** Bump `protocolVersion` constant to `2025-06-18` in `mcp.ts`. Pull
   `serverInfo.version` from `package.json` via dynamic import.
9. **B2.** Add a thin internal Zod-style validator (own impl to keep zero
   new runtime deps, OR add `zod` — see Workstream E). Validate every
   `tools/call` input against its `inputSchema`. Reject with
   `error(-32602, "Invalid params: …")` on failure.
10. **B3.** Add new tools:
    - `memos_context_pack` — implements the `ai-trio.memos.context-pack.v1`
      contract from `docs/ai-trio-contracts.md`. Args: `query`, `namespace`,
      `tokenBudget`, `limit?`, `filters?`. Returns the contract object.
    - `memos_flush_embeddings` — calls `MemOS.flushEmbeddings()`.
    - `memos_embedding_status` — returns queue status.
    - `memos_capabilities` — returns protocol/features/version info.
11. **B4.** Add `memos_store` fields: preserve `metadata` and `importance`
    in the createInput (regression: currently dropped).
12. **B5.** Handle `notifications/cancelled` (MCP 2025 spec) by aborting the
    in-flight tool call. Use `AbortController` per call.
13. **B6.** Expose `.well-known/mcp-server.json` discovery metadata when
    the server is started with `--http` (deferred to a follow-up — the CLI
    `mcp` subcommand is stdio-only today; the UMT aggregator can be updated
    separately to use stdio handshakes with `--card-stdout`).

### Workstream C — UMT Handshake Test

14. **C1.** New `__tests__/mcp-handshake.test.ts` that:
    - Spawns the MemOS MCP server via `node dist/mcp.js` with an in-memory DB
    - Sends `initialize`, asserts `protocolVersion === "2025-06-18"` and
      `serverInfo.version` matches `package.json`
    - Sends `tools/list`, asserts presence of all current tools PLUS the
      new ones (B3)
    - Sends `tools/call` for `memos_capabilities` and validates the shape
    - Sends a malicious `memos_store` (missing `content`) and asserts
      `-32602` is returned

### Workstream D — Guardian Context Pack Test

15. **D1.** New `__tests__/context-pack.test.ts` that:
    - Seeds 5 nodes across 2 namespaces with varying trust/source tags
    - Calls `memos_context_pack` and validates the full
      `ai-trio.memos.context-pack.v1` schema: `schema`, `query`, `namespace`,
      `tokenBudget`, `items[].{id,content,summary,score,scores,trust,source,
      tags,updatedAt}`, descending relevance order, and reproducibility
      (call twice, same result).
16. **D2.** Validate `items[].content` is plain text and under `tokenBudget`.

### Workstream E — Dependencies

17. **E1.** `npm outdated` audit. The CHANGELOG already claims Jest 30,
    TypeScript 6, ESLint 10, `better-sqlite3` 12. Verify, bump if not.
18. **E2.** Add `zod` to `dependencies` (^3.23.x or 4.x whichever is
    current) for MCP tool input validation. OR — preferred — write a tiny
    internal validator (~30 LOC) to avoid the dep. Decision: skip `zod` for
    the in-tree validator, but add it as optional for downstream users who
    want to build their own server.
19. **E3.** `pyproject.toml` audit: bump `fastapi`, `uvicorn`, `pydantic` to
    current stable. Run `pip install -e ".[dev]"` to confirm resolution.

### Workstream F — Performance

20. **F1.** `cosineSimilarity`: collapse 3 passes (dot, aNorm, bNorm) into
    one. Keep the same return semantics. Test: identical results to old
    impl on fixed inputs.
21. **F2.** `querySimilarEmbeddings`: use a bounded min-heap of size
    `candidateLimit`. Stop scoring once we have `limit` items above
    `threshold`. Test: identical ordering for small inputs, faster on
    large synthetic.
22. **F3.** `evict`: replace `getAllNodes() → sort → forget(victim)` loop
    with a single SQL `DELETE ... ORDER BY importance ASC, last_accessed
    ASC LIMIT 1` per iteration, then sync the in-memory graph by removing
    the same victim. Test: same set of evictions as before.
23. **F4.** `hybridSearch`: cache the query embedding per `search()` call
    (no global cache — different queries cache different vectors in the
    same in-flight call). Test: semantic and hybrid share one embed call
    when both are computed.
24. **F5.** `SQLiteStorage.getNode`: stop writing `access_count` +
    `last_accessed` synchronously on every read. Switch to a coalesced
    in-memory buffer flushed on a `setInterval(15s)` and on `close()`.
    Re-test: behaviour preserved after close.
25. **F6.** `GraphEngine`: add reverse-adjacency map. `getNeighbours` and
    `getEdgesForNode` use it for O(1) per edge lookup. Test: identical
    output.

### Workstream G — Fixes / Patches

26. **G1.** `mcp.ts`: `memos_store` currently drops `metadata` and
    `importance`. Add them to `createInput` (recovered in B4, listed
    separately for the changelog).
27. **G2.** `memory.ts`: `tag()` and `untag()` go through `getNode()` and
    inflate `accessCount`. Move to a `storage.getNodeNoTrack` path.
28. **G3.** `server/main.py`: `_BRIDGE_SCRIPT` is a 170+ line string literal
    inside the Python source. Extract to a generated template
    (`server/_bridge.mjs.tpl`) and write out at startup, but write to a
    **per-user** path (`~/.memos/bridge/_bridge.mjs` or PID-scoped tmp).
    Avoids the multi-user collision on `/tmp/memos-bridge/_bridge.mjs`.
29. **G4.** `mcp.ts` `protocolVersion` and `serverInfo.version` from
    `package.json` (recovered in B1, listed separately).
30. **G5.** Dedupe `STOP_WORDS` between `src/memory.ts` and `src/graph.ts`
    to a single canonical export.
31. **G6.** `mcp.ts` handle `notifications/cancelled` (recovered in B5).

### Workstream H — Docs / Changelog

32. **H1.** Add `[1.5.1] - 2026-06-15` section to `CHANGELOG.md` covering
    all fixes, perf, and dependency refresh. Keep `[Unreleased]` empty or
    roll the new work into 1.5.1 directly.
33. **H2.** `ROADMAP.md` — check the box "Background embedding queue so
    slow remote providers do not block `store()`". Add a "Completed in
    1.5.1" subsection listing the other items.
34. **H3.** `README.md` — flip the demo GIF placeholder comment block
    out (or leave a TODO with the image path), update "Features" table
    to mark embedding async, MCP 2025-06-18, and context pack as
    available.
35. **H4.** Bump version in `package.json`, `pyproject.toml`, and the
    inline `_BRIDGE_SCRIPT` / FastAPI `app.version` to `1.5.1`.

### Workstream I — Verification

36. **I1.** `npm run typecheck` clean
37. **I2.** `npm run lint` clean
38. **I3.** `npm test` — all pass, including new tests
39. **I4.** `npm run build` clean
40. **I5.** `npm run bench` — record numbers; new p50/p95/p99 in the
    release notes section
41. **I6.** Python: `ruff check`, `mypy server`, `pytest tests/` all clean
42. **I7.** UMT handshake test (C1) passes
43. **I8.** Context pack test (D1) passes
44. **I9.** Manual smoke: `memos mcp < /dev/null` exits cleanly

### Workstream J — Commit

45. **J1.** After the user has reviewed the working tree, one commit at the
    end with a detailed message that mirrors the changelog.

---

## Risks / Open Questions

- **Concurrency 2 default** — chosen for local Ollama. For LM Studio with
  batching this may be too low. Exposed as `embeddings.queueConcurrency`.
- **Per-user bridge path** — `~/.memos/bridge/` is fine on single-user
  systems. On multi-user servers, fall back to `${TMPDIR}/memos-<uid>-<pid>/`.
- **Zod skip** — keeps zero new runtime deps, but the `inputSchema`
  definitions in `mcp.ts` are still hand-written. Acceptable trade-off
  for the in-tree MCP server; the UMT aggregator may want to wrap it
  with Zod externally.
- **Demo GIF** — we have no recording to drop in, leaving the placeholder
  comment but with a clearer "TODO" path.

## Files Most Likely to Change

- `src/memory.ts` — embed queue wiring, tag/untag regression fix
- `src/mcp.ts` — protocol version, new tools, Zod-style validation,
  notifications/cancelled
- `src/embeddings.ts` — unchanged (no internal contract change)
- `src/queue.ts` — NEW
- `src/storage/sqlite.ts` — perf: SQL evict, debounced access tracking
- `src/graph.ts` — perf: reverse adjacency, dedupe stop words
- `src/types.ts` — new event types, `EmbeddingJob`, `ContextPack`,
  `EmbeddingConfig.queue*`
- `src/cli.ts` — `memos flush`, `memos embedding:status`
- `src/index.ts` — export `EmbeddingQueue`
- `__tests__/memos.test.ts` — extend with queue + perf assertions
- `__tests__/mcp-handshake.test.ts` — NEW
- `__tests__/context-pack.test.ts` — NEW
- `server/main.py` — per-user bridge path, version bump
- `server/routes.py` — no functional change; maybe `/api/mem/flush` and
  `/api/mem/embedding-status`
- `package.json` / `pyproject.toml` — version bump
- `CHANGELOG.md`, `README.md`, `ROADMAP.md` — sync
