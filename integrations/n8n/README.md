# MemOS for n8n

An importable n8n workflow that stores a memory and recalls it through the
MemOS HTTP API. No custom node package to install.

## Setup

1. Start MemOS:

   ```bash
   MEMOS_API_KEY="n8n-token" python -m memos.server.main
   ```

   Default bind: `127.0.0.1:7400`. If n8n runs in Docker, replace the URL with
   a host n8n can reach.

2. In n8n: **Workflows → Import from File** and choose
   [`memos-workflow.json`](memos-workflow.json).
3. Set `MEMOS_API_KEY` in the n8n process environment (or replace the header
   value with a credential).
4. Execute the workflow. It writes one fact and searches for it.

## What the workflow does

```text
Manual Trigger → Set content → POST /api/mem/store → POST /api/mem/search
```

The store node sends:

```json
{ "content": "...", "type": "fact", "tags": ["n8n", "runbook"] }
```

The search node sends:

```json
{ "query": "how do we deploy and roll back", "limit": 5 }
```

## Using it as an AI Agent tool

In an **AI Agent** node, add an **HTTP Request Tool**:

- Method: `POST`
- URL: `http://127.0.0.1:7400/api/mem/search`
- Body (JSON): `{{ JSON.stringify({ query: $fromAI("query"), limit: 5 }) }}`
- Authorization: `Bearer {{$env.MEMOS_API_KEY}}`

Give the tool a description such as: "Search the user's persistent MemOS
memory before answering personal or project questions."

Add a second tool for `POST /api/mem/store` so the agent can write durable
facts back. Keep the store description narrow: preferences, decisions, and
corrections — not transient chatter.

## Notes

- `MEMOS_API_KEY` is optional for loopback-only use. Remove the Authorization
  header if the server has no key.
- The HTTP API is the stable boundary; the workflow does not depend on the
  Node SDK.
- Context packs: `POST /api/mem/context-pack` with `token_budget` and
  `format: "toon-compact"` when you need a compact, citable prompt block.
