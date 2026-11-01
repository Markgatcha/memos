# Harness matrix

MemOS is a plain stdio MCP server. That makes it portable, but each harness
has its own config key, file location, and plugin format. This page maps the
ones worth supporting, with the exact command or block.

## Where the usage numbers come from

OpenRouter publishes opt-in app attribution at
<https://openrouter.ai/apps>. The figures below are the rolling token totals
shown on 2026-11-01. They are a traffic signal, not market share: Claude Code,
Cursor, OpenCode, and Codex mostly run on first-party inference, so their
OpenRouter numbers understate real use. Treat the ordering as a priority hint,
not a census.

| Harness | OpenRouter tokens | MemOS support | How |
| --- | ---: | --- | --- |
| Hermes Agent | 52.85T | Agent Plugin + MCP | `memos connect hermes` |
| Claude Code | 44.91T | Native plugin + MCP | `/plugin install memos@memos-marketplace` |
| Kilo Code | 24.53T | MCP | `memos connect kilo` |
| pi | 16.41T | MCP | `memos connect pi` |
| Codex | 14.03T | MCP | `memos connect codex` |
| Cline | 12.96T | MCP | `memos connect cline` |
| omp (Oh My Pi) | 9.94T | MCP (Pi-compatible) | `memos connect pi` |
| OpenClaw | 9.80T | Agent Plugin bundle + MCP | `memos connect openclaw` |
| Cursor | 44.6B | Plugin manifest + MCP | `memos connect cursor` |
| Zed | 32.4B | MCP (`context_servers`) | `memos connect zed` |
| goose | 12.5B | MCP extension | `memos connect goose` |
| Roo Code | 5.61B | MCP settings | paste the Cline-shaped block |
| OpenCode | not attributed | MCP + plugin system | `memos connect opencode` |
| Gemini CLI | not listed | Extension + MCP | `memos connect gemini` |

## What "support" means

- **Native plugin** means the repo ships a manifest the harness's own installer
  understands, with skills and commands in addition to the MCP server.
- **Agent Plugin** means the repo root has `plugin.json` and `mcp.json` in the
  Agent Plugins 1.0.0 layout. Hermes and OpenClaw both load that format.
- **MCP** means one config block pointing at `npx -y @mem-os/sdk mcp`. There is
  no harness-specific code to maintain.

We do not claim a native plugin where only the MCP config exists. Kilo, pi,
Cline, omp, Zed, goose, and Roo use MCP; that is the supported integration.

## Install paths that write a file

```bash
memos connect claude-code --write   # ./.mcp.json
memos connect cursor --write        # ~/.cursor/mcp.json
memos connect windsurf --write      # ~/.codeium/windsurf/mcp_config.json
memos connect opencode --write      # ./opencode.json
memos connect codex --write         # appends ~/.codex/config.toml
memos connect gemini --write        # ~/.gemini/settings.json
memos connect kilo --write          # ./kilo.json
memos connect pi --write            # ~/.pi/agent/mcp.json
```

The remaining harnesses merge MCP servers into a larger settings file. Writing
that file whole would destroy the user's editor settings, so `memos connect`
prints the block instead:

- Hermes: `~/.hermes/config.yaml`
- OpenClaw: `~/.openclaw/openclaw.json`
- Zed: `~/.config/zed/settings.json`
- goose: `~/.config/goose/config.yaml`
- Cline / Roo: the VS Code globalStorage `mcp_settings.json`

## Hermes Agent

Hermes ships MCP in the standard install and also loads portable Agent Plugins.
The root of this repository is already a valid package:

```bash
hermes plugins install Markgatcha/memos --no-enable
```

Then enable `memos` in `~/.hermes/config.yaml`. The native config route:

```yaml
mcp_servers:
  memos:
    command: "npx"
    args: ["-y", "@mem-os/sdk", "mcp"]
    protocol: auto
    trust: full
```

`trust: full` is appropriate only when you control the package. Set
`trust: untrusted` to require approval for every write-capable tool.

## Kilo Code

Kilo uses a top-level `mcp` key, a command array, and `environment` rather than
`env`:

```json
{
  "mcp": {
    "memos": {
      "type": "local",
      "command": ["npx", "-y", "@mem-os/sdk", "mcp"],
      "enabled": true
    }
  }
}
```

Kilo also has a Marketplace that accepts MCP server entries and companion
skills. Publishing there is a separate submission; the config above is the
equivalent local install today.

## pi and omp

Pi reads `mcpServers` from `~/.pi/agent/mcp.json` or `.pi/mcp.json`. omp is a
Pi fork and inherits the same MCP surface. Use `memos connect pi --write` and
restart the agent.

## OpenClaw

OpenClaw accepts both native plugins and Agent Plugin bundles. Its MCP block
lives under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "memos": {
        "command": "npx",
        "args": ["-y", "@mem-os/sdk", "mcp"],
        "enabled": true
      }
    }
  }
}
```

Verify with `openclaw mcp doctor memos --probe`.

## Zed

Zed calls MCP servers "context servers" and stores them in the editor settings:

```json
{
  "context_servers": {
    "memos": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@mem-os/sdk", "mcp"]
    }
  }
}
```

`source: "custom"` marks the entry as manually managed. A project-level
`.zed/settings.json` overrides the user file.

## What to build next

1. **Kilo Marketplace listing** - the config works; a listing adds discovery.
2. **Pi package** - a small extension could bundle the MCP entry and a memory
   skill, instead of asking users to edit `mcp.json`.
3. **OpenCode native plugin** - OpenCode can add custom tools directly. An
   npm package could expose `memos_store`, `memos_search`, and
   `memos_context_pack` without an MCP hop.
4. **Cline/Roo marketplace listings** - both have MCP marketplaces that crawl
   the official registry. Publishing `server.json` is the prerequisite.

## Sources

- OpenRouter app rankings: <https://openrouter.ai/apps>
- Hermes MCP config:
  <https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference>
- Hermes plugins:
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins>
- Kilo MCP: <https://kilo.ai/docs/automate/mcp/using-in-kilo-code>
- pi MCP: <https://pi.dev/docs/latest/mcp>
- OpenClaw MCP: <https://docs.openclaw.ai/tools/mcp>
- Zed MCP: <https://zed.dev/docs/ai/mcp>
