# Reviewer test plan

Prerequisites: Node.js 20+, `npx`, and a terminal. No account or API key. The
Python tests need Python 3.10+ and `pip install -e ".[server]"` from the repo.

Run every command in a temporary directory so the reviewer's real store is
untouched. `MEMOS_DB_PATH` points the CLI at a scratch database.

## Positive tests

### P1 — persistence across a process restart

```bash
npx -y @mem-os/sdk demo
```

Expected: three stores, two searches that return `HIT`, and
`restart proof: memory survived a fresh process`. Exit code 0.
Artifact: `memos demo` uses a temporary database and cleans up.

### P2 — store and recall from the CLI

```bash
export MEMOS_DB_PATH="$PWD/review.db"
npx -y @mem-os/sdk store "The deploy window is Friday at 14:00 UTC" --type fact
npx -y @mem-os/sdk search "when is the deploy window?"
```

Expected: the stored sentence is the top hit with a score. Exit code 0.

### P3 — ingest a folder

```bash
mkdir -p notes
printf '# Runbook\nRollback with kubectl rollout undo.\n' > notes/runbook.md
npx -y @mem-os/sdk ingest notes
npx -y @mem-os/sdk search "how do I roll back?"
```

Expected: `added 1`, and the runbook chunk is returned. Re-running `ingest`
reports `unchanged 1` (incremental, idempotent).

### P4 — MCP modern protocol and tool surface

From a repo checkout:

```bash
npm test -- mcp-modern-protocol mcp-protocol mcp-http mcp-annotations
```

Expected: all suites pass. `server/discover` advertises `2026-07-28`, tools
carry annotations, and the legacy `initialize` fallback still answers.

Manual alternative:

```bash
npx -y @mem-os/sdk mcp --http --port=8788
curl -s http://127.0.0.1:8788/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'
```

Expected: a JSON-RPC result naming protocol revision `2026-07-28`.

### P5 — HTTP auth and a public health route

```bash
export MEMOS_API_KEY="review-token"
python -m memos.server.main &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7400/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7400/api/mem/count
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer review-token" http://127.0.0.1:7400/api/mem/count
```

Expected: `200`, `401`, `200`. Without `MEMOS_API_KEY` the server binds
loopback and serves without auth — intended for local use only.

## Negative tests

### N1 — empty query

```bash
npx -y @mem-os/sdk search ""
```

Expected: a clear validation error, non-zero exit code, no crash report.

### N2 — missing memory id

```bash
npx -y @mem-os/sdk forget does-not-exist
```

Expected: `Memory not found` (or `false`), non-zero exit code or a graceful
message. No stack trace.

### N3 — unauthorized HTTP write

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://127.0.0.1:7400/api/mem/store \
  -H 'content-type: application/json' \
  -d '{"content":"should not be stored"}'
```

With `MEMOS_API_KEY` set, expected `401` and no row written. Verify with an
authorized `count` before and after.

## What not to test

- No payment flow, no sign-up, no email.
- No hosted dashboard. The website is static.
- Embedding downloads are optional; the default Model2Vec table ships with the
  package. A reviewer without network access can still run P1–P3 and P5.

## Support during review

Open an issue at https://github.com/Markgatcha/memos/issues with the
`marketplace-review` label, or email the maintainer through the GitHub profile.
Security reports go through
https://github.com/Markgatcha/memos/security/advisories/new.
