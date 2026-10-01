# Tamper-evident mutation log

Every memory mutation — `store`, `import`, `update`, `forget` — appends
one entry to an append-only, hash-chained log stored in the `tamper_log`
table of the same database. Each entry records the operation, node ID,
timestamp, the SHA-256 of the node's **full state** at mutation time
(content, tags, importance, metadata, namespace, provenance, validity
window, TTL, timestamps — everything except volatile read stats), and a
`prevHash` linking to the previous entry (genesis entry links to a
fixed domain-separated constant). The chain position `seq` is bound
into the entry hash and assigned atomically by the storage adapter
(tip lookup + hash + insert in one transaction), so concurrent writers
cannot fork the chain.

## Commands

```bash
memos log verify [--expect <hash>]   # verify chain + node contents; exit 1 on tampering
memos log show [--limit N]           # print the N most recent entries
memos log checkpoint                 # print the tip hash to anchor externally
```

`verify` checks three things:

1. **Chain integrity** — sequence continuity (no deleted/reordered
   rows), `prevHash` linkage, and recomputed entry hashes (no edited
   rows, no replayed positions).
2. **DB cross-check** — every node's current full state must match the
   `nodeHash` of its latest log entry. A node edited or deleted
   directly in the DB (bypassing the log) fails here — including
   metadata-only edits to tags, importance, or TTL — as does a node
   resurrected after a `forget` entry.
3. **Checkpoint anchor** (only with `--expect`) — the current tip hash
   must equal the hash you recorded earlier.

Nodes created before the log existed have no entries and are reported
as `unloggedNodes` — informational, not a failure.

## The honest threat model

The log is tamper-*evident*, not tamper-*proof*. It detects:

- edited, deleted, or reordered log rows,
- nodes modified or deleted directly in the database,
- resurrected nodes.

It does **not** stop an attacker with full write access to the database
file from rewriting the entire chain from genesis — no local-only
scheme can. What makes a full rewrite detectable is an **external
checkpoint**: run `memos log checkpoint`, write the tip hash down
somewhere the database writer cannot reach (paper, another machine, a
signed git commit), and later `memos log verify --expect <hash>`
proves the chain still ends where you left it.

## Design notes

- **Fail-open**: logging never blocks a mutation. If the log write
  fails (locked DB, read-only backend, adapter without log support),
  the memory operation still succeeds — the log is evidence, not a
  gate.
- **Storage-level**: the log lives in the database next to the nodes,
  and every `updateNode` path in `MemOS` routes through
  `updateNodeLogged`, so imports, TTL changes, validity edits, tag
  edits, and revert bookkeeping are all covered — not just `store()`.
  Reads are deliberately not logged: retrievals bump `accessCount` /
  `lastAccessed`, and those volatile read stats are excluded from the
  state hash so reads never false-positive at verify time.
- **No secrets in the log**: entries contain hashes only, never
  content. Safe to show, export, or compare without leaking memories.
- Custom `StorageAdapter` implementations can opt out by not
  implementing `appendTamperEntry`/`readTamperLog`; `verify` then
  reports the log as unsupported.

## Schema migration (v1 → v2)

The first-day format hashed only node content (`content_hash`,
sequence not bound into the entry hash). On open, databases with that
schema are migrated automatically: old rows are carried into
`node_hash`, the redundant `content_hash` column is dropped, and new
entries chain onto the old tip with the v2 format. `verify` checks
migrated rows with the legacy v1 algorithm (chain linkage +
content cross-check) and reports their count as `legacyEntries` —
informational, not a failure.
