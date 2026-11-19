# MemOS Desktop UI research — 2026-11-17

Two parallel research passes looked at why MemOS Desktop still reads bland next
to Cap, and what to change without a rewrite. One pass tore down Cap's GPUI
rebuild; the other benchmarked premium desktop apps and GPUI component options.
Both inspected the current 0.1.0 screenshots and `DESIGN.md`. This is a research
artefact, not an implementation log.

## Implemented in the 0.1.0 build

The first pass landed on 2026-11-17:

- Light borders split into `#D8D1C6` / `#EDE8DF`; per-item card strokes removed
  from Today and Review rows.
- Graph type colors retuned to the low-chroma warm palette above.
- Type scale: `32 px` mono Store count, `26/700` page title, `14/500` list row
  title, `12 px` meta, mono numerals on the hero count.
- Store card became the hero: count + label, `4 px` health bar, `28 px`
  Open health control.
- Motion wired: `120 ms` eased list-row hover, `180 ms` page-title transition,
  and GPUI reduce-motion follows the OS / `--no-fun` policy.
- Warm glass pass: Windows requests a Mica backdrop; the palette, popovers, and
  the main dialogs use alpha glass tokens with a 1 px top highlight, 16 px radii,
  and a warm scrim. Content surfaces stay opaque.

## Warm glass research (2026-11-17)

Three follow-up passes checked translucency in GPUI 1.28.1 and the warm-glass
direction.

- **Window material is real and already in the crate.** `WindowOptions`
  exposes `WindowBackgroundAppearance::{Transparent, Blurred, MicaBackdrop,
  MicaAltBackdrop}`. The Windows backend maps Mica to
  `DWMWA_SYSTEMBACKDROP_TYPE = DWMSBT_MAINWINDOW` with a build guard
  (`gpui-windows-…/src/window.rs:918-943`). MemOS now requests `MicaBackdrop`;
  older builds stay opaque.
- **No per-element backdrop blur.** GPUI has no public shader or background
  sample API; the renderer's only blur is the box-shadow SDF. The palette,
  popovers, and dialogs therefore use layered alpha quads, a 1 px top highlight,
  16 px radii, and shadows. Content rows and the graph stay opaque.
- **Readability wins.** Text-heavy surfaces use `glass_panel` alpha 0.98;
  floating palette uses 0.97. The warm scrim is 0.55 dark / 0.28 light. The
  effect is deliberately restrained: glass frames floating work, it does not
  cover the memory list.
- **Fallbacks.** Mica is Win11-only and silently opaque below build 22621;
  transparency effects off / RDP / VM should fall back to the same solid warm
  surface with highlight and shadow intact. No continuous animation; the
  palette entrance is a one-shot 180 ms fade.
- **What not to copy.** Cap's macOS system material is not portable to Windows;
  its shader/blur workarounds are not worth reproducing. No 2021 glassmorphism
  gradients, nested glass, or blur on every card.

