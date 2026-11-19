# MemOS Desktop improvement backlog (November 2026)

Thirty-eight concrete ways to make the Rust/GPUI desktop app feel premium,
finish it as a product, and keep it fast at 100k+ memories.

Each item names the surface it touches and the evidence behind it. External
patterns are cited; repo-specific gaps are grounded in the current source.
Effort is `S` (hours), `M` (1–2 days), or `L` (3+ days).

The app is deliberately read-only. Items that need writes (editing, deleting,
sync) are out of scope unless a future CLI bridge performs them explicitly.

## A. Premium UI and interaction

### A1. Hover-to-peek rows

Hovering a list row for ~200 ms opens a floating card with the title, two or
three content lines, type chip, age, and edge count, without changing
selection. Canario does this for tabs with live previews.

- Evidence: https://rioterm.com/canario
- Effort `M` · Impact high · `ui/views/list.rs`, `ui/views/detail.rs`

### A2. Perceived-instant frame policy

Never show a spinner for work under ~150 ms; keep the previous frame visible
while a filter change resolves; stop requesting frames ~100 ms after the last
input. Cap's GPUI rewrite cut idle wake-ups from 121/s to 1 using this policy.

- Evidence: https://cap.so/blog/rebuilding-cap-in-gpui
- Effort `S` · Impact high · `ui/app.rs` render loop, `ui/motion.rs`

### A3. Settings as a searchable window

Move the settings modal into its own window with a category rail, search, and
per-row reset. Zed chose a window over a tab because settings have their own
conceptual location.

- Evidence: https://zed.dev/blog/settings-ui
- Effort `L` · Impact high · `core/settings.rs`, new `views/settings_window.rs`

### A4. Live appearance preview with Esc-revert

Arrow through themes and density presets and recolor the whole app live;
Enter commits, Esc restores. Canario previews themes as mini terminal cards.

- Evidence: https://rioterm.com/canario
- Effort `S` · Impact medium · `ui/views/mod.rs`, settings window

### A5. Scoped palette prefixes and a settings index

Accept `type:`, `tag:`, `src:`, `view:`, and `mem:` prefixes as filter chips,
and index every setting toggle and keybinding in the palette. Warp's palette
indexes settings and exposes `actions:` scopes.

- Evidence: https://docs.warp.dev/terminal/command-palette/
- Effort `S` · Impact high · `ui/views/palette.rs`

### A6. Type-to-search when nothing is focused

Typing a printable character anywhere in list or graph moves focus into
search. COSMIC Files/Settings shipped this in point releases.

- Evidence: https://system76.com/blog/post/cosmic-epoch-1-updates
- Effort `S` · Impact medium · `ui/app.rs` key routing

### A7. Searchable, rebindable keymap with conflict takeover

Replace the read-only shortcuts modal with a list searchable by action or
chord. If a chord is taken, name the owner and offer to reassign instead of
double-binding.

- Evidence: https://rioterm.com/canario
- Effort `L` · Impact high · `ui/app.rs`, `core/settings.rs`

### A8. Keyboard hint overlay

Label every visible row, graph node, and chip with a home-row letter; type it
to act, Esc cancels, more than 26 targets grow to two keys. This is the most
demo-able premium pattern in the Canario release.

- Evidence: https://rioterm.com/canario
- Effort `M` · Impact high · `ui/views/list.rs`, `ui/views/graph.rs`

### A9. Selection history with back/forward

Keep a bounded ring of `(memory id, view mode, filter)` and bind Alt+←/→. The
right-click menu shows the full stack. Rerun logs and steps through selection.

- Evidence: https://rerun.io/docs/reference/viewer/selection
- Effort `M` · Impact medium-high · `ui/app.rs`

### A10. Linked hover across list, graph, and detail

One `hovered_id` in app state: hovering a graph node highlights its list row
and receipt; hovering a row highlights the node. Rerun shares hover and
selection across every view.

- Evidence: https://rerun.io/docs/reference/viewer/selection
- Effort `M` · Impact high · `graph.rs`, `list.rs`, `detail.rs`

### A11. Progressive graph drill-down

First click selects a namespace/tag cluster and shows a group summary card;
second click drills into the node; a breadcrumb shows the path. Rerun refines
entity → instance over successive clicks.

