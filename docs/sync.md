# Encrypted Sync

Sync memories between machines using encrypted bundle files. The bundle is
encrypted with AES-256-GCM before it touches disk — your cloud drive, USB
stick, or email never sees plaintext.

## Threat model

**Protected:**
- Memory content, types, tags, and all other fields are encrypted with
  AES-256-GCM (random nonce per record).
- The encryption key is derived from your passphrase via PBKDF2 (100,000
  iterations, SHA-256) or read from a key file. It never leaves your devices.

**Not protected:**
- Record IDs, timestamps, ciphertext sizes, and record counts are visible
  in the bundle (needed for sync metadata).
- An attacker with your passphrase or key file can decrypt everything.
  Choose a strong passphrase.
- Access patterns (when you sync, how many records) are not hidden.

## Usage

### Export

```sh
# Using a passphrase (you'll be prompted if not provided via flag/env)
memos sync export --output ~/Dropbox/memos-sync.json --key "my-secret-passphrase"

# Using a key file (32-byte raw or 64-char hex)
memos sync export --output sync.json --key-file ~/.memos/sync.key

# Using environment variable
export MEMOS_SYNC_KEY="my-secret-passphrase"
memos sync export --output sync.json
```

### Import (on the other machine)

```sh
# Default: skip records that already exist locally
memos sync import --input ~/Dropbox/memos-sync.json --key "my-secret-passphrase"

# Overwrite with newer versions when IDs conflict
memos sync import --input sync.json --key-file ~/.memos/sync.key --strategy last-write-wins
```

### Inspect a bundle

```sh
# Show metadata without decrypting (no key needed)
memos sync status --input sync.json
# Bundle: 42 records, exported 2026-09-30T12:00:00Z
# Version: 1
```

## Conflict resolution

| Strategy | Behavior |
|----------|----------|
| `skip-existing` (default) | Records with IDs already in the local store are skipped. Only new records are imported. |
| `last-write-wins` | If a record exists, the version with the newer `updatedAt` timestamp wins. |

Content-identical records are never duplicated.

## Local-first

The local SQLite database remains the source of truth. Sync is additive:
- Export writes a snapshot of current memories.
- Import merges into the local store.
- Nothing is ever deleted by a sync operation.

## Key management

**Passphrase (simplest):**
- Easy to remember and type on a new machine.
- Derived to a 32-byte key via PBKDF2. Use a long, unique passphrase.

**Key file (strongest):**
- Generate: `openssl rand -hex 32 > ~/.memos/sync.key`
- Store securely, back it up separately from your bundles.
- The file should contain either 32 raw bytes or a 64-character hex string.

**Never:**
- Commit your key or passphrase to git.
- Store the key alongside the bundles on the same untrusted storage.
- Reuse a passphrase you use elsewhere.

## Example workflow

Machine A (laptop):
```sh
memos sync export --output ~/Dropbox/memos.json --key "correct horse battery staple"
# → Dropbox syncs the encrypted file
```

Machine B (desktop):
```sh
# Wait for Dropbox to sync, then:
memos sync import --input ~/Dropbox/memos.json --key "correct horse battery staple"
# → Import complete: 15 imported, 3 skipped, 0 updated.
```
