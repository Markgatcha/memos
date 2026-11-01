# Ingest your notes in 60 seconds

This is the shortest path from a folder of notes to a memory you can search.
No account, no API key, no cloud.

## 1. Install

```bash
npm install -g @mem-os/sdk
```

Check it:

```bash
memos --version
```

## 2. Point it at a folder

```bash
memos init
memos ingest ~/notes
```

Expected output:

```text
  added     projects/roadmap.md (3 chunks)
  added     meeting-2026-10-12.md (1 chunks)
  added     manual.pdf (7 chunks)
Ingested: 3 added, 0 updated, 0 unchanged, 0 removed, 0 skipped, 0 errors (11 chunks).
```

Supported: Markdown, text, CSV, JSON, YAML, HTML and PDF. Re-running is
incremental — unchanged files are skipped, edited files replace their chunks,
deleted files remove theirs.

## 3. Ask for something that only exists in those notes

```bash
memos search "what did we decide about the release date"
```

Expected output:

```text
  [fact] Release date moved to 14 November; freeze starts on the 7th.
    ID: 39f5e742-...  Score: 0.816
    Tags: doc:754b6dc3f8728b19, ingested
```

## 4. Keep it current

```bash
memos ingest ~/notes --watch
```

Leave it running while you edit. New files are added, edits replace the old
chunks, deletions remove them.

## Use it from code

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

await memos.ingest("./notes", { namespace: "documents" });
const pack = await memos.contextPack({
  query: "release date",
  tokenBudget: 1200,
  namespace: "documents",
});
```

## Use it from Python

```bash
curl -X POST http://localhost:7400/api/mem/ingest \
  -H "Content-Type: application/json" \
  -d '{"path": "./notes", "namespace": "documents"}'
```

## Use it from an MCP client

Ask the agent to call `memos_ingest` with `{"path": "./notes"}`. The tool
returns the same counters, is idempotent, and sits in the default core tool
set.

## Where to go next

- [Document Ingestion](ingestion.md) — formats, chunking, namespaces, safety
- [Preferences](preferences.md) — capture tastes, not just facts
- [Troubleshooting](troubleshooting.md) — if ingestion finds nothing

## Common first-run issues

| Symptom | Fix |
| --- | --- |
| `0 added, N skipped` | Files are empty or only front-matter; check the file contents |
| PDF yields no text | It is a scanned image; run OCR first |
| Search feels lexical | The default embedder is small; configure Ollama or FastEmbed for better recall |
| `MEMOS_API_KEY` set and the API returns 401 | Send `Authorization: Bearer <key>` |
