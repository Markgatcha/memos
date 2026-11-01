# MCP compatibility policy

MemOS speaks the Model Context Protocol over **stdio** and **Streamable HTTP**.
This document states which revisions we support, how we test them, and when we
remove old ones.

## Supported revisions

| Revision | Status | Transport | Notes |
| --- | --- | --- | --- |
| `2026-07-28` | **Current** | stdio, Streamable HTTP | Stateless core, `server/discover`, cache hints |
| 2025-era `initialize` | **Legacy fallback** | stdio, Streamable HTTP | Negotiated by the SDK for clients that still send `initialize` |

The server advertises `2026-07-28` in `server/discover` and accepts the legacy
`initialize` handshake so older clients keep working. There is no third
revision in the compatibility set today; adding one means adding it to the
modern core, not maintaining a fork.

## Deprecation window

The `2026-07-28` specification defines a **12-month deprecation window**. We
follow it:

- A revision is removed no earlier than 12 months after its successor ships.
- The legacy `initialize` path therefore remains available through at least
  **2027-07-28**.
- Removal is announced in `CHANGELOG.md` and on the `/changelog` page before
  the release that removes it.

## SDK pin

`@modelcontextprotocol/server` is pinned at **2.4.0** in `package.json`. The pin
is deliberate: protocol behavior is part of the product contract, and a
floating range would let a transitive update change negotiation or cache hints
without a release. Upgrade steps:

1. Read the upstream changelog for the target version.
2. Run the protocol suites:
   ```bash
   npm test -- mcp-modern-protocol mcp-protocol mcp-http mcp-annotations
   ```
3. Manually verify `server/discover` returns the expected revision and cache
   hints:
   ```bash
   npx -y @mem-os/sdk mcp --http --port=8788
   curl -s http://127.0.0.1:8788/mcp \
     -H 'content-type: application/json' \
     -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'
   ```
4. Update the pin, this table, and the changelog in the same commit.

## What the server exposes

| Surface | Supported | Notes |
| --- | --- | --- |
| Tools | Yes | 40 registered; 12 in the default core profile; annotations declare read-only, destructive, idempotent, open-world |
| Resources | Yes | `memos://context` (brief), `memos://graph` (Mermaid), explorer app |
| Prompts | Yes | `recall` (search, summarize, flag trust and age) |
| Sampling | No | Memory retrieval never calls back into the client's model |
| Elicitation | No | No interactive prompts during a tool call |
| Logging | Yes | Server-side logs; no telemetry leaves the machine |

## HTTP security

- Binds `127.0.0.1` by default.
- When `MEMOS_API_KEY` is set, every route except `/health`, `/docs`, `/redoc`,
  and `/openapi.json` requires `Authorization: Bearer <key>`.
- The MCP endpoint itself is `/mcp`; legacy SSE endpoints are not served.
- TLS termination is the operator's responsibility when binding beyond
  loopback.

## Testing

The compatibility suite lives in `__tests__/`:

- `mcp-modern-protocol.test.ts` — `server/discover`, revision negotiation,
  cache hints, tool list shape.
- `mcp-protocol.test.ts` — legacy `initialize` fallback and core tool calls.
- `mcp-http.test.ts` — Streamable HTTP transport and auth.
- `mcp-annotations.test.ts` — destructive/idempotent/read-only annotations.

A change that alters negotiation, tool schemas, or annotations must update the
relevant suite in the same commit. If a client incompatibility cannot be fixed
without breaking the current revision, the fix goes behind a new revision
rather than silently changing behavior.

## Client compatibility

Tested against Claude Code, Cursor, Windsurf, Cline, OpenCode, Codex CLI, and
Gemini CLI through `memos connect`. Per-harness snippets are in
[`llms-install.md`](../llms-install.md) and on the site's `/docs/install` page.

If a client only implements the legacy handshake, it should connect without
configuration. If it implements `2026-07-28`, it should call `server/discover`
first and honor the advertised cache TTLs.
