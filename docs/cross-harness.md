# Cross-Harness Memory Sync — "One Memory, Every Harness"

MemOS ships as a plugin for many agent harnesses (Claude Code, Cline,
Codex, Gemini CLI, OpenClaw, …), but the memory itself was never tied to
any of them. This feature makes that explicit: **your memory follows
you, not your harness.** Every memory records which harness authored
it, recall can scope to one harness or span all of them, and a separate
harness's database file can be merged into yours.

## The model

Three rules, all deterministic, all shared by every harness:

1. **Attribution, not isolation.** Each memory carries a `harness` tag
   (`"claude-code"`, `"cline"`, `"codex"`, `"gemini-cli"`,
   `"openclaw"`, or `"unknown"`). It says _who wrote this version_ —
   it never restricts who can read it. Default recall is
   cross-harness.
2. **Versions keep their own tag.** When harness B updates a memory
   written by harness A, the old version keeps its A tag and the
   replacement carries B. The version ledger stays honest, exactly like
   the bitemporal supersession the temporal-event feature uses.
3. **One resolution system.** Cross-harness duplicates and
   contradictions converge through the _existing_ write-time
   contradiction scan + read-time resolution — deterministic rules every
   harness runs identically. There is no merge-specific adjudication,
   the same way there is no harness-specific event parsing: shared
   deterministic rules are what make independent writers converge.

## Harness detection

`detectHarness()` in `src/harness.ts` is a pure function of the
environment:

1. `MEMOS_HARNESS` — explicit override, wins over everything (also the
   test seam).
2. Known env markers, in priority order: `CLAUDECODE` /
   `CLAUDE_CODE_*` → `claude-code`, `CLINE_*` → `cline`,
   `CODEX_*` → `codex`, `GEMINI_*` → `gemini-cli`,
   `OPENCLAW_*` → `openclaw`.
3. Fallback: `"unknown"`.

Every `store()` stamps the detected harness (overridable per-write via
`store(content, { harness })`). Rows written before this feature existed
are backfilled as `"unknown"` by the schema migration — legacy
databases keep working unchanged, and `"unknown"` behaves as the
unscoped bucket in filters.

## Scoped recall

```ts
// Default: cross-harness, behavior-preserving.
await memos.search({ query: "deploy checklist" });

// Only what Claude Code wrote.
await memos.search({ query: "deploy checklist", harness: "claude-code" });

// Fidelity-level recall honors it too (top-level or via filter).
await memos.recall("deploy checklist", { harness: "cline" });
await memos.recall("deploy checklist", { filter: { harness: "all" } });
```

The scope applies to the keyword leg, the structured leg, and the
semantic (embedding) leg. Citation and MCP output carry the tag, so an
agent can see _where_ a memory came from:

```
[mem:a3f9] → 7f3a…
Type: fact  Source: user_input  Trust: 1
Harness: claude-code
```

## Merging another harness's database

Two harnesses that each kept their own DB file (e.g. a laptop and a
dev container) converge with:

```bash
memos harness list
# Memories by harness (128 total):
#   claude-code      90
#   codex            30
#   unknown          8

# See the plan first — nothing is written:
memos harness merge --from /path/to/other-harness.db --dry-run

# Then merge for real:
memos harness merge --from /path/to/other-harness.db
```

The merge is a faithful row-level import, **not** a re-write:

- Every source node keeps its **id** (so `[mem:hex]` citations keep
  working), timestamps, **bitemporal validity interval**
  (`validFrom`/`validTo`), **provenance tier**, trust score, tags, and
  quarantine state.
- Ids are remapped only on collision (near-impossible with UUIDs; the
  remap is reported), and every incident edge endpoint follows the
  remap. Edges whose relation already exists in the target are skipped.
- Cross-harness **duplicates and contradictions flow through the
  existing machinery**: imported nodes are re-embedded by the local
  provider and registered for the standard write-time contradiction
  scan, so `unresolved` candidates are recorded and `resolved` pairs
  keep their read-time demotion — exactly as if the memories had been
  written locally.

## Honest limitations

- **Merge is SQLite → SQLite.** Both sides must be MemOS `.db` files.
- **Embeddings are re-computed**, not copied: the source DB's vectors
  are left behind and the local provider re-embeds on import (models
  and dimensions can differ between deployments).
- **Citations survive only when ids do.** A remapped id gets a new
  `[mem:hex]` token; the remap is printed and returned in the result.
- **Opening the source DB runs its migrations.** The source file gains
  the additive `harness` column (backfilled `"unknown"`) if it lacks
  it — harmless and idempotent, but it does touch the source file.
- **Detection is env-based.** A harness that sets none of the known
  markers (or a bare SDK process) attributes as `"unknown"`; set
  `MEMOS_HARNESS` in the deployment when the harness is known but
  leaves no marker.
- **No live sync.** Merge is a point-in-time operation. Two harnesses
  writing to the _same_ DB file need no merge at all — that is the
  primary shape, and it works today because every rule on the
  write/read path is deterministic and shared.