Glass sources: [Microsoft Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica),
[Microsoft Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic),
[Zed transparency issue](https://github.com/zed-industries/zed/issues/5040),
local `gpui-windows-gpui-unofficial-1.28.1/src/window.rs:918-943` and
`gpui-unofficial-1.28.1/src/platform.rs:2899-2919`.

## Sources

- Cap GPUI deep dive, 2026-10-21: https://cap.so/blog/rebuilding-cap-in-gpui
- Cap site, changelog, repo: https://cap.so, https://cap.so/changelog/desktop,
  https://github.com/CapSoftware/Cap
- Linear redesign: https://linear.app/now/how-we-redesigned-the-linear-ui
- Zed appearance/theme docs: https://zed.dev/docs/appearance
- Rerun selection/timeline: https://rerun.io/docs/reference/viewer/selection
- Raycast 2.0: https://raycast.com/new
- Warp command palette: https://docs.warp.dev/terminal/command-palette/
- gpui-kit: https://gpui-kit.com/
- Local: `apps/desktop-gpui/DESIGN.md`, `docs/desktop-design-review.md`,
  `website/public/desktop/*.png`

Vendor claims are marked. Values proposed below are recommendations, not
shipped tokens.

## The consensus diagnosis

1. **Everything is a box.** Today, Review, Tools and Context render each row as
   its own 1px rounded card. Ten equal outlines flatten hierarchy. Linear and
   Cratebook use one hairline between regions and spacing inside them.
2. **Two products in one shell.** Dark is flat obsidian rows; light is white
   cards on cream. The copper accent is the only shared identity. Linear
   generates both themes from one hue family rather than hand-tuning two
   palettes.
3. **No typographic voice.** The 12/13 px row titles, 10/11 px metadata, and
   26 px page title sit within one weight. Counts, ages, tags and token
   estimates all read as the same gray. There is no display size and no mono
   face for IDs/shortcuts.
4. **Accent inflation.** `#C97B4A` appears on the primary button, selected bar,
   progress, health, chips and focus ring at once. Premium apps use one
   high-energy signal on roughly 5% of pixels.
5. **Outlines instead of elevation.** In light mode `border` and
   `border_subtle` are effectively the same (`views/mod.rs:132-133`). In dark
   mode the six luminance steps are within ~10% of each other and there are no
   shadows, so nothing floats.
6. **A dead motion layer.** `motion.rs` has 120/180/240 ms tokens, easing, HSL
   interpolation and reduced-motion detection, but the only non-test use is
   `prefers_reduced_motion`. Every hover is a hard cut.
7. **Web-app tells.** The duplicate `MemOS` wordmark (native titlebar + toolbar),
   a centered 600 px search field, seven competing toolbar controls, and bare
   glyph actions (`...`, `→`, `{}`, `↻`) next to the icon family.
8. **The graph is D3 confetti.** Type colors are saturated hues (208/276/34/
   152/184/328/250) against a warm obsidian surface. The graph is the hero
   visual but reads as a different product.
9. **Empty states are zeros.** Review `0` and Contradictions `1` get no
   treatment; a new user learns nothing.
10. **Modals are forms, not surfaces.** The composer stacks six equal-weight
    field groups with actions parked at the bottom right; Cap Settings uses
    section title + one-line description + grouped rows + contextual footer.

## Proposed token system

**Type** — Inter Variable for UI, JetBrains Mono for IDs, counts, ages, tokens.

| Role | Size / line / weight / tracking |
| --- | --- |
| Display | 32 / 40 / 600 / -0.02em |
| Page title | 26 / 32 / 700 / -0.01em |
| Section | 15 / 22 / 600 |
| Row title | 14 / 20 / 500 |
| Body | 14 / 20 / 400 |
| Meta | 12 / 16 / 400, tabular |
| Eyebrow | 10 / 14 / 600, uppercase, 0.08em |

**Spacing** — 4 px base: 4, 8, 12, 16, 24, 32, 48, 64. Panel padding 24, card
padding 16, section gap 32.

**Surface ladder** — depth by luminance step plus a hairline, not stacked
shadows.

- Dark: `L0 #0B0908` canvas, `L1 #12100E` app, `L2 #1A1714` panel,
  `L3 #221E1A` elevated, `L4 #2E2823` floating.
- Light: `L0 #F3EFE8`, `L1 #F9F6F0`, `L2 #FDFBF6`, `L3 #FFFFFF`,
  `L4 #EFE8DC`.
- One shadow for modals/palette only: `0 8px 32px rgba(0,0,0,.35)`.
- Borders max 1 px: structural `rgba(255,255,255,.08)` dark /
  `rgba(60,40,20,.10)` light; strong `#3A322A` / `rgba(40,25,10,.14)`.
- Accent: keep `#C97B4A` fill, add `accent_hot #E8945B` for hover/focus. Reserve
  accent for active, CTA and focus only. 2 px ring + 2 px offset.
- Text contrast: 7:1 primary, 4.5:1 secondary, 3:1 meta.

**Motion** — hover 120 ms, selection 180 ms, modal/panel 240 ms, graph camera
320–480 ms; easing `cubic-bezier(.2,.8,.2,1)`; color/opacity/transform only.
Animate only while a transition is active; never a continuous 60 fps loop.

## Twelve concrete changes

| # | Change | Target | Effort | Impact |
| --- | --- | --- | --- | --- |
| 1 | Retone graph type colors to system hues: fact `#6E9CB8`, preference `#9B8AAE`, decision `#C97B4A`, procedure `#7FA98D`, observation `#6FA8A4`, entity `#B08C6A`, contradiction `#B5614F`, default `#8C8378`; saturation ≤35% | `views/mod.rs:157-174` | S | High |
| 2 | Split light borders: `border #D8D1C6`, `border_subtle #EDE8DF`; remove card strokes | `views/mod.rs:132-133` | S | High |
| 3 | Apply the type scale above; row title 14/500, hero count 32/650, mono for counts/ages | `list.rs`, `views/mod.rs`, `detail.rs` | M | High |
| 4 | Make the Store card the hero: 32 px count, 12 px label, 4 px health bar, 28 px Open health button | `sidebar.rs` | S | High |
| 5 | Remove per-item card borders in Today/Review/Tools/Context; use 32 px section gaps and one hairline | `brief.rs`, `review.rs`, `app.rs` | M | High |
| 6 | One primary action in the toolbar: keep `New memory`; demote Ingest to ghost; List/Graph segmented control with a 180 ms indicator; `…` stays a 32 px icon button | `app.rs` toolbar | S | High |
| 7 | Wire the existing motion tokens: 120 ms hover, 180 ms selection, `ease_out_cubic`, reduced-motion | `motion.rs`, `sidebar.rs`, `list.rs`, `palette.rs` | M | High |
| 8 | Replace bare glyphs with Segoe Fluent at 16 px, add 2 px focus ring, keycap chips (`⌘K`, `?`) | `views/mod.rs`, `palette.rs` | M | Med-high |
| 9 | Sectionize Detail: 10 px eyebrow + hairline per section; Receipts as an elevated card; contradiction as a 1 px `#7A3A32` border + `#2A1A17` wash | `detail.rs` | S-M | High |
| 10 | Designed empty states: 280 px block, 32 px line icon, 15/600 headline, 12 px explanation, one text action | `brief.rs`, `review.rs`, `list.rs` | S | Med |
| 11 | Tighten composer/Tools: 24 px padding, 36 px inputs, two-up Namespace/Context, sticky footer, character count, one-line preview; Tools right pane ≤520 px | `app.rs` | M | Med-high |
| 12 | Graph depth without shaders: node halo r+6 at 12% color, edges `#4A423A` @35%, cluster labels 12/600 with halo, floating legend panel | `graph.rs` | M-L | High |

## Three signature moments

1. **Graph mode morph.** Switching modes animates camera + node positions from
   the cached layout over 320–480 ms, with edge crossfade and one focal bloom.
   The custom painter is cheap; stop requesting frames when the transition ends.
2. **Receipts timeline scrubber.** Render the existing `#1 INSERT → #2 UPDATE →
   #3 PROMOTE` chain as a horizontal rail with clickable dots; hovering a
   receipt highlights its graph node. Static data, zero idle cost.
3. **"What the AI sees" palette.** `Ctrl/Cmd+K` results with a right-hand
   preview of the exact context plus a live token meter. Content is cached text;
   only position/opacity animate.

## First three hours

1. **0–60 min:** tokens only — split light borders, graph type colors, remove
   duplicate wordmark, demote secondary toolbar buttons. Every screenshot
   changes immediately.
2. **60–120 min:** type scale + Store hero + 2 px focus ring + 120 ms hover on
   sidebar/list rows.
3. **120–180 min:** composer density, Receipts elevation + sticky Detail header,
   graph halo/edges/legend. Re-capture the same six screenshots and diff.

## What not to copy

- Cap's content canvas (3D scenes, gradients, color grading) — MemOS is text, and
  GPUI has no public shader/pipeline API.
- macOS Liquid Glass — Cap used the real system material; faking blur on Windows
  needs shaders and patches.
- "Port without redesign" parity — Cap's own post says it still reads like
  Tailwind; component parity is not visual quality.
- Cap's 2,700-line text field / 182k LOC — reuse a vetted component instead.
- Always-on 120 Hz redraw — copy the idle suppression, not the loop.
- Per-item card outlines and equal-weight controls — the two biggest blandness
  causes in the current screenshots.

## Caveats

- Cap's CPU/memory figures are vendor-run on an M4 Max.
- The 56 px rail is confirmed in code but not visible in the supplied captures;
  those show the 280 px admin-tree sidebar.
- `docs/desktop-design-review.md` is partly stale: several of its "six tells"
  (glyph icons, cool blue-gray, page header) are already fixed.
- Proposed hex/type values must be validated in-window at 1536 and 900 before
  committing.
- The current pass enables Mica on the window and glass on floating surfaces, but
  the client toolbar and content stay opaque. A transparent Mica toolbar band is
  the next step and needs a Windows 11 build guard plus a solid Win10 fallback.
