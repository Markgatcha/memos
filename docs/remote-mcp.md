# Remote MCP: self-hosting and OAuth

MemOS ships **local-only by default**. There is no hosted MemOS endpoint and no
account. The optional Streamable HTTP transport exists so you can self-host it
for a team or a remote harness.

## Listing note

> MemOS is local-first. The npm package runs on your machine over stdio. An
> optional Streamable HTTP transport binds loopback by default and can be
> self-hosted behind your own TLS and auth. No hosted endpoint is operated by
> the project.

## Self-hosted remote, bearer auth

On the server:

```bash
export MEMOS_DB_PATH=/srv/memos/memos.db
export MEMOS_API_KEY="$(openssl rand -hex 32)"
npx -y @mem-os/sdk mcp --http --port=8788 --host=127.0.0.1
```

Put a TLS reverse proxy in front. The MCP endpoint is `/mcp`; the FastAPI
server's public paths are `/health`, `/docs`, `/redoc`, and `/openapi.json`.

Caddy example:

```caddyfile
memos.example.com {
  reverse_proxy 127.0.0.1:8788
}
```

Nginx example:

```nginx
location / {
  proxy_pass http://127.0.0.1:8788;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
}
```

Clients send:

```
Authorization: Bearer <MEMOS_API_KEY>
```

Verify:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://memos.example.com/health
curl -s -o /dev/null -w "%{http_code}\n" https://memos.example.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'
```

The first should be `200`; the second `401` without the header and `200` with
it.

## OAuth

OAuth is **not built into MemOS today**. The supported remote posture is a
single bearer token terminated at your proxy. If you need OAuth:

1. Put an OAuth-aware proxy in front of the server. `oauth2-proxy` with any
   OIDC provider is the smallest path; it authenticates the user and forwards
   an identity header.
2. Do **not** trust an identity header from the public internet. Strip
   incoming `X-Forwarded-*` and identity headers at the edge, then have the
   proxy set them.
3. Keep `MEMOS_API_KEY` as a second factor between the proxy and MemOS, or
   bind MemOS to loopback so only the proxy can reach it.
4. Scope tokens per user or team at the proxy. MemOS itself has namespaces,
   not per-user ACLs; a shared database behind one proxy trusts every caller
   the proxy admits.

A future release may ship an OAuth resource server. Until then, do not describe
a MemOS deployment as OAuth-protected unless the proxy is doing the work.

## Security checklist

- [ ] MemOS bound to `127.0.0.1`, not `0.0.0.0`
- [ ] TLS terminated before traffic leaves the host
- [ ] `MEMOS_API_KEY` set and rotated
- [ ] `/health` is the only unauthenticated route exposed (or put auth in
      front of everything)
- [ ] Database file permissions restricted to the service user
- [ ] Backups encrypted; the database contains raw memories
- [ ] Rate limiting at the proxy
- [ ] Logs do not include request bodies (they contain memories)

## Why local-first is still the default

A remote endpoint adds an operator, a certificate, a token rotation policy,
and a breach target. Most agent use is one person on one machine. The default
keeps the database on that machine and makes the remote path an explicit
choice rather than a silent dependency.
