# Encrypted Sync

Sync memories between machines using encrypted bundle files. The bundle is
encrypted with AES-256-GCM before it touches disk — your cloud drive, USB
stick, or email never sees plaintext.

## Threat model

**Protected:**

- Every record field — id, content, summary, type, tags, importance,
  timestamps, namespace, metadata, provenance — is encrypted with
  AES-256-GCM (fresh random nonce per record).
- Bundle metadata (`version`, `exportedAt`, `salt`, `recordCount`) is
  plaintext but _authenticated_: it is bound into every record's GCM
  additional authenticated data, so tampering fails decryption.
- The encryption key is derived from your passphrase via PBKDF2 (100,000
  iterations, SHA-256) or read from a key file. It never leaves your devices.

**Not protected:**

- An attacker with the bundle but not the key learns only: bundle
  version, export timestamp, salt, record count, and per-record
  ciphertext sizes.
- An attacker with your passphrase or key file can decrypt everything.
  Choose a strong passphrase.
- Access patterns (when you sync, how many records) are not hidden.

## Usage

### Export

```sh
# Using a passphrase (prompted interactively when run on a TTY)
memos sync export --output ~/Dropbox/memos-sync.json

# …or passed explicitly
memos sync export --output ~/Dropbox/memos-sync.json --passphrase "my-secret-passphrase"

# Using a key file (32-byte raw or 64-char hex)
memos sync export --output sync.json --passphrase-file ~/.memos/sync.key

# Using environment variable
export MEMOS_SYNC_KEY="my-secret-passphrase"
memos sync export --output sync.json
```

Non-interactive contexts (pipes, CI) cannot prompt: pass `--passphrase`,
`--passphrase-file`, or `MEMOS_SYNC_KEY` explicitly.

### Import (on the other machine)

```sh
# Default: skip records that already exist locally
memos sync import --input ~/Dropbox/memos-sync.json --passphrase "my-secret-passphrase"

# Replace local copies with newer incoming versions on ID conflict
memos sync import --input sync.json --passphrase-file ~/.memos/sync.key --strategy last-write-wins
```

Import preserves the original record IDs and timestamps — a record
synced to a second machine keeps its identity there, so a later sync
back recognizes it instead of duplicating it.

### Inspect a bundle

```sh
# Show metadata without decrypting (no key needed)
memos sync status --input sync.json
# Bundle: 42 records, exported 2026-10-01T12:00:00.000Z
# Version: 2
```

## Conflict resolution

| Strategy                  | Behavior                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skip-existing` (default) | Records with IDs already in the local store are skipped. Only new records are imported (with original IDs/timestamps).                                            |
| `last-write-wins`         | If a record exists, the version with the newer `updatedAt` wins and replaces the local copy. On equal timestamps the local copy is kept (deterministic tiebreak). |

In both modes, content-identical records are never duplicated: if any
local record already has the same SHA-256 content hash, the incoming
record is skipped.

## Local-first

The local SQLite database remains the source of truth. Sync is additive:

- Export writes a snapshot of current memories.
- Import merges into the local store, preserving IDs and timestamps.
- Nothing is ever deleted by a sync operation, except the single
  conflicting record replaced under `last-write-wins`.

## Transport

Transport is manual: you move the bundle file yourself — cloud drive,
USB stick, `scp`, email attachment, whatever you like. There is no
network sync backend; the bundle file _is_ the transport, and the
encryption above is what makes untrusted transport safe.

## Bundle versions

Current bundles are **v2**. Version 1 bundles (which left record IDs and
timestamps in plaintext) are rejected on import — re-export from the
source machine with the current memos version.

## Key management

**Passphrase (simplest):**

- Easy to remember and type on a new machine.
- Derived to a 32-byte key via PBKDF2. Use a long, unique passphrase.

**Key file (strongest):**

- Generate: `openssl rand -hex 32 > ~/.memos/sync.key`
- Or raw bytes: `openssl rand 32 > ~/.memos/sync.key`
- Back it up somewhere safe — losing it loses the bundles.
