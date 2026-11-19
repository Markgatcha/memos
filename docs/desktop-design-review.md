# MemOS Desktop design review (November 2026)

Why the app can read as “made in two minutes with AI”, what the strongest Rust
desktop apps do instead, and the smallest set of changes that fixes it.

## References actually viewed

- **Cratebook** (GPUI component gallery) — warm graphite “Editor” theme, 32 px
  page title with breadcrumb, a summary card with an uppercase micro-label and
  progress bar, quiet 1 px dividers, numbered component sidebar.
  <https://kahwee.github.io/cratebook/>
- **Zed** — restrained type, keycap chips on primary actions, dense panels,
  settings treated as a real surface. <https://zed.dev>
- **Cap** — native window chrome, mode pills, layered surfaces, no web-app
  tells. <https://cap.so/blog/rebuilding-cap-in-gpui>
- **Rerun** — shared hover/selection across views, timeline scrubber, label
  discipline. <https://rerun.io/docs/reference/viewer/selection>
- **Spacedrive** — one strong focal element per screen and an obvious primary
  action. <https://spacedrive.com>

## The six tells

1. **Cool blue-gray surfaces under a warm copper accent.** The dark theme uses
   `#0E1013`, `#15181D`, `#252B35`, `#E7E9EC`. The light theme is warm cream.
   They feel like two different products, and the copper looks pasted on.
2. **Glyph icons.** `×`, `[]`, `✦`, `!`, `+`, and `...` are Unicode characters,
   not an icon set. This is the most obvious “prototype” tell.
3. **No page hierarchy.** Content starts at the top of the list. There is no
   breadcrumb, page title, or one-line summary of the store.
4. **A border around everything.** Per-row separators plus outlined controls
   flatten the surface. Premium apps use a hairline between regions and
   spacing inside them.
5. **Modals are too airy.** Health and settings have large empty areas and
   actions parked at the far right.
6. **The numbers have no shape.** Counts, ages, and token estimates sit in the
   same 12 px gray as metadata. They should use tabular numerals and a step
   more contrast.

## The premium pass

### 1. Warm the dark palette (one file, biggest effect)

`src/ui/views/mod.rs`, dark branch:

| Token | Current | Replace with |
| --- | --- | --- |
| `bg_sunken` | `0x090B0E` | `0x0B0908` |
| `bg_app` | `0x0E1013` | `0x12100E` |
| `bg_panel` | `0x15181D` | `0x1A1714` |
| `bg_elevated` | `0x1B1F26` | `0x221E1A` |
| `bg_floating` | `0x20252E` | `0x28231F` |
| `bg_hover` | `0x161A20` | `0x1F1B17` |
| `bg_selected` | `0x212731` | `0x2A241F` |
| `bg_badge` | `0x1B1F26` | `0x221E1A` |
| `border` | `0x252B35` | `0x2E2823` |
| `border_subtle` | `0x252B35` | `0x241F1A` |
| `border_strong` | `0x343C4A` | `0x3A322A` |
| `text_primary` | `0xE7E9EC` | `0xE8E1D5` |
| `text_secondary` | `0xC2C8D2` | `0xC9C0B2` |
| `text_muted` | `0x98A2B3` | `0xA79D8F` |
| `accent` | `0xE0A46E` | `0xC97B4A` |
| `accent_soft` | `0x1B1F26` | `0x2A211B` |
| `graph_bg` | `0x0E1013` | `0x12100E` |
| `graph_grid` | `0x1B1F26` | `0x221E1A` |

Keep the light palette; it is already warm. This makes dark and light feel like
the same product and makes the copper read as intentional.

### 2. Add a page header

Above the list, 24 px from the top:

```
STORE / ALL                       (10 px, uppercase, muted, 0.08em)
All memories                      (26 px, 600)
96 memories · 14 tags · 3 types · last write 2m ago   (13 px, muted)
```

The count and age use tabular numerals. The header replaces the current
`96 memories` strip; Filter/Sort move to the right of the second line.

### 3. One icon family

Replace every glyph with 14/16/20 px stroke icons at 1.75 px: close, copy,
reveal-in-graph, context/eye, warning, plus, overflow, search, chevron. The
current `[]`, `✦`, and `...` are the most visible offenders. Use the same
family in the palette, detail header, modals, and sidebar.

### 4. Remove per-row borders

Keep one hairline under the header and one between major regions. Rows are
64 px (comfortable) or 48 px (compact), separated by 0 px of border and 16 px
of horizontal padding. Selection keeps the 3 px copper bar plus a quiet
`bg_selected`; hover is `bg_hover` at 120 ms.

### 5. Add a store card

At the top of the sidebar:

```
STORE
96 memories
Health 96 · 3 need review
[================----]
Open health →
```

10 px uppercase label, 20 px number, 3 px progress bar, one text action. This
gives the screen a focal element and makes health a first-class surface instead
of a modal.

### 6. Tighten modals

- Health: 520 px wide, 24 px padding, three fix rows at 56 px, no dead space.
- Settings: 520 px, sections separated by 1 px hairlines, actions left-aligned
  under the section they affect.
- Destructive actions: primary button on the right, danger color only on the
  button, not the whole dialog.

### 7. Motion and focus

- 120 ms hover, 180 ms selection, 240 ms modal; color/opacity only.
- 2 px focus ring in copper with a 2 px offset; never remove it.
- No spinner under 150 ms; keep the previous frame while filtering.

## What to do first

1. Palette + page header + remove row borders (one afternoon, visible
   immediately).
2. Icon family (one day; touches every surface).
3. Store card + modal density (one day).
4. Sticky detail header and linked hover (already queued with the writer pass).

The palette, header, and border changes are the difference between “a dark
admin table” and “a product”.
