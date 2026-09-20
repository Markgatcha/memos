# MCP Apps Memory Explorer

An interactive memory-graph explorer served as a `ui://` resource
(`ui://memos/explorer`) under MCP Apps (ratified January 2026). It renders
the MemOS entity/memory graph as a self-contained, CSP-locked HTML payload:
nodes colored by provenance tier, edges labeled by relation, with
pan/zoom, text/type/provenance filters, and a bitemporal **as-of scrubber**
for time travel. No LLM is involved anywhere — the payload is deterministic.

## Opening the app

The resource is registered as a URI template:

```
ui://memos/explorer{?asOf,mode,nodeLimit,edgeLimit}
```

Query variables:

| Variable    | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `asOf`      | Unix ms. Render the graph at a past timestamp (bitemporal read). |
| `mode`      | `app` forces the HTML app; `text` forces the markdown fallback.  |
| `nodeLimit` | Override the node cap (clamped to 1–1000).                       |
| `edgeLimit` | Override the edge cap (clamped to 1–2000).                       |

Whether a read returns the HTML app or the markdown fallback is decided by
`resolveExplorerMode`:

1. An explicit `?mode=app` / `?mode=text` always wins.
2. Otherwise the host may signal MCP Apps support in the request `_meta`
   with `{ "memos.uiApps": true }`.
3. Otherwise the resource **fails closed to the text fallback** — a host that
   cannot render `ui://` apps gets a mermaid diagram plus a summary, never a
   broken iframe.

So `resources/read` on `ui://memos/explorer?mode=app` always returns
`text/html`; a bare `ui://memos/explorer` read returns `text/markdown`
unless the host set the `_meta` signal. The advertised MIME type on the
template is `text/html`, but the actual MIME type is chosen per read.

## The consent model and the host bridge

The app itself is **unprivileged**: it cannot touch the database. Mutating
actions (forget, link, release from quarantine) are expressed as structured
_intents_ posted to the host via `window.postMessage`; the host translates
each intent into a normal MCP `tools/call` so the **host's consent UI**
applies exactly as if the agent had called the tool itself. Read-path
interactions (pan/zoom/filter/scrub) need no consent.

The `postMessage` protocol (`memos-explorer/1`):

```ts
// App -> host: a mutating intent. Host maps it with intentToToolCall()
// and runs it as tools/call under its own consent UI.
{ protocol: "memos-explorer/1", kind: "intent",
  intent: "forget" | "link" | "release-quarantine",
  params: { id: string } | { sourceId, targetId, relation, weight? },
  requestId: string }

// Host -> app: the outcome.
{ protocol: "memos-explorer/1", kind: "intent-result",
  requestId: string, ok: boolean, error?: string }
```

`intentToToolCall` (exported from `src/apps/explorer.ts`, pure and
deterministic) maps `forget` → `memos_forget`, `link` → `memos_link`, and
`release-quarantine` → `memos_quarantine_release`, rejecting unknown
intents, missing ids, unknown relations, and out-of-range weights. Two
standard MCP tools were added to back the bridge: `memos_link` and
`memos_quarantine_release` (`memos_forget` already existed).

The app must be embedded with `<iframe sandbox="allow-scripts">` —
**without** `allow-same-origin` — so it stays origin-less and can only talk
to the host through `postMessage`.

## The as-of scrubber

Moving the time slider does **not** filter the embedded snapshot
client-side. Each scrub position (debounced 300 ms) posts a read request
to the host:

```ts
// App -> host (read-only, consent-free).
{ protocol: "memos-explorer/1", kind: "read",
  requestId: string, asOf: number | null }   // null = live graph
```

The host performs an MCP `resources/read` of
`ui://memos/explorer?mode=app` (plus `&asOf=<ms>` when set) — the existing
server-side as-of read path (`MemOS.getGraphAtTime`, backed by the SQLite
validity predicates) — and replies with the raw resource text:

```ts
// Host -> app.
{ protocol: "memos-explorer/1", kind: "snapshot",
  requestId: string, ok: boolean, html?: string, error?: string }
```

The app extracts the new snapshot from the resource's
`<script id="memos-snapshot" type="application/json">` tag, swaps it in,
and re-renders. Node positions are kept stable across snapshots (new nodes
go on an outer ring). If the host never answers within 2 s — i.e. it does
not implement the bridge — the app degrades to filtering its embedded
snapshot locally with the same validity predicates the server uses, and
stops asking.

Because the node-validity boundary is inclusive (`valid_to >= t`) while the
edge boundary is strict (`valid_to > t`), a node superseded at exactly `t`
is still shown at `t` while its closed edges are already gone. Both the
server read path and the client's fallback filter implement this asymmetry.

## Payload caps

Every payload is capped so one resource read stays small:

- 150 nodes / 400 edges by default (`?nodeLimit=` / `?edgeLimit=` override,
  hard ceilings 1000 / 2000).
- 280 characters of node content per node; each node carries a
  `[mem:xxxxxx]` citation token.
- The snapshot records `totalNodes` / `totalEdges` and a `truncated` flag
  so the UI can say "N of M".

## Security properties

- `Content-Security-Policy: default-src 'none'` meta tag; no external URLs
  (`http://`/`https://`) anywhere in the payload — verified by tests.
- No CDN scripts, no network fetches; the SVG renderer is hand-rolled.
- Node content is JSON-escaped into the snapshot script tag (no
  `</script>` breakouts).
- Additive-only server change: two new tools, one optional
  `StorageAdapter.getGraphAtTime` method with an in-memory fallback, one new
  resource. No existing tool, resource, or API was modified incompatibly.

## Host support and known gaps

- **SDK template matching.** The pinned `@modelcontextprotocol/server`
  compiles `{?a,b,…}` into a regex requiring _every_ variable present, in
  order — so `?mode=app` alone would never match the advertised template.
  `ExplorerUriTemplate` (in `src/apps/explorer.ts`) subclasses the SDK's
  `UriTemplate`, keeps the standard template string for
  `resources/templates/list` advertisement, and overrides `match()` with
  correct optional-query semantics. If the SDK fixes its matcher, the
  subclass becomes a thin pass-through.
- **The host must implement both `postMessage` pairs.** Intent translation
  (`intentToToolCall`) and the read bridge are specified here, but a host
  that just iframes the HTML without wiring the bridge gets intents that
  are announced but never applied, and scrubbing that silently degrades to
  the local snapshot. The app toasts in both cases so the state is visible.
- **Snapshot scope.** The embedded and re-queried snapshots are capped
  (see above): time travel shows the top-N-by-importance slice at each
  timestamp, not the full historical graph. Raising the caps raises payload
  size linearly.
- **No live updates.** The app does not subscribe to graph changes; after
  the host applies an intent it tells the user to refresh the resource.
