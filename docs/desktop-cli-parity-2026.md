# MemOS Desktop ↔ CLI parity and next UX pass

The desktop app now writes (create / edit→supersede / forget), covers 16
harnesses, and has the warm visual system. It still covers roughly 20 of the
CLI's 67 commands. This is the gap map and the next set of surfaces worth
building.

## Coverage today

| Job | CLI / MCP | Desktop status |
| --- | --- | --- |
| Browse and search | `list`, `search`, `browse` | ✅ list, FTS5, filters, sort, saved views |
| Read one memory | `retrieve`, `cite` | ✅ detail, receipts, connections, copy citation |
| Graph | `graph` | ✅ namespace, tag, entity, temporal, contradictions |
| Write | `store` | ✅ create via MCP |
| Edit | SDK `update` / `memos_supersede` | ✅ store + supersede (keeps history) |
| Delete | `forget`, `forget-source` | ✅ forget with deletion record |
| Health | `health` | ✅ score, fix cards, drill-down |
| Consolidation view | `dream`, `consolidate` | ✅ dream diff (read-only) |
| Context | `context`, `context-pack` | ✅ “What the AI sees” |
| Harnesses | `connect`, `harness` | ✅ 16 targets, snippets, versions |
| Ingest files | `ingest` | ✅ Ingest modal (`memos_ingest`, native picker, presets, count summary) |
| Review / quarantine | `review`, `quarantine` (MCP) | ✅ Review queue view (`memos_review` list + gated Approve/Reject + capability card on 24-tool writers) |
| Brief / digest | `brief` (MCP), `digest` | ✅ Today / Brief view (24h SQLite digest, 5 sections, empty state) |
| Answer audit | `audit-answer` (MCP) | ❌ |
| Recall explain / replay | `explain-recall`, `replay` (MCP) | ❌ |
| Query plan | `plan` | ❌ |
| Drift | `drift` | ❌ |
| Usage / stats | `stats`, `usage` (MCP) | Partial (store card only) |
| History / revert | `history`, `revert` (MCP) | Partial (receipts only) |
| Export / backup | `export`, `backup` | Copy-as-Markdown only |
| Import | `import`, `import-external` | ❌ |
| MemFS | `mount` | ❌ |
| Images | `image` | Captions only; no preview |
| Reminders | `reminders`, `remind` | ❌ |
| Profile / handoff | `profile`, `handoff` | ❌ |
| Link / tag / trust / validity | `link`, `tag`, `quarantine`, MCP setters | ❌ (only edit tags in composer) |

## Architecture that keeps performance

- **Reads stay in Rust.** Brief, stats, drift, history, reminders, and search
  scopes can be answered from SQLite in a few milliseconds with no Node.
- **Writes go through MCP.** Store, supersede, forget, review, ingest, revert,
  link, and trust changes use the existing bridge so provenance, embeddings,
  and the tamper log stay correct.
- **Analysis uses the CLI/MCP when available.** `audit-answer`,
  `explain-recall`, `replay`, and `plan` depend on the TypeScript engines.
  Curated modals should check the bridge's tool list and show a clear
  “requires the local CLI” state instead of failing.
- **No direct SQLite writes.** That rule stays.

## Next 12, ranked

### 1. Today / Brief
A new sidebar view under Views: new, changed, expiring, newly contradicted,
and provenance-less memories from the last 24 h. Each row jumps to the memory
or applies a filter. Data is already in `updated_at`, `expires_at`,
`contradictions`, and `tamper_log`.
**Effort M · Impact high ·** new `ui/views/brief.rs`, `core/db.rs`.

### 2. Review queue
A derived queue over the health checks with j/k, Approve, Reject, and Quarantine
release. Uses `memos_review` / `memos_quarantine_release` through the bridge.
**Effort M · Impact high ·** new `ui/views/review.rs`, bridge methods.

### 3. Ingest
A file/folder picker with type filters, namespace, and progress. Calls
`memos_ingest`; the app never parses files itself.
**Effort M · Impact high ·** new `ui/views/ingest.rs`, `rfd` file picker.

