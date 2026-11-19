# MemOS Desktop v0.1 — release blockers and next features

Consolidated from four independent reviews on 2026-11-18: a CLI/MCP feature-gap
audit, a signature-differentiator study, a product-completeness audit, and a
critical strategy review. This is the short list to act on, not another backlog.

## Fixed since the reviews

- Review no longer starts the MCP writer in read-only mode; it shows a
  "Review is read-only" state and cannot duplicate `node_tags`.
- DeepSeek Harness detection checks `dsh_dir()` (`DSH_HOME` or `~/.dsh`); this
  machine has no `~/.dsh`, so "Not found" is correct here.
- The build is versioned `0.1.0` with a refreshed build date; the previous
  preview is `0.0.1`.
- Warm glass surfaces, Mica titlebar, version/size/doc consistency, and nine
  current screenshots are in place.

## P0 — do not ship without these

1. **Commit and tag the app.** `git status` still shows `?? apps/`. The entire
   desktop app is untracked, so a desktop tag cannot contain it and the desktop
   CI workflow has never run from a commit. Committed as `desktop-v0.1.0`; the
   existing `v0.1.0` tag belongs to the SDK/core release.
2. **Produce real artifacts.** The website Download button points at Releases,
   but the workflow only uploads a 7-day CI artifact. Add a tag-triggered job
   that uploads a Windows zip (GUI + CLI), macOS/Linux archives,
   `SHA256SUMS.txt`, license, and release notes; state that builds are unsigned.
3. **Fix Fit view.** The live build stays at 56–70% after clicking Fit, while
   the README advertises a padded Fit view. Add a regression test that zooms a
   non-fit viewport, clicks Fit, and asserts the nodes fit with padding.
4. **Keep Review read-only.** Opening Review with write mode off used to start
   the MCP writer and duplicate `node_tags`. It now shows a read-only banner and
   never starts the writer; listing/approve/reject require Write mode. Add a
   test that opening every view leaves the DB hash and `node_tags` count
   unchanged.
5. **Unify attention counters.** "4 need review", Review 0, "Needs attention
   21", and Today 24 come from different definitions. Pick one SQL definition
   for attention/review and drive the store card, Today, Review, and Health from
   it. Remove the duplicate count if it cannot agree.
6. **A first run that reaches live data.** Add an "Open demo store" path with a
   bundled 96-memory sample (or a generated sample), alongside Open existing /
   Create store. A clean machine currently dead-ends at a path and a CLI
   command.

## P1 — the difference between demo and product

- **Export and backup.** Copy the current view as Markdown/JSON and make a
  WAL-consistent database backup. This is the trust baseline for a local store.
- **About / update.** Version is now v0.1.0 and the build date refreshes; add a
  release-notes link and an update check.
- **Designed zero states.** Today/Review/Contradictions/Ask should teach the next
  action instead of showing "0".
- **Shortcut sheet.** Add the new Open Today / Open Review commands, Fit view,
  and write actions; keep it in sync with the keymap.
- **Docs single source of truth.** Graph label policy is 85% / six labels; the
  GUI binary is 18.86 MB; all nine screenshots are current. Remove remaining
  0.40 / top-10 / 18.84 claims.
- **DeepSeek Harness.** Detection now checks `dsh_dir()` (DSH_HOME or `~/.dsh`).
  This machine has no `~/.dsh`, so it correctly shows "Not found"; verify on a
  machine that does.
- **Distribution.** Signing/notarization is post-0.1, but document the SmartScreen
  path and ship checksums now.

## Feature shortlist for v0.1.1 / v0.2

Ranked by the reviews, not by novelty:

1. **Contradiction Court** — side-by-side verdict for a contradiction pair, with
   Keep A / Keep B / Time-split / Quarantine and a tamper-log receipt. Highest
   trust payoff; data already exists.
2. **History timeline** — versions and supersede chain in Detail, built from
   `edges` and `tamper_log`; read-only first, no destructive verbs.
3. **As-of / believed-at** — a scoped time cursor for Detail and the context
   preview, then list/graph. Uses existing `valid_from`/`valid_to`.
4. **Audit-answer** — paste an agent answer, see supported / partial /
   unsupported / contradicted claims via `memos_audit_answer`; capability probe
   already exists.
5. **Export + backup** — table stakes, also a P1.
6. **Ask / retrieval surface** — query to ranked results with keyword, semantic,
   and entity score breakdown; the strongest "memory working" surface, but the
   riskiest to land in three days.
7. **Health report card** — turn the 0–100 score into seven clickable checks
   with exact filters (extend the existing health modal).
8. **Context Budget Composer** — strategy chips and a live diff for "What the AI
   sees".

Explicitly out of scope for v0.1: usage/token dashboards, MemFS, replay,
standalone Plan view, image add/purge, destructive revert execution.

## Definition of done

- `git ls-files apps/` is non-empty; `desktop-v0.1.0` tag; CI green on Windows, macOS,
  and Linux from that commit.
- Clean VM: install, open the demo store, see 96 memories, no CLI commands.
- Read-only invariant: every view opens with zero DB hash / `node_tags` delta.
- One attention definition drives all counters.
- Fit view frames all nodes at 96 and 10k; a regression test proves it.
- Export and backup work; release notes and screenshots match the build.
- `cargo fmt --check`, both clippy targets, tests, release smoke bench, and
  website build all green.

## Sources

- CLI/MCP feature audit: `src/cli-help.ts` (67 commands), `src/mcp.ts` (42 tools),
  `docs/answer-audit.md`, `docs/query-planner.md`.
- Competitor patterns: Zep two-timeline, OpenMyMemo brief/undo, Memorandai
  keystones/context bundle, memrot checks.
- Local evidence: `apps/desktop-gpui` code paths and the nine screenshots in
  `website/public/desktop/`, plus the four 2026-11-18 review reports.
