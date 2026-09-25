# Troubleshooting Playbook

Symptom → diagnose → fix for the failure modes MemOS users actually hit.
Run **`memos doctor`** first — it's the one-command health check for the
store, embedding config, and endpoints, and every entry below tells you
which doctor output to paste into a GitHub issue if you're still stuck.

---

## "Database not found" at a path you expected to work

**Symptom**

A command that touches the database exits with something like:

```
Error: Database not found at /home/you/.memos/memos.db
```

**Diagnose**

The database path resolves in this order: `--db` wins, then
`~/.memos/config.json` (written by `memos init`), then the SDK default
`~/.memos/memos.db`. The error means no file exists at the resolved path —
either MemOS was never initialized here, or the DB lives somewhere else
(`MEMOS_DB_PATH` / `~/.memos/config.json` not in effect for this shell).

**Fix**

- If you never ran setup on this machine: `memos init` — it creates the
  store and saves your path choice.
- If your DB lives elsewhere: pass `--db <path>` (or set `MEMOS_DB_PATH`)
  to every CLI command, including `mcp`.
- If the file was deleted: MemOS can't resurrect it. `memos backup` only
  works while a DB exists — make one _before_ you need it.

**Escalate:** paste the exact error line plus the `Store:` line from
`memos doctor --db <path>`, so the issue shows which path was resolved.

---

## Embeddings silently fell back to local-hash

**Symptom**

Semantic search works but feels no better than keyword search. `memos doctor`
prints something like:

```
Embedding provider: fastembed (fallback — @huggingface/transformers not installed, using deterministic local-hash vectors).
```

**Diagnose**

A bare `new MemOS()` (and the MCP server) enables embeddings by default —
but real local vectors need the optional peer dependency
`@huggingface/transformers`. Without it, MemOS degrades to a deterministic
local-hash embedder with a one-time install warning instead of failing, so
everything _runs_ while the semantic leg is much weaker. Run
`memos doctor` and look at the `Embedding provider:` line — it reports
whether the fallback is active and why.

**Fix**

1. `npm install @huggingface/transformers`
2. Re-embed the store so hash vectors are replaced with real ones:
   `memos reindex-embeddings`
3. Re-run `memos doctor` — the provider line should show no fallback.

**Escalate:** paste the full `Embedding provider:` line from `memos doctor`
and the output of `npm ls @huggingface/transformers` in your project.

---

## Search returns nothing (or weak results)

**Symptom**

`memos search` / `memos_search` misses memories you know exist, or results
got noticeably worse after you switched embedding providers/models.

**Diagnose**

Run `memos doctor` and read the two embedding lines:

- `Only X/Y memories have embeddings.` — partial coverage silently weakens
  the semantic leg (new writes embed; old ones never backfilled).
- `Embeddings from N different models: ...` — vectors from different
  models are never compared against each other, so after a model switch
  the semantic leg only sees the subset embedded with the _current_ model.
- `Embedding endpoint <url> unreachable` — when `MEMOS_EMBEDDING_*` points
  at an OpenAI-compatible server (e.g. `scripts/embed-server.py` or
  `llama-server --embedding`), doctor probes `<baseUrl>/models`; a failure
  means the server isn't up or the URL is wrong, and search falls back to
  keyword-only scoring.
- `Embeddings disabled — semantic search falls back to keyword scoring.` —
  you opted out (`embeddings: { enabled: false }` or the `off` choice in
  `memos init`); this is expected, not a bug.
- `Rerank endpoint <url> unreachable` — rerank is optional; when
  `MEMOS_RERANK_URL` fails, results just use the base ranking. Fix the URL
  or unset it; nothing else is needed.

**Fix**

- Partial coverage: `memos reindex-embeddings`
- After a model switch: `memos reindex-embeddings --purge-stale` (deletes
  the other models' vectors first, then re-embeds everything with the
  current provider)
- Unreachable endpoint: start the embedding server and confirm
  `MEMOS_EMBEDDING_BASE_URL` — or unset the `MEMOS_EMBEDDING_*` vars to fall
  back to local fastembed/hash
- Then re-run `memos doctor` until the model list shows exactly one model
  and coverage is complete.

**Escalate:** paste the `Store:` and `Embedding models:` lines from
`memos doctor`, plus the model/provider you switched from and to.

---

## MCP server runs but the harness doesn't see it

**Symptom**

