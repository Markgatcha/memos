# Harness compatibility

How to register the **`mem-os`** MCP server and install the **`mem-os-memory`**
skill in each coding harness. The server is plain stdio MCP:

```
npx -y @mem-os/sdk@1.6.26 mcp
```

`@mem-os/sdk` is pinned to **1.6.26** everywhere below (never a floating tag).
All data stays in a local SQLite database under the user home directory; no
cloud, no telemetry, no API keys.

> **`cwd` note.** In the Hermes catalog package the server runs with
> `cwd: ${PLUGIN_DATA}` so nothing is written into the install tree. That
> variable is Hermes-specific — in every other harness **omit `cwd`** (the
> server stores its database under your home directory by default), or set it
> to a data directory of your choice.

**Verified** = the config location and schema were checked against the
harness's official documentation (see the *Source* column). **Live
installation into each harness was not performed** — the snippets are
schema-checked against the docs, not installed. Treat rows marked
*unverified* as best-effort from secondary sources.

## Matrix

| Harness | MCP config location | Shape | Skill install path | Verified | Source |
| --- | --- | --- | --- | --- | --- |
| Hermes Agent | catalog package (`plugin/mcp.json`) | `mcpServers` | bundled (skills/) | ✅ | this repo |
| Claude Code | `~/.claude.json` (global) or `.mcp.json` (project) | `mcpServers` | `plugin/.claude-plugin` + `skills/` (shipped) | ✅ | [claude-code/mcp](https://docs.claude.com/en/docs/claude-code/mcp) |
| Kilo Code | `~/.config/kilo/kilo.jsonc` (global) or `./.kilo/kilo.jsonc` (project) | top-level `mcp` (local command array) | `./.kilo/skills/mem-os-memory/` or `~/.kilo/skills/mem-os-memory/` | ✅ MCP / ⚠️ skill | [kilo MCP](https://kilo.ai/docs/automate/mcp/using-in-kilo-code) |
| Cline | VS Code globalStorage `cline_mcp_settings.json` | `mcpServers` | — (no documented skills dir) | ✅ | [cline MCP](https://docs.cline.bot/mcp/configuring-mcp-servers) |
| omp (Oh My Pi) | `~/.omp/agent/mcp.json` (project: `.omp/mcp.json`) | `mcpServers` | `~/.omp/agent/skills/mem-os-memory/SKILL.md` | ⚠️ | oh-my-pi docs |
| pi | `~/.config/mcp/mcp.json` (project: `./.mcp.json`) | `mcpServers` | `./.pi/…` (skills supported) | ⚠️ | pi-mcp-adapter |
| Codex | `~/.codex/config.toml` | `[mcp_servers.<name>]` TOML | — (no skills dir) | ✅ | [codex/mcp](https://developers.openai.com/codex/mcp) |
| OpenClaw | `~/.openclaw/openclaw.json` | `mcp.servers` (nested) | — | ⚠️ | openclaw docs |
| ZCode | Settings → MCP Servers → `.zcode` config | `mcp.servers` (nested) | `~/.zcode/skills/mem-os-memory/SKILL.md` | ⚠️ | zcode docs |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` | — | ✅ | [cursor MCP](https://docs.cursor.com/context/model-context-protocol) |

## Per-harness snippets

### Hermes Agent

Shipped by this catalog entry — no manual setup. The portable package's
`plugin/mcp.json` already registers `mem-os` with `@mem-os/sdk@1.6.26` and
`cwd: ${PLUGIN_DATA}`.

### Claude Code

Already shipped: the package's `.claude-plugin/` registers the server, the
`mem-os-memory` skill loads from `skills/`, and the `hooks/` session scripts
(SessionStart summarize / SessionEnd consolidate) run automatically.
The **hooks are Claude Code-only** — no other harness below runs them.

Global (`~/.claude.json`) or project (`.mcp.json`):

```json
{
  "mcpServers": {
    "mem-os": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
    }
  }
}
```

### Kilo Code

`~/.config/kilo/kilo.jsonc` (global) or `./.kilo/kilo.jsonc` (project). Kilo
uses a top-level `mcp` key with a **command array** (not `mcpServers`):

```jsonc
{
  "mcp": {
    "mem-os": {
      "type": "local",
      "command": ["npx", "-y", "@mem-os/sdk@1.6.26", "mcp"],
      "enabled": true
    }
  }
}
```

Skill: copy `skills/mem-os-memory/` into `./.kilo/skills/` (project) or
`~/.kilo/skills/` (global). Kilo reads Claude-shaped skills from those dirs.

### Cline

Cline stores MCP servers in its VS Code globalStorage file
`cline_mcp_settings.json` (edit via the Cline MCP settings UI). Standard shape:

```json
{
  "mcpServers": {
    "mem-os": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
    }
  }
}
```


### omp (Oh My Pi)

`~/.omp/agent/mcp.json` (project: `./.omp/mcp.json`). Standard `mcpServers`
shape:

```json
{
  "mcpServers": {
    "mem-os": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
    }
  }
}
```

Skill: copy `skills/mem-os-memory/SKILL.md` to
`~/.omp/agent/skills/mem-os-memory/SKILL.md`.

### pi

pi loads MCP servers from `~/.config/mcp/mcp.json` (shared user-global) or
`./.mcp.json` (project), via the pi-mcp-adapter extension. Standard shape:

```json
{
  "mcpServers": {
    "mem-os": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
    }
  }
}
```

### Codex

`~/.codex/config.toml` — Codex uses TOML `[mcp_servers.<name>]` tables:

```toml
[mcp_servers.mem-os]
command = "npx"
args = ["-y", "@mem-os/sdk@1.6.26", "mcp"]
```

### OpenClaw

`~/.openclaw/openclaw.json` — servers nest under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "mem-os": {
        "command": "npx",
        "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
      }
    }
  }
}
```

### ZCode

Settings → MCP Servers (stdio), persisted to `.zcode` config; servers nest
under `mcp.servers`. ZCode also offers one-click import from Claude Code /
Codex / `~/.agents/mcp.json`.

```json
{
  "mcp": {
    "servers": {
      "mem-os": {
        "command": "npx",
        "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
      }
    }
  }
}
```

Skill: copy `skills/mem-os-memory/SKILL.md` to
`~/.zcode/skills/mem-os-memory/SKILL.md` (Claude-shaped).

### Cursor

`~/.cursor/mcp.json` — standard `mcpServers` shape:

```json
{
  "mcpServers": {
    "mem-os": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk@1.6.26", "mcp"]
    }
  }
}
```

## Hooks

The `plugin/hooks/` SessionStart / SessionEnd scripts are **Claude
Code-only**. No other harness above runs them, so outside Claude Code the
memory is not auto-summarized on session start or auto-consolidated on exit —
run `npx -y @mem-os/sdk@1.6.26 summarize --json` /
`... consolidate --no-summarize --json` manually if you want that behavior.

## Limitations

- Snippets are schema-checked against each harness's documented config format;
  **live installation into every harness was not performed**.
- Rows marked ⚠️ (omp, pi, OpenClaw, ZCode MCP paths; the Kilo skill path) use
  the best-documented location but could not be confirmed against a stable
  official reference at the time of writing.
- `cwd: ${PLUGIN_DATA}` is Hermes-only; omit it elsewhere.
