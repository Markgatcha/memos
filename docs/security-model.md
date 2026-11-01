# Security model

MemOS is local-first, which removes a class of risk but not all of it. This
page states what is protected by default and what the operator must do.

## Defaults

| Surface | Default |
| --- | --- |
| Storage | SQLite at `~/.memos/memos.db`, owned by the current user |
| Network | None for SDK, CLI, and stdio MCP |
| HTTP server | Binds `127.0.0.1:7400` |
| HTTP auth | `MEMOS_API_KEY` bearer token, when set |
| Public HTTP routes | `/health`, `/docs`, `/redoc`, `/openapi.json` |
| Telemetry | None |
| Encryption | Off unless `MEMOS_KEY` / `cipherKey` is set |

The stdio server never opens a listener. The HTTP server is opt-in.

## Write gate

Every write is screened locally with a regex-and-score classifier. Nothing is
sent to a model. Instruction-like content is stored but marked
`quarantined: true`; recall excludes it until a human releases it. The gate is
deliberately additive: it does not silently drop writes.

`quarantineScreen: false` bypasses the gate for trusted bulk operations. Use it
only on data you control.

## Provenance and trust

A memory's tier decides how much the ranker and the host trust it:

- `user-verified` and `user` rank highest.
- `tool-output` and `imported` are marked `untrustedSource` in context packs.
- `agent_inferred` sits in the middle.

The host should confirm low-trust rows before acting on them. An MCP annotation
of `readOnlyHint` is a hint, not a security boundary; a malicious server can
lie about it.

## HTTP deployment

If you bind beyond loopback:

1. Set `MEMOS_API_KEY` to a long random value.
2. Terminate TLS at a reverse proxy.
3. Strip incoming `X-Forwarded-*` and identity headers at the edge.
4. Rate-limit at the proxy.
5. Keep the SQLite file readable only by the service user.

See [Remote MCP and OAuth](remote-mcp.md) for a Caddy/Nginx example and the
OAuth-proxy pattern. MemOS does not ship an OAuth resource server today.

## Deletion and proof

`forget()` and `forgetSource()` write a hash-chained tombstone. `proveForget()`
returns a certificate with the node id, deletion time, content hash, tamper
sequence, and chain link. `verifyForget()` checks the chain. This is evidence
you can hand to an auditor; it is not a backup.

## Encryption at rest

`memos encrypt --db <path> --key <key>` encrypts the database in place with
SQLCipher (requires `better-sqlite3-multiple-ciphers`). Keep the key in the
environment or a secret manager, not in a committed file. `memos decrypt`
removes encryption and keeps a plaintext backup.

## Backups

The database is a single file. Use SQLite's backup API through
`memos backup`, or stop writes and copy the file plus its `-wal` and `-shm`
companions. A raw copy of a live WAL database can be inconsistent.

## What is out of scope

- A compromised local account. If an attacker can read your home directory,
  they can read the database.
- Prompt injection from content you chose to ingest. The write gate reduces
  the risk; it does not make untrusted text safe.
- Multi-tenant isolation. Namespaces are a data boundary, not an ACL. Put
  separate tenants behind separate databases or separate authenticated
  proxies.

Report vulnerabilities through
<https://github.com/Markgatcha/memos/security/advisories/new>.
