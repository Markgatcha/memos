# MemFS — a browsable filesystem view of memory

MemFS materializes memories as Markdown files in a stable tree and syncs
edits back. It exists because coding agents are better at `grep`/`ls`/`cat`
than at learning a retrieval API, and because file-based memory has a
measurable advantage on agentic benchmarks.

```bash
memos mount ./memfs              # write the tree
memos mount ./memfs --status     # what would sync change?
memos mount ./memfs --sync       # apply file edits back to the store
```

## Why files

On LongMemEval-V2, a coding agent driving file-based memory scored **74.9%**
versus **42.8%** for RAG over the same store, and beat the same agent with no
memory (69.9%). The interface matters: a tree the agent can browse natively
avoids a tool-selection step and lets the agent follow its own search
instincts.

MemFS is not a replacement for `search()`. It is a second surface over the
same SQLite store:

- `search()` is for ranked recall under a query.
- MemFS is for exploration, grep, bulk review, and editing.

## Layout

```text
memfs/
  .memfs-manifest.json
  default/2026/03/deployment-approvals-<id>.md
  project-alpha/2026/02/rollback-policy-<id>.md
```

Path: `<namespace>/<YYYY>/<MM>/<slug>-<full-id>.md`.

- Namespace and slug are lowercased, diacritic-folded, and reduced to
  `[a-z0-9-]`, so the tree is safe on Windows and POSIX.
- The full id is in the filename, so two memories with the same summary
  cannot collide.
- The month comes from `createdAt` (UTC).
- Once a file is tracked, its path is **stable**: changing a summary or
  namespace does not move it. Only new memories get a new path.

## Frontmatter

```markdown
---
id: 6f0c2f2e-...
namespace: "default"
type: fact
tags: ["deploy", "sre"]
created: 2026-03-15T00:00:00.000Z
updated: 2026-03-16T00:00:00.000Z
importance: 0.7
trust: 0.9
provenance: user
source: "manual"
---

Production deployment runbook requires two SRE approvals.
```

`id` is the identity. A file without an `id` is treated as a new memory.
`namespace`, `type`, `tags`, `created`, and `updated` are read on sync;
the other fields are informational and rewritten from the store.

## The manifest

`.memfs-manifest.json` stores, for every memory:

- the relative path,
- the SHA-256 of the file text at the last sync,
- the memory's `updatedAt` at the last sync.

That pair is what makes sync safe: comparing the file hash tells you whether
the **file** changed; comparing `updatedAt` tells you whether the **memory**
changed. Neither alone is enough.

## Sync semantics

`memos mount --sync` runs three passes:

1. **Files → memory.** For each `.md` file:
   - No `id`, or an `id` not in the store: create a memory, then rename the
     file to its canonical path and write the new id into it.
   - File hash differs from the manifest: update the memory's content and
     tags.
   - File hash matches but the memory is newer: rewrite the file.
2. **Memory → files.** Nodes the file pass did not handle are written,
   including brand-new memories.
3. **Prune (opt-in).** With `--prune`, a tracked file that no longer exists
   deletes its memory. Without `--prune`, the file is recreated — the tree is
   a projection of the store.

### Conflicts

Both sides changed since the last sync:

| `--conflict` | Behaviour |
| --- | --- |
| `memory` (default) | Keep the memory, copy the edited file to `<name>.conflict-<timestamp>.md`, rewrite the canonical file. |
| `file` | Apply the file to the memory. |
| `skip` | Change nothing, count the conflict, and report the path. |

Conflict backups are skipped by later syncs (they do not end in plain
`.md` for matching purposes), so they are safe to inspect and delete.

## Status

```bash
memos mount ./memfs --status --json
```

```json
{
  "tracked": 42,
  "files": 42,
  "pendingWrites": 3,
  "pendingCreates": 1,
  "pendingUpdates": 2,
  "pendingDeletes": 0,
  "conflicts": 0
}
```

`pendingWrites` counts memory-side changes that would rewrite files;
`pendingUpdates` counts file-side edits that would update memories.

## Using it with an agent

Point the agent at the directory. Claude Code, Codex, Cursor, and any tool
with file access can then:

```bash
rg "deployment runbook" ./memfs
ls ./memfs/default/2026/03
cat ./memfs/default/2026/03/deployment-approvals-<id>.md
```

Edits the agent makes are applied with `memos mount ./memfs --sync`.

## Scope and limits

- **Not a live filesystem.** There is no watcher in this version. Run
  `--sync` on demand, or from a shell loop:
  `while true; do memos mount ./memfs --sync; sleep 30; done`.
- **One root per store.** Two roots tracking the same store will diverge;
  the manifest is per-root.
- **Not a backup.** `memos backup` and `memos export` remain the backup and
  interchange formats.
- **Large stores:** export is O(nodes) and writes only changed files after
  the first pass. The manifest is rewritten each sync.
- Markdown is the only format. Binary/image memories are not materialized.

## API

```ts
await memos.memfsExport("./memfs", { namespace: "project:alpha" });
await memos.memfsStatus("./memfs");
await memos.memfsSync("./memfs", {
  prune: false,
  conflict: "memory",
});
```

Exported helpers (`src/memfs.ts`): `memfsRelativePath`, `serializeMemFSNode`,
`parseMemFSFile`, `hashMemFSContent`, `readMemFSManifest`,
`writeMemFSManifest`, `listMemFSFiles`.
