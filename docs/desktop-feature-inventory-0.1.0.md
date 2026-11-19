# MemOS Desktop 0.1.0 — feature inventory and demo status

Verified on 2026-11-17 against `apps/desktop-gpui` and a live release build
(`C:\Users\marki\.cargo-target\memos-gpui\release\memos-desktop.exe`) opened on
the 96-memory `rich_final.db` fixture and the curated 96-memory demo store.
"Live" means the surface was exercised in the app, not inferred from code.

## Release framing

- Desktop version: **0.1.0** (preview was 0.0.1)
- CLI/SDK package: unchanged by this release
- Primary platform: Windows x86_64
- Core claim: a native Rust/GPUI window over the local MemOS SQLite store;
  Rust reads are read-only, writes are opt-in and delegated to MCP so
  embeddings, provenance, contradictions, and tamper receipts stay correct.

## New since 0.1.0

| # | Feature | Surface | Status | Evidence / demo notes |
|---|---|---|---|---|
| 1 | Modern MCP client (`server/discover`, per-request `_meta`, `MCP 2026-07-28`, legacy fallback) | Settings → Test connection | Code complete; needs a migrated store to re-verify | `WriteBridge`; the current fixture blocks write mode with the schema-preflight message |
| 2 | Opt-in write mode (off by default) | Settings | Live | Toggle, writer command, Test connection, Reset, footer mode |
| 3 | Schema preflight with human migration message | Settings | Live | "This store predates the writer schema (missing edges.metadata)" |
| 4 | Local writer CLI discovery (`memos` → `dist/cli.js mcp` → `npx`) | Settings | Live | **Use local CLI** button; resolved `node C:\Users\marki\memos\dist\cli.js mcp` |
| 5 | Writer capability preflight and tool-count state | Review, Tools | Live | Prevents raw `-32602` errors; default `npx` exposes 24 tools, local build 42 |
| 6 | New memory composer | Header (write mode) | Code complete; verify on migrated store | Multiline composer, `memos_store`, immediate reload |
| 7 | Edit via supersede | Detail (write mode) | Previously verified | `memos_store` + `memos_supersede`; old version retained with `temporal_precedes` |
| 8 | Forget with confirmation and deletion record | Detail (write mode) | Code complete; verify | Confirmation dialog, `memos_forget` |
| 9 | Document and folder ingest | Header (write mode) | Previously verified | `memos_ingest`, 60 s timeout, native picker, Added/Updated/Unchanged/Removed/Skipped/Errors/Chunks |
| 10 | Review queue with approve/reject | Review workspace | Live in write mode; read-only shows a banner without starting the writer | `memos_review` list/approve/reject; capability card when the tool is missing |
| 11 | Today / Brief workspace | Today | Live | New / Changed / Expiring / Contradictions / **Needs attention**; badges and View all drill-down |
| 12 | Search scopes as removable chips | Search bar | Live | `type:decision` → 24 of 96; commits on trailing space; Backspace removes chips |
| 13 | Keyset pagination past 500 | List | Previously verified | 500 first page + 250 per page; `showing N of total`; row 602 reachable |
| 14 | Five graph modes | Graph | Live | Namespace / Tag / Entity / Temporal / Contradictions; 96 nodes, 95–96 edges |
| 15 | Temporal day columns | Graph → Temporal | Live | One column per date; no single stacked band |
| 16 | Linked List ↔ Graph hover | List + Graph | Code complete; verify in the recording pass | Hover a row, then a node |
| 17 | Graph label LOD, halos, selection ring | Graph | Live | Ambient labels are gated at 85% zoom and capped at six, so dense cluster views show only selected/hovered titles; halos and the 2 px selection ring remain |
| 18 | Sticky detail header | Detail | Code complete; verify by scrolling | 40 px bar after 56 px of scroll |
| 19 | Time block (Created / Updated / Last read / Reads / Expires / Valid from-to) | Detail → Details | Code complete; verify on a recalled memory | "Never recalled" empty state |
| 20 | Receipts and provenance | Detail | Live | Origin, trust, importance, reads, causal lineage, tamper hashes |
| 21 | Dream Diff timeline | Overflow / palette | Live | All 103 / Promoted 2 / Merged 1 / Decayed 1 / Contradiction 1 / Updated 98 |
| 22 | Store Health score and fix cards | Sidebar store card / overflow | Live | 75/100; Contradicting, Stale/drifted, Low-trust; click filters the list |
| 23 | Live memory strip | List | Code complete; verify with a write | New-write count, Jump to newest, Refresh; preserves selection |
| 24 | "What the AI sees" context preview | Detail / palette | Live | 12 items, 680 tokens / 2,720 chars, Copy context |
| 25 | Warm obsidian surface + warm glass | Global | Live | `#12100E` / `#1A1714` / `#221E1A` / `#E8E1D5` / `#C97B4A`; Windows Mica backdrop; alpha glass on palette, popovers, and dialogs with a 1 px top highlight; content rows stay opaque |
| 26 | Unified icon family and tabular numerals | Global | Live | Segoe Fluent/MDL2; no `×`, `[]`, `✦` glyph tells in chrome |
| 27 | Compact 56 px icon rail | Sidebar at 900×600 | Live | Icons with AX labels ("Expand sidebar", "Tools (9 installed)") |
| 28 | Row density (64 / 48 px) | Settings, palette | Live in Settings | Comfortable selected; verify Compact visually |
| 29 | Command palette groups, preview, keycaps, fuzzy highlight | Ctrl/Cmd+K | Live | Recent / Views / Actions / Navigate; **Open Today Brief** and **Open Review Queue** added in 0.1.0 |
| 30 | Settings About, Reveal database, Copy path | Settings | Live | `v0.1.0` + build date; database actions |
| 31 | Window bounds, sort, last view persistence | Settings file | Verified in `settings.json` | `window_bounds`, `last_sort`, `last_view_mode` |
| 32 | App icon | Executable / title bar | Live | Copper seven-block "M"; embedded via `embed-resource` |