### 4. Graph label collisions and hover
At 96 nodes labels already overlap (“Design note #14/#29”, “#9/#39”).
Label only selected, hovered, and the top 10 by importance; hide a label if it
overlaps a higher-ranked one; add a 1 px halo; dim edges to 35%; 2 px selection
ring. Hovering a node highlights its list row and vice versa.
**Effort M · Impact high ·** `ui/views/graph.rs`, `ui/views/list.rs`.

### 5. Search scopes and chips
Accept `type:decision`, `tag:auth`, `src:claude-code`, `has:contradiction`,
`after:2026-11-01`, and `is:stale` in the search box, rendered as removable
chips. Saved views already persist the filter.
**Effort S · Impact high ·** `core/model.rs`, `ui/views/list.rs`.

### 6. Keyset pagination past 500 rows
The list is capped at 500 with no load-more. Add a `(sort_key, rowid)` cursor and
append on scroll; keep the 500-row page for the initial paint.
**Effort M · Impact high ·** `core/db.rs`, `ui/views/list.rs`.

### 7. Image memory preview
Image memories show a caption but not the image. Resolve the content-addressed
blob in `~/.memos/memos-images` and render a thumbnail in the detail pane and a
small preview in the row.
**Effort M · Impact medium-high ·** `core/db.rs`, `ui/views/detail.rs`.

### 8. History and revert
A version rail in detail from `tamper_log` + supersession edges, with a diff and
a confirmed Revert (`memos_revert`). This completes the receipts story.
**Effort M · Impact high ·** `ui/views/detail.rs`, bridge method.

### 9. Usage and stats panel
A compact panel in the store card or a modal: memories by type/namespace, edges,
avg trust, quarantined, expires soon, embedding coverage, and last write.
Data is local SQL; no Node.
**Effort S · Impact medium ·** `core/db.rs`, `ui/app.rs`.

### 10. Drift radar
Hash file sources against the stored `sourceHash` and show unchanged, drifted,
missing, unreadable. A filter and “set reminder” action, no DB writes.
**Effort M · Impact medium ·** new `ui/views/drift.rs`.

### 11. Export / backup
Copy the SQLite file with a timestamp, export the current view as Markdown/JSON,
and open the folder. No new dependencies.
**Effort S · Impact medium ·** `ui/app.rs`, `core/db.rs`.

### 12. Audit-answer and explain-recall
Two advanced modals: paste an answer to check claim support (`audit-answer`), or
inspect a recall trace and replay a config (`explain-recall` / `replay`). Check
the bridge's tool list; show “requires local CLI” if missing.
**Effort L · Impact high ·** new `ui/views/audit.rs`, `ui/views/recall.rs`.

## Performance guardrails

- Keep the 10k gate: FTS p95 < 30 ms, layout < 250 ms, 50k RSS < 200 MB.
- Add a 100k smoke case and a 8.33 ms frame budget for 500 rows + 2k graph.
- Cache shaped graph labels by `(text, size)`; rank labels once per layout.
- Coalesce WAL refresh to 500 ms and skip the health aggregate when
  `(node_count, max(updated_at))` is unchanged.
- Run `INSERT INTO nodes_fts(nodes_fts) VALUES('optimize')` on churn.
- Keep `LIST_PAGE_SIZE = 500` as the first page, appending `LIST_NEXT_PAGE_SIZE = 250` pages via keyset pagination (implemented).

## Suggested sequence

1. **Done (current pass):** Today/Brief, Review queue, Ingest, graph labels (`0.40` floor, halo, bounds clamping) & linked hover, search scopes, keyset pagination past 500 (`500 + 250`), Detail Time block + `retrieve`/`show` timestamps.
2. **Next:** image preview, history/revert, usage/stats, drift, export.
3. **Then:** audit-answer, explain-recall/replay, MemFS, reminders.

The first pass adds three CLI jobs (brief, review, ingest), fixes the most
visible graph defect, and removes the 500-row ceiling — a clear step from
“viewer” to “the app for your memory store.”
