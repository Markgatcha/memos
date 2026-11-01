# MemOS for Dify

Dify imports OpenAPI schemas as custom tools. The schema in this directory
exposes four MemOS operations: store, search, context pack, and overview.

## Setup

1. Start the MemOS HTTP server:

   ```bash
   MEMOS_API_KEY="dify-token" python -m memos.server.main
   ```

   It listens on `127.0.0.1:7400`. If Dify runs in Docker, use a host Dify can
   reach and put the server behind TLS before exposing it.

2. In Dify: **Tools → Custom → Create Custom Tool → Import from OpenAPI**.
3. Paste [`memos-openapi.yaml`](memos-openapi.yaml).
4. Set authentication to **Bearer** with the same `MEMOS_API_KEY`.
5. Change the `servers` URL if Dify is not on the same host.

## Tool mapping

| Dify tool | MemOS route | Use |
| --- | --- | --- |
| `memos_store` | `POST /store` | Save a durable fact or preference |
| `memos_search` | `POST /search` | Recall before answering |
| `memos_context_pack` | `POST /context-pack` | Inject a budgeted, citable pack |
| `memos_overview` | `GET /overview` | Session-start index |

## Prompt snippet

```text
Before answering questions about the user, call memos_search.
When the user states a durable preference or decision, call memos_store.
For long answers, call memos_context_pack with a 1200-token budget and cite
the returned `[mem:...]` tokens.
```

## Notes

- `context-pack` expects snake_case (`token_budget`), matching the HTTP API.
- The local server has no account system. `MEMOS_API_KEY` is a single bearer
  token; rotate it like any shared secret.
- `overview` returns counts and topics, never memory contents.
