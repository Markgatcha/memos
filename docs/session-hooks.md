# Session Hooks

Automatically extract durable facts when a coding session ends. MemOS provides
session-end hooks for Claude Code and OpenCode that run `memos session-hook`,
parse the session transcript, and store facts via the existing
`extractFacts({ autoStore: true })` path.

## How it works

1. When your session ends, the harness invokes `memos session-hook`.
2. The hook reads the session transcript: Claude Code passes `transcript_path`
   via stdin JSON; the OpenCode plugin passes `--opencode-session <id>`
   and memos loads the session from OpenCode's data dir.
3. It parses the transcript into conversation messages (Claude Code JSONL
   first, plain-text fallback when that yields nothing).
4. It calls `extractFacts()` with `autoStore: true`, which extracts candidate
   facts, filters by confidence (>= 0.6 by default), dedupes against existing
   memories, and stores the rest.

The hook is **fail-open**: if anything goes wrong, it logs the error but never
breaks session teardown. Set `MEMOS_SKIP_SESSION_HOOK=1` to opt out for a
single session.

## Claude Code setup

Add to `.claude/settings.json` (project scope) or `~/.claude/settings.json`
(user scope):

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "memos session-hook"
          }
        ]
      }
    ]
  }
}
```

Or see the instructions via:

```sh
memos connect claude-code
```

## OpenCode setup

1. Save the plugin as `.opencode/plugins/memos-session-hook.ts` (generate it
   with `memos connect opencode`, or copy the source from
   `openCodePluginSource()`):

```typescript
export const MemosSessionHook = async ({ $ }) => {
  return {
    "session.deleted": async (event) => {
      try {
        await $`memos session-hook --opencode-session ${event.sessionID}`;
      } catch {
        // Never break session teardown.
      }
    },
  };
};
```

2. Add to `opencode.json`:

```json
{
  "plugin": ["./plugins/memos-session-hook.ts"]
}
```

How the OpenCode path works: on `session.deleted`, the plugin passes the
ended session's ID to `memos session-hook --opencode-session <id>`. Memos
then loads that session's messages from OpenCode's data directory —
`$XDG_DATA_HOME/opencode` when set, otherwise the platform default
(`~/.local/share/opencode` on Linux,
`~/Library/Application Support/opencode` on macOS,
`%LOCALAPPDATA%/opencode` on Windows). Current OpenCode stores sessions
in SQLite at `<data>/opencode.db` (tables `message`/`part`); older
installs used `<data>/storage/message/<sessionId>/*.json` and
`<data>/storage/part/<messageId>/*.json` — memos reads the database
first and falls back to the legacy JSON layout.

Limitations, stated plainly:

- Only `user`/`assistant` text parts are extracted; tool calls, file
  edits, and reasoning blocks are skipped.
- If the session can't be found (custom data dir, session storage
  already cleaned up), the hook logs and exits — it never fails the
  session teardown.
- Set `XDG_DATA_HOME` if you moved OpenCode's data directory.

## Manual extraction

Extract facts from any transcript without a hook:

```sh
# Claude Code JSONL transcript
memos extract-facts --transcript ~/.claude/projects/my-project/session.jsonl

# Preview without storing
memos extract-facts --transcript session.jsonl --dry-run

# Custom namespace and confidence threshold
memos extract-facts --transcript session.jsonl --namespace my-project --min-confidence 0.7
```

## What gets stored

The fact extractor is rule-based and local (no LLM calls). It identifies:

- **Preferences**: "I prefer dark mode", "My favorite language is TypeScript"
- **Facts**: "I work at Acme Corp", "The API key is in ~/.env"
- **Procedures**: "To deploy, run `pnpm deploy`"
- **Relationships**: "Alice is my teammate"

Each fact gets a confidence score. Only facts >= `minConfidence` (default 0.6)
are stored. Near-duplicates of existing memories are skipped automatically.

## Opting out

```sh
# Skip for one session
MEMOS_SKIP_SESSION_HOOK=1 claude

# Or remove the hook from settings.json
```