The server starts (it waits on stdin — that's normal for stdio), but the
harness shows no `memos__*` tools, or it sees an empty/different database
than the CLI does.

**Diagnose**

1. Smoke-test the server itself, bypassing the harness:
   ```bash
   memos mcp --db /tmp/probe.db < /dev/null; echo "exit=$?"
   ```
   Exit `0` with **zero bytes on stdout** means the server starts fine —
   anything printed to stdout would corrupt the MCP stdio protocol, so
   this failing points at a startup problem (native binding, DB path),
   not a harness-config problem.
2. `memos connect <target>` prints the exact JSON config for your harness
   (claude-code, cursor, windsurf, cline, opencode, codex, gemini, generic).
   Check that the `env` block carries `MEMOS_DB_PATH` (if you use `--db`)
   and your `MEMOS_EMBEDDING_*` vars — the server inherits its config from
   those, not from your shell.
3. If tools still don't appear, the harness usually needs a restart
   (e.g. Cursor: "restart Cursor, then enable the memos server in MCP
   settings").

**Fix**

- Use the printed config verbatim, or `memos connect <target> --write` to
  write the file directly (`--force` to overwrite).
- If you use a custom `--db`, re-run `memos connect` so `MEMOS_DB_PATH` is
  baked into the entry — otherwise the harness opens the default
  `~/.memos/memos.db` and sees nothing.
- Restart the harness after changing its MCP config.

**Escalate:** paste the smoke-test result, the harness name/version, the
config entry from `memos connect <target>` (redact nothing — it contains
no secrets), and the `Semantic search probe:` line from `memos doctor`.

---

## "harness merge" results look wrong

**Symptom**

`memos harness merge --from other.db` imports fewer nodes than expected,
reports `remapped` IDs, or errors out.

**Diagnose**

Always start with a dry run — it reports exactly what _would_ happen
without writing anything:

```bash
memos harness merge --from other.db --dry-run --json
```

- Missing `--from` is a usage error, not a bug: the source DB path is
  required.
- `remapped <sourceId> → <targetId>` is normal: the target already had a
  node with that ID, so the import got a fresh one instead of colliding.
- Remember the merge is **point-in-time, not live sync** — memories written
  to the source DB after the merge won't follow.

**Fix**

- Verify the `--from` path is the DB you think it is
  (`memos doctor --db <path>` on it first).
- Run without `--dry-run` once the dry run looks right.
- Re-run the merge later if the source keeps changing (it's a one-shot).

**Escalate:** paste the full `--dry-run --json` output and what you
expected instead.

---

## A memory is stuck in quarantine (false positive)

**Symptom**

A legitimate memory never shows up in recall. Nothing errored — it was
stored, just flagged.

**Diagnose**

The write-gate classifier quarantines prompt-injection-shaped writes; they
stay stored but are excluded from recall until reviewed:

```bash
memos quarantine list          # review queue, most recently flagged first
```

Each row shows the reason. Note that the meta-discussion exemption
(discussing attacks, quoting clichés) only _halves_ signals — one more
signal still quarantines.

**Fix**

```bash
memos quarantine release <id>  # make it recallable again
```

Release preserves the audit trail (`quarantinedAt` / `quarantineReason` stay
on the node, `metadata.releasedFromQuarantine: true` is added). It restores
recall — it does **not** launder trust: the memory still reports
`untrusted_source: true` to agents until a human promotes its provenance
tier. Full policy: [Provenance & Trust](provenance-trust.md).

**Escalate:** paste the quarantine-list row (id + reason) and why you
believe the memory is benign. If the same phrasing keeps getting flagged,
say so — that's classifier feedback.

---

## "memos init" hangs in CI or a non-TTY shell

**Symptom**

`memos init` hangs forever in CI, Docker builds, or piped stdin.

**Diagnose**

The wizard builds an interactive readline prompt for the database path and
provider unless you pass `--yes` — there is no TTY check, so with piped or
closed stdin it waits on the first prompt indefinitely.

**Fix**

- In CI/scripts: `memos init --yes` — accepts all defaults (or keeps the
  existing `~/.memos/config.json`) without prompting.
- Alternatively seed `~/.memos/config.json` directly, or set
  `MEMOS_DB_PATH` / `MEMOS_EMBEDDING_*` — environment variables always
  override the saved config.

**Escalate:** paste the exact command, the CI runner OS, and
`node --version`.

---

## better-sqlite3 native binding errors

**Symptom**

Any command fails immediately on startup with an error like:

```
Could not locate the bindings file ... better-sqlite3
```

or `... was compiled against a different Node.js version`.

**Diagnose**

MemOS stores everything in SQLite via `better-sqlite3` (v13), which ships
N-API prebuilds at `prebuilds/<platform>-<arch>.node` — no compiler needed,
but the prebuild must match your Node version and CPU architecture, and
the package requires **Node ≥ 22**.

**Fix**

1. Use Node 22 or newer (`node --version`).
2. Clean reinstall: delete `node_modules` and run `npm ci` again (this
   resolves most arch/version mismatches).
3. If it persists on an unusual platform, `npm rebuild better-sqlite3`.

**Escalate:** paste `node --version`, `npm --version`, your OS/arch, and the
exact binding error.

---

## An encrypted database won't open

**Symptom**

`memos encrypt` fails with:

```
Error: Encryption requires the optional driver better-sqlite3-multiple-ciphers.
Install it with: npm i better-sqlite3-multiple-ciphers
```

or commands against an encrypted DB fail to open it.

**Diagnose**

Encryption is opt-in: `memos encrypt` / `memos decrypt` need the optional
cipher driver (the default driver can't read encrypted files), and every
other command opens the store with `--key <key>` or the `MEMOS_KEY`
environment variable. `memos encrypt` keeps the original as
`<path>.plaintext.bak`.

**Fix**

- Install the driver: `npm i better-sqlite3-multiple-ciphers`
- Pass the key explicitly: `--key <key>` or set `MEMOS_KEY`.

**Escalate:** paste the exact error and whether the DB was encrypted with
`memos encrypt` — never paste the key itself.
