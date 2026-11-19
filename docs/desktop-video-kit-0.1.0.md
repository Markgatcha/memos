# MemOS Desktop 0.1.0 — launch video kit

Prepared 2026-11-17. Companion to
`docs/desktop-feature-inventory-0.1.0.md` and
`apps/desktop-gpui/CHANGELOG.md`.

## Positioning

**One line:** Your AI remembers you. MemOS Desktop lets you see it, check it,
and prove where it came from.

**Release type:** first public 0.1 release of a desktop app, for people who
will install it. Put **0.1.0** on screen in the first 10 seconds and show two or three real
changes, not a tour of every screen.

**Audience:** developers and technical users already using Claude Code, Codex,
Cursor, OpenCode, or another MCP client with MemOS.

## The one real flow

Do not show a feature list. Show one memory's life:

1. A memory exists with a receipt.
2. The store surfaces a contradiction or a stale fact.
3. The user opens **What the AI sees** and sees the exact context a harness
   would receive.
4. A new memory is written through MCP and appears in the live strip.
5. The graph shows where it sits.

That is the product in one pass.

## Master script — 90 seconds

| Time | Picture | Voice / caption |
| --- | --- | --- |
| 0:00–0:06 | Dark 1536×900, All list, slow scroll of real memory titles | "Your AI has a memory about you. Until now, you could only trust it." |
| 0:06–0:12 | Title card: **MemOS Desktop 0.1.0** | "This is the local memory layer, visible." |
| 0:12–0:24 | Store card → Store Health, 75/100, click **Contradicting memories** | "94 memories, one contradiction, one low-trust write. Health is a score with a fix, not a dashboard." |
| 0:24–0:36 | Today → Needs attention → open a memory | "The daily brief shows what is new, what changed, and what needs a decision." |
| 0:36–0:50 | Detail: body, Time block, Receipts & provenance | "Every memory carries a receipt: who wrote it, which harness, how many reads, and the hash chain behind it." |
| 0:50–1:02 | **What the AI sees**: scroll payload, 680 tokens / 2,720 chars, click Copy | "This is the exact context your agent receives, with a token estimate and citations." |
| 1:02–1:14 | Graph: Namespace → Temporal, hover a node, linked list row highlights | "Five ways to see the same store: namespace, tag, entity, time, contradictions." |
| 1:14–1:26 | Write mode: New memory → type → save; count increments; live strip shows the write | "Writes go through MemOS MCP, not raw SQL, so embeddings, provenance, and contradictions stay intact." |
| 1:26–1:30 | End card: **0.1.0** · Windows · local-first · download link | "MemOS Desktop 0.1.0. Your memory, on your machine." |

## 30-second cut

1. **0:00–0:05** — All list + title card.
2. **0:05–0:12** — Detail with Receipts & provenance.
3. **0:12–0:19** — What the AI sees + Copy.
4. **0:19–0:25** — Temporal graph + linked hover.
5. **0:25–0:30** — Write mode + end card.

Vertical 9:16: crop one panel at a time (detail pane, context modal, graph),
never shrink the full 1536×900 frame.

## Shot list

Record in this order so the app state stays predictable. Take each shot twice:
once dark, once light, and keep the dark take as primary.

| Shot | View | Size | Theme | Action | Hold |
| --- | --- | --- | --- | --- | --- |
| 01 | All list | 1536×900 | Dark | Scroll 3 rows, pause on a real title | 4 s |
| 02 | All list | 1536×900 | Light | Same scroll | 3 s |
| 03 | Store health | 1536×900 | Dark | Open, hover a fix card, click Filter | 4 s |
| 04 | Today | 1536×900 | Dark | Scroll sections, open a row | 4 s |
| 05 | Detail | 1536×900 | Dark | Scroll to Time + Receipts | 5 s |
| 06 | What the AI sees | 1536×900 | Dark | Open, scroll payload, Copy | 5 s |
| 07 | Graph Namespace | 1536×900 | Dark | Hover a node, linked row highlight | 4 s |
| 08 | Graph Temporal | 1536×900 | Dark | Hover a column, pause | 4 s |
| 09 | Command palette | 1536×900 | Dark | `Ctrl+K`, type `review`, Enter | 3 s |
| 10 | Review queue | 1536×900 | Dark | Hover a row, show gated actions | 3 s |
| 11 | Tools | 1536×900 | Dark | OpenCode row, show version + connect | 3 s |
| 12 | New memory | 1536×900 | Dark | Type a real sentence, save, live strip | 5 s |
| 13 | Compact rail | 900×600 | Light | Show icons, Today, detail overlay | 3 s |
| 14 | End card | 1920×1080 | Dark | Logo, 0.1.0, URL | 3 s |

Capture at native resolution or higher. Do not upscale a 1536 frame to 4K.
Record 60 fps, H.264, constant frame rate; keep UI text at 100% or 125% Windows
scaling, not fractional.

## Demo dataset

The current `rich_final.db` fixture has 96 nodes but 90 of them repeat
"Design note #N on …". That reads as synthetic in a close-up. Record against a
curated store with:

- 90–120 nodes across `work`, `architecture`, `personal`.
- 5 types: `decision`, `fact`, `preference`, `procedure`, `observation`.
- 5–8 tags, including `#auth`, `#cli`, `#sqlite`, `#security`, `#design`.
- 8–12 entities with real names (MemOS, OpenCode, DeepSeek Harness, SQLite,
  auth-gateway, GPUI).