- Evidence: https://rerun.io/docs/reference/viewer/selection
- Effort `M` · Impact medium · `ui/views/graph.rs`

### A12. Sticky detail header after scroll

When the detail body scrolls past the title, pin a 40 px header with the short
id, type chip, and copy/cite actions; clicking it scrolls to top. Warp only
shows its sticky header after scrolling begins.

- Evidence: https://docs.warp.dev/terminal/blocks/sticky-command-header/
- Effort `S` · Impact medium-high · `ui/views/detail.rs`

### A13. Dockable, serialized panels

Let users dock the detail/side panels left, right, or bottom and persist the
layout per workspace. Zed made panels dock-configurable; gpui-kit ships
serializable `DockArea`/`DockLayout`/`TabGroup`, so don't hand-roll it.

- Evidence: https://zed.dev/blog/parallel-agents · https://gpui-kit.com/
- Effort `L` · Impact medium · `ui/app.rs` layout

## B. Memory surfaces and new ways to see memory

### B1. Contradiction pair diff

For each `contradictions` row show a side-by-side redline: summary, content,
trust, provenance, timestamps, and a "superseded but still marked current"
badge. Today contradictions are only a boolean filter and a detail card.

- Evidence: https://getzep.com/blog/context-graphs-two-timelines-every-fact
- Effort `M` · Impact high · `ui/views/detail.rs`, `core/db.rs`

### B2. As-of / "believed at" cursor

Add a time cursor to `QueryFilter`: `created_at <= T` plus
`valid_from <= T < valid_to` where present. Wire it through list, detail, and
the temporal graph; persist it in saved views. The MCP explorer already has an
as-of scrubber; the desktop app does not.

- Evidence: `docs/mcp-apps-explorer.md`; https://getzep.com/blog/context-graphs-two-timelines-every-fact
- Effort `M` · Impact high · `core/model.rs`, `core/db.rs`, `ui/views/sidebar.rs`

### B3. Deterministic daily brief

A "since you last opened" panel: new, changed, expiring, newly contradicted,
and provenance-less memories, each a jump link. Pure SQL, no model. MemOS has
`brief()` in the SDK but does not surface it in the app.

- Evidence: https://openmymemo.com/ · https://memorandai.com/how-it-works/memory
- Effort `S` · Impact high · new `ui/views/brief.rs`

### B4. Health drill-down, not just a score

The 0–100 score exists; add the fix list behind it: contradiction,
superseded-but-served, stale, orphaned entity, provenance-less, duplicate.
Each count sets a filter. Memrot ships seven deterministic checks in this shape.

- Evidence: https://openmymemo.com/ · https://github.com/oleksiijko/pmb
- Effort `M` · Impact high · `core/health.rs`, `ui/views/sidebar.rs`

### B5. Context preview v2: budget, layers, inclusion reasons

The app now has a context preview with a `chars/4` estimate. Add a token
budget target, named layers (always-on vs conditional), a per-item reason
("matched postgres", "1 hop from #auth"), and copy-as-MCP arguments.
Memorandai labels context layers; Mem0 built a Request Inspector that shows
which memories were added.

- Evidence: https://memorandai.com/ · https://pratham.design/work/mem0-observability
- Effort `M` · Impact high · `core/model.rs`, context modal

### B6. Entity map mode

A graph mode over `entity_index`: entity nodes sized by degree, memories as
leaves, shared-entity edges. Current modes group by namespace, tag, type, and
time, so people/projects are not visible as structure.

- Evidence: https://docs.mem0.ai/platform/features/graph-memory · https://github.com/oleksiijko/pmb
- Effort `M` · Impact high · `core/db.rs`, `ui/views/graph.rs`

### B7. Review inbox (read-only triage)

A derived queue over the health checks with j/k navigation and local
"reviewed" markers kept in settings, never written to the database. Sthayi
exposes a paginated review tool; OpenMyMemo holds AI writes as proposals.

- Evidence: https://sthayi.ai/ · https://openmymemo.com/
- Effort `M` · Impact medium · new `ui/views/review.rs`

### B8. Multi-select and bulk actions

Shift/Cmd range selection, then copy as Markdown, JSON, or a context pack;
export the selection; compare exactly two memories with the B1 diff.

- Evidence: https://openmymemo.com/ · https://sthayi.ai/
- Effort `M` · Impact high · `ui/views/list.rs`, `ui/app.rs`

