# Drift radar

A memory written from a file records `metadata.sourcePath` and
`metadata.sourceHash` at ingest time. If the file changes afterwards, the
memory silently keeps asserting the old version. Drift radar hashes the file
again and tells you which sources moved.

```bash
memos drift --root ./docs
# Drift scan: 12 source(s), 348 memory(s)
#   unchanged 10  drifted 1  missing 1  unreadable 0  unsupported 0
#   [drifted] docs/deploy.md (a1b2c3d4 -> 9f8e7d6c) - 24 memory(s)
#   [missing] docs/retired.md (ENOENT) - 12 memory(s)
```

## Statuses

| Status | Meaning |
| --- | --- |
| `unchanged` | File hash matches the recorded `sourceHash`. |
| `drifted` | File exists but the hash differs. |
| `missing` | File no longer exists (`ENOENT`). |
| `unreadable` | File exists but could not be read (permissions, I/O). |
| `unsupported` | Remote URL, or the memory has no `sourceHash`. |

## CLI

```bash
memos drift [--root <dir>] [--namespace <ns>] [--stamp] [--all] [--json]
```

- `--root` resolves relative `sourcePath` values. Defaults to the current
  directory.
- `--stamp` writes `metadata.drift = { status, checkedAt, expectedHash,
  actualHash }` on every affected memory.
- `--all` includes unchanged sources in text output.

## API

```ts
const report = await memos.detectDrift({
  root: "./docs",
  namespace: "project:alpha",
  stamp: true,
});
```

```ts
interface DriftReport {
  checkedAt: number;
  scanned: number;      // memories carrying a source
  sources: number;      // distinct sources checked
  unchanged: number;
  drifted: number;
  missing: number;
  unreadable: number;
  unsupported: number;
  findings: DriftFinding[];
}
```

Helpers live in `src/drift.ts`: `sourceOf`, `isLocalSource`,
`resolveSourcePath`, `hashSourceBytes`, `checkSource`, `formatDriftReport`.

## Hashing

`hashSourceBytes()` is SHA-256 truncated to the first 32 hex characters —
the same convention as `ingest.ts`. If you change one, change both, or
every source will report as drifted.

## What this is not

- **Not a content diff.** A hash mismatch says "changed", not "the sentence
  you remember was replaced". Chunked documents cannot be compared line by
  line without storing chunk offsets.
- **Not a fetcher.** HTTP(S) sources are reported as `unsupported` rather
  than downloaded. A local-first memory layer should not make surprise
  network calls.
- **Not automatic remediation.** It reports; it does not rewrite or forget.
  Stamp the report and let a review queue or a human decide.
