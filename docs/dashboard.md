# Local Dashboard

A browser-based UI for your MemOS memory store. No MCP Apps host required —
just run `memos dashboard` and a local web server starts serving an
interactive dashboard.

## Usage

```sh
memos dashboard
# → MemOS dashboard running at http://127.0.0.1:54321
# → Browser opens automatically. Press Ctrl+C to stop.
```

Options:

```sh
memos dashboard --port 8080    # Use a specific port
memos dashboard --no-open      # Don't open the browser automatically
```

The server binds to `127.0.0.1` only — it's not accessible from other machines
on your network.

## Features

### Browse

Lists your memories, 50 at a time. Each card shows the type, ID, timestamp,
and content.

### Search

Full-text search across all memories. Results update as you type (press Enter
or click Search).

### Graph

Visualizes the memory graph as a radial layout. Nodes are memories, edges are
relationships (links, citations, etc.). Hover to see details.

### Stats

Shows total memory count, number of types, and edge count.

## API

The dashboard also exposes a JSON API:

| Endpoint | Description |
|----------|-------------|
| `GET /api/memories?limit=50&offset=0` | List memories |
| `GET /api/search?q=...&limit=20` | Search memories |
| `GET /api/memory/:id` | Get a single memory |
| `GET /api/graph` | Graph nodes and edges |
| `GET /api/stats` | Store statistics |

Example:

```sh
curl http://127.0.0.1:54321/api/stats
# {"total":42,"byType":{"note":30,"preference":12},"edges":5}
```

## Security

- Binds to localhost only (`127.0.0.1`).
- No authentication (it's your local machine).
- Read-only operations (browse/search/graph). To modify memories, use the CLI
  or MCP tools.
