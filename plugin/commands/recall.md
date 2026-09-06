---
description: "Recall what MemOS knows about a topic as a token-budgeted context pack"
argument-hint: "<what to recall>"
---

Recall memories relevant to: $ARGUMENTS

1. Call `memos_context_pack` with `query` set to "$ARGUMENTS" and `tokenBudget` 2000. If the result looks sparse, widen with `memos_search` (limit 10).
2. Summarize what the memories say in plain prose, citing memory IDs like `[mem:abc12345]` for anything I might want to update or forget.
3. If nothing relevant exists, say so plainly and offer to `memos_store` a new memory if I state the fact now.
