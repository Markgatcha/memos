# Reviewer notes

## Data handling

- Memories live in a SQLite file chosen by `MEMOS_DB_PATH`, default
  `~/.memos/memos.db`.
- The npm package does not phone home. There is no telemetry endpoint, no
  analytics key, and no hosted control plane.
- The optional HTTP server binds `127.0.0.1`. Set `MEMOS_API_KEY` to require a
  bearer token; `/health`, `/docs`, `/redoc`, and `/openapi.json` stay public.
- Document ingestion reads only the path passed on the command line.
- npm, GitHub, and Discord are third parties with their own policies.

## Credentials

None are required for the core product. A reviewer does not need an API key,
account, or invitation. If an LLM-backed feature is tested, the reviewer uses
their own provider key; MemOS never ships one.

## Security model

- The write gate screens instruction-like content locally (pure regex/score, no
  LLM) and stores flagged rows quarantined, not recalled by default.
- Source-scoped deletion writes hash-chained tombstones and returns
  proof-of-forgetting certificates.
- The MCP surface annotates destructive and idempotent tools so hosts can ask
  for consent.
- Full policy: https://context-core.dev/security

## Support

- Issues: https://github.com/Markgatcha/memos/issues
- Discord: https://discord.gg/DyQGgPuueu
- Security: https://github.com/Markgatcha/memos/security/advisories/new
