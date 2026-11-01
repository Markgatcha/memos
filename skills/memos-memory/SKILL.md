---
name: memos-memory
description: Use when the user shares durable facts worth persisting across sessions (preferences, project decisions, environment setup, corrections), asks to remember or recall something, or when a question may depend on prior sessions. Drives the local MemOS MCP server (memos_* tools, all data in local SQLite).
---

# MemOS persistent memory

MemOS gives you persistent, local-first memory across sessions. Everything
stays in a local SQLite database — never send secrets to it (it is a plain
file on disk).

> **If you are not running in Claude Code, read
> [Harness protocol](#harness-protocol) first.** Plugin hooks are
> Claude-Code-only — in Hermes and most other harnesses nothing is injected
> or saved automatically, and silence here looks exactly like "there are no
> memories." It usually means the protocol at the bottom never ran.

For memory hygiene — consolidation, superseding outdated facts, diagnostics,
forgetting — use the **`memos-maintenance`** skill instead.

## When to STORE (memos_store)

Store durable, reusable facts — not chatter. Store when the user:

- states a **preference** ("always use pnpm, never npm", "I like concise answers")
- makes a **project decision** ("we chose Postgres over Mongo because of JSONB")
- describes their **environment** ("Windows 11, RTX 5050 GPU, 16GB RAM")
- **corrects** something you did ("don't run tests with --watch")
- shares **facts about people/projects** ("the API base URL is staging.example.com")

Pick a sensible `type`: `preference`, `fact`, `context`, `entity`,
`relationship`. Confirm briefly after storing ("Remembered: …").

Do NOT store: secrets/keys, session-ephemeral details (file contents you
already see), task checklists, or anything the user asks you to forget later.

**Store when you learn it, not at the end.** In harnesses without hooks there
is no save-on-exit safety net — if the session dies, an unstored fact is gone.

### Storing conversation turns (contextual retrieval)

For anything that came from a conversation — a decision, a stated preference,
an answer — include the surrounding situation in `context` and identify the
thread in `metadata`:

```json
{
  "content": "Researching adoption agencies — it's been a dream to have a family.",
  "type": "fact",
  "context": "session_2 · 7 May 2023 · Caroline\nMelanie: Any fun plans for the summer?",
  "metadata": {
    "sessionId": "session_2",
    "timestamp": "7 May 2023",
    "speaker": "Caroline"
  }
}
```

- `context` is embedded with the memory (contextual retrieval) and never
  returned in search results. Putting the **previous turn** there bridges
  question/answer wording: the answer rarely repeats the question's words.
- `sessionId` enables session-neighbour expansion: a hit pulls in the turns
  immediately around it, which is where a conversational answer usually lives.
- On LoCoMo retrieval-only, these two conventions moved Hit@10 from 69.2% to
  80.1% and all-evidence recall@10 from 59.6% to 71.5% (same embedder,
  fusion and top-10; see `docs/benchmark-comparison.md`).

`context` is also the right place for a short topic/project header on
non-conversational facts ("repo: memos · deploy pipeline"). Keep it to one or
two lines; it is charged to the embedder on every write.

## When to RECALL

- Before answering questions like "why did we…", "what did I say about…",
  "how do I usually…" → call `memos_context_pack` with `tokenBudget` 2000.
  It returns a token-budgeted, relevance-ranked slice ready to use.
- For raw exploration → `memos_search` (limit 10).
- When the exact wording may have changed over time (renamed services,
  moved URLs) → `memos_search_temporal` with a past `atTime` to see what
  was true then.

### Hybrid recall: wide, then narrow

MemOS indexes **both** distilled memories and the raw sessions they came from.
Search all pools first. Then, depending on what comes back:

- results look **noisy or generic** → re-run scoped to distilled memories
  only (`pool: ["note", "procedure"]`). This is the precision mode.
- the question needs **exact wording** that was never distilled (a quoted
  decision, a specific error message) → re-run on raw context
  (`pool: ["event"]`). Falling back to raw context beats guessing.

### If memory abstains, abstain too

Low-confidence or empty results are a **signal, not a gap to fill with a
guess**. Say plainly that something is not stored rather than inferring it.
Memory that fabricates is worse than no memory — this is the behaviour that
separates a memory layer from RAG.

## Namespaces and scopes

If the harness runs across several unrelated projects, keep memories
separated with `namespace` (e.g. the repo name). Ask once if unclear.
Prefer `scope` (`user`, `agent`, `run`) for per-user or per-agent isolation
within a shared store — user-level queries see everything beneath them.

## Harness protocol

What your harness does for you, and what you must do yourself:

| Harness | Auto-recall | Auto-save | Auto-consolidate |
|---|---|---|---|
| **Claude Code** | yes — `SessionStart` + `UserPromptSubmit` hooks | no (store explicitly) | yes — `SessionEnd` hook |
| **Hermes / others** | **no** | **no** | **no** |

**Claude Code:** don't duplicate the per-prompt recall on every turn; search
explicitly only when the injected slice is clearly off-topic.

**Hermes and every other hook-less harness — do all three yourself:**

1. **At the start of a task** that could depend on prior context, call
   `memos_context_pack` with a one-line summary of the task as `query` and
   `tokenBudget` 2000. Do this *before* answering "why did we…" or
   "how do I usually…" questions.
2. **During the task**, call `memos_store` the moment a durable fact appears.
   Do not defer to the end — there is no save-on-exit hook.
3. **Before finishing**, if you stored several facts, run
   `memos_consolidate` with `dryRun: true` and apply it if the preview looks
   sane. Say what you remembered.

Skipping step 1 does not fail loudly — you simply answer from general
knowledge while relevant memories sit on disk. That is the single most common
MemOS failure mode outside Claude Code.
