# MemOS Desktop (`apps/desktop-gpui`)

Native desktop memory explorer and interactive graph viewer for the [MemOS](../../README.md) SQLite store, built with Rust and [GPUI](https://crates.io/crates/gpui-unofficial).

SQLite access in Rust is **strictly read-only** (`SQLITE_OPEN_READ_ONLY` + `PRAGMA query_only = ON` via bundled `rusqlite`), with no WebView or Electron. By default the app runs in read-only mode; users can optionally enable **Write mode (MCP)** in Settings, which delegates creates, versioned edits, deletes, review actions, and document ingest to a persistent MemOS MCP stdio child (auto-discovering `memos` on `PATH`, then a sibling/repo `dist/cli.js mcp`, then `npx -y @mem-os/sdk mcp`) speaking modern `MCP 2026-07-28` (`server/discover` + per-request `_meta`, with legacy `initialize` `2025-11-25` fallback) so embeddings, provenance, and tamper logs remain intact.

## Prerequisites

- **Rust**: stable toolchain pinned via [`rust-toolchain.toml`](./rust-toolchain.toml) (`edition = "2024"`).
- **Windows**: MSVC build tools (defaults to Win32 + DirectWrite).
- **macOS**: Xcode Command Line Tools.
- **Linux**: `pkg-config`, `libxkbcommon-dev`, `libxkbcommon-x11-dev`, `libwayland-dev`, `libfontconfig1-dev`, `libxcb1-dev`, `libxcb-xfixes0-dev`, `libxcb-render0-dev`, `libxcb-shape0-dev`, `libvulkan1`, `libasound2-dev`.

# Build & Run

From `apps/desktop-gpui`:

```bash
# Development check, lint, and tests (GUI default + lightweight CLI feature build)
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo clippy --no-default-features --features cli --all-targets -- -D warnings
cargo test
cargo test --no-default-features --features cli

# Run locally (Windows: keep target artifacts outside synced folders if needed)
cargo run -- [--db <path>]

# Build resource-light read-only CLI (`memos`) without GPUI
cargo build --release --no-default-features --features cli --bin memos

# Release build (LTO thin, stripped, single codegen unit) and release smoke benchmarks
cargo build --release --all-targets
cargo test --release --test smoke_bench -- --nocapture
```

Per-platform notes:

- **Windows (PowerShell)**: `$env:CARGO_TARGET_DIR="C:\path\to\target"` before `cargo` commands; MSVC build tools required (`gpui` defaults to Win32 + DirectWrite).
- **macOS**: Xcode Command Line Tools (`cargo build --release`).
- **Linux**: install the X11/Wayland/Vulkan/Fontconfig dev packages listed under Prerequisites (`cargo build --release`).

### CLI Flags & Environment Overrides

| Flag / Env | Description |
| --- | --- |
| `--db <path>` | Override the SQLite database path (also `--db=<path>`). |
| `--diagnostics` | Print non-sensitive versions, DB path, introspected table row/column counts, log locations, and read-only harness detection. Never prints memory content. |
| `--startup-report <path>` | Write the JSON startup phase timeline (`process_start`, `settings`, `telemetry_init`, `gpui_app_init`, `window_open`, `first_render`, `first_frame`, `db_open`, `overview`, `first_list_page`) to `<path>` (`--startup-report=<path>` also supported). |
| `--smoke-exit-after-first-frame` | Exit cleanly after rendering the first frame and completing initial DB load; used for repeatable startup timing runs. |
| `--self-test` | Exercise onboarding state transitions, core view constructors, DB path resolution, and harness discovery without requiring interactive display input, then exit `0`. |
| `--crash-test` | *(Debug builds only)* Verifies the telemetry scrubber removes a synthetic secret string and triggers a local crash report panic test. |
| `MEMOS_DESKTOP_HOME` | Override the platform settings/log directory for isolated testing (e.g. forcing first-run onboarding). |

## First-Run Onboarding

When `settings.onboarding_completed` is `false`, MemOS Desktop launches directly into a native 2-step GPUI onboarding flow (`1100×720`, minimum `900×600`, keyboard-navigable with `Tab`/`Shift-Tab`, `Enter`/`Space`, and `Esc` to step backward):

1. **Database (`1/2`)** — Auto-detects `MEMOS_DB` / `~/.memos/memos.db`. Displays the path and node/edge counts when found. When it is missing, **Create memory store** writes the canonical SDK schema at that path (no Node or CLI required) and re-probes; the `memos init` command remains available as a secondary copy action, alongside **Browse…** and **Retry**. Selected files are validated asynchronously off the UI thread (read-only SQLite + `nodes` table check, guarded by a generation counter) with inline errors if invalid.
2. **Ready (`2/2`)** — Live **System** / **Light** / **Dark** theme, **List** / **Graph** default view, and the opt-in crash-reporting toggle (**OFF** by default), finishing into the main window.

Settings persist atomically (temporary file write + rename) to `settings.json` inside the platform config dir or `$MEMOS_DESKTOP_HOME`. If the chosen database opens with `0` memories, the main window displays an empty state with exact `memos store` and `memos mcp` copyable commands. **Optimize store** in Settings adds any missing read-path indexes (recency, provenance, …) to an existing store; it is a non-destructive, idempotent DDL action and the only SQLite write besides creating a new store.

## Surfaces

- **Today / Brief (`Today`).** A pure-SQLite daily digest listing `New`, `Changed`, `Expiring`, `Contradictions`, and `Needs attention` entries with live sidebar badge counts, `View all →` section filters, keyboard navigation, and an empty state (`"Nothing changed in the last 24 hours"`). The `New` and `Changed` sections cover the last 24 hours; contradiction and attention sections are standing issues.
- **Review queue (`Review`).** Lists candidate memories pending approval straight from SQLite in read-only mode (no writer process), with type, namespace, age and reason. Approve/Reject are gated: read-only shows an `"Turn on editing to approve"` banner and never starts the writer, while enabling **Write mode (MCP)** unlocks the actions. Reject is a two-step inline confirm. If the configured writer exposes fewer tools (e.g. a `24`-tool build missing `memos_review`), write-mode Review shows a clear capability card with **Settings** and **Retry** actions instead of a raw RPC error or false empty state.
- **Opt-in MCP writing, capability preflight & Ingest.** Disabled by default so the app opens strictly read-only. Turning on **Write mode (MCP)** in Settings runs a schema preflight (`WriterSchemaPreflight`) and connects via `server/discover` + `_meta` (`MCP 2026-07-28`, falling back to legacy `initialize` `2025-11-25` only if unsupported). Settings auto-detects local CLIs (`memos` on `PATH` -> repo `dist/cli.js mcp` -> `npx -y @mem-os/sdk mcp`) with a **Use local CLI** button, **Test connection** summary (`Connected · MCP 2026-07-28 · 42 tools · review ✓`), and footer state (`Read-only` / `Write mode enabled (MCP ...)`). Older stores missing required write columns/tables keep write mode off cleanly with human migration guidance; compatible stores unlock header **Ingest** (gated on `memos_ingest`; modal with native folder picker, `documents`/`default` presets, extensions, chunk size, recursive toggle, and `Added`/`Updated`/`Unchanged`/`Removed`/`Skipped`/`Errors`/`Chunks` summary) and **New memory** CTAs, multiline composer modal, **Edit** (`memos_store` + `memos_supersede`), **Forget** confirmation modal, **Review** approvals, palette write commands, and automatic store reload. Errors map raw SQLite/MCP strings into short actionable messages inside a non-blocking banner with **Retry** and **Settings**.
- **Search scopes & Keyset pagination.** The search bar (`"Search memories · type: tag: ns:"`) promotes `type:`, `tag:`, `ns:`, `provenance:`, `has:contradiction`, `is:stale`, `after:YYYY-MM-DD`, `trust:<N`, and `is:quarantined` tokens into removable filter pills (`Backspace` on empty input or click `×`). Results load in keyset-paginated batches (`500` initial + `250` per page) with `showing N of total` in the list header until the tail is reached.
- **Warm obsidian surface & Store Card.** Dark mode uses warm obsidian surfaces (`#12100E` app, `#1A1714` panel, `#221E1A` elevated, `#2E2823` hairlines, `#E8E1D5` text, `#C97B4A` accent) unified with the warm light theme. Above the list, a two-line page header (`STORE / ALL`, active view title, tabular summary with `last write <age>`, right-aligned **Filter** / **Sort**) pairs with a fixed sidebar **Store card** showing total memories, 0–100 health score bar, and **Open health →**.
- **Row density & unified icons.** Lists render without per-row boxes at **Comfortable (`64 px`)** or **Compact (`48 px`)** row density (configurable in Settings and Command Palette). Semantic UI icons render via Windows `Segoe Fluent Icons` / `Segoe MDL2 Assets` (`UiIcon`, centered at `14/16/20 px`) with cross-platform symbol fallbacks on macOS, Linux, and headless runs.
- **Command palette (`Ctrl/Cmd+K`).** Grouped results, fuzzy matching with match highlighting, a preview pane, keycap hints, and actions for Today/Review/views, graph modes, sorting, row density, theme, health, dream diff, shortcuts, diagnostics, saved views, and (in write mode) New/Edit/Forget/Ingest actions.
- **Context pack builder.** `C` (or **Context** in the inspector) collects memories from the selection, the current view, or pinned memories (`P`), fits them to a 1k–8k token budget without ever cutting a memory's text, and copies them as Plain, Markdown, Citations or JSON. Local only.
- **Quick capture.** `Ctrl/Cmd+N` opens one field where `#tag`, `ns:` and `type:` become structured fields; `Ctrl/Cmd+Enter` saves through the MCP writer. Gated on write mode; in read-only mode the command explains how to enable it.
- **Compare.** `X`, the inspector's conflict rows and Today's contradiction cards open a side-by-side comparison with differing facts called out. Forgetting either side appears only in write mode.
- **Sticky detail & Time block.** Scrolling `>= 56 px` inside Detail reveals a compact `40 px` bar with type badge, monospace short ID, copy content/citation, and click-to-top. Under **Details**, a **Time** block displays `Created`, `Updated`, `Last read` (relative + absolute, or `"Never recalled"` when unset), `Reads`, plus `Expires`, `Valid from`, and `Valid to` when set.
- **Graph & linked hover.** Clicking a node shows a compact card (type, group, age, links, importance, conflicts) with **Open** and **Focus**; zoom controls sit bottom-right. Five modes (`Namespace`, `Tag`, `Entity`, `Temporal`, `Contradictions`) with `0.40` zoom floor on ambient top-10 importance labels, collision culling, viewport bounds clamping, `1 px` text halos, `35%`/`70%` edge opacities, soft radial halo behind the `2 px` selected ring, and bi-directional List ↔ Graph hover highlighting.
- **Saved views and search syntax.** Save the current filter (including search-scope chips) and sort as a named sidebar view; rename it, point it at the current filters, or delete it from **Edit** / right-click or the palette. **Syntax** (`Ctrl/Cmd+/`) lists every scope with one-click completions from the store and your recent searches.
- **Store health.** A 0–100 score and an action center: issues grouped by urgency (*Needs attention*, *Worth a review*, *Good to know*), each explained in plain words with a button that opens the exact memories, Today or Review.
- **Dream diff.** A read-only timeline of promotions, merges, decays, contradictions, and updates derived from the tamper log.
- **Live memory strip.** New writes detected by the WAL watcher appear without replacing the active selection, with **Jump to newest** and **Refresh**.
- **Receipts and provenance.** Trust, importance, read count, origin, causal lineage, and tamper-log entries with chain hashes.
- **Keyboard and accessibility.** `j`/`k` and arrows move across List, Today, Review and Graph (Graph: arrows step through nodes, `Home`/`End` jump, `Enter` opens Detail, `F` focuses the neighborhood, `+`/`-`/`0` zoom), `Ctrl/Cmd+1–4` switch List / Graph / Today / Review, `I` toggles the inspector, `C`/`P`/`X` drive context packs and comparison, `Esc` closes modals/popovers, `?` opens the shortcut sheet. Rows, sidebar views, palette rows, tabs, and modal buttons expose AccessKit roles and labels. Closing the command palette restores the focus you had before opening it.

## Database Path Resolution

MemOS Desktop resolves the target database path in strict order:

1. `--db <path>` CLI argument
2. `MEMOS_DB` environment variable
3. `~/.memos/memos.db` (`%USERPROFILE%\.memos\memos.db` on Windows)

If the database file does not exist yet, the UI displays an explicit empty state with the resolved path and a **Create memory store** button that writes the canonical schema in place; it also offers Retry and the `memos init` command as a secondary path.

All SQLite connections enforce:

- `SQLITE_OPEN_READ_ONLY`
- `PRAGMA query_only = ON`
- `PRAGMA busy_timeout = 5000`
- Runtime schema introspection via `PRAGMA table_info(...)` so older or newer MemOS schemas (missing optional tables or columns) open cleanly.

## Measured performance (release, Windows)

Measured on Windows x86_64 against synthetic 10k/50k stores (`cargo test --release --test smoke_bench -- --nocapture --test-threads=1`). The 0.1.0 smoke bench was re-run on 2026-11-16; the CLI wall-time and first-frame rows are from the earlier preview pass and were not re-run:

| Metric | Measured | Budget |
| --- | ---: | ---: |
| GUI release binary (`memos-desktop.exe`) | `18.86 MB` (`19,780,096 B`) | `< 80 MB` |
| CLI release binary (`memos.exe`, `--no-default-features --features cli`) | `2.69 MB` (`2,816,000 B`) | `< 6 MB` |
| CLI `memos list --limit 20` warm wall time (0.1.0 pass) | `19.31–19.82 ms` | `< 30 ms` |
| First frame, warm (0.1.0 pass, 5 runs) | `147.13–163.26 ms` | `< 400 ms` |
| DB startup (open + overview + 500-row page), 10k store | `49.87 ms` | — |
| First list page, 50k store, two-phase startup (2026-11-20) | `93–96 ms` list; `~257 ms` for facets/health in phase two | `< 200 ms` list |
| FTS5 search p50 / p95 (warm) & cold-cache p95, 10k store | `5.40 ms` / `10.89 ms` (`9.59 ms` cold) | `< 30 ms` warm / `< 60 ms` cold |
| RSS, 50k store, GUI window (`500 + 250` paginated rows = `750` loaded) | `98.4 MB` working set / `88.7 MB` private (measured 2026-11-20, maximized window). The earlier `32.14 MB` figure was the headless smoke harness, which opens no window. | `< 200 MB` |
| Graph query + layout (1,941 visible + 8,064 clustered): Namespace | `29.28 ms` query + `23.76 ms` layout | `< 250 ms` layout |
| Graph query + layout: Tag / Entity / Temporal | `18.68–30.39 ms` query + `0.52–18.76 ms` layout | `< 250 ms` layout |
| Graph query + layout: Contradictions (`60` nodes, `35` edges) | `2.79 ms` query + `0.31 ms` layout | `< 250 ms` layout |

Warm startup phase breakdown (`median` / `p95` duration across 10 warm runs):

- `settings`: `2.26 ms` / `2.68 ms`
- `telemetry_init`: `1.13 ms` / `1.29 ms`
- `gpui_app_init`: `111.32 ms` / `115.09 ms`
- `window_open`: `30.61 ms` / `35.39 ms`
- `first_render`: `0.07 ms` / `0.14 ms`
- `first_frame` paint: `4.17 ms` / `6.00 ms`
- `db_open`: `3.43 ms` / `4.79 ms`
- `overview`: `0.80 ms` / `1.60 ms`
- `first_list_page`: `1.79 ms` / `6.78 ms`

Notes:

- Startup and graph timings are sensitive to GPU power state and background
  load. A 2026-11-15 re-run with several desktop apps open measured first frame
  `0.51–0.60 s` and graph queries `59–67 ms` (layout `2.5–108 ms`). The table
  above is the idle, foreground measurement; both are reproducible with the
  commands in this section.
- Warm runs follow a single warmup launch; cold-cache starts after OS reboot or GPU/shader cache eviction were not isolated separately in this measurement pass.
- The list loads `500` rows on the first page (`LIST_PAGE_SIZE` in `src/core/db.rs`) and appends `250` rows per page (`LIST_NEXT_PAGE_SIZE`) via SQL keyset cursor `(sort_value, id)` as you scroll near the bottom. The header shows `showing N of total` until all matching rows are loaded, avoiding `59–235 ms` debounced search latency from materializing 50k rows upfront.
- Performance assertions in `tests/smoke_bench.rs` gate release builds only;
  debug builds print the numbers without failing.

## Privacy & Crash Reporting

- **Sensitive text protection**: Memory content, summaries, tags, and search queries are never written to tracing logs, analytics, error alerts, or crash reports. Logs record only counts, durations, IDs, and versions.
- **Opt-in telemetry (OFF by default)**: On first launch, a dialog lets you opt in or keep crash reporting disabled.
- **Scrubber (`before_send`)**: Sentry events and local crash reports strip tracked memory strings, search queries, full filesystem paths, usernames, and hostnames while preserving app version, OS/arch, GPUI version (`1.29.2`), error kind, and a random `install_id`.
- **Offline crash recovery & logs**:
  - Rotating file logs (`5 × 2 MB`) are stored in the platform data log directory (accessible via Command Palette → **Open Logs Directory** or `--diagnostics`).
  - Unhandled panics always write a scrubbed local crash report and open a recovery window with **Copy diagnostics** and **Open logs** buttons — even with network telemetry disabled.
  - Provide `MEMOS_DESKTOP_SENTRY_DSN` at build or runtime to enable remote scrubbed crash uploads after opt-in; without a DSN, telemetry remains local-only.

## Tools Matrix & Phase 3 Seams (`src/core/harness/`)

`HarnessAdapter` and its 16 targets in [`src/core/harness/`](./src/core/harness/mod.rs) match all 15 `memos connect` targets plus Continue:

- **Configurable targets:** Claude Code (`~/.claude`), Codex (`~/.codex`), Cursor (`~/.cursor`), Windsurf (`~/.codeium/windsurf`), OpenCode (`~/.config/opencode` — 2.x nested `mcp.servers.memos`), OpenCode 1.x (legacy flat `mcp.memos`), Gemini CLI (`~/.gemini`), Kilo (`~/.config/kilo`), Pi (`~/.pi/agent`), and Continue (`~/.continue`).
- **Print-only targets** (flagged in the Tools UI and `memos harness` output; snippets are previewed/copied without overwriting existing config files): Cline, Hermes Agent, `.dsh` (`$DSH_HOME` / `~/.dsh` targeting dedicated `memos.patch.yml`, never touching `cordis.patch.yml`), OpenClaw, Zed, and Goose.

Current guarantees and Tools modal capabilities:

- **Fast, read-only detection**: probes all 16 adapters over fixed config paths and cached directory binary lookups with mtime/version cache invalidation (`2` fake-home & read-only unit tests cover both `0/16` and `16/16`).
- **Non-mutating install plans**: `plan_memos_install()` generates MCP snippets (`stdio`: `npx -y @mem-os/sdk mcp` and `HTTP`: `http://localhost:7400/mcp`), backup destination paths, and config diffs (`applied = false`) without ever modifying external tool configurations.
- **Usable v1 actions**: **Connect** spawns supported harnesses with `MEMOS_DB` set and a generated temporary MCP config passed on the command line (never editing global configs), alongside **Open terminal**, **Copy MCP snippet**, and **Reveal**.
- **Phase 3 PTY seam**: `HarnessAdapter::launch()` opens the tool in an external terminal in v1; in Phase 3, an embedded PTY (`PtySession`) + GPUI terminal pane will plug into the same adapter registry.

## CI Workflow (`.github/workflows/desktop-gpui.yml`)

- **`check`** (`ubuntu-latest`): `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, debug `cargo build`.
- **`test`** (`[ubuntu-latest, windows-latest, macos-15]`): `cargo test -- --nocapture` with isolated `MEMOS_DESKTOP_HOME`.
- **`release`** (`[ubuntu-latest, windows-latest, macos-15]`): `cargo build --release`, Linux `cargo test --release --test smoke_bench -- --nocapture`, `--diagnostics` & `--self-test` smoke verification, and release binary upload.
