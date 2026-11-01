# MemOS feature roadmap — demand, gaps, and plugin integration

> Last updated: 2026-09-17
> Companion to [`memos-vs-supermemory.md`](./memos-vs-supermemory.md).

## How this list was built

Demand signals came from: competing memory-layer READMEs and docs (supermemory,
mem0, Zep, Letta), third-party comparison write-ups (Mnemoverse Q3 2026,
Vectorize, EverMind, Medium/puppyone), the LongMemEval/Mastra benchmark
write-ups, and the debugging-pain checklist that shows up repeatedly in
integration guides.

**Caveat, stated up front:** this is competitor-and-commentator evidence, not a
survey of MemOS users. MemOS's own issue tracker should validate this ordering
before engineering time is committed. The value here is the *feature set*, the
MemOS-gap assessment, and the plugin mapping — not the exact ranking.

---

## The one-sentence finding

MemOS is already strong at the **hard** parts (abstention, provenance,
tiered compression, scope isolation, offline operation) and weak at the
**demonstrable** parts (a one-call profile, connectors, published numbers).
The market buys the second group. That asymmetry is the whole roadmap.

---

## Tier 1 — do first

### F1. One-call user profile (`memos_profile`)

- **What:** a single call returning `static` (durable facts: role, prefs,
  environment) + `dynamic` (recent activity). Inject into the system prompt.
