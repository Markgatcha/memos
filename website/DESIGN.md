# ContextCore site design rules

The site is an archive, not a terminal. These rules exist so future edits do
not drift back to the default developer-tool template.

## Visual thesis

A warm reading room for machine memory: paper neutrals, ruled texture, index
cards, and one oxide accent. The interface should feel like a catalog you can
inspect, not a dashboard you subscribe to.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| Canvas | `#10140f` | Page background |
| Panel | `#151a14` | Cards, windows |
| Ink | `#efe6d3` | Primary text |
| Muted | `#b9b1a0` | Body copy |
| Quiet | `#918a7b` | Metadata |
| Accent | `#cf7b52` | Links, active nav, primary CTA |
| Line | `rgba(239,230,211,0.16)` | Borders and rules |

Tailwind's `zinc` scale is remapped to this warm palette in `globals.css`, so
existing utility classes inherit the paper neutrals.

## Type

- Display: **Spectral** (serif), weight 400-500, tight tracking.
- Body: **IBM Plex Sans**, 400-600.
- Code and identifiers: **IBM Plex Mono**, 400-500.
- Sentence case everywhere. No tracked-out all-caps labels.
- Section labels are serif italic with a short accent rule, not `// SECTION`.

## Layout

- Asymmetry is allowed. The hero puts the claim on the left and the memory
  index on the right; it is not a centered stack.
- Borders, not shadows. Cards are square and sit on hairline rules.
- One accent, used for action and provenance. Never for decoration.
- Numbers are allowed when they are measured. No ornamental `01 / 02 / 03`
  unless the content is actually a sequence.

## Prohibited

- Pure `#000` canvas or pure white text.
- Purple/indigo gradients, gradient text, glows, dot grids, or scan lines.
- Rounded-everything cards with soft shadows.
- All-caps mono kickers above every section.
- Fade-up animation on every section.
- Generic copy that could sell a CRM ("unlock", "supercharge", "seamless").
- Three equal feature cards with one icon each.
- Stock illustrations or fake customer logos.

## Evidence over decoration

Every benchmark number on the site must trace to a file in `docs/artifacts/`
or `scripts/*-results.json`. The page links to the methodology and says when a
number is not claimed. The design should make the evidence feel like the
product, not a marketing afterthought.

## Accessibility

- Body text meets 4.5:1; metadata at 9px must use `zinc-500` or lighter.
- Focus rings are 1px oxide, visible on every interactive element.
- Do not remove visible text from a link's accessible name; avoid `aria-label`
  that omits visible words.
- Reduced-motion is honored globally.
