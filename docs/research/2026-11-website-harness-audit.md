# Website and harness audit, November 2026

Research notes behind the redesign and the harness support added this month.

## Why the old site read as generated

The redesign brief came from a simple observation: the old site was polished
but interchangeable. Three patterns caused that.

1. **The default dev-tool skin.** Pure `#000`, Geist Sans/Mono, a dot grid, a
   top glow, and an all-caps mono kicker above every section. That combination
   is the 2026 house style; it signals "developer tool" without saying anything
   about MemOS.
2. **Generic structure.** Hero, three stat columns, three product cards, an
   inverted guarantee band, a writing list, a final CTA. The order could sell a
   database, a deploy platform, or a note app.
3. **Copy without a testable claim.** "Your agents, with a memory" is true of
   every memory product. The page needed to say what only MemOS does: a SQLite
   file, local tools, artifacts you can inspect.

Sources on the tells:

- InterfaceKit, "What makes a website look AI-generated":
  <https://blog.interfacekit.io/what-makes-a-website-look-ai-generated>
- Design engineering anti-patterns:
  <https://github.com/agentsorg/design-engineering/blob/main/skills/design-engineering/references/anti-patterns/ai-default-tells.md>
- Sites.how, "Make an AI-generated website look genuinely designed":
  <https://sites.how/guides/design-ai-sites>
- 21st.dev, "How to make a site not look AI generated":
  <https://21st.dev/blog/website-not-look-ai-generated>
- WeLoveDaily, "The Vercel aesthetic":
  <https://welovedaily.net/article/vercel-aesthetic-dev-tool-lingua-franca>
- Jeppesen, developer-tool website patterns:
  <https://jeppesen.dev/tools/website-examples/developer-tools/>

## The visual thesis we chose

**An archive at night.** MemOS is a memory index, so the site behaves like a
reading room: warm paper neutrals, a ruled-page texture, squared index cards,
and one oxide accent. The display face is a serif; mono is reserved for
identifiers, commands, and evidence. Headlines are sentence case. Section
labels are serif italic, not tracked-out capitals.

The rules:

- Canvas `#10140f` (warm green-black), not pure black.
- Paper ink `#efe6d3`, oxide `#cf7b52`, sage for quiet success states.
- Spectral for display, IBM Plex Sans for body, IBM Plex Mono for code.
- Zero border radius on cards and buttons; hairlines instead of shadows.
- No gradient text, dot grid, glow, scan line, or scroll-triggered fade-up.
- The hero shows a real memory index and a recalled pack, not a terminal.

## What changed in the code

- `website/app/layout.tsx` loads Spectral, IBM Plex Sans, and IBM Plex Mono.
- `website/app/globals.css` defines the warm palette, type roles, squared
  surfaces, and removes the old motion/glow utilities.
- `website/app/page.tsx` rewrites the hero copy and removes numbered section
  labels that implied a sequence where there was none.
- `website/app/_components/HeroDemo.tsx` is now a paper index with provenance
  and a recalled pack.
- `website/app/_components/Reveal.tsx` is a static wrapper; no IntersectionObserver
  fade on every section.
- `website/app/_components/PageBackground.tsx` is two architectural rules, not
  a particle field.

## Docs comparison

Supermemory's docs open with a platform choice: developer platform, plugins and
MCP, self-hosting, then product features. Their navigation is grouped by job,
not by file. MemOS had a flat 25-item list and no reference for most of its
surface.

The MemOS docs now use:

- **Start here** (overview, install, first memory, harness matrix)
- **Concepts** (memory model, fidelity, time, feedback)
- **Guides** (operations, ingestion, preferences, sync, integrations)
- **Reference** (generated CLI, MCP, HTTP, TypeScript API, compatibility)
- **Operations** (security, runbook, troubleshooting)
- **Benchmarks**

The reference pages are generated from `src/cli-help.ts`, `src/mcp.ts`, and the
FastAPI OpenAPI document. `npm run docs:coverage` reports name-level coverage
for all three surfaces; it is currently 100% for 60 CLI commands, 40 MCP tools,
and 35 HTTP paths / 36 operations.

## Harness usage research

OpenRouter publishes opt-in app attribution at <https://openrouter.ai/apps>.
The 2026-11-01 rolling totals put Hermes Agent first (52.85T tokens), Claude
Code second (44.91T), Kilo Code third (24.53T), pi fourth (16.41T), Codex fifth
(14.03T), Cline sixth (12.96T), omp eighth (9.94T), and OpenClaw ninth (9.80T).
Cursor, Zed, goose, and Roo Code appear lower in the coding category. OpenCode
does not appear because it mostly uses direct inference rather than OpenRouter
attribution.

Caveat: this is traffic, not users or market share. Claude Code, Codex, Cursor,
and OpenCode under-report because most of their inference is first-party.

Sources:

- OpenRouter apps: <https://openrouter.ai/apps>
- OpenRouter top-apps API:
  <https://openrouter.ai/docs/api/api-reference/datasets/top-apps-by-token-usage>
- HarnessMatch usage signals: <https://harnessmatch.dev/usage>
- lagindicator harness ranking:
  <https://lagindicator.com/dev-tools/coding-harness-ranking-2026-09/>

## Harness support decisions

| Harness | Decision | Why |
| --- | --- | --- |
| Claude Code | Keep native plugin; add marketplace docs | Already shipped; high usage |
| Hermes Agent | Add MCP target + root Agent Plugin package | Highest OpenRouter traffic; loads Agent Plugins 1.0.0 |
| Kilo Code | Add `memos connect kilo` | Top-3 coding traffic; distinct `mcp` schema |
| pi | Add `memos connect pi` | Top-5 coding traffic; simple `mcpServers` file |
| Codex | Keep MCP TOML target | Top-5; config already supported |
| Cline | Keep MCP target | Large installed base; marketplace later |
| OpenClaw | Add MCP target + bundle support | Top-10; loads Agent Plugins bundles |
| Zed | Add config snippet | 32.4B tokens; `context_servers` schema |
| goose | Add config snippet | 12.5B tokens; extension recipe |

What we did **not** do: ship native plugins for Kilo, pi, Cline, omp, Zed,
goose, or Roo. Those are MCP integrations. Calling them plugins would be
inaccurate.

## Sources for harness config

- Hermes MCP: <https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference>
- Hermes plugins: <https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins>
- Kilo MCP: <https://kilo.ai/docs/automate/mcp/using-in-kilo-code>
- pi MCP: <https://pi.dev/docs/latest/mcp>
- OpenClaw MCP: <https://docs.openclaw.ai/tools/mcp>
- OpenClaw bundles: <https://docs.openclaw.ai/plugins/bundles>
- Zed MCP: <https://zed.dev/docs/ai/mcp>
- Agent Plugins schema: <https://agent-plugins.org/schemas/1.0.0/plugin.schema.json>