### B9. Unified receipt timeline

Merge `tamper_log`, `recall_batches`, contradictions, and dream edits into one
chronological rail per memory, with a chain-verification badge. Today the
receipts section shows at most three entries.

- Evidence: https://ghosts.lk/wyrm · https://sthayi.ai/
- Effort `M` · Impact medium · `ui/views/detail.rs`

### B10. Compact memory card for MCP Apps search results

The repo already ships `ui://memos/explorer` with pan/zoom and an as-of
scrubber. Add a single-memory card surface for search tools that reuse the same
payload formatter as the desktop context preview.

- Evidence: `docs/mcp-apps-explorer.md`; https://github.com/modelcontextprotocol/ext-apps
- Effort `L` · Impact high (distribution) · `src/mcp.ts`, one HTML template

### B11. Memory activity heatmap

A GitHub-style calendar of writes, recalls, contradictions, and consolidations
per day, driven by `tamper_log` and `recall_batches`. Click a day to filter the
list or set the as-of cursor. This is the visual companion to the daily brief.

- Evidence: https://openmymemo.com/ · https://memorandai.com/
- Effort `M` · Impact medium · new `ui/views/activity.rs`

## C. Performance and scale

### C1. Keyset pagination past 500 rows

`LIST_PAGE_SIZE = 500` is a hard window with no load-more. Add a
`(sort_key, rowid)` cursor and append pages on scroll. For recency sorts,
order by `rowid` so FTS5 can early-terminate.

- Evidence: `core/db.rs`; Amethyst FTS rewrite https://github.com/vitorpamplona/amethyst
- Effort `M` · Impact high · `core/db.rs`, `ui/views/list.rs`

### C2. FTS5 optimize on segment churn

Run `INSERT INTO nodes_fts(nodes_fts) VALUES('optimize')` in the background
when segment churn is detected. A 100k-doc test saw median latency roughly
double (0.284 → 0.567 ms) before optimize and recover afterward.

- Evidence: https://cstsolution.com/blog/keeping-an-index-fresh
- Effort `S` · Impact medium · `core/db.rs`

### C3. Make the semantic leg opt-in and prefiltered

At 100k × 384-d a float full scan is ~68 ms; int8 is ~17 ms, and preloaded
int8 ~4 ms at recall@20 = 1.0 in one 2025 measurement. Prefilter with FTS or
entity and cap k; keep exact scan as the fallback.

- Evidence: https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite · https://github.com/asg017/sqlite-vec
- Effort `S` · Impact high · `core/db.rs` vector path

### C4. Incremental graph layout

Persist positions keyed by `(mode, node_id)`, freeze known nodes, and place
only new ones. Reusing the repulsion grid cut d3-force runtime by 10–90% at
equal quality; freezing placed vertices is the standard staged approach.

- Evidence: https://github.com/twosixlabs/d3-force-reuse · https://vis.cs.ucdavis.edu/papers/egpgv2008.pdf
- Effort `M` · Impact high · `ui/views/graph.rs`

### C5. Precompute row strings and rank labels once per layout

`render_rows` rebuilds preview, relative age, and tags for every visible row
on every frame; the graph sorts all labels on every paint. Precompute
`SharedString`s at load, refresh ages on a 60 s tick, and rank labels once per
layout. Zed traced drag-scroll cost to `layout_wrapped_line` cache misses.

- Evidence: https://github.com/zed-industries/zed/discussions/24260
- Effort `S` · Impact high · `list.rs`, `graph.rs`

### C6. Idle policy and notify equality guards

GPUI draws on request, but animation timers and unconditional `cx.notify()`
keep the compositor busy. Match Zed's policy: repeated frames for ~1 s after
input, then stop; only notify when state actually changed.

- Evidence: https://zed.dev/blog/120fps
- Effort `S` · Impact medium · `ui/motion.rs`, `ui/app.rs`

### C7. 100k and frame-budget harness

Assert 8.33 ms/frame (120 fps) for a 500-row list plus a 2k-node graph in
release; extend `smoke_bench` to 100k nodes with p50/p95 and RSS budgets.
LongMemEval-V2 scores accuracy and latency together, so latency belongs in the
product claim.

- Evidence: https://xiaowu0162.github.io/longmemeval-v2/
- Effort `M` · Impact high · `tests/smoke_bench.rs`

