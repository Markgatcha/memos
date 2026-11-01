# UMT × MemOS shared configuration

The Universal MCP Toolkit and MemOS agree on one configuration surface: the
environment. Nothing is copied into a second settings file, and no secret is
written in plaintext by either tool.

## What UMT writes

```bash
npx universal-mcp-toolkit config --server memos --target cursor --write
```

The generated block is:

```json
{
  "mcpServers": {
    "memos": {
      "command": "npx",
      "args": ["-y", "@mem-os/sdk", "mcp"],
      "env": {
        "MEMOS_DB_PATH": "${MEMOS_DB_PATH}",
        "MEMOS_NAMESPACE": "${MEMOS_NAMESPACE}"
      }
    }
  }
}
```

The `${...}` values are placeholders, not literals: the harness expands them
from the environment at launch. That is the shared store — export the variables
once, in your shell profile or your harness's environment, and both `umt` and
`memos` see the same database and namespace.

```bash
export MEMOS_DB_PATH="$HOME/.memos/work.db"
export MEMOS_NAMESPACE="work"
```

## What MemOS reads

| Variable | Read by | Purpose |
| --- | --- | --- |
| `MEMOS_DB_PATH` | SDK, CLI, MCP, HTTP server | SQLite file |
| `MEMOS_NAMESPACE` | SDK, CLI, MCP | Default namespace |
| `MEMOS_API_KEY` | HTTP server only | Bearer token for non-public routes |

`MEMOS_API_KEY` is deliberately not in the UMT stdio block: stdio has no
network listener, so the token would be unused. Keep it in the environment of
whatever process runs `memos mcp --http` or `memos-server`.

## Linking an existing database

If the database already exists, let UMT find it and write a ready-to-use MCP
block:

```bash
npx universal-mcp-toolkit link memos
# or
npx universal-mcp-toolkit link memos --db-path /path/to/memos.db
```

UMT checks `~/.memos/memos.db` and `~/memos.db` first, stores the resolved path
in its own state, and writes `memos-mcp.json` with `mcp --db <path>`. That is
the same file the stdio server reads, so nothing is duplicated. `memos` is the
only Memory-category provider in the UMT registry, so it is the default when a
user asks for memory.

## Verify

```bash
umt doctor
npx -y @mem-os/sdk doctor
umt config --server memos --target json   # inspect the generated block
```

`umt doctor` reports missing environment variables for every server, including
MemOS. `memos doctor` reports the resolved database path, embedding provider,
and storage health. If the two disagree about the path, the harness did not
expand the placeholder.

## Credential handling

- UMT writes placeholders; it does not store secrets.
- MemOS never writes `MEMOS_API_KEY` to disk.
- For a hosted deployment, put the token in the process manager's secret store
  (systemd `EnvironmentFile`, Docker secret, or your platform's secret
  manager) and pass it through as an environment variable.
- Never commit a filled-in harness config containing a real token.

## Why not a second config file?

A `~/.memos/config.json` plus a UMT config would give two sources of truth and
two ways to be wrong. Environment variables are already the contract every
harness supports, they expand at launch, and they keep secrets out of generated
JSON. The MemOS CLI still accepts explicit flags (`--db`, `--namespace`) when
you need a one-off override; flags win over the environment.
