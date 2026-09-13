# Memory Operations Guide

Everything you can do with a running MemOS store beyond the basic
store/search loop. Every command below works through the TypeScript SDK,
the CLI, and the MCP server unless noted.

---

## Multi-scope memory (user / agent / run)

Scope keys isolate memories per user, agent, and session — composed into
the underlying namespace in a fixed order (`user → agent → run`):

```bash
memos store "Prefers concise answers" --scope user:alice
memos search "answers" --scope user:alice
```

```typescript
await memos.store("Prefers concise answers", {
  scope: { user: "alice", agent: "coder" },
});

// Hierarchical by default: this surfaces everything Alice stored —
// including memories from her agents and runs.
const results = await memos.search({
  query: "answers",
  scope: { user: "alice" },
});

// Exact match requires the identical scope set.
const exact = await memos.search({
  query: "answers",
  scope: { user: "alice", agent: "coder" },
  scopeMatch: "exact",
});
```

Plain writes (no scope, no namespace) land in the `default` namespace, so
existing stores are unaffected. Raw namespaces still work for custom
grouping; scopes are the typed interface on top.

---

## Multi-granularity pools

Memories belong to a pool: `event` (raw statements — the default), `note`
(distilled summaries produced by consolidation), or `procedure`
(workflow / how-to knowledge). Context packs query the pools as separate
streams and fuse the results.

```bash
memos store "Run migrations before deploy" --pool procedure
memos search "deploy" --pool procedure
```

```typescript
await memos.contextPack({
  query: "deploy",
  tokenBudget: 2000,
  // multiStream: false  ← disable per-pool streams
});
```

---

## Consolidation: self-maintaining memory

One pass merges near-duplicates, archives stale low-importance memories,
**supersedes decayed ones** (marked historical — never deleted), and
distills cluster summaries into the note pool:

```bash
memos consolidate                    # one pass + summary
memos consolidate --dry-run          # preview
memos consolidate --no-summarize     # skip note distillation
```

### Watch mode

Run consolidation on a schedule from a terminal, tmux pane, or systemd
unit — each cycle prints a one-line digest:

```bash
memos consolidate --watch                  # every 30 minutes
memos consolidate --watch --interval-min 10
```

### Digest

```bash
memos digest
```

```
Memory digest:
  learned/merged:  2 duplicate cluster(s) merged
  superseded:      1 decayed
  archived:        0 moved aside
  new notes:       1 cluster summary(ies)
  context packs:   12 built · 61.4% tokens saved vs raw JSON
```

### Decay-based forgetting

Retention is scored from importance (0.35), trust (0.15), access
frequency (0.15), and exponential recency (0.35, 60-day half-life).
Memories below the threshold (default 0.2) are superseded — their
`validTo` is set so they drop out of default search but remain queryable
via temporal search. Nothing is ever deleted:

```bash
memos consolidate --min-retention 0.35 --decay-half-life 30 --older-than 30
```

Tune the knobs in the SDK via `ConsolidateOptions`. LLM-assisted note
distillation is available through the `summarizeClusterLlm` config hook —
give it a local 0.6B–4B model for fully-offline runbook notes.

---

## Version timeline (audit)

Every superseded version stays queryable. `history` reconstructs the
timeline for one memory — what it replaced, what replaced it, and which
consolidated notes were derived from it:

```bash
memos history <id>
```

```typescript
const timeline = await memos.history(id);
timeline.supersedes;    // older versions this one replaced
timeline.supersededBy;  // newer versions that replaced this one
timeline.derivedNotes;  // notes derived via `derived_from` edges
timeline.edges;         // every graph edge touching this memory
```

On the MCP surface the same audit is `memos_history`.

---

## Importing from ChatGPT / Claude

Bring memories from other assistants. The parser sniffs the export shape
(ChatGPT `mapping` trees, Claude `chat_messages`, flat memory lists) and
imports user-side text with `external_data` provenance and lower default
trust:

```bash
memos import-external ~/export/memories.json --source auto --dry-run
memos import-external ~/export/conversations.json --source chatgpt
```

---

## Encryption at rest

Databases are plaintext SQLite by default. Encryption uses
[ better-sqlite3-multiple-ciphers ](https://github.com/m4heshd/better-sqlite3-multiple-ciphers)
(AES-256), an API-compatible drop-in driver:

```bash
npm i better-sqlite3-multiple-ciphers   # one-time, optional

memos encrypt --key "<passphrase>" --db ~/.memos/memos.db
# the plaintext original is kept as <db>.plaintext.bak
```

From then on, provide the key at runtime — `MEMOS_KEY` environment
variable or `cipherKey` in the SDK config. Remove encryption with
`memos decrypt --key "<passphrase>" --db <path>`. Keys live with you:
there is no recovery without the passphrase.

---

## Token-savings telemetry

Every context pack records what it cost versus the naive raw-JSON
baseline for the same candidates:

```bash
memos stats
```

```typescript
memos.usageStats();
// { packsBuilt, packTokens, naiveBaselineTokens, savedTokens, savedPct }
```

On the MCP surface: `memos_usage`. Counters are per-process (the SDK is
embedded in your app or MCP server).

---

## Interactive browser and graph export

```bash
memos browse              # full-screen pager: search, inspect, forget
memos graph --mermaid     # GitHub-renderable diagram of the memory graph
```
