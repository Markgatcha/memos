---
description: "Forget a MemOS memory by fuzzy match — search, confirm, delete"
argument-hint: "<what to forget>"
---

Forget the MemOS memory matching: $ARGUMENTS

1. Call `memos_search` with query "$ARGUMENTS" and limit 5.
2. If there is exactly one clear match, call `memos_forget` with its ID and confirm what was deleted.
3. If several candidates match, list each with its ID and a one-line summary, then ask me which one to forget — delete only after I confirm.
4. If nothing matches, say so plainly instead of deleting anything.

Rules:
- Never delete without a matching memory: no match, no delete.
- Never store secrets (API keys, passwords, tokens) — MemOS is plain SQLite on disk.
