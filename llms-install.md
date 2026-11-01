# MemOS install contract

Agent-readable install instructions for MemOS. Follow this file top to bottom;
every command is copy-pasteable. No account, API key, or network service is
required after the npm download.

## What you get

- A **stdio MCP server** (`npx -y @mem-os/sdk mcp`) exposing a 12-tool core
  set: `store`, `ingest`, `search`, `profile`, `retrieve`, `forget`,
  `context_pack`, `explain`, `feedback`, `health`, `overview`, `handoff`;
  `MEMOS_MCP_TOOLS=all` exposes all 40.
- Local SQLite storage at `~/.memos/memos.db` (override with `MEMOS_DB_PATH`).
- Optional Streamable HTTP transport: `npx -y @mem-os/sdk mcp --http --port=8788`
  (loopback by default; set `MEMOS_API_KEY` before exposing it).

## Prerequisites

- Node.js 20 or newer
- `npx` on `PATH`

## Canonical MCP config

```json
{
  "mcpServers": {
    "memos": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk", "mcp"]
    }
  }
}
```

## Per-harness install

Let the CLI print or write the right file for your harness:

| Harness | Dry run (prints config) | Write |
| --- | --- | --- |
| Claude Code | `npx -y @mem-os/sdk connect claude-code` | `npx -y @mem-os/sdk connect claude-code --write` |
| Cursor | `npx -y @mem-os/sdk connect cursor` | `npx -y @mem-os/sdk connect cursor --write` |
| Windsurf | `npx -y @mem-os/sdk connect windsurf` | `npx -y @mem-os/sdk connect windsurf --write` |
| Cline | `npx -y @mem-os/sdk connect cline` | `npx -y @mem-os/sdk connect cline --write` |
| OpenCode | `npx -y @mem-os/sdk connect opencode` | `npx -y @mem-os/sdk connect opencode --write` |
| Codex CLI | `npx -y @mem-os/sdk connect codex` | `npx -y @mem-os/sdk connect codex --write` |
| Gemini CLI | `npx -y @mem-os/sdk connect gemini` | `npx -y @mem-os/sdk connect gemini --write` |

Exact config bodies, if you prefer to edit files by hand:

**Claude Code** — `claude mcp add memos -s user -- npx -y @mem-os/sdk mcp`,
or project scope in `./.mcp.json` using the canonical JSON above.

**Cursor** — `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memos": { "command": "npx", "args": ["-y", "@mem-os/sdk", "mcp"] }
  }
}
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json`: same `mcpServers` shape.

**Cline** — `cline_mcp_settings.json` under VS Code's global storage: same
`mcpServers` shape.

**OpenCode** — `opencode.json`:

```json
{
  "mcp": {
    "memos": {
      "type": "local",
      "command": ["npx", "-y", "@mem-os/sdk", "mcp"]
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.memos]
command = "npx"
args = ["-y", "@mem-os/sdk", "mcp"]
```

**Gemini CLI** — `~/.gemini/settings.json`: same `mcpServers` shape as Cursor.

## Verify

```bash
npx -y @mem-os/sdk doctor
npx -y @mem-os/sdk store "The project uses pnpm workspaces"
npx -y @mem-os/sdk search "package manager"
```

`doctor` must print `Doctor: no problems found`, and `search` must return the
stored sentence. From an MCP client, call `memos_health` and expect
`{ "ok": true, ... }`.

## Rollback

- Claude Code: `claude mcp remove memos -s user`
- Cursor / Windsurf / Cline / Gemini: delete the `memos` key from the
  `mcpServers` object.
- OpenCode: delete the `memos` key from the `mcp` object.
- Codex: delete the `[mcp_servers.memos]` block.

Removing the server does **not** delete your memories. Delete
`~/.memos/memos.db` (or your `MEMOS_DB_PATH`) to erase them.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMOS_DB_PATH` | `~/.memos/memos.db` | SQLite file location |
| `MEMOS_NAMESPACE` | `default` | Namespace for reads and writes |
| `MEMOS_API_KEY` | unset | Bearer token for the optional HTTP server |

## Non-goals

- No telemetry, no phone-home, no cloud sync.
- No API key is needed for the core memory engine.
- The stdio server never opens a network listener.
