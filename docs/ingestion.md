# Document Ingestion

Point MemOS at a folder and it remembers what is in it. Markdown, text, CSV,
JSON, YAML, HTML and PDF are supported. No cloud, no upload, no API key.

```bash
memos ingest ./notes
memos ingest ./notes --watch          # keep it in sync
memos ingest ./papers --ext .pdf --namespace research
```

From code:

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

const result = await memos.ingest("./notes", {
  namespace: "documents",
  chunkChars: 1200,
});
console.log(result); // { added, updated, unchanged, removed, skipped, errors, chunks }
```

Live sync:

```ts
import { watchPath } from "@mem-os/sdk";

const handle = await watchPath(memos, "./notes", { namespace: "documents" });
// ... later
handle.close();
```

## From Python

The HTTP server exposes the same operation:

```bash
curl -X POST http://localhost:7400/api/mem/ingest \
  -H "Content-Type: application/json" \
  -d '{"path": "./notes", "namespace": "documents"}'
```

```json
{"added": 12, "updated": 0, "unchanged": 0, "removed": 0, "skipped": 1, "errors": 0, "chunks": 34}
```

For safety the server only reads inside its working directory. Set
`MEMOS_INGEST_ROOT` to widen that (the HTTP server binds `0.0.0.0` by default,
so an unrestricted path would let anyone on the network read local files).

## From an MCP client

`memos_ingest` is part of the core MCP tool set, so Claude Desktop, Cursor and
other MCP clients can ingest without shell access:

```json
{
  "name": "memos_ingest",
  "arguments": { "path": "./notes", "namespace": "documents" }
}
```

It returns the same counters and is annotated idempotent, so agents can retry
safely.

## How it behaves

- **Incremental.** Each file is hashed. Unchanged files are skipped; an edited
  file replaces its old chunks; a deleted file removes them.
- **Chunked.** Text is split on paragraph boundaries (default 1,200 characters)
  with a 150-character overlap, so a sentence cut at a boundary is still
  recoverable from the neighbouring chunk.
- **Tagged.** Every chunk carries `ingested`, a stable `doc:<hash>` tag, and
  metadata with `sourcePath`, `sourceHash`, `chunkIndex` and `chunkCount`, so
  you can trace a memory back to the file it came from.
- **Namespaced.** Default namespace is `documents`; pass `--namespace` to keep
  projects, research and personal notes apart.

## Supported formats

| Format | Notes |
| --- | --- |
| `.md`, `.mdx`, `.txt`, `.rst`, `.log` | read as-is |
| `.json`, `.jsonl`, `.csv`, `.tsv`, `.yaml`, `.yml` | read as text, chunked |
| `.html`, `.htm` | tags, scripts and styles stripped, entities decoded |
| `.pdf` | text extracted with [`unpdf`](https://github.com/unjs/unpdf) (pure JS, no native build) |

Folders are scanned recursively; `.git`, `node_modules`, `dist`, `build`,
virtualenvs and caches are skipped. Files over 20 MB are skipped by default.

## PDF support

PDF text extraction uses the optional `unpdf` package. It ships as a normal
dependency, so a standard install already has it. If you install MemOS with
optional dependencies disabled, add it manually:

```bash
npm install unpdf
```

Scanned PDFs (images of text) have no text layer; run OCR on them first.

## Choosing a namespace

```bash
memos ingest ./work-notes   --namespace work
memos ingest ./papers       --namespace research --ext .pdf
memos ingest ./journal      --namespace personal
```

Searches can then be scoped:

```bash
memos search "reset code" --namespace work
```

## Limits and honest notes

- Chunking is lexical; a table split across pages may lose its header. Keep
  small, self-contained files where possible.
- There is no automatic summarisation of long documents beyond the SDK's normal
  extractive summary.
- Ingestion is single-process. Running two watchers over the same database is
  not supported.