- **Demand:** this is supermemory's most-cited DX feature
  (`client.profile()`, "~50ms", "one call and your agent knows who it's
  talking to"). Every 2026 comparison article lists profiles as a first-class
  capability.
- **MemOS status:** **missing.** Nearest is `memos_context_pack`
  (token-budgeted, relevance-ranked) — a *query-dependent slice*, not a
  maintained profile. The distinction matters: a profile is stable across turns
  and cheap to cache; a context pack is recomputed per query.
- **Core work:** `src/memory.ts` profile API + `src/mcp.ts` tool
  `memos_profile`; back it with pinned `type=preference|entity` memories plus a
  recency window. Cache it — the 50ms claim is a caching claim.
- **Plugin:** `SessionStart` hook should call `profile`, not `summarize`; add a
  "use `memos_profile` at session start" rule to SKILL.md.

### F2. Per-prompt recall hook — **SHIPPED (2026-09-17)**

- **What:** recall on every user message, not once per session.
- **Demand:** supermemory's documented harness recipe is
  *session-start → profile, on-message → search, on-stop → save*. MemOS had
  start and stop but no middle leg, so a long session drifted: context
  recalled at turn 1 was stale by turn 40 and nothing re-injected on topic
  change.
- **Status:** added `plugin/hooks/user-prompt-submit.mjs` and registered
  `UserPromptSubmit` in `hooks/hooks.json`. Skips short prompts and slash
  commands, drops matches below score 0.15, caps at 5 memories / 1500 chars,
  8s timeout, fail-soft.

### F3. Hybrid recall — make it explicit and measured

- **What:** memories *and* raw session context in one ranked result, with a
  documented way to ask for memories only.
- **Demand:** the supermemory post that triggered this review.
- **MemOS status:** **capability shipped, never positioned or measured.** Pools
  (`event`/`note`/`procedure`) + session/graph expansion already do this.
- **Work:** documentation + the `--pool=` ablation in
  `bench-longmemeval.ts` (done). No new core code.
- **Plugin:** teach the wide→narrow pattern in SKILL.md — search all pools
  first, fall back to `--pool=note,procedure` when results look noisy.

### F4. Precision, not recall

- **What:** raise precision@10 from **0.099**.
- **Demand:** internal, and the most important number MemOS owns. See §4 of
  `memos-vs-supermemory.md`: hit@10 is a respectable 0.832 while ~90% of
  injected tokens are noise. Context reduction is the product; precision *is*
  the product metric.
- **Work:** tune `relevanceRatio` and the abstention floor against a labelled
  set; treat reranking as a first-class stage rather than an option.

---

## Tier 2

### F5. Automatic forgetting / temporary facts

- **Demand:** supermemory markets it directly — "Temporary facts ('I have an
  exam tomorrow') expire after the date passes."
- **MemOS status:** **partial.** `memos_set_validity` (validFrom/validUntil)
  and decay exist, but nothing *automatically* expires a fact when its date
  passes, and nothing infers "this is temporary" at write time.
- **Work:** a validity sweeper at `init()`/consolidation + a temporal-language
  heuristic on `memos_store` to propose `validUntil`.

### F6. Absence detection as a headline feature

- **Demand:** hallucinated recall is the top complaint about memory layers.
  LongMemEval ships an abstention setting for exactly this.
- **MemOS status:** **ahead of the market, and not saying so.** `trustFloor`
  (0.7), `shouldAbstain` and the confidence machine already implement it.
- **Work:** mostly marketing + a benchmark (score abstention separately:
  correct-answer rate, false-answer rate, correct-abstention rate). Add
  "knows when it doesn't know" to the README and `plugin.json`.

### F7. Memory inspector — "why did I recall this?"

- **What:** `memos_explain <memoryId|query>` returning score decomposition
  (keyword vs semantic vs recency vs confidence), pool, supersede chain, and
  which expansion stage contributed it.
- **Demand:** integration guides converge on the same debugging checklist:
  *did the right content get ingested? was it attached to the right scope? did
  a newer fact override an older one? did the search use the right mode?*
  Answering those today means ad-hoc SQL.
- **MemOS status:** **SHIPPED (2026-10-27).** `memos.explain()`,
  `memos_explain`, and `memos explain` return pre-gate candidates with per-leg
  components, lifecycle status, supersede chain, outcome utility, and a
  `focus` block for a memory that was *not* retrieved (namespace, pool,
  lifecycle, embedding-model mismatch, lexical overlap). See
  [`recall-inspector.md`](./recall-inspector.md).
- **Plugin:** `/memos explain <id>` command can now call the MCP tool.

### F8. Outcome-conditioned ranking — "did the memory help?"

- **What:** explicit task-outcome feedback per query, used to promote memories
  that were actually useful and demote ones used in failed tasks.
- **Demand:** 2026 memory research and products are moving from predicted
  relevance to measured utility; no major local-first competitor exposes
  outcome-conditioned ranking with an observational uplift metric.
- **MemOS status:** **SHIPPED (2026-10-27).** `recordRecallFeedback` /
  `memos_feedback` persist `used` ids plus `success|partial|failure`; a bounded
  multiplier (±20% default) applies only after feedback exists. `health()`
  reports useful-recall rate.
- **Caveat:** uplift is observational. Do not market it as causal.

### F9. Governance: scoped delete / export / rollback

- **Demand:** the "governance layer" is called out as a distinct buying
  criterion (who can read, write, approve, delete, inspect, roll back).
- **MemOS status:** CLI `export`/`backup` exist; scoped *delete* is not
  exposed over MCP.
- **Work:** `memos_forget --scope` / namespace purge + an MCP tool.

---

## Tier 3 — real demand, lower priority for MemOS

| Feature | Demand | MemOS position | Note |
|---|---|---|---|
| Connectors (Drive/Gmail/Notion/GitHub) | Very high | Absent | Big surface; OAuth burden fights "zero cloud". Prefer an import CLI over always-on sync. |
| Multimodal ingestion (PDF/OCR/video) | High | Absent | Low differentiation for a *memory* layer. Defer. |
| Procedural / skill memory (L2) | Growing | **Already have `procedure` pool** | The "missing diagonal" of 2026. Market it; expose `pool=procedure` in MCP store. |
| Multi-agent shared memory | High | **Have `scope` + `namespace`** | Undersold. |

---

## Plugin integration matrix

Where each feature lands across the three surfaces.

| Feature | Core (`src/`) | MCP tool | Plugin surface |
|---|---|---|---|
| F1 profile | `memory.ts` + `mcp.ts` | `memos_profile` | `SessionStart` hook → profile; SKILL.md rule |
| F2 per-prompt recall | — | (uses `memos_search`) | **`UserPromptSubmit` hook (shipped)** |
| F3 hybrid | none needed | `pool` param on `memos_search` | SKILL.md wide→narrow pattern |
| F4 precision | `retrieval.ts` tuning | — | — |
| F5 forgetting | validity sweeper | extend `memos_set_validity` | consolidate hook copy |
| F6 abstention | already exists | surface signal in `memos_search` | README + `plugin.json` |
| F7 inspector | `memos.explain` | `memos_explain` | `/memos explain` command |
| F8 outcome feedback | `feedback.ts` | `memos_feedback` | skill rule: report used ids + outcome |
| F9 governance | scoped delete | `memos_forget --scope` | `/memos` command extension |

### Current plugin files

```
plugin/
  plugin.json                        Portable Agent Plugins v1 — Hermes reads
  mcp.json                           MCP server — Hermes reads
  skills/memos-memory/SKILL.md       store/recall — Hermes AND Claude Code
  skills/memos-maintenance/SKILL.md  hygiene — Hermes AND Claude Code
  .claude-plugin/plugin.json         Claude Code manifest
  .mcp.json                          Claude Code MCP
  commands/memos.md                  /memos     — Claude Code only
  commands/recall.md                 /recall    — Claude Code only
  hooks/hooks.json                   SessionStart | UserPromptSubmit | SessionEnd
  hooks/session-start.mjs                       — Claude Code only
  hooks/user-prompt-submit.mjs                  — Claude Code only
  hooks/session-end.mjs                         — Claude Code only
```

Only the first four lines are visible to Hermes. Everything below
`.claude-plugin/` is inert there.

---

## ⚠ Hermes loads three things, and hooks are not one of them

**Verified against Hermes' own loader**, not inferred. Loading
`plugin/` with `hermes_cli.agent_plugins.load_agent_plugin` (the function
Hermes calls at startup) and running `hermes plugins doctor` both report:

```
registrations: 0 tool(s), 0 hook(s)
```

A portable Agent Plugins v1 package has exactly three loadable components:

| Path | Hermes | Claude Code |
|---|---|---|
| `plugin.json` | ✅ | ❌ (uses `.claude-plugin/plugin.json`) |
| `mcp.json` | ✅ | ❌ (uses `.mcp.json`) |
| `skills/<name>/SKILL.md` | ✅ | ✅ |
| `commands/` | ❌ ignored | ✅ |
| `hooks/hooks.json` | ❌ ignored | ✅ |

Two independent reasons the hooks are dead under Hermes:

1. **Variable substitution.** Hermes expands only `${PLUGIN_ROOT}` and
   `${PLUGIN_DATA}` (`_PLACEHOLDER_RE` in `agent_plugins.py`).
   `${CLAUDE_PLUGIN_ROOT}` is left literal, so every hook command would be an
   invalid path even if the file were read.
2. **A different hook system.** Hermes' native hooks come from `plugin.yaml`
   with `provides_hooks` (`plugins_manifest.py`). No `SessionStart`,
   `PreToolUse` or `UserPromptSubmit` exists anywhere in `hermes_cli/`.

### Mitigation applied — behaviour moved into skills

Since skills are the **only** behavioural surface Hermes loads, the work the
hooks were doing is now written into them:

- `memos-memory` carries a **Harness protocol** section: a table of what each
  harness automates, and an explicit start / during / finish checklist for
  hook-less harnesses (recall first, store as you learn it, consolidate before
  finishing). Without it, the failure is silent — the agent answers from
  general knowledge while relevant memories sit on disk.
- `memos-maintenance` is a new second skill covering hygiene (consolidate,
  supersede, diagnostics, reindex, trust/validity, forget). It was previously
  buried in `memos-memory`; splitting it gives Hermes a second activation
  trigger, and Hermes loads multiple skills without limit.

### Also fixed

- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and
  `plugin/plugin.json` descriptions/keywords were stale and had drifted apart;
  all three now match.
- `.mcp.json` used an **unpinned** `@mem-os/sdk` while `mcp.json` pinned
  `@1.6.26`. Both are pinned now — an unpinned stdio server is a silent
  version-drift risk against a manifest that advertises 1.6.26.

### Regression guard

`hermes plugins validate` only parses the manifest, and `hermes plugins doctor`
only reports native registrations. Neither tells you whether your skills were
discovered. Use:

```bash
python scripts/check-hermes-plugin.py          # needs PyYAML + HERMES_SRC
```

It calls `load_agent_plugin` directly and prints the skills, MCP servers and
any diagnostics. Current output: 2 skills, 1 MCP server, 0 diagnostics.

### Not done — option B

A Hermes-native `plugin.yaml` with `provides_hooks` and Python hooks would
restore true automation, but it is a second implementation of the same
behaviour in a different language and only works in one harness. Defer until
Hermes-specific behaviour is genuinely required.

---

## Suggested order

1. F2 — done.
2. F4 (precision) — it is the product metric and needs no new API.
3. F1 (profile) — highest demand-per-effort, and it is the feature the
   comparison articles name first.
4. F6 (abstention) — nearly free; it is positioning work on existing code.
5. F7/F8 (inspector, governance) — converts existing primitives into a story.
6. F5, then Tier 3.

## Explicitly not building

- **A MemOS benchmark suite.** Contribute to the existing open ones instead; a
  vendor's own benchmark convinces nobody (see the 81.6/84.6/85.2 spread).
- **Document RAG as memory.** Supermemory is right that "memory is not RAG";
  copying their SuperRag surface would dilute the fact-tracking core.
- **Multimodal ingestion** (Tier 3) until connectors prove out.
