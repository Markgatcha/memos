# Task 3 — Kimi K3.1 Pro: premium design pass + agent-readable docs for context-core.dev

**Model:** `zenmux/moonshotai/kimi-k3.1-pro` (1,048,576-token context)
**Repo:** `C:\Users\marki\memos` — the site is **`website/`**
**Branch:** `design/premium-pass` — do not commit to main.

---

Two goals, both required:

1. **A design pass** that makes the site feel more premium while keeping its monochrome identity.
2. **Agent-readable docs** — the "agent mode" pattern Supermemory uses, adapted so it works on a
   static export. This is a real product feature for users whose agents browse the web.

---

## 0. Hard constraints (read before anything else)

### `website/AGENTS.md` — Next.js 16 warning

This Next.js version has breaking changes from what you were trained on. Read the relevant guide
under `website/node_modules/next/dist/docs/` before writing code. Verify, don't assume. Leave the
generated block in `AGENTS.md` intact.

### ⚠️ The site is a static export — this constrains goal 2

`website/next.config.js` sets:

```js
output: "export",
trailingSlash: true,
```

There is **no server**. Therefore the following are **not available** and you must not design
around them:

- ❌ `Accept: text/markdown` content negotiation (no middleware to switch on it)
- ❌ `Link:` / `X-Llms-Txt:` response headers
- ❌ Same-URL dynamic rendering

What **is** available and is what you should build:

- ✅ Static files under `website/public/` served verbatim (`public/llms.txt` already exists)
- ✅ Static routes at build time (a route can export a `.md` file as plain text)
- ✅ `<link rel="alternate" type="text/markdown" href="...">` in page `<head>`
- ✅ A visible **"Agent mode"** toggle in the UI

---

## 1. Verified audit of what exists today

I measured the live site, so do not re-derive these:

| URL | Status |
|---|---|
| `/llms.txt` | **200**, 1,865 chars — exists, but links to HTML pages only |
| `/llms-full.txt` | **missing** |
| `/docs/llms.txt` | **missing** |
| `*/​.md` on any page | **missing** (`.md` variants do not exist) |
| `/docs` with `Accept: text/markdown` | returns **HTML** (31,820 chars) |
| `/sitemap.xml`, `/robots.txt` | present |

Source of truth: `website/public/llms.txt`.

### What Supermemory does (researched, for reference — copy the pattern, not the design)

- `/llms.txt` (8.2 KB) and `/docs/llms.txt` (35.9 KB, **202 pages**) are indexes with one-line
  descriptions per page.
- Every docs page exists as a `.md` twin: `/docs/quickstart` → `/docs/quickstart.md` (21 KB vs
  ~540 KB of HTML on the same route). That is a **~25× token reduction**.
- Every `.md` page **begins** with this directive (top, not bottom — agents truncate from the end):

  ```md
  > ## Documentation Index
  > Fetch the complete documentation index at: https://supermemory.ai/docs/llms.txt
  > Use this file to discover all available pages before exploring further.
  ```

- Their homepage's primary CTA is **"Copy prompt"**: one button that copies a self-contained
  agent prompt into the user's coding agent. Their docs carry an explicit `agents-and-mcp` page
  with a table of three paths (CLI / Skill / Docs MCP).

### Industry consensus (llmstxt.org + agent-docs-spec, 2024–2026)

- `llms.txt` must stay **under 50,000 characters** to fit a single agent fetch.
- Markdown twins are the single highest-impact change; treat the markdown renderer as a second
  pipeline that needs its own QA (it can emit broken links while HTML looks fine).
- Keep individual pages under 50,000 characters; tabbed/dropdown content serializes into blobs.
- **Don't break URLs**; same-host redirects only.

---

## 2. Goal A — agent-readable docs (do this first, it is the concrete feature)

### A1. Markdown twins for every content route

Every route under `website/app/**/page.tsx` that has prose must expose a `.md` sibling returning
`text/markdown`, containing the page's content as clean markdown:

- Per-page index blockquote **at the top** (adapted for ContextCore), then the content.
- No nav, no footer, no scripts, no styling — text and structure only.
- Must include content hidden in tabs/accordions (that is the point).
- Route targets: `/docs`, `/docs/architecture`, `/benchmarks`, `/memos`, `/umt`, `/guardian`,
  `/compare/*`, `/blogs/*`, `/playground`, `/support`.

**Implementation guidance for a static export:** create a route handler or a build-time generator
that emits `out/<route>.md`. If Next's export does not serve `.md` paths cleanly, generate the
files into `public/` or post-process `out/` in a script wired to `pnpm build` — but the result must
be a real static file that returns `text/markdown`. Document which approach you chose and why.

**Single source of truth:** do not hand-maintain two copies of every page. Extract the prose into
a shared module (e.g. `website/lib/content/*.ts`) that both the React page and the markdown
generator read. If that is too invasive for some pages, say so and list them as follow-up.

### A2. Upgrade `/llms.txt` and add `/docs/llms.txt`

- `public/llms.txt`: keep under ~8 KB, point **every** link at the `.md` twin, keep it a true index.
- Add `public/llms-full.txt` if you can produce a single concatenated document under 50,000 chars;
  if it exceeds that, split it (see the nested pattern) and say so.
- Add `public/docs/llms.txt` for the docs subtree.

### A3. Visible "Agent mode"

