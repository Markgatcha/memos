# Round-2 status

Status of `ROADMAP-NEXT-2.md` after the 2026-11-01 implementation pass.

| # | Item | Status | Evidence |
| --- | --- | --- | --- |
| 1 | UMT server | Done | Existing `memos` registry entry enriched (Memory category, env vars, 11 tools, Streamable HTTP); duplicate `servers/memos` removed; `umt list` verified |
| 2 | Multi-manifest plugins | Done | `.cursor-plugin/plugin.json`, `.cursor-plugin/mcp.json`, `gemini-extension.json`; 9 manifests validated |
| 3 | `llms-install.md` | Done | Root file: prerequisites, per-harness snippets, verify, rollback |
| 4 | MCP registry publish | Prepared, blocked | `server.json` validates against the `2025-12-11` schema; publishing needs a verified namespace |
| 5 | Privacy / terms / security | Done | `/privacy`, `/terms`, `/security`; footer links; build verified |
| 6 | Directory packet | Done | `docs/marketplace/`: listing, test plan (5 positive, 3 negative), reviewer notes, screenshots |
| 7 | UMT memory category/default | Done | `memos` is the only Memory-category provider; `umt link memos` documented |
| 8 | Shared config | Done | `docs/umt-integration.md`; UMT writes env placeholders, MemOS reads them |
| 9 | Cross-tool memory skill | Done | `plugin/skills/memos-with-umt/SKILL.md` in UMT |
| 10 | Guardian folded memory | Partial | `foldMemoryPack` / `fold` implemented; token savings measured (20–47%); accuracy run blocked by provider balance |
| 11 | Trigger endpoint | Done | `POST /api/mem/trigger`, `memos_trigger`, `MemOS.trigger()` + tests |
| 12 | Dream consolidation | Done | `memos dream [--schedule daily] [--dry-run]` with report |
| 13 | Overview | Done | `GET /api/mem/overview`, `memos_overview`, core MCP set |
| 14 | Review queue | Done | `review: true` writes, `memos_review`, approve/reject + tests |
| 15 | Knowledge pages | Done | `MemOS.savePage/readPage/listPages/deletePage`, `memos_page`, file-backed definitions |
| 16 | Delete by source | Done | `forgetSource()` + proof-of-forgetting certificates + tests |
| 17 | Per-user brief | Done | `MemOS.brief()`, `memos_brief`, `POST /api/mem/brief` |
| 18 | AI SDK middleware | Done | `memosRecallMiddleware()` + `ingest_documents` tool + tests |
| 19 | Dify / n8n | Done | `integrations/dify` OpenAPI schema, `integrations/n8n` importable workflow |
| 20 | MCP deletion tools | Done | `memos_forget_source`, `memos_deletion_status` |
| 21 | BEAM-10M | Skipped | Per request; dataset/run too large |
| 22 | Floor and ceiling arms | Partial | Floor 2.0%, ceiling 16.0% (free models, 0 errors); memory row is a different model pair; same-model memory run blocked by free-tier limits |
| 23 | Cost per correct answer | Done | 2,306 tokens/correct measured; rate table on `/benchmarks` |
| 24 | Cross-model judge matrix | Skipped | Per request |
| 25 | LoCoMo span aggregation | Done | Post-hoc 1,986q study; top-1 ±1 = +5.5pp for 0.7 turns; artifact |
| 26 | Memory playground | Done | `/playground/memory`, recorded SDK trace, live additions |
| 27 | Homepage MCP copy | Done | Streamable HTTP 2026-07-28 |
| 28 | Methodology links | Done | Benchmark claims link to `/benchmarks#methodology`; unsourced BEAM comparator removed |
| 29 | Per-harness snippets | Done | `/docs/install` + `llms-install.md` |
| 30 | Changelog page | Done | `/changelog` generated from `CHANGELOG.md` |
| 31 | Remote MCP + OAuth | Done (docs) | `docs/remote-mcp.md`: local-only listing note, bearer reverse-proxy setup, OAuth proxy guidance |
| 32 | MCP compatibility | Done | `docs/mcp-compatibility.md`: revisions, 12-month window, SDK pin, test suites |

## Verification at close

- JS: 96 suites / 1,399 tests passed (2 skipped)
- Python: 16 passed
- Root `tsc --noEmit` and `oxlint src` clean
- Website typecheck and static build exit 0
- Plugin manifests: 9 validated
- `llms.txt`: 33 pages, `--check` clean
- `server.json`: schema-valid
- UMT: 54 tests passed; typecheck clean
- Guardian: 324 tests passed; lint/typecheck clean (`format:check` still flags the
  pre-existing `.tmp-shot.ts` scratch file)

## Post-round: website and harness pass (2026-11-01)

- Site redesigned around a warm "archive" system: Spectral / IBM Plex, oxide
  accent, squared index cards, no glow/dot-grid/fade-up. `website/DESIGN.md`
  records the rules.
- Lighthouse on the rebuilt homepage: accessibility 1.0, best practices 1.0,
  SEO 1.0, zero failing audits.
- Docs restructured into Start here / Concepts / Guides / Reference /
  Operations / Benchmarks. Generated references:
  - 60 CLI commands
  - 40 MCP tools
  - 35 HTTP paths / 36 operations
  - `docs/coverage.md`: 100% name coverage on all three surfaces
- New harnesses: `memos connect` targets for Hermes Agent, Kilo Code, pi,
  OpenClaw, Zed, and goose; root Agent Plugins 1.0.0 package (`plugin.json`,
  `mcp.json`, `skills/`) for Hermes and OpenClaw.
- Research notes with sources:
  `docs/research/2026-11-website-harness-audit.md`.

## Open blockers

1. **MCP registry publish (#4)** — needs a DNS-verified namespace or GitHub
   namespace auth. Files are ready.
2. **Same-model floor/ceiling/memory arms (#22)** — the paid provider balance
   is $0 and free tiers rate-limit before 50 questions. Floor and ceiling are
   published with a different answerer and labelled as not subtractable.
3. **Guardian folded-pack accuracy (#10)** — token side measured; the paired
   answer/judge run needs a funded model endpoint.
