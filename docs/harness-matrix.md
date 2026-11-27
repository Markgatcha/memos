# Harness matrix

MemOS is a plain stdio MCP server. That makes it portable, but each harness
has its own config key, file location, and plugin format. This page maps the
ones worth supporting, with the exact command or block.

## Where the usage numbers come from

OpenRouter publishes opt-in app attribution at
<https://openrouter.ai/apps>. The figures below are the rolling token totals
shown on 2026-11-01, except DeepSeek Harness, which was not yet on the page
then; its 324B figure is from the 2026-11-15 snapshot, ranked #5 in the Today
view. Treat the numbers as a traffic signal, not market share: Claude Code,
Cursor, OpenCode, and Codex mostly run on first-party inference, so their
OpenRouter numbers understate real use. Ordering is a priority hint, not a
census.

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
| DeepSeek Harness | 324B | MCP (Cordis patch) | `memos connect dsh` |
| Cursor | 44.6B | Plugin manifest + MCP | `memos connect cursor` |
| Zed | 32.4B | MCP (`context_servers`) | `memos connect zed` |
| goose | 12.5B | MCP extension | `memos connect goose` |
| Roo Code | 5.61B | MCP settings | paste the Cline-shaped block |
| OpenCode | not attributed | MCP (2.x) + MCP (1.x) | `memos connect opencode` / `opencode-v1` |
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
memos connect opencode --write      # ./opencode.json (2.x: mcp.servers)
memos connect opencode-v1 --write   # ./opencode.json (1.x: mcp.<name>)
memos connect dsh --write           # ~/.dsh/memos.patch.yml (dedicated file; NOT your cordis.patch.yml)
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
- DeepSeek Harness: `- insert:` row in a `cordis.patch.yml` (see below)

## DeepSeek Harness (dsh)

dsh has no `mcp.json`. MCP servers are rows for the
`@deepseek-ai/dsh-mcp-client` plugin inside a Cordis patch file. Merge this
row into `$DSH_HOME/cordis.patch.yml` (every profile) or
`$DSH_HOME/profiles/<name>/cordis.patch.yml` (one profile):

```yaml
- insert:
    - id: memos
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memos
        transport: stdio
        command: "npx"
        args: ["-y", "@mem-os/sdk", "mcp"]
```

Do not replace an existing patch file: dsh warns it may already contain
unrelated user patches. One-off test without touching your patch file:

```bash
dsh web --patch <file>
```

Then restart dsh and verify with `dsh web --dump-config | grep -A3 mcp`.
`memos connect dsh` prints the row; `memos connect dsh --write` saves it to
`~/.dsh/memos.patch.yml` (safe: a new file, never your `cordis.patch.yml`),
which you still need to either pass to `dsh web --patch` or merge by hand.

dsh namespaces bridged tools as `mcp__memos__<tool>`. Only tools bridge —
resources and prompts have no dsh consumer.

`$DSH_HOME` defaults to `~/.dsh`. MemOS stamps memories authored inside dsh
as harness `dsh` when it detects the runtime-injected `DSH_HOME` /
`DSH_SHELL` environment variables.

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

## OpenCode

OpenCode 2.0 made a breaking change: the config nests MCP servers under
`mcp.servers` (not `mcp.<name>`), and the plugin API was rewritten. MemOS
supports both lines:

```bash
memos connect opencode    # OpenCode 2.x / latest: writes mcp.servers
memos connect opencode-v1 # OpenCode 1.x: writes the mcp.<name> shape
```

Both write `opencode.json` (or `~/.config/opencode/opencode.json` for global).
Add `--with-session-hook` to also write the session-hook plugin:

- v2: `.opencode/plugins/memos-session-hook/index.ts` — `Plugin.define({ id, setup(ctx) })`, `ctx.event.subscribe()`, `plugins` array
- v1: `.opencode/plugins/memos-session-hook.ts` — `event` hook, `plugin` array

```bash
memos connect opencode --with-session-hook --write
```

Two OpenCode-2.x gotchas to know before writing your own hook:

- `session.idle` is declared in the V2 schema but never emitted; plugins
  that wait for it silently never fire. V2 completion arrives as
  `session.execution.succeeded` / `.failed` / `.interrupted`, with the
  session id under `event.data.sessionID` (payload `data`, not `properties`).
- V1 hook names and the bun-shell `$` helper are gone; V2 code uses
  `Plugin.define` + `ctx.event.subscribe()` and `node:child_process`.

## What to build next

1. **Kilo Marketplace listing** - the config works; a listing adds discovery.
2. **Pi package** - a small extension could bundle the MCP entry and a memory
   skill, instead of asking users to edit `mcp.json`.
3. **OpenCode native plugin** - OpenCode can add custom tools directly. An
   npm package could expose `memos_store`, `memos_search`, and
   `memos_context_pack` without an MCP hop. The session-hook plugin already
   ships for both V1 and V2 (`memos connect opencode --with-session-hook`).
4. **Cline/Roo marketplace listings** - both have MCP marketplaces that crawl
   the official registry. Publishing `server.json` is the prerequisite.
5. **DeepSeek Harness plugin** - dsh loads Cordis bundle plugins from npm
   (`dsh plugin --profile web add <source>`). A `@dsh-external/memos-memory`
   bundle could wrap the MCP row plus a memory skill, instead of asking users
   to merge a patch row by hand.

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
- DeepSeek Harness MCP:
  <https://deepseekdocs.com/en/docs/features/mcp>
- DeepSeek Harness plugins:
  <https://deepseekdocs.com/en/docs/user-guide/plugins>
- DeepSeek Harness configuration (cordis.patch.yml):
  <https://deepseekdocs.com/en/docs/user-guide/configuration>
- OpenCode V2 config (mcp.servers): <https://opencode.ai/docs/config>
- OpenCode V2 plugin migration: <https://opencode.ai/docs/build/plugins/migrate-v1>