## Demo store

A curated 96-memory demo store was generated for the recording at:

`C:\Users\marki\AppData\Local\Temp\opencode\memos-demo.db`

It keeps the fixture's IDs, contradictions, receipts, and tamper chain, but
replaces the 92 placeholder "Design note #N" rows with real MemOS decisions,
architecture facts, and preferences. It has three namespaces, five types, seven
tags, one unresolved contradiction, one quarantined row, one low-trust row, a
recent write burst for Today, and 8-15 reads on the hero memory. It is outside
the repo and should not be committed.

Launch it with:

```powershell
.\memos-desktop.exe --db "$env:TEMP\opencode\memos-demo.db"
```

## Demo blockers still open

These are the things to fix or avoid before recording. They are ordered by how
likely a viewer is to notice them.

### Fixed and verified 2026-11-17

- **Settings scrolling.** Fixed-height dialog + tracked scroll body + shared
  overlay. Verified at 1536×900 and 900×600.
- **First click after a popover or search chip.** Removed the full-window
  dismiss backdrop, dismiss on root mouse-down below the header, and switch nav
  rows on press. Clicking a sidebar view while Filter or a `type:` chip is open
  now dismisses and switches in one click.
- **Ctrl/Cmd+K while a popover is open.** Verified: the palette opens and the
  popover is dismissed.
- **Detail pane wheel scrolling.** The tracked body receives the wheel; the
  sticky header appears after 56 px. Verified at 1536×900.
- **Tools first-click inspector.** Harness rows select on mouse-down; OpenCode
  updates the right pane on the first press.
- **Graph ambient labels.** Gated at 85% zoom and capped at six; fitted cluster
  views are clean.

### Still open

1. **Fit view did not change the zoom** in the live build (stayed at 57% and
   70%). Verify before using it as a beat.
2. **Today's "Needs attention" count does not match Review.** They are
   different concepts; the naming fix reduces the confusion, but do not show
   both counts side by side as if they should agree.
3. **The sidebar tag list has no visible scrollbar.** At 1536 only about two and
   a half of the seven tags are visible; the rest scroll inside the nav column.
   Scroll the sidebar or collapse TAGS before a wide shot; at 1920×1040 all seven
   fit.
4. **The desktop app is untracked in git.** `apps/` is `??` in `git status`.
   Commit and tag `desktop-v0.1.0` before publishing a video or release notes.
   (The plain `v0.1.0` tag belongs to the older SDK/core release.)
5. **The default writer path is hardcoded** in this machine's settings
   (`node C:\Users\marki\memos\dist\cli.js mcp`). A fresh install should
   auto-discover; do not show the path as a product feature.
6. **DeepSeek Harness detection now honors `~/.dsh`.** This machine has no
   `~/.dsh`, so Tools correctly still shows "Not found"; verify on a machine
   with dsh installed before claiming detection on camera.
7. **Opening Review in read-only mode no longer starts the writer.** The view
   now shows the write-mode banner and an empty read-only state instead of
   calling `memos_review`; this removes the `node_tags` duplication path. Review
   listing and approve/reject require Write mode (MCP).

## After the video (not blockers)

These came out of the competitor research and are intentionally out of scope for
0.1.0:

1. **Per-harness read receipts.** Show which harness read a memory, when, and for
   which query. `recall_batches`/`recall_feedback` exist but there is no per-read
   event history. OpenMyMemo makes "who read what" a first-class surface.
2. **One-click undo for AI writes.** `tamper_log` already records the ops; a
   reverse action with a preview would make agent writes safe to try.
   OpenMyMemo ships undo for every AI change.
3. **As-of / believed-at scrubber.** `valid_from`/`valid_to` are already stored
   but only used as filters. A time cursor would make "what did I believe on
   date X" a real surface, matching Zep's two-timeline model.
4. **Layered context bundle with a token budget.** The current preview is a flat
   12-item block. Named layers (always-on, conditional, retrieved) plus a budget
   would match Memorandai's context bundle and make the token number actionable.

## Safe claims for the video

- Native Rust + GPUI, no Electron or WebView.
- Direct SQLite reads are read-only; writes go through MCP.
- MCP `2026-07-28` with `server/discover` and legacy fallback.
- 16 supported harness targets; the exact installed count is machine-specific.
- Capability-aware writer state (tool count, review available or not).
- Local-first; telemetry is opt-in and off by default.
- Five graph modes, receipts, health score, Dream Diff, daily brief.
- "What the AI sees" is an estimate (`chars / 4`), not an exact tokenizer.

## Claims to avoid until verified

- "Fit view always frames the graph."
- "The 24-hour brief" for contradiction/attention sections; say "daily brief".
- "42 tools" as a universal number; it is build-dependent.
- "Screen-reader complete"; say "AccessKit roles/labels and keyboard navigation".
- "Read-only app" when write mode is enabled.