### C8. Coalesce WAL refresh and skip unchanged health

`start_db_watcher` polls every 1.5 s and, on every WAL change, re-runs the
overview, list query, and full health aggregate. Coalesce bursts (~500 ms)
and skip the aggregate when `(node_count, max(updated_at))` is unchanged.

- Evidence: `ui/app.rs`; `core/db.rs`
- Effort `S` · Impact medium · `ui/app.rs`

## D. CLI parity and product completion

The CLI implements 67 commands (`src/cli-help.ts`). The desktop app exposes a
read-only subset. These items close the gap without giving the app write
access.

### D1. Read-only CLI bridge

Add a "Run a memos command" palette action that shells out to the bundled CLI
for an allowlist of read-only commands (`search`, `plan`, `audit-answer`,
`drift`, `health`, `stats`, `history`, `explain-recall`, `replay`, `digest`,
`eval`, `graph`). Show stdout in a panel with copy/export. Never spawn a write
command.

- Evidence: `src/cli-help.ts`; `apps/desktop-gpui/src/cli.rs`
- Effort `M` · Impact high · `core/`, new `views/cli_panel.rs`

### D2. Plan view

Surface `memos plan` (intent classification + retrieval route) as a read-only
inspector: query, classified intent, chosen tiers, and the budget it would
use. This makes the retrieval engine legible and pairs with the context
preview.

- Evidence: `src/cli.ts`, `docs/feature-roadmap-2026.md`
- Effort `S` · Impact medium · new modal

### D3. Audit-answer / claim checker

Surface `memos audit-answer`: paste an answer, resolve `[mem:...]` citations,
and list per-claim support and coverage. Read-only, deterministic, no model.

- Evidence: `docs/answer-audit.md`
- Effort `M` · Impact high · new modal

### D4. Explain-recall and replay viewer

Show the flight-recorder trace for a query: per-leg candidates, fusion
contributions, rerank deltas, and a config replay diff.

- Evidence: `docs/retrieval-debugging.md`; `src/cli.ts`
- Effort `M` · Impact high · new modal, `core/db.rs`

### D5. Drift radar

A source-freshness view over memories with file/URL sources: last checked,
changed, stale, and never verified, with a filter and a one-click "set
reminder" that writes nothing to the DB.

- Evidence: `docs/drift-detection.md`
- Effort `M` · Impact medium · new `ui/views/drift.rs`

### D6. Parity matrix and deep links

Document which CLI/MCP capabilities exist in the app, and add deep links from
docs/CLI help to the corresponding app view. A generated matrix prevents the
app and CLI from silently diverging again.

- Evidence: `src/cli-help.ts`, `apps/desktop-gpui/README.md`
- Effort `S` · Impact medium · `docs/`, `README.md`

## Cleanup and release hygiene

These are not product features, but they block a credible launch:

- Decide the fate of the deleted `scripts/dataset/**` files. The working tree
  has 97 changes, most of them dataset deletions; either restore the vendored
  datasets, move them to a separate benchmark package, or commit the deletions
  with a note.
- Add `apps/desktop-gpui/CHANGELOG.md` and a desktop section in the root
  changelog; both are missing today.
- Add a docs page for the desktop app and link it from the docs nav, README,
  and website.
- Add a CI check that compares package.json, README, changelog, plugin, server,
  and desktop versions.
- Keep release artifacts and QA screenshots out of the repo; the screenshot
  folders under the Antigravity brain are fine as long as they are not copied
  into `apps/`.

## Suggested sequence

1. **This week:** A2, A12, B1, B2, C1, C5, C8, D6 + cleanup.
2. **Next:** A1, A5, A8, A10, B3, B4, B8, C4, C7, D1.
3. **Later:** A3, A4, A7, A13, B6, B7, B9, B10, B11, C2, C3, D2–D5.

## Caveats

- Vendor performance and adoption numbers are self-reported. Trust ratios,
  not absolutes.
- Several products cited here launched in 2026 and have little independent
  evaluation; use them as design evidence, not market proof.
- GPUI API claims from 2023–24 posts may predate `gpui-unofficial 1.28.1`;
  verify against the crate source before implementing.
- The FTS5, vector, and graph-layout figures come from single-machine tests
  with different hardware and schemas. Re-measure on the 10k/50k fixtures
  before changing defaults.
