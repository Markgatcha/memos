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

### Scoped spaces and the shared-default union

A scoped read **always unions the shared `default` namespace** with the
requested scope(s) — shared knowledge is visible inside every scope,
while other scopes stay isolated (company-brain container semantics):

```bash
memos store "Q4 hiring freeze" --namespace project:alpha
memos search "hiring" --namespaces project:alpha,project:beta  # + default
memos scope list   # every scope with its live memory count
```

Free-form scope names follow the `project:<name>` / `harness:<name>`
convention. Pass `includeSharedScope: false` in the SDK for the legacy
exclusive behavior. Unscoped searches are unchanged.

### Write-side salience triage

`memos store` runs a cheap no-LLM retain filter that skips trivial
acknowledgements ("ok", "thanks") and near-duplicates of recent
same-scope memories before anything is persisted. The rule is
conservative-first: a write is skipped only on positive noise evidence —
when in doubt the memory is kept. Bypass with `--force`; the MCP
`memos_remember` tool opts in via `filter_retain` (a skip returns a
plain-text notice, not an error). Skipped writes log at debug level
(`MEMOS_DEBUG=1`).

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

## Time-aware retrieval

Semantic similarity answers "what is this about". People also ask "what
happened around then", and those are different questions. Two opt-in
re-rankers cover the gap; neither changes what the retriever found, only
the order it is returned in.

### Relative-time anchoring

When a query carries a relative expression — "10 days ago", "two weeks
ago", "in the past month" — memories dated inside that window are promoted
above memories outside it. Order is preserved within each group, so a
weaker-but-relevant memory does not leapfrog a stronger one.

```ts
const hits = await memos.search({
  query: "what kitchen appliance did I buy 10 days ago?",
  limit: 20,
  relativeTimeBoost: true, // default: on when the query has an expression
});
```

Resolution is relative to `validAt` when set (replaying history), otherwise
to now. Parsing lives in `src/relative-time.ts`; the ranking step is
`applyRelativeTimeAnchor` in `src/temporal-rerank.ts`.

> Why not just filter by date? On LongMemEval, relative-offset windows cover
> 10%–77% of a conversation corpus depending on the unit. "Everything in the
> window" is close to a random pick, so the window re-orders — it never
> replaces — the semantic ranking.

### Chronological neighbour expansion

A conversation is a timeline. The answer to "what did we decide in that
session" is often in the turn just before or after the one that matched.

```ts
const hits = await memos.search({
  query: "what did we settle on for the billing migration?",
  limit: 20,
  sessionNeighbours: { radius: 2 }, // or `true` for the default
});
```

Each promoted memory takes the lowest-ranked slot and is scored below the
hit that produced it. Two rules make this safe:

- **Only memories the query already matched are expanded.** A neighbour of
  an unrelated memory is not a neighbour of the answer; scanning the corpus
  for temporal adjacency measurably *lowered* LongMemEval all-evidence
  recall (97.8% → 97.0%) by evicting sessions that had legitimately matched.
- **The budget is `ceil(limit / 5)`** — the retriever keeps at least 80% of
  the window. Tune with `maxInjected`.

Implementation: `expandToTemporalNeighbours` in `src/temporal-rerank.ts`,
tests in `__tests__/temporal-rerank.test.ts`.

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