- One unresolved contradiction pair with a visible "Unresolved" badge.
- One superseded chain (old version still inspectable).
- One low-trust and one quarantined memory.
- One expiring memory inside the next 7 days.
- 8–15 reads on the hero memory so **Last read** and **Reads** are non-zero.
- Receipts on the hero memory: `INSERT`, `UPDATE`, `PROMOTE`.
- A recent write burst (last 24 h) so Today has New / Changed content.
- Dates spread over ~3 months, with most activity in the last 2 weeks.

Keep the demo DB outside the repo:

```powershell
$env:MEMOS_DESKTOP_HOME="$env:TEMP\memos-demo-home"
.\memos-desktop.exe --db "$env:TEMP\memos-demo.db"
```

Do not commit `.db` files. If a seed script is added, put it under
`apps/desktop-gpui/demo/` and generate the database into the temp directory.

## Pre-flight checklist

### Must be true before recording

- [ ] `memos-desktop` version is `0.1.0` and the Settings footer shows it.
- [ ] `cargo fmt --check`, both clippy targets, and both test suites pass.
- [ ] Release binary rebuilt after the 0.1.0 fixes.
- [ ] Settings scrolls at 1536×900 and 900×600; writer buttons reachable.
- [ ] Command palette finds `Open Today Brief` and `Open Review Queue`.
- [ ] First click after a popover/scope dismiss switches views (or avoid the
      sequence in the take).
- [ ] Graph labels do not overlap in the exact zoom used on camera.
- [ ] Demo DB has no repeated placeholder titles.
- [ ] Write mode works on the demo DB (migrated schema; local CLI exposes 42
      tools).
- [ ] `apps/` is committed and tagged `desktop-v0.1.0` before the video goes public.
- [ ] Website `/desktop` screenshots match the recorded build.
- [ ] No local absolute paths (`C:\Users\marki\…`) visible on camera.

### Release assets

- [ ] Windows release `.exe` + `.zip` with the icon embedded.
- [ ] `apps/desktop-gpui/CHANGELOG.md` 0.1.0 entry.
- [ ] Root `CHANGELOG.md` 0.1.0 entry.
- [ ] Regenerated `website/data/changelog.json`.
- [ ] `/desktop` page: 0.1.0 line, fresh dark/light screenshots, download link.
- [ ] 90 s master (16:9, 1080p or 1440p), 30 s cut, 9:16 cut.
- [ ] Captions burned in or `.srt` shipped; most viewers watch muted.
- [ ] End card with version, platform, and one URL.

## Status at 2026-11-17

Verified against the rebuilt 0.1.0 release and the curated demo store:

- Settings now has a fixed dialog height, a tracked scroll body, and the shared
  scroll overlay. Writer controls and database actions are reachable at
  1536×900 and 900×600.
- The palette exposes **Open Today Brief** and **Open Review Queue**.
- Graph ambient labels are gated at 85% zoom and capped at six, so fitted cluster
  views show cluster titles plus the selected/hovered memory only.
- All nine `/desktop` screenshots were recaptured from the 0.1.0 build with the
  curated 96-memory store after the warm visual pass (32 px mono Store count,
  26/700 page title, 14/500 rows, split light borders, retuned graph colors,
  120/180 ms motion) and the warm-glass floating surfaces (Mica titlebar, alpha
  palette/popovers/modals, 16 px radii, 1 px top highlight).
- Desktop version, app changelog, root changelog, and
  `website/data/changelog.json` all report 0.1.0.
- First click after a popover or scope chip now dismisses and switches in one
  click; Ctrl/Cmd+K opens over an open popover.
- Detail wheel scrolling works and reveals the sticky header; Tools selects a
  harness on the first press.
- Graph ambient labels are gated at 85% zoom.

Still open for the recording pass:

- Fit view did not change the zoom in the live build; verify before using it.
- DeepSeek Harness still reports "Not found" on this machine.
- Commit/tag `desktop-v0.1.0` (the plain `v0.1.0` tag is the older SDK/core release).
- Fit view is still open. DeepSeek Harness detection now honors `~/.dsh`; this
  machine has no `~/.dsh`, so it correctly shows "Not found". Read-only Review
  no longer starts the writer, so it cannot duplicate `node_tags`.

## Channel cuts

| Channel | Length | Notes |
| --- | --- | --- |
| Website `/desktop` | 90 s | Autoplay muted, captions, poster = Detail + Receipts |
| GitHub release | 30 s | Loopable, no audio dependency |
| X / LinkedIn | 30 s | 16:9 or 9:16, first frame must show the app |
| Product Hunt | 30 s | Works muted in a feed |
| Docs | 90 s | Full flow, can keep the palette and Tools beats |

## Copy blocks

**Hero:** Your AI remembers you. See what it knows.

**Subhead:** MemOS Desktop 0.1.0 is a native Rust window into your local MemOS
store: receipts, contradictions, a daily brief, five graph views, and the exact
context your agent receives.

**CTA:** Download for Windows · local-first · no account.

## What not to say

- "24-hour brief" for contradiction/attention sections — say "daily brief".
- "42 tools" without "with a local CLI build".
- "Read-only" while write mode is on.
- "Fit view always frames the graph" until it is verified.
- "Accessible" as a blanket claim — say "keyboard navigation and AccessKit
  labels".