Add a toggle (nav or docs header) — **"Agent view"** — toggled by a query param (`?agent=1`) so it
is linkable and does not require JS state to be correct on load. In agent view:

- Collapse decorative elements (backgrounds, animations, glow, image cards) to text.
- Render the page as short, dense, scannable markdown-like text.
- Show the `.md` URL prominently with copy button.
- Must be **usable, not merely present**: a reader should get the same facts, faster.

Also add to each page's `<head>`:

```html
<link rel="alternate" type="text/markdown" href="https://context-core.dev/<route>.md" />
```

### A4. A "Copy prompt" entry point (strongly recommended)

Supermemory's homepage leads with it, and it fits ContextCore: one button that copies a
self-contained prompt telling a coding agent how to install and wire MemOS (or UMT / Guardian) into
a project. Keep it factual and copy its API from the repo's own docs — do not invent endpoints.
Put it on the homepage hero as a secondary action, and on `/memos`.

---

## 3. Goal B — design pass (keep it monochrome)

Preserve: pure black `--bg: #000000`, white/zinc greys, hairline `rgba(255,255,255,0.1)` borders,
dot grid with radial mask, single top glow, Geist + Geist Mono, `-0.03em` heading tracking,
`tabular-nums` figures, 11px/0.12em mono uppercase micro-labels. **No colour accents, no decorative
gradients, no new fonts, no rebrand.**

Existing kit to reuse (`website/app/_components/`):
`BenchmarkChart Counter Diagram HeroDemo Navbar PageBackground PageHeader Reveal ServerGrid SpotlightCard StarButton Terminal DiscordIcon GithubIcon XIcon`

Do:

1. **Motion discipline.** No animation may delay first paint of readable text; everything respects
   `prefers-reduced-motion`; total entrance stagger ≤ ~250ms.
2. **Rhythm.** Unify vertical spacing across pages; fix orphans and ragged grids at 375 / 768 / 1440.
3. **Typography.** Consistent heading scale, `text-balance` on display headings, `text-pretty` on
   body copy, no widows.
4. **Depth.** All borders currently read at one weight — introduce a restrained elevation scale
   (monochrome only).
5. **Hero.** The first screen must state the pitch in one glance, with the terminal as proof.
6. **Docs layout.** Study Supermemory's docs IA: left sidebar with grouped sections, right-hand
   on-page TOC, previous/next footer, copy-able code blocks with language tabs. Recreate the
   *structure* in ContextCore's monochrome language.
7. **Accessibility.** Body text ≥ 4.5:1, large text ≥ 3:1, visible focus rings, correct landmarks,
   no `aria-hidden` on interactive elements.

### Out of scope
No rebrand, logo, palette, or font change. No copy rewrites except the facts in §4.

---

## 4. Facts to correct (the site currently understates its own results)

These are exact locations:

- **`app/benchmarks/page.tsx`** (~lines 89, 107, 108, 273, 275) and
  **`app/blogs/beating-supermemory-longmemeval/page.tsx`** (~lines 15, 135-160) quote
  **`96.4% all-evidence@20`** and **`98.3% evidence recall@20`**. Both are stale.
- The blog also lists **`temporal reasoning 99.2%`** — that is a *per-category* number; do not
  present it as the overall figure.

Replace with these verified values:

| Metric | Value |
|---|---|
| LongMemEval-S Hit@20 | **99.4%** |
| LongMemEval-S evidence recall@20 | **99.3%** |
| LongMemEval-S all-evidence@20 | **97.8%** |
| HotPotQA Hit@10 | **99.6%** |
| HotPotQA all-evidence@10 (multi-hop off, default) | **77.8%** |
| HotPotQA all-evidence@10 (multi-hop on) | **93.8%** |

Do not invent numbers. HotPotQA rows only if that page already has a HotPotQA section. Any claim
that MemOS "beats" Supermemory on all-evidence must be softened to **ties** (97.8% vs 97%); the
Hit@20 claim (99.4% vs 97%) stands.

Leave "BEAM-1M recall@10 95.9%" and "77.6% token savings" alone unless you can point at a committed
artifact that contradicts them — in which case flag it in the report instead.

---

## 5. Performance is part of "premium"

```
cd website
pnpm build
```

Report route sizes before/after. No new client-side JS in components that do not need
interactivity; no CLS; no `"use client"` that could be a server component.

---

## 6. Acceptance

1. `cd website && pnpm build` succeeds.
2. For **every** route in A1, the generated `.md` exists and contains that page's real prose
   (spot-check at least five, paste the first 15 lines of two).
3. `curl -sI http://localhost:3000/docs.md`-style check via the built static output: returns the
   file, not a 404 (report the actual command and output you used).
4. `/llms.txt` links all resolve to `.md` files that exist.
5. Agent view reachable at `?agent=1` on `/docs` and `/benchmarks`.
6. `AGENTS.md` unchanged.

---

## 7. Report

- Per-page changelog: page → what changed → why it is more premium.
- The agent-mode architecture: how `.md` is generated, where it lives, and how the single source of
  truth is shared with the React page.
- Markdown-vs-HTML size comparison for at least three pages (token-count proxy).
- Every accessibility issue found and fixed, and any you could not fix.
- Anything deliberately left alone to respect the existing design intent.
- If a change did not clearly help, revert it and say so. Restraint is a feature here.
