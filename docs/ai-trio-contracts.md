# AI Trio Contracts

MemOS is the local memory layer in the AI Trio. It should retrieve and score context, preserve provenance, and expose compact read-only context packs before any agent mutates memory.

## Context Pack V1

```json
{
  "schema": "ai-trio.memos.context-pack.v1",
  "query": "release blockers",
  "namespace": "default",
  "tokenBudget": 1200,
  "items": [
    {
      "id": "memory-id",
      "content": "Stable fact or preference.",
      "summary": "Short summary when available.",
      "score": 0.91,
      "scores": {
        "keyword": 0.2,
        "semantic": 0.9,
        "hybrid": 0.59
      },
      "trust": "local",
      "source": "session",
      "tags": ["release"],
      "updatedAt": "2026-06-04T00:00:00.000Z"
    }
  ]
}
```

## Rules

- `items` must be sorted by descending relevance after namespace, trust, tag, and metadata filters are applied.
- `content` must be plain text and safe for downstream folding.
- `score` must be reproducible for the same database, query, provider, and embedding model.
- `trust` and `source` must be preserved when Guardian folds context.
- Mutation APIs remain separate from context pack retrieval.

Benchmark claims must come from `npm run bench` or explicit release evidence.
