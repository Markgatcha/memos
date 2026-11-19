# MemOS Desktop Architecture & Read-Only Design (`DESIGN.md`)

## 1. Strict Read-Only SQLite Boundary & Opt-In MCP Writer

MemOS Desktop opens the SQLite store **strictly read-only** from Rust (`src/core/db.rs`):

1. **Driver flags**: Every connection opens with `OpenFlags::SQLITE_OPEN_READ_ONLY` (`src/core/db.rs`).
2. **Engine guard**: Immediately after opening, the connection executes `PRAGMA query_only = ON;` and `PRAGMA busy_timeout = 5000;` so concurrent WAL writers (`memos` CLI or MCP server) never cause spurious `SQLITE_BUSY` failures while the desktop client reads consistent snapshots.
3. **No SQLite mutation code paths**: The Rust crate contains zero `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, or `DROP` queries. Harness detection (`src/core/harness/`) also inspects config files read-only (`applied = false` on `InstallPlan`).

When users opt into **Write mode (MCP)** in Settings (disabled by default), writes never touch SQLite directly from Rust. First, `SchemaInfo::check_writer_preflight` (`src/core/db.rs`) verifies the store contains required write columns/tables (`nodes.metadata`, `nodes.valid_from/valid_to`, `edges.metadata`, `edges.valid_from/valid_to`, `node_tags`, `contradictions`). Older stores keep write mode disabled and show a human migration banner without exposing raw SQLite errors. On compatible stores, `WriteBridge` (`src/core/write_bridge.rs`) lazily spawns one persistent MCP child process (auto-discovering `memos` on `PATH`, then a sibling/repo `dist/cli.js mcp`, falling back to `npx -y @mem-os/sdk mcp`; users can switch via **Use local CLI** in Settings) with `MEMOS_DB_PATH` and `MEMOS_MCP_TOOLS=all`, discovers capabilities via `server/discover` and sends the per-request `2026-07-28` `_meta` envelope (`io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities` — no handshake; falling back to legacy `initialize` `2025-11-25` only on `-32022`/`-32601`/invalid-envelope responses), gates specialized tools (`memos_review`, `memos_ingest`, `memos_audit_answer`, `memos_explain_recall`) against the returned tool list so older `24`-tool writers surface an actionable capability card instead of raw `-32602` RPC errors, enforces a `10 s` call timeout (`60 s` for `memos_ingest`) and `CREATE_NO_WINDOW` on Windows, and cleans up the subprocess on `Drop` or mode disable:

- **Create**: `memos_store` (content, type, pool, tags, namespace, context).
- **Edit**: `memos_store` followed by `memos_supersede` against the previous memory ID so history and provenance stay intact.
- **Forget**: confirmation modal + `memos_forget`.
- **Review queue**: reads pending candidates via `memos_review` (`action: "list"`) in any mode, and gates **Approve** / **Reject** mutations on write mode (`action: "approve"` / `"reject"`).
- **Ingest files or folder**: modal UI over `memos_ingest` (`60 s` timeout, native folder picker via GPUI `prompt_for_paths`, presets, extensions, chunk size, recursive flag) with zero Rust document parsing.
- Errors map SQLite/MCP codes into short, actionable messages inside a non-blocking header banner showing the failing command, **Retry**, and **Settings** so reading and browsing remain uninterrupted.

## 2. Why MemOS Desktop Queries SQLite Directly (And Bridges Writes Only When Enabled)

Rather than embedding an Electron shell, WebView, or unconditionally spawning Node for reads:

- **Cold start under 400 ms**: Native binary startup avoids V8 isolate initialization, TypeScript module resolution, and IPC handshakes.
- **Predictable memory footprint (< 200 MB at 50k nodes)**: Direct `rusqlite` queries project only light list-row fields (`substr(coalesce(summary, content), 1, 220)` in SQL) and intern repeated namespaces, types, sources, harnesses, provenance tiers, and tags into `gpui::SharedString` handles. The list fetches an initial `LIST_PAGE_SIZE` (500) page and appends `LIST_NEXT_PAGE_SIZE` (250) pages cleanly via SQL keyset pagination on `(sort_value, id)` as the user scrolls or navigates near the bottom; graph snapshots scan up to 50k matching rows so cluster counts stay accurate. Full `content`, `metadata`, linked `edges`, and `contradictions` are fetched lazily only for the actively selected node.
- **Self-contained distribution**: `rusqlite` uses the `bundled` feature (`libsqlite3-sys`), eliminating runtime Node or system SQLite version mismatches while matching MemOS's exact FTS5 (`porter unicode61`) tokenizer behavior directly in SQL.
- **Zero UI-thread stalls**: Every SQLite query, FTS5 search (120 ms debounced), schema introspection, spatial-grid graph layout (up to 2,000 visible nodes + cluster nodes via `lyon` curves), and harness inspection runs on GPUI's background executor (`cx.background_executor().spawn(...)`) with generation counters cancelling stale in-flight requests.

## 3. Forward/Backward Schema Introspection

Because user databases may come from older or newer MemOS CLI releases, `ReadOnlyStore::open` never hardcodes optional columns or auxiliary tables:

- `SchemaInfo::introspect` queries `sqlite_master` and `PRAGMA table_info(...)` for every table/view.
- Missing auxiliary tables (`edges`, `node_tags`, `embeddings`, `contradictions`, `procedural_lessons`, `recall_traces`, `tamper_log`, `entity_index`, `nodes_fts`) degrade cleanly to empty facets/edges and SQL `LIKE` fallback when `nodes_fts` is absent.
- Optional `nodes` columns (`summary`, `importance`, `confidence`, `evidence_count`, `provenance`, `trust_score`, `quarantined`, `valid_from`, `valid_to`, `expires_at`, `metadata`, etc.) are dynamically projected with safe SQL defaults whenever absent.

## 4. Sensitive Data Isolation

Memory text and search queries are treated as sensitive user data:

- `tracing` logs emit only structured counts, durations, table names, schema column counts, and IDs.
- Database and UI errors are sanitized before rendering or logging.
- Both Sentry's `before_send` hook and local crash report writers (`src/telemetry.rs`) pass all strings, frames, breadcrumbs, tags, and `extra` payloads through `scrub_sentry_event` / `scrub_text` to redact active queries, inspected memory samples, filesystem paths, OS usernames, and hostnames.

## 5. Startup Timeline & Performance Design

- **Phase instrumentation (`src/telemetry.rs`, `--startup-report <path>`)**: records monotonic spans for `process_start`, `settings`, `telemetry_init`, `gpui_app_init`, `window_open`, `first_render`, `first_frame`, `db_open`, `overview`, and `first_list_page`, emitting one non-sensitive `tracing` line per phase plus optional JSON export.
- **Measured Windows release timings (0.1.0 gate, 2026-11-16)**: `49.87 ms` 10k DB open + overview + 500-row page; `5.40 ms` p50 / `10.89 ms` warm p95 / `9.59 ms` cold-cache p95 10k FTS5 search; `29.28 ms` query + `23.76 ms` layout for 1,941-node Namespace graph; `32.14 MB` RSS at 50k nodes (750 loaded paginated rows: `500 + 250`, vs `20.85 MB` at 10k); release GUI binary `memos-desktop.exe` `18.86 MB` (`19,780,096 B`); standalone `memos.exe` CLI binary `2.69 MB` (`2,816,000 B`). The preview idle pass measured `147–163 ms` first frame; treat idle and busy-host numbers as a range, not a single promise. The full table lives in `README.md`.

## 6. Visual Surface & Icon System (`src/ui/views/mod.rs`)

- **Warm obsidian palette**: Dark mode uses `#0B0908` sunken, `#12100E` app canvas, `#1A1714` panel, `#221E1A` elevated, `#28231F` floating, `#2E2823` hairlines, `#241F1A` subtle dividers, `#E8E1D5` primary text, `#C9C0B2` secondary, `#A79D8F` muted, and `#C97B4A` burnt copper accent so dark and light modes feel like one product.
- **Hierarchy & density**: A pinned sidebar **Store card** (`32 px` mono count + `12 px` label, `4 px` 0–100 health bar, `28 px` **Open health →**) and two-line list page header (`STORE / ALL`, `26/700` title, `12 px` tabular summary showing `showing N of total` while paginated plus `last write <age>`, right-aligned **Filter**/**Sort**) anchor navigation alongside **Today** (daily Brief) and **Review** surfaces. List rows drop internal card borders in favor of `64 px` Comfortable / `48 px` Compact spacing (`AppSettings.row_density`), `14/500` titles, `12 px` meta, and `tabular_nums()` (`tnum`) counts.
- **Warm surface & motion**: Dark uses `#12100E` / `#1A1714` / `#221E1A` / `#2E2823` / `#E8E1D5` / `#C97B4A`; light splits structural `#D8D1C6` from subtle `#EDE8DF`. Graph type colors are low-chroma warm hues (max saturation ~0.41), not D3 defaults. List-row hover eases over `120 ms`, the page title fades over `180 ms`, and `with_animation` follows GPUI's reduce-motion flag (`--no-fun` / OS preference).
- **Warm glass, not glassmorphism**: Windows requests GPUI's `MicaBackdrop`; the palette, filter/sort/overflow popovers, and Settings/Health/Tools/Composer/Ingest/Context/Dream Diff dialogs use `glass_floating`/`glass_panel` alpha sheets (0.97/0.98), a `1 px` top highlight, 16 px radii, a warm scrim, and `shadow_lg`. Memory rows, the graph, and the detail body stay opaque to protect contrast. There is no per-element backdrop blur in GPUI 1.28; the effect is layered quads, not a sampled background.
- **Single icon family**: `UiIcon` resolves `Segoe Fluent Icons` (falling back to `Segoe MDL2 Assets`) on Windows via `Window::text_system().all_font_names()`, with safe Unicode symbol fallbacks on macOS, Linux, and headless runs.
- **Graph legibility**: Ambient node labels appear only for the top-10 by importance plus selected/hovered nodes, hidden below `GRAPH_AMBIENT_LABEL_MIN_ZOOM` (`0.40`) zoom with priority collision culling, viewport bounds clamping, and `1 px` text halos; ambient edges render at `35%` alpha (`70%` when highlighted or contradictory) and selected nodes use a soft radial halo behind a crisp `2 px` copper ring.

## 7. First-Run Onboarding & Atomic Settings (`src/ui/views/onboarding.rs`, `src/core/settings.rs`)

- **Trigger & geometry**: launches when `settings.onboarding_completed` is `false` inside a single `1100×720` (min `900×600`) GPUI window following the active `ThemePalette`.
- **Non-blocking DB validation**: path probing (including native `Browse…` dialogs via `rfd`) executes on GPUI's background executor using a cancel-safe generation counter and verifies both SQLite readability (`SQLITE_OPEN_READ_ONLY`, `PRAGMA query_only = ON`) and the presence of a `nodes` table before advancing.
- **Keyboard-first focus**: because GPUI's focused `.on_click(...)` div elements dispatch activation on `Enter`/`Space`, `OnboardingView::on_key_down` handles `Esc` (step back, never quit) and `Tab`/`Shift-Tab` while only advancing on `Enter` when no interactive button holds focus — preventing double-step skips.
- **Atomic persistence**: `settings.json` writes go to a temp file followed by atomic rename inside the platform config dir or `MEMOS_DESKTOP_HOME`.

## 8. Harnesses Discovery & Temporary-Config Launch (`src/core/harness/`)

- **Full `memos connect` parity (`16` targets)**: covers all 15 `memos connect` targets (Claude Code, Codex, Cursor, Windsurf, Cline, OpenCode 2.x default, OpenCode 1.x legacy, Gemini CLI, Hermes Agent, `.dsh`, Kilo, Pi, OpenClaw, Zed, Goose) plus Continue, flagging print-only targets cleanly and keeping `.dsh` scoped to `$DSH_HOME`/`~/.dsh/memos.patch.yml` (or detected `dsh` binary) without touching `cordis.patch.yml`. Probes `opencode --version` so only the installed major (2.x vs 1.x) is marked active.
- **Bounded `< 100 ms` discovery**: fixed config path checks and directory-indexed `PATH` lookups across all 16 adapters use mtime/version caching so repeated modal opens avoid redundant process spawns.
- **Non-mutating launch**: **Connect** passes `MEMOS_DB` and generated temporary MCP configuration arguments/files where supported, keeping external global harness config files untouched (`applied = false`).
