# Operations

How to run a MemOS store over months rather than a demo.

## Backup and restore

```bash
memos backup --out ./backups/memos-$(date +%F).db
memos restore ./backups/memos-2026-11-01.db
```

`backup` uses SQLite's online backup API, so it is safe while the process is
running. If you copy the file manually, stop writes first and include `-wal`
and `-shm`. Test a restore into a scratch `MEMOS_DB_PATH` before you need it.

## Health

```bash
memos doctor
memos health --json
memos diagnostics
```

- `doctor` checks the store, embedding provider, model coverage, and endpoints.
- `health` scores hygiene: contradictions, expired rows, low-confidence share,
  quarantine count, and recall outcomes.
- `diagnostics` reports storage size, per-model vector counts, and index state.

Run `doctor` after changing embedding models. Mixed models mean the semantic
leg only sees part of the store.

## Consolidation

```bash
memos consolidate --dry-run
memos consolidate
memos dream --dry-run
memos dream --schedule daily
```

Consolidation merges near-duplicates, archives stale rows, supersedes decayed
memories (kept as history), and writes cluster summary notes. `dream` adds a
report with merged, superseded, archived, cluster, and contradiction counts.

`--schedule daily` runs in the foreground. For a background job, use cron,
systemd, or Task Scheduler:

```cron
0 3 * * * cd /srv/memos && MEMOS_DB_PATH=/srv/memos/memos.db memos dream --json >> /var/log/memos-dream.log 2>&1
```

Always run `--dry-run` once after upgrading.

## Retention

| Control | What it does |
| --- | --- |
| `ttl` on write | Row expires after N seconds |
| `validTo` | Event-time end; row becomes historical |
| `consolidate --older-than` | Archive rows older than N days |
| `consolidate --min-retention` | Supersede rows below a retention score |
| `forget` / `forgetSource` | Hard delete with a tombstone |
| `archive` | Move rows to the archive pool |

Historical rows are still queryable with `searchTemporal`; archive moves are
reversible through the archive API.

## Embeddings

Default is the zero-dependency Model2Vec table (`potion-base-8M`, 256d). For
better recall, configure Ollama, FastEmbed, Voyage, Cohere, or an
OpenAI-compatible endpoint. After a model change:

```bash
memos reindex-embeddings --purge-stale
memos doctor
```

`--purge-stale` deletes vectors from other models first. Without it, mixed
vectors stay in separate model tables and semantic search sees only the
current model.

## Upgrades

1. Read `CHANGELOG.md` for migrations.
2. Back up the database.
3. Install the new version.
4. Run `memos doctor` and `memos health`.
5. Run `memos consolidate --dry-run`.
6. Re-run the MCP compatibility suite if you maintain a client.

The SQLite schema migrates on `init()`. Downgrades are not supported; restore
the backup instead.

## Multi-harness

One database can serve several harnesses. Use `MEMOS_NAMESPACE` to separate
work, or let each harness write to the shared `default` namespace and use tags
for provenance. `memos handoff` builds a brief for the next harness, including
the profile, a token-budgeted pack, lessons, reminders, and health.

## Observability

- `memos stats` reports in-process token savings.
- `memos usage` is the same data through the HTTP API.
- `memos audit` writes a tamper-chain and provenance report.
- `memos eval` measures retrieval against recent memories or a labelled corpus.

There is no external telemetry endpoint. Export the JSON and ship it to your
own monitoring if you need history.

## Incident checklist

1. Stop writers (`SIGTERM` the server, close the CLI).
2. Copy the database, `-wal`, and `-shm` to a safe location.
3. Run `memos audit --json` and `memos doctor --json`.
4. Check `memos quarantine list` for held writes.
5. If a source is compromised, `memos forget-source <source> --dry-run`, then
   run it for real and keep the certificates.
6. Restore from backup if the file is corrupt; do not edit SQLite by hand.
