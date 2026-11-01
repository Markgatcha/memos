# Marketplace submission packet

Everything a directory reviewer needs for MemOS. The product is local-first:
there is no hosted account, no reviewer credential, and no data leaves the
reviewer's machine.

## Contents

| File | Purpose |
| --- | --- |
| [`listing.md`](listing.md) | Name, tagline, descriptions, categories, links |
| [`test-plan.md`](test-plan.md) | Prerequisites, five positive tests, three negative tests |
| [`reviewer-notes.md`](reviewer-notes.md) | Security model, data handling, support path |
| `screenshots/` | Current-build screenshots (memory playground, benchmarks) |

## Screenshots

| File | What it shows |
| --- | --- |
| `screenshots/memory-playground.jpeg` | Store + recall view, recorded SDK trace |
| `screenshots/memory-playground-full.jpeg` | Full workflow: memories, hits, context pack |
| `screenshots/qa-efficiency.jpeg` | QA accuracy, interval, tokens per correct answer |
| `screenshots/benchmark-arms.jpeg` | Floor / memory / ceiling arms with honest empty cells |

## Quick facts

- **Package:** `@mem-os/sdk` on npm, MIT licensed
- **Runtime:** Node.js 20+; optional Python HTTP server
- **Transport:** stdio MCP and Streamable HTTP (MCP `2026-07-28`, legacy
  `initialize` fallback)
- **Storage:** SQLite at `~/.memos/memos.db`
- **Account required:** no
- **Network required after install:** no
- **Privacy:** https://context-core.dev/privacy
- **Terms:** https://context-core.dev/terms
- **Security:** https://context-core.dev/security

## Registry

`server.json` at the repo root is the official MCP registry manifest for
`io.github.markgatcha/memos`. It validates against the `2025-12-11` schema.
Validate locally with:

```bash
npm run check:server-json
```

Publishing requires a DNS-verified namespace (or GitHub auth for the
`io.github.markgatcha` namespace) and is tracked in
[`ROADMAP-NEXT-2.md`](https://github.com/Markgatcha/memos/blob/main/ROADMAP-NEXT-2.md) item 4. The manifest is prepared
so publishing is one command once the namespace is verified.

## Reviewer short path

```bash
npx -y @mem-os/sdk demo
npx -y @mem-os/sdk doctor
```

`demo` stores three memories in a temporary database, searches them, closes and
reopens the file to prove persistence, then cleans up. `doctor` must print
`Doctor: no problems found`.

For the MCP surface:

```bash
npx -y @mem-os/sdk connect cursor        # prints the config
npx -y @mem-os/sdk mcp                   # starts the stdio server
```
