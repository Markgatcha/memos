# Changelog

All notable changes to MemOS Desktop are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the desktop app is
versioned independently from the `@mem-os/sdk` package.

## [Unreleased]

### Added

- **Batch review.** In write mode, tick Review candidates (click or `Space`, or **Select all**) and **Approve N** / **Reject N** after an inline confirmation. Each memory is a separate `memos_review` call through the existing writer, with per-item progress, **Stop after this one**, and an honest summary ("Approved 3 of 4. 1 failed."); failed items stay in the queue. Rows explain why each candidate is pending and flag low confidence. Read-only mode explains instead of showing disabled controls.
- **Persistent pins.** Pins are saved per store in `settings.json` (local UI state, never written to the store or treated as memory metadata), pruned when their memories disappear, reorderable in the pack, shown as a **Pinned** sidebar row, and reachable from the palette (**Show pinned memories**, **Clear all pins**).
- **Export.** **Save…** in the context pack (or `Ctrl/Cmd+E`, or **Export…** in the inspector's More menu) writes the selection, pins or current view (up to 1,000 memories with **No limit**) as Markdown, JSON or text through the native save dialog, atomically and off the UI thread. Without a save dialog it saves to the documents/home folder and says where. Exports carry ids, created/updated dates, namespaces, tags and provenance; Markdown keeps the full id in an HTML comment.
- **Store switcher.** **Switch store…** (palette, Settings) reopens a recent store or browses for one. Candidates are probed read-only before the window switches; nothing is merged or copied. The sidebar summary names the open store, and recent stores appear directly in the palette.
- **Graph card detail.** The selected node's full title and a link breakdown ("1 contradicts · 1 relates to") load lazily; focus mode shows a **Show all** banner and `Esc` leaves it.
- **Reading size.** Standard or large text for the inspector and comparison (Settings, palette), persisted.
- **Ingest plan.** The Ingest dialog checks the path off the UI thread, states in one sentence what will happen, and reports grouped results with **Show ingested**.

- **Context pack builder (`C`).** Replaces the single "What the AI sees" preview. Choose the source (**Selected**, **Current view** in list order, or **Pinned**), a token budget (**1k / 2k / 4k / 8k / No limit**, estimated as chars ÷ 4) and a format (**Plain**, **Markdown**, **Citations** digest, or **JSON**). Memories that do not fit are left out whole and counted; text is never cut. Pin or unpin the selection with `P` or **Pin** in the inspector (session-only, up to 100); the status bar shows `N pinned`.
- **Quick capture (`Ctrl/Cmd+N`, header **Capture**, palette).** One field; `#tag`, `ns:name` and `type:kind` at the start or end become fields, inline hashtags stay in the text and are also tagged. Defaults come from the current filter. `Ctrl/Cmd+Enter` saves through `memos_store`; **More fields…** hands the draft to the full composer. In read-only mode the command explains why and opens Settings.
- **Contradiction comparison (`X`, inspector **Compare**, Today **Compare**).** Side-by-side text, newer / more-trusted markers, aligned fact rows with differences called out, **Open** and **Pin** per side, and **Forget…** per side only in write mode.
- **Search workflow.** **Syntax** popover (`Ctrl/Cmd+/`) lists every scope with an insertable example and the store's most common values as one-click completions, plus the last searches (local, up to 8, clearable). Saved views can be renamed, re-pointed at the current filters, or deleted (two-step) from the sidebar (**Edit** on the active view or right-click) or the palette.
- **Store health action center.** Issues are grouped as *Needs attention*, *Worth a review* and *Good to know*, each with its consequence in plain words and one button to the exact memories (list filter, Today or Review). Includes expired, held-for-review and missing full-text index cases.
- **Graph inspector and focus.** Clicking a node selects it and shows a compact card (type, group, age, links, importance, conflicts) instead of covering the graph with the full inspector; **Open** or `Enter` opens it. **Focus** (`F`) dims everything outside the node's direct neighborhood. Zoom controls (`-`, `+`, `0`) sit bottom-right.
- **Keyboard.** `Ctrl/Cmd+3` Today, `Ctrl/Cmd+4` Review, `I` toggles the inspector without losing the selection; a regrouped shortcut sheet (`?`) covers every key.

### Changed

- **Design system completion.** The full editor, Ingest, Forget, Save view, Settings controls and onboarding buttons now use the shared kit; Forget is an explicit "Keep it / Forget" confirmation. The inspector's copy/citation/graph glyph buttons became one **More** menu, and its receipts and linked memories are hairline sections. Today is ordered as *Needs your attention*, *What changed*, *Coming up*, with a one-line explanation per section. Palette rows ellipsize and no longer repeat a Memory badge.

- **Shared UI kit (`ui/views/kit.rs`).** One set of buttons (primary, secondary, subtle, danger, icon, disabled-with-reason), segmented control, dialog shell, notices, empty states and markers, on a 4 px spacing scale and 11/12/13/14/20 px type scale.
- **List rows.** Real ellipsis, an aligned age column, a type dot, namespace and up to two tags, and at most one state marker (*Quarantined*, *Conflict*, *Low trust*, *Pinned*) spelled out rather than color-only. Rows no longer slide under the overlay inspector.
- **Inspector.** Header shows type and citation with **Pin** and **Context**; a one-line strip summarises namespace, freshness, trust and conflicts; **Edit** and **Forget…** move from the header to below the text.
- **Shell.** The in-app "MemOS" label is gone (the title bar already says it) and search lines up with the content column. The accent-filled **New memory** button became a quiet **Capture**, **Ingest** became an icon button, and the status bar shows the mode as a word with a dot (*View only*, *Editing on*, *Saving…*). Page titles are 20 px everywhere.
- **Sidebar.** Sentence-case sections, a lighter store summary, and the top 8 tags with **Show all**.
- **Command palette.** Sentence-case titles, hidden keyword aliases (e.g. "what the ai sees" finds the context pack), and new actions.
- Monospace text uses each platform's stock face (Consolas, Menlo, DejaVu Sans Mono) instead of Windows-only Consolas.

## [0.1.0] - 2026-11-17

### Added

- **Modern MCP `2026-07-28` client (`WriteBridge`).** Replaced the legacy startup handshake with `server/discover` carrying the `io.modelcontextprotocol/*` `_meta` envelope on `server/discover`, `tools/list`, and `tools/call` (falling back to legacy `initialize` `2025-11-25` only on `-32022`/`-32601`/invalid-envelope errors), tracking negotiated revision, era (`modern`/`legacy`), server info, `ttlMs`, `cacheScope`, tool count, and capability flags.
- **Writer capability preflight & local CLI discovery.** Gates `memos_review`, `memos_ingest`, `memos_audit_answer`, and `memos_explain_recall` on the live `tools/list` inventory so `24`-tool writers show a clear capability card with **Settings** and **Retry** instead of raw `-32602` errors or a false empty Review state. Auto-discovery checks `memos` on `PATH`, then a sibling/repo `dist/cli.js mcp`, then `npx -y @mem-os/sdk mcp`, paired with a **Use local CLI** button and live status line (`Connected · MCP 2026-07-28 · 42 tools · review ✓`) plus mode footer (`Read-only` / `Write mode enabled (MCP ...)`).
- **UI polish.** Simplified the top bar to brand-only `"MemOS"` (removing the duplicate header count), cleaned up Today contradiction card status labels (`"Unresolved"` / `"Open"` without parenthetical duplicates), and added responsive spacing to the Settings footer.
- **Opt-in MCP write mode (`WriteBridge`).** Direct SQLite access in Rust remains
  strictly read-only, while enabling **Write mode (MCP)** in Settings (off by
  default) unlocks creating, editing (via `memos_store` + `memos_supersede`), and
  forgetting (`memos_forget`) memories over newline-delimited JSON-RPC 2.0 stdio
  (`npx -y @mem-os/sdk mcp` default or `memos mcp` override, `MEMOS_DB_PATH`,
  `MEMOS_MCP_TOOLS=all`, 10 s call timeout, Windows `CREATE_NO_WINDOW`).
- **Write UI surfaces.** Settings toggle with command reset and **Test connection**
  ping, primary **New memory** header button, multiline composer modal, Detail
  **Edit** / **Forget** buttons with confirmation dialog, Command Palette write
  actions, footer `write mode` / `read-only` status indicator, immediate DB reload
  after writes, and a non-blocking bridge error banner with **Retry** and **Settings**.
- **Tools matrix parity (16 targets).** Expanded read-only detection and install
  plans to match all 15 `memos connect` targets plus Continue: Claude Code, Codex,
  Cursor, Windsurf, Cline (print-only), OpenCode (2.x nested `mcp.servers.memos`),
  OpenCode 1.x (legacy flat `mcp.memos`), Gemini CLI, Hermes Agent (print-only),
  `.dsh` (`$DSH_HOME` / `~/.dsh`, print-only `memos.patch.yml` without modifying
  `cordis.patch.yml`), Kilo, Pi, OpenClaw (print-only), Zed (print-only),
  Goose (print-only), and Continue, with a scrollable Tools sidebar and
  `Print-only` badges/notes.
- **Sticky detail header.** Scrolling `>= 56 px` in the Detail pane pins a compact
  `40 px` overlay bar with memory type, monospace short ID, copy content, copy
  citation, and click-to-top.
- **Linked list ↔ graph hover.** Hovering a memory row highlights its node/edges
  in Graph view, and hovering a graph node highlights the matching list row.

- **Write hardening (`WriterSchemaPreflight` + humanized errors).** Settings now runs a schema preflight across `nodes.metadata`, `nodes.valid_from/valid_to`, `edges.metadata`, `edges.valid_from/valid_to`, `node_tags`, and `contradictions`; legacy stores keep write mode off with a clear human migration notice (`missing <item>`), raw SQLite/MCP errors map to short actionable messages, and the Settings footer dynamically displays `"Write mode enabled (MCP)"` vs `"Read-only"`.
- **Warm obsidian design pass.** Updated the dark palette (`#12100E` app, `#1A1714` panel, `#221E1A` elevated, `#2E2823` hairlines, `#E8E1D5` text, `#C97B4A` accent), added a pinned sidebar **Store card** with health score bar & **Open health →**, replaced the compact strip with a two-line Page header (`STORE / ALL`, `26 px` title, tabular summary with `last write <age>`, right-aligned Filter/Sort), removed per-row borders, and added **Row density** (`Comfortable 64 px` / `Compact 48 px`) in Settings and the Command Palette.
- **Unified Windows icons & tabular numerals.** Replaced Unicode glyph tells across chrome, detail, composer, modals, and inputs with `UiIcon` (`Segoe Fluent Icons` / `Segoe MDL2 Assets` on Windows with cross-platform symbol fallback) and enabled OpenType `tnum` on counts, scores, and timestamps.
- **Time-surface parity (Desktop + CLI).** Detail `Details` now renders a tabular `Time` block (`Created`, `Updated`, `Last read` showing relative + absolute timestamps or `"Never recalled"`, `Reads`, plus `Expires`, `Valid from`, `Valid to` when set); TypeScript `memos retrieve` text output adds `Updated:` and `Last accessed:`, and Rust `memos show` adds `Last read:`.
- **Today / Brief view.** Added a pure-SQLite daily workspace (`Today` sidebar item with live badge) grouping `New`, `Changed`, `Expiring`, `Contradictions`, and `Needs attention` sections with `View all →` filter drill-down, keyboard `j`/`k`+`Enter` opening Detail, DB watcher refresh, and an empty state (`"Nothing changed in the last 24 hours"` + `"View all memories"`). `New` and `Changed` cover the last 24 hours; `Contradictions` and `Needs attention` are standing issues.
- **Review queue.** Added a `Review` sidebar workspace backed by `memos_review` (`list`, `approve`, `reject`) showing preview, type, namespace, age, confidence, and reason. Write mode (MCP) is required to list candidates; read-only mode shows an `"Enable write mode to review"` banner and never starts the writer. Per-row **Approve** / **Reject** actions activate with Write mode and refresh list, review count, and Store Health immediately.
- **Document & folder ingest (MCP).** When Write mode (MCP) is enabled, the header renders **Ingest** beside **New memory**, opening a modal (`memos_ingest`, 60 s timeout, zero Rust parsing) with path input + native `Browse…` picker, `default`/`documents` namespace presets, extensions, chunk size, recursive toggle, in-flight indicator, `Added`/`Updated`/`Unchanged`/`Removed`/`Skipped`/`Errors`/`Chunks` count badges, sanitized error messages, and **Retry**.
- **Search scopes.** The search input (`"Search memories · type: tag: ns:"`) promotes `type:`, `tag:`, `ns:`, `provenance:`, `has:contradiction`, `is:stale`, `after:YYYY-MM-DD`, `trust:<N`, and `is:quarantined` prefixes into removable pills beneath the search box (`Backspace` on empty text removes the rightmost chip; click removes directly) backed cleanly by `QueryFilter` / `SavedView`.
- **Keyset pagination past 500.** Replaced the hard 500-row ceiling with SQL keyset pagination (`LIST_PAGE_SIZE = 500`, `LIST_NEXT_PAGE_SIZE = 250`) ordered by `(sort_value, id)` across Recency, Importance, Trust, and FTS5 searches, loading additional pages automatically as you scroll or step near the bottom and displaying `showing N of total` in the list header until all matches are loaded.
- **Graph label & halo polish.** Raised the ambient label zoom floor to `0.85` (`GRAPH_AMBIENT_LABEL_MIN_ZOOM`) so dense cluster views show only selected or hovered titles, capped ambient labels at six, added priority collision culling, viewport bounds clamping, `1 px` text halos, and a soft translucent radial halo behind the `2 px` selected node ring alongside `35%`/`70%` edge opacities and synchronized List ↔ Graph hover.
- **Palette navigation to Today and Review.** Added `Open Today Brief` and `Open Review Queue` commands so the two non-list workspaces are reachable from `Ctrl/Cmd+K`, not only from the sidebar.
- **Settings: version and database actions.** The About footer shows the app version and build date, and the Database section adds **Reveal database** and **Copy database path**.

### Changed

- **Warm glass floating surfaces.** Windows now requests a Mica window backdrop,
  and the palette, filter/sort/overflow popovers, and Settings/Health/Tools/
  Composer/Ingest/Context/Dream Diff dialogs use alpha glass tokens, a 1 px top
  highlight, 16 px radii, and a warm scrim. Memory rows and the graph stay
  opaque for contrast; only surfaces that genuinely float are glass.
- **Warm visual refinement.** Split light-mode borders into structural
  `#D8D1C6` and subtle `#EDE8DF`, removed per-item card strokes from Today and
  Review rows, retuned graph type colors to low-chroma warm hues, and sharpened
  the type scale (`32 px` mono store count, `26/700` page title, `14/500` list
  row title, `12 px` meta).
- **Motion tokens wired.** List rows now ease hover in over `120 ms`, the page
  title fades over `180 ms` when the active view changes, and GPUI's
  reduce-motion flag follows the OS preference / `--no-fun`.
- **Modal density & Settings layout.** Health and Settings dialogs widen to `520 px` (`24 px` padding, `56 px` fix rows) with hairline section dividers and left-aligned section actions.
- **Tools detection hardening.** Probes `opencode --version` so OpenCode 2.x vs legacy 1.x do not double-report on the same host (labeling the inactive sibling `"Not detected · legacy"`), and marks `dsh` installed only when `$DSH_HOME` exists or `dsh` is on `PATH`.
- Harness `PATH` scanning now builds a per-directory binary lookup map once per
  discovery call instead of probing every binary × directory combination separately.

### Fixed

- **Read-only Review no longer mutates the store.** Opening Review with write
  mode off now shows the write-mode banner and an empty read-only state instead
  of starting the MCP writer, so `node_tags` cannot be duplicated by a browse.
  Review listing and approve/reject require Write mode (MCP).
- **DeepSeek Harness detection.** The adapter now checks `dsh_dir()`, which
  honors `DSH_HOME` and falls back to `~/.dsh`, instead of requiring the env var
  to be exported into the desktop process.
- **First click after a popover or search scope.** Replaced the full-window
  dismiss backdrop with a root mouse-down handler, and nav rows now switch
  views on press. Clicking a sidebar view while Filter/Sort or a `type:` chip is
  open now both dismisses the overlay and performs the switch in one click.
- **Detail pane wheel scrolling.** Removed the scroll-propagation stop on the
  detail overlay so the tracked detail body receives the wheel; the overlay is
  still occluded from the list. Verified at 1536×900 with the sticky header.
- **Tools inspector on first click.** Harness rows select on mouse-down instead
  of click, and a stale initial inspector request can no longer overwrite the
  current selection, so the right pane updates on the first press.
- **Corrupt window bounds on close.** The bounds observer now ignores
  non-finite, zero, or sub-minimum frames instead of persisting them, so a
  minimized/transitional close cannot save a negative window size.
- **Today section naming.** The heuristic "needs attention" section is now labeled
  **Needs attention** instead of **Needs review**, so it is not confused with the
  MCP-backed Review queue, and the page subtitle reads **Daily brief** because the
  contradiction and attention sections are standing issues rather than 24-hour
  activity.
- **Settings scroll affordance.** The Settings body now tracks its own scroll
  handle and renders the shared vertical scroll overlay, so writer controls and
  database actions stay reachable at `900×600` instead of disappearing under the
  footer.
- `Esc` now reliably dismisses the Keyboard Shortcuts modal (and restores root keyboard focus when opening or closing overlays from the overflow menu).
- Filter popovers cap cleanly to the viewport height at `900×600` with a bottom scroll fade, thumb, and `"Scroll for more"` cue so Provenance and Contradictions facets remain reachable.

## [0.0.1] - 2026-11-15

Internal preview build; superseded by `0.1.0`.

### Added

- **Native read-only explorer.** First public build. Opens a MemOS SQLite store directly through
  bundled SQLite (`rusqlite`), with no Node sidecar, WebView, or Electron. Every
  connection uses `SQLITE_OPEN_READ_ONLY`, `PRAGMA query_only = ON`, and a 5 s
  busy timeout.
- **Onboarding.** Two steps: database selection (detected path, counts, native
  file picker, async validation) and preferences (theme, default view, crash
  reporting). Settings persist atomically.
- **List and search.** Virtualized 500-row list, 120 ms debounced FTS5 search,
  namespace/type/provenance filters, contradiction and stale filters, and three
  sort orders (recency, importance, trust).
- **Detail overlay.** Content-first detail pane with tags, entities, causal
  connections, contradictions, technical metadata, and a copy-citation action.
  Below 1600 px the pane overlays instead of squeezing the list.
- **Receipts and provenance.** Per-memory trust, importance, read count, origin,
  causal lineage, and tamper-log entries with chain hashes, plus a clear empty
  state for unsigned memories.
- **Five graph modes.** Namespace, tag, entity, temporal, and contradiction
  views, with padded Fit view, label level-of-detail, haloed labels, and cluster
  overflow counts.
- **Store health.** 0–100 score with fix cards for contradictions, stale or
  drifted memories, low-trust writes, and duplicates. Every card filters the
  list.
- **Command palette.** Ctrl/Cmd+K with grouped results, fuzzy matching, match
  highlighting, a preview pane, keycap hints, and actions for views, graph
  modes, sorting, theme, health, dream diff, shortcuts, diagnostics, and saved
  views.
- **What the AI sees.** Read-only context preview for the selected memory or the
  current filtered view, with citations, memory content, a character/token
  estimate, and copy.
- **Saved views.** Save the current filter and sort as a named sidebar view;
  duplicate names are suffixed and custom views can be deleted.
- **Live memory strip.** The WAL watcher surfaces newly written memories
  without replacing the active selection, with "Jump to newest" and "Refresh".
- **Dream diff.** Read-only timeline of promotions, merges, decays,
  contradictions, and updates derived from the tamper log.
- **Tools.** Detection and launch plans for Claude Code, Codex, Cursor,
  OpenCode, Gemini CLI, Zed, and Continue, with Connect, Open terminal, Copy MCP
  snippet, and a reviewable confirmation card.
- **Keyboard and accessibility.** j/k and arrow navigation, Enter/Esc, Home/End,
  `?` shortcuts, visible focus rings, and AccessKit roles/labels on rows,
  sidebar views, palette rows, tabs, and modal buttons.
- **Theme integration.** Dark and light palettes, 120–240 ms motion tokens with
  reduced-motion support, and a Windows DWM caption that follows the app theme
  by targeting the visible top-level `Zed::Window`.
- **App icon.** A copper seven-block "M" mark embedded into the Windows
  executable through `embed-resource`, with frames from 16 to 256 px.
- **Persistence.** Window bounds, sort order, last view, theme, saved views, and
  the preferred database path survive a restart.
- **Operations.** Opt-in crash reporting (off by default), scrubbed local crash
  reports, rotating logs, `--diagnostics`, `--startup-report`, `--self-test`,
  and a headless `memos` CLI built from the same core.

### Changed

- Release benchmark tests now serialize the 10k and 50k cases; running them in
  parallel let the 50k setup steal CPU and disk from the 10k p95 gate.
- Filter popovers scroll within the viewport and expose every facet at 900×600.
- Hover state is cleared on window resize.

### Fixed

- Header popovers (Filter, Sort, overflow menu) no longer close in the same
  gesture that opens them.
- Palette recents are filtered by the active query, so a matching command
  cannot lose to a non-matching recent item.
- The detail overlay no longer forwards wheel events to the list behind it.
- Light mode now has a light native title bar.
- Graph labels strip non-hex citation prefixes and stay inside the canvas.

### Security

- Memory text, summaries, tags, and queries are never written to logs,
  analytics, or crash reports. The scrubber removes paths, usernames, and
  hostnames while keeping version, OS/arch, error kind, and an install id.
- Telemetry is opt-in and off by default.

### Known issues

- Direct SQLite access in Rust is read-only. Creating, editing, forgetting,
  reviewing, and ingesting require **Write mode (MCP)** and a writer that exposes
  the relevant tools; the default `npx` package currently exposes 24 tools while
  a local `dist/cli.js mcp` exposes 42.
- Command palette `Open Today Brief` / `Open Review Queue` are new in 0.1.0 and
  have not yet been added to the Keyboard Shortcuts sheet (no default keybinding).
- Opening Review while write mode is off still starts the MCP writer to call
  `memos_review`. On stores that carry both `nodes.tags` JSON and `node_tags`
  rows, that writer pass can duplicate tag rows; the desktop sidebar then shows
  doubled tag counts. Dedupe the store or fix the writer sync before recording.
- Linux and macOS artifacts are built by CI but not signed or notarized.
