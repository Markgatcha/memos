# MemOS Desktop

MemOS Desktop is a native Rust/GPUI app for exploring and managing a local MemOS
store. Direct SQLite access in Rust is strictly read-only (bundled `rusqlite`,
zero Node sidecar for browsing, zero WebView or Electron), and users can
optionally enable **Write mode (MCP)** in Settings to route creates, edits, and
deletes through the MemOS MCP stdio server.

Source: [`apps/desktop-gpui`](https://github.com/Markgatcha/memos/tree/main/apps/desktop-gpui) ·
Changelog: [`apps/desktop-gpui/CHANGELOG.md`](https://github.com/Markgatcha/memos/blob/main/apps/desktop-gpui/CHANGELOG.md)

## What it shows

- **List, Page Header, Scopes & Pagination.** A virtualized list under a
  two-line page header (`STORE / ALL`, title, tabular summary with `showing N
  of total` while paginated plus `last write`, right-aligned **Filter** /
  **Sort**), `120 ms` debounced FTS5 search (`"Search memories · type: tag: ns:"`)
  promoting scope prefixes (`type:`, `tag:`, `ns:`, `provenance:`,
  `has:contradiction`, `is:stale`, `after:YYYY-MM-DD`, `trust:<N`,
  `is:quarantined`) into removable pill chips, namespace/type/provenance/
  contradiction/stale filters (scrollable inside `900×600`), three sort orders,
  SQL keyset pagination (`500` first page + `250` per page past 500), and
  **Row density** (`Comfortable 64 px` / `Compact 48 px`).
- **Today / Brief (`Today`).** A pure-SQLite daily digest grouped into `New`,
  `Changed`, `Expiring`, `Contradictions`, and `Needs attention` with `View all →`
  filter drill-down and an empty state (`"Nothing changed in the last 24 hours"`).
  `New` and `Changed` cover the last 24 hours; `Contradictions` and
  `Needs attention` are standing issues rather than a 24-hour window.
- **Review queue (`Review`).** Lists candidate memories from `memos_review` when
  Write mode (MCP) is active; read-only mode shows an
  `"Enable write mode to review"` banner without starting the writer. Per-row
  **Approve** / **Reject** actions update the store and health immediately.
- **Store card & Health.** A pinned sidebar Store card displays the memory
  count, 0–100 health bar, and **Open health →**, opening a `520 px` health modal
  with `56 px` quick-filter fix cards for contradictions, stale notes,
  low-trust writes, and duplicates.
- **Detail, Time block & sticky header.** Content, tags, entities, causal
  connections, contradictions, a tabular **Time** section under **Details**
  (`Created`, `Updated`, `Last read` relative + absolute / `"Never recalled"`,
  `Reads`, plus `Expires`, `Valid from`, `Valid to` when set), technical metadata,
  copyable citations (`Segoe Fluent Icons` on Windows), and a `40 px` sticky
  header when scrolled (`>= 56 px`). Below 1600 px the detail pane overlays the
  list instead of squeezing it.
- **Opt-in MCP writing, Ingest & Preflight.** Off by default (`read-only`).
  Toggling **Write mode (MCP)** runs a schema preflight (`nodes.metadata`,
  `edges.metadata`, temporal columns, `node_tags`, `contradictions`); older stores
  keep write mode disabled with a clear human migration prompt instead of raw
  SQLite errors. Compatible stores connect via `npx -y @mem-os/sdk mcp` (or
  `memos mcp`), unlocking **Ingest** (`memos_ingest` modal with native folder
  picker, presets, extensions, chunk size, recursive option, and count summary),
  **New memory**, **Edit** (`memos_store` + `memos_supersede`), and **Forget**
  (`memos_forget`) with humanized error banners.
- **Receipts and provenance.** Trust, importance, read count, origin, causal
  lineage, and tamper-log entries with chain hashes. Memories without receipts
  say so explicitly.
- **Graph & linked hover.** Five modes — namespace, tag, entity, temporal, and
  contradictions — with padded Fit view, top-10/selected label LOD hidden below
  `0.40` zoom with bounds clamping and `1 px` text halos, `35%`/`70%` edge
  opacities, soft radial halo behind the `2 px` selected ring, and synchronized
  List ↔ Graph hover highlighting.
- **Dream diff, Saved views & Context.** Read-only tamper timeline, custom saved
  filters, live WAL strip, and “What the AI sees” prompt preview.
- **Tools (16 targets).** Detection and launch plans for Claude Code, Codex,
  Cursor, Windsurf, Cline (print-only), OpenCode 2.x vs legacy 1.x (`opencode --version`
  disambiguation), Gemini CLI, Hermes Agent (print-only), `.dsh` (`$DSH_HOME`/binary
  detection, print-only `memos.patch.yml` without modifying `cordis.patch.yml`),
  Kilo, Pi, OpenClaw (print-only), Zed (print-only), Goose (print-only), and
  Continue. Global configs are never modified.

## Read-only SQLite & Opt-In Write Mode

Every direct SQLite connection from Rust opens with:

- `SQLITE_OPEN_READ_ONLY`
- `PRAGMA query_only = ON`
- `PRAGMA busy_timeout = 5000`

The Rust crate contains no `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, or
`DROP` statements. Schema introspection tolerates older and newer stores:
missing optional tables or columns degrade cleanly to empty facets rather than
failing to open.

When **Write mode (MCP)** is toggled on in Settings, writes route through a
persistent MemOS MCP stdio subprocess (auto-discovering `memos` on `PATH`, then
a sibling/repo `dist/cli.js mcp`, then `npx -y @mem-os/sdk mcp`; switchable via
**Use local CLI** in Settings) with `MEMOS_DB_PATH` and `MEMOS_MCP_TOOLS=all`.
The bridge discovers capabilities over `MCP 2026-07-28` (`server/discover` +
per-request `_meta`, with legacy `initialize` `2025-11-25` fallback only if
unsupported) and gates `memos_review`, `memos_ingest`, `memos_audit_answer`,
and `memos_explain_recall` on the live `tools/list` inventory so `24`-tool
writers show an actionable capability card instead of raw `-32602` errors,
keeping embeddings, provenance, contradiction scans, and tamper logs consistent
with the CLI and SDK.

## Run it

```bash
cd apps/desktop-gpui
cargo run -- --db ~/.memos/memos.db
```

The database path resolves in this order: `--db`, `MEMOS_DB`, then
`~/.memos/memos.db`. If the file or `nodes` table is missing, the app shows the
resolved path and the command to create a store.

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--diagnostics` | Print versions, DB path, table counts, log paths, and harness detection. No memory text. |
| `--startup-report <path>` | Write a JSON startup timeline. |
| `--smoke-exit-after-first-frame` | Exit after the first frame and initial DB load; used for timing. |
| `--self-test` | Exercise onboarding, DB resolution, harness detection, and core views without input. |
| `MEMOS_DESKTOP_HOME` | Override the settings/log directory for isolated runs. |

## Keyboard

`Ctrl/Cmd+K` opens the command palette. `Ctrl/Cmd+F` focuses search,
`Ctrl/Cmd+1` and `Ctrl/Cmd+2` switch list/graph, `j`/`k` and arrows move the
selection, `Enter` opens the detail pane, `Home`/`End` jump, and `?` opens the
shortcut sheet.

## Performance

The release gate asserts FTS5 p95 under 30 ms and graph layout under 250 ms on a
10k-node synthetic store; the 50k test asserts RSS under 200 MB. Numbers vary
with GPU state and system load, so reproduce them locally:

```bash
cargo test --release --test smoke_bench -- --nocapture
```

The two benchmark cases serialize themselves. Running them concurrently made
the 10k p95 gate flaky because the 50k setup competed for CPU and disk.

## Privacy

Memory text, summaries, tags, and search queries are never written to logs,
analytics, or crash reports. Crash reporting is opt-in and off by default; the
scrubber removes paths, usernames, and hostnames while keeping app version,
OS/arch, error kind, and a random install id.

## Related docs

- [0.1.0 feature inventory](desktop-feature-inventory-0.1.0.md) — every new
  surface, its demo status, and the blockers to fix before recording.
- [0.1.0 launch video kit](desktop-video-kit-0.1.0.md) — 90-second script,
  30-second cut, shot list, demo dataset spec, and release checklist.
- [Desktop UI research (2026-11-17)](desktop-ui-research-2026-11-17.md) — Cap
  teardown, premium desktop benchmarks, token proposals, and the first
  three-hour visual pass.
- [Desktop v0.1 release blockers](desktop-v0.1-release-blockers.md) — the
  consolidated P0/P1 list from the four 2026-11-18 reviews.
- [Desktop improvement backlog](desktop-improvement-backlog-2026.md) — 38
  researched ways to extend the app.
- [Memory Explorer MCP App](mcp-apps-explorer.md) — the in-chat graph explorer.
- [Retrieval flight recorder](retrieval-debugging.md) — explain and replay
  retrieval decisions.
