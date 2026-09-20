---
description: "Revert a MemOS memory to its previous version — natural-language undo"
argument-hint: "<what to revert: 'that', 'the last thing', or 'what I said about X'>"
---

Revert the MemOS memory matching: $ARGUMENTS

1. Call `memos_revert` with text "$ARGUMENTS" (dry_run defaults to true — confirm scope before executing).
2. Show the would-be target and the predecessor that would be restored, then ask me to confirm.
3. Only after I confirm, call `memos_revert` again with dry_run=false and report what was restored.

Rules:
- Never revert without a matching target: no match, no revert.
- The reverted-away version stays in history (add-only) — revert never deletes anything.
- If several candidates match, list each with its ID and a one-line summary, then ask me which one to revert.
- Record why on the audit event (pass `reason`).
