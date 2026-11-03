# Memory improvement scan, November 2026

Research notes for the next MemOS roadmap. The question: given the 2026
memory literature, the major product launches, and the current codebase, what
should MemOS build next?

## The short version

An agent memory system is a notebook, not a brain. The evidence says five
things:

1. **A cheap index and good search beat a cleverly rewritten notebook.**
   Raw-history retrieval and BM25 often match elaborate memory pipelines.
2. **Keep the original pages.** Summaries lose the details that answer
   questions, especially process details in coding tasks.
3. **Mark old pages as old.** Do not file a superseded fact next to the
   current one and hope the reader notices.
4. **A notebook nobody opens is worthless.** Delivery matters more than
   storage; agents often make zero memory calls unless the harness injects
   memory for them.
5. **A notebook anyone can write to is a security hole.** Persistent memory
   is a cross-session attack surface, and local MCP servers have shipped
   serious auth and CORS bugs.

MemOS already has the hard storage pieces: SQLite, hybrid retrieval,
provenance tiers, supersession, validity windows, decay, context packs,
deletion certificates, and a tamper log. The highest-value work is now around
the edges: **delivery, deletion, security, process memory, and proof that it
helps**.

## What the evidence says

| Finding | Evidence | What it means for MemOS |
| --- | --- | --- |
| Raw history is a strong baseline | Raw-RAG ranks first in 6 of 7 benchmark-model settings, beating the strongest agentic memory by 0.13-5.53 points ([2610.30755](https://arxiv.org/abs/2610.30755)). Memory Tax finds many systems have negative net value ([2610.34073](https://arxiv.org/abs/2610.34073)). EvoMemBench finds long-context baselines highly competitive ([2605.18421](https://arxiv.org/abs/2605.18421)). | Keep L3 verbatim. Add a raw-history arm to the benchmark instead of assuming extraction helps. |
| Retrieval matters more than writing | Across three write strategies and three retrieval methods, retrieval moved accuracy by 20 points; the write strategy moved it by 3-8 (Diagnosing Retrieval vs. Utilization Bottlenecks, cited in the [3,283-paper review](https://openchamber.dev/blog/agent-memory-research/)). | Spend effort on ranking, coverage, and budget allocation before adding more extraction. |
| Structure wins when state changes | Typed state reaches 99% on aggregate questions where retrieval collapses to 6-43%. A deterministic supersession rule reaches 0.95-1.00 on evolving knowledge where RAG gets 0.20-0.47 (cited in the same review). | MemOS's `validFrom`/`validTo`, supersede edges, and contradiction detection are the right investment. Make them visible in context. |
| Deletion is unsolved | The review reports that no tested system passed more than 1.5% of forget requests end to end ([review](https://openchamber.dev/blog/agent-memory-research/), citing [2610.18052](https://arxiv.org/abs/2610.18052)). After deletion, 39-76% of secrets were still recoverable from derived records ([2610.21405](https://arxiv.org/abs/2610.21405)). | Follow `derived_from` edges on delete and report residual risk. This is a trust differentiator. |
| Memory poisoning is real and cross-session | The review reports 81.7% cross-session attack success against Claude Code ([review](https://openchamber.dev/blog/agent-memory-research/), citing [2609.13889](https://arxiv.org/abs/2609.13889)). Five flattening harnesses let forged turns survive compaction 87-100% of the time; role-typed harnesses were at 0% ([2610.29869](https://arxiv.org/abs/2610.29869)). | Bind authority at write time. Never render tool output or external content as instructions. Isolate recalled memory from execution. |
| Delivery beats storage | An agent given a pre-seeded store made 0 memory calls in 114 turns; deterministic injection on cues fired in every seeded run (Delivery, Not Storage, cited in the review). | MemOS has `memos profile` but only installs a `SessionEnd` hook. Add a `SessionStart` injection path. |
| Coding agents need process memory | Memory mainly improves fine-grained localization and editing, but raw trajectories reduce steps because compressed memories omit process details ([2610.27524](https://arxiv.org/abs/2610.27524)). Repository memory found the root-cause file in 21/24 trials vs. 6/24 for retrieval-only, at 4.5x lower token cost ([2610.36153](https://arxiv.org/abs/2610.36153)). | Facts alone are not enough. Store a compact episode: files, commands, failures, fix, tests. |
| Evaluation is fragmented | 324 unique benchmark names in 2026 abstracts; LoCoMo is saturating; vendor LongMemEval numbers have differed by 45 points under the same name ([review](https://openchamber.dev/blog/agent-memory-research/), [comparison](https://aiagentmemory.org/articles/llm-memory-comparison/)). | Publish the protocol, the answer model, the judge, and the raw artifact. Do not compare across vendors casually. |

### The strongest single result

The most useful paper for MemOS is not a new architecture. It is the
demonstration that **memory transforms can hurt**. Memory Tax separates
"memory benefit" from "memory tax": reorganization can help, but it can also
remove or obscure evidence. Raw-RAG makes the same point empirically.

That does not mean "delete the graph." It means every transformation needs a
measured reason to exist. MemOS's existing retrieval-only numbers (99.4%
Hit@20 on LongMemEval-S, 62.7-64.1% Hit@10 on LoCoMo) are retrieval metrics.
They do not answer "does the assembled context produce a better answer than
raw history?" That is the number to add.

## Where MemOS stands

| Area | Today | Gap |
| --- | --- | --- |
| Automatic delivery | `memos profile` can build a session-start block; `memos connect` installs only a `SessionEnd` hook (`src/session-hooks.ts:441`, `src/cli.ts:624`). | No `SessionStart` hook, so agents may never call memory. |
| Raw history | L3 verbatim content is stored; Markdown/Obsidian export exists. | No raw-history answer baseline in the benchmark. |
| Deletion | `forget`, `forgetSource`, deletion certificates, tamper log (`src/memory.ts:3617`, `src/memory.ts:3653`). | `forget` deletes one row; consolidation notes linked by `derived_from` survive (`src/memory.ts:6088`). |
| Security | Bearer auth, loopback default, MCP tool annotations (`src/mcp.ts:136`). | HTTP CORS is `*` with credentials (`memos/server/main.py:307`); mutating MCP tools have no per-tool scope or confirmation. |
| Coding-agent memory | Session hook extracts durable facts (`src/session-hooks.ts`). | No process trace: files, commands, failures, fix, tests. |
| Consolidation | `memos dream` merges duplicates, supersedes decayed rows, writes cluster notes, reports contradictions (`src/cli.ts:2918`). | No failure-to-rule distillation. |
| Proactive recall | `memos brief` searches and groups open/closed items (`src/memory.ts:3741`). | No store-size-aware gate; fixed thresholds degrade as the store grows. |
| Interop | MCP, HTTP, JSON/Markdown/Obsidian export. | No vendor-neutral wire format; migration is bespoke. |

## The best improvements, ranked

### P0: Inject memory at session start

**Why.** MemOS can store a perfect memory and still lose to a worse system
that actually puts memory in front of the model. The review's clearest
delivery result is an agent with a pre-seeded store making zero memory calls
in 114 turns. Cursor's own rules documentation makes the same distinction:
rules are static context injected at the start; learned memory is separate.

**What to change.** Add a `SessionStart` path alongside the existing
`SessionEnd` hook:

- Claude Code: a `SessionStart` hook that runs `memos profile` (or a new
  `memos inject` command) and returns `hookSpecificOutput.additionalContext`.
- OpenCode: a plugin hook on session creation that appends the same block.
- Codex and other harnesses without hooks: write a small managed block into
  `AGENTS.md`, or expose an MCP prompt the harness can call at startup.
- Keep it small: a fixed token budget, static facts first, recent activity
  second, and a pointer to `memos search` for deeper recall.

**Why it is safe.** It reuses `memos profile`, which already has static and
dynamic sections and a token budget. It does not change storage or retrieval.

**How to verify.** A fixture hook input should produce a non-empty
`additionalContext` under the budget, and an empty store should produce a
clear no-op rather than an error.

### P0: Close the local HTTP and MCP security gaps

**Why.** Persistent memory is now an attack channel. The MCP ecosystem has
already shipped the exact bugs to avoid:

- CVE-2026-33010: wildcard CORS plus anonymous access let any website read,
  rewrite, and delete memories in `mcp-memory-service`.
- CVE-2026-49291: an OAuth client with only `read` scope could call
  `store_memory` and `delete_memory` through MCP `tools/call`.
- CVE-2026-29787: a health endpoint disclosed system information.
- The MCP memory server hardening issue lists the same defaults: persistence
  outside the package, atomic writes, a mutation journal, destructive tools
  disabled by default, quotas, secret redaction, and namespace isolation
  ([#4117](https://github.com/modelcontextprotocol/servers/issues/4117)).

**What to change.**

- Replace `allow_origins=["*"]` with an explicit local allowlist, or an empty
  list plus `MEMOS_CORS_ORIGINS`. Never combine `*` with
  `allow_credentials=True`.
- Refuse to bind a non-loopback host without `MEMOS_API_KEY`, or print a
  prominent warning and require an explicit opt-in.
- Give MCP tools a read/write/destructive classification and enforce it at
  dispatch, not only in annotations. `forget`, `forgetSource`, `revert`, and
  quarantine release should require an explicit confirmation argument when
  called remotely.
- Keep the tamper log and add a short-lived read lease for destructive
  operations, so an injected agent cannot chain "read secret" into "delete
  everything" in one turn.

**How to verify.** A request with `Origin: https://evil.example` must not
receive an `Access-Control-Allow-Origin` header. A remote bind without a key
must fail at startup or return 401. A destructive tool call without the
confirmation argument must be rejected before it reaches storage.

### P0: Make deletion follow derived memory

**Why.** MemOS markets proof of forgetting. The current `forget` deletes one
node and writes a tombstone; it does not touch a consolidation summary that
was derived from that node. MemCut found 39-76% residual recovery after
deletion, and Bemula found no system above 1.5% end-to-end. This is a place
where MemOS can be materially better than the field, not just equal.

**What to change.**

- On `forget(id)` and `forgetSource(...)`, walk `derived_from` edges (and
  `metadata.derivedFrom` when present).
- If all of a derived note's sources are gone, delete it too.
- If some sources remain, mark it `staleDerivedFrom` and exclude it from
  search until a human or a consolidation pass rewrites it.
- Extend `proveForget` to report residual candidates: derived notes that still
  mention the deleted content, even if they are not exact copies.
- Add `--cascade` and `--audit` flags to the CLI and the MCP tools.

**How to verify.** Store a secret, run `memos consolidate` to create a cluster
note, forget the secret, and assert that the note is deleted or flagged and
that the certificate reports no unqualified residual.

### P1: Measure net value against raw history

**Why.** The literature's central challenge is that memory systems rarely
prove they beat raw retrieval. MemOS's current LoCoMo script uses an LLM judge
but has no raw-history arm (`scripts/bench-locomo.ts`). Without that arm, a
99.4% retrieval number cannot answer the question users and reviewers actually
ask.

**What to change.**

- Add `--baseline=raw` to `scripts/bench-locomo.ts` and
  `scripts/bench-longmemeval.ts`.
- Ingest raw turns into a separate namespace with the same embedding and FTS
  pipeline. Retrieve top-k turns with the same budget.
- Answer with the same model, prompt, and token budget. Judge with the same
  judge.
- Report accuracy, Gold Hit / Turn Hit coverage, tokens, latency, and the
  delta: memory benefit minus memory tax.
- Commit the artifact, not just the number. State the answer model, judge,
  split, and retrieval depth.

**Why it is worth it.** True Memory reports 93.0% LoCoMo and 87.8%
LongMemEval end-to-end on a single SQLite file ([2605.04897](https://arxiv.org/abs/2605.04897)).
Mem0 and Zep report 92-95% on their own harnesses. These numbers are not
directly comparable, but users will compare them. A raw-history arm lets
MemOS make a defensible claim instead of a leaderboard claim.

### P1: Add episode memory for coding agents

**Why.** MemOS's harness support is broad, but the session hook stores only
extracted facts. The coding-agent literature is unusually consistent:
process details matter. MemDev-Bench finds raw trajectories reduce steps
because compressed memories omit them. Stratum finds repository memory
dramatically improves root-cause localization. PROJECTMEM records typed
events (issues, attempts, fixes, decisions) and exposes a file-scoped precheck.
REM injects a short experience document at task start, withholds details until
the agent struggles, and evicts after one exposure.

**What to change.**

- Add an `episode` record (new type or a documented metadata schema) with:
  repo, branch, commit, files touched, commands run, failures, root cause,
  fix, tests, outcome, model, harness.
- Write one compact episode per session, linked to extracted facts by
  `derived_from`.
- Add `memos episode recall --repo . --files src/foo.ts` and an MCP tool.
- Inject an episode only when the current task touches the same repo or files,
  and re-check applicability before trusting it.

**Why it is different.** Mem0, Zep, and Letta are general memory layers.
MemOS already owns six coding harnesses. A repository-aware episode layer is
a product wedge that general-purpose competitors do not have.

### P2: Teach `dream` to turn failures into rules

**Why.** `memos dream` currently merges duplicates, supersedes decayed rows,
writes cluster notes, and reports contradictions. It does not learn from
failures. Let Them Sleep clusters failures, distills short rules, deletes the
raw episodes, decays unreinforced rules, and promotes rules that recur across
contexts. It reports +9.1 on a SWE-bench simulation, +11.9 on temporal
consistency, and +7.6 on LoCoMo-10, with about 30% fewer stored entries.

**What to change.**

- Add a `lessons` phase to `dream`: cluster failed episodes or negative
  feedback by tag/entity, emit a `rule` memory with evidence links, reinforce
  it when the same pattern recurs, and decay it when it does not.
- Start with a deterministic threshold (for example, three episodes with the
  same `failure.kind`) before adding an LLM.
- Keep the raw episodes until the rule has survived a reinforcement cycle.

**How to verify.** Three failed episodes with the same failure kind produce
one rule; two more produce a confidence increase; no recurrence produces
decay.

### P2: Calibrate proactive recall

**Why.** `memos brief` searches and groups items, but it has no gate. The
Price of Scale result is blunt: a similarity threshold tuned to 5% false
alarms at 8 memories reaches 84-100% false alarms at 2,048 memories. If MemOS
adds proactive suggestions or reminders, a fixed threshold will become noise.

**What to change.** Calibrate against no-match probes, or use a conformal
quantile that accounts for store size. Do this only when proactive recall is a
real product surface; it is not worth the complexity for on-demand search.

### P2: Add a vendor-neutral memory wire format

**Why.** Memory portability is becoming a user expectation. Claude and Gemini
both ship memory import/export. Letta projects memory as a git-backed
filesystem. memorywire proposes a JSON schema for `remember`, `recall`,
`forget`, `merge`, and `expire` over semantic, episodic, procedural, and
emotional memory types, with a human-in-the-loop governance channel.

**What to change.** Implement memorywire as an adapter over the SDK and
expose it through the CLI or MCP. This makes MemOS a backend for other tools
and lowers migration cost. It is strategic, not urgent.

## What not to do

- **Do not add more extraction by default.** Raw history is a strong
  baseline. Extraction should pay for itself in a measured comparison.
- **Do not over-compress.** MemOS's L3 verbatim level is an asset. Keep it,
  and make compression opt-in.
- **Do not chase LoCoMo alone.** LoCoMo is saturating. MemoryArena and
  DolphinBench test whether memory changes what an agent does, not just what
  it recalls.
- **Do not treat MCP annotations as permissions.** They are hints. Enforce
  authorization at dispatch.
- **Do not put secrets, credentials, or unreviewed policy in memory.**
  Memory is not a security boundary.

## What the product landscape implies

| System | What it shows | MemOS response |
| --- | --- | --- |
| OpenAI Dreaming V3 | Background synthesis, a reviewable memory summary, automatic freshness updates. | MemOS's `dream` and `profile` are directionally right; add automatic delivery and a clear "what I know" view. |
| Claude memory | Topic files, project-scoped memory, editable entries, import/export. | MemOS has project scope and knowledge pages; make them easier to inspect and edit. |
| Letta MemFS | Git-backed Markdown files, progressive disclosure, memory subagents. | MemOS has Markdown export; a live file projection would improve inspectability and portability. |
| Mem0 / Zep | 92-95% vendor-reported LoCoMo and LongMemEval, different harnesses. | Do not compete on the headline. Compete on local-first, harness breadth, and provable deletion. |
| True Memory | 93.0% LoCoMo and 87.8% LongMemEval on one SQLite file. | This is the closest direct competitor. Run the raw-history arm and publish the protocol. |
| SuperLocalMemory 4.0 | Governed local-first memory OS with verified erasure and a hash-chained audit trail. | MemOS already has the audit pieces; finish the deletion cascade to stay ahead. |

## Caveats

- Most sources are arXiv preprints from 2026. They are not peer-reviewed, and
  several use LLM judges, synthetic histories, or author-run studies.
- Vendor benchmark numbers are not comparable across systems. Different
  answer models, judges, splits, retrieval depths, and token budgets can move
  results by tens of points.
- The 3,283-paper review is a secondary analysis. Its counts are useful for
  direction; primary claims should be checked against the cited paper.
- MemOS's own retrieval numbers are retrieval-only. They should not be
  compared with end-to-end answer accuracy.

## Sources

### Primary papers

- [Memory Tax: Dissecting the Net Value of Agent Memory](https://arxiv.org/abs/2610.34073)
- [Is Complex Agentic Memory Always Needed? Naive RAG Is Stronger Than We Thought](https://arxiv.org/abs/2610.30755)
- [MemCompile: From Memory Hits to Answerable Evidence](https://arxiv.org/abs/2610.23313)
- [Relevance Is Not Sufficiency](https://arxiv.org/abs/2610.09348)
- [When Retrieval Is Not Enough: Obsolete Facts in Agent Memory](https://arxiv.org/abs/2610.36308)
- [Let Them Sleep: Recursive Self-Pruning Memory](https://arxiv.org/abs/2610.25561)
- [REM: What to Store, When to Recall, What to Forget](https://arxiv.org/abs/2610.27377)
- [Stratum: Repository Memory for Coding Agents](https://arxiv.org/abs/2610.36153)
- [MemDev-Bench: Does Memory Help Code Agents?](https://arxiv.org/abs/2610.27524)
- [Accept Changes, Reject Attacks](https://arxiv.org/abs/2610.41056)
- [SAFE-Mem: Secure Agentic Memory](https://arxiv.org/abs/2610.22959)
- [Compaction Laundering](https://arxiv.org/abs/2610.29869)
- [MemCut: Every Secret Leaves a Trail](https://arxiv.org/abs/2610.21405)
- [Can Agents Forget When Asked?](https://arxiv.org/abs/2610.18052)
- [The Price of Scale in Proactive Memory Recall](https://arxiv.org/abs/2610.34507)
- [EvoMemBench](https://arxiv.org/abs/2605.18421)
- [MemoryArena](https://arxiv.org/abs/2602.16313)
- [DolphinBench](https://arxiv.org/abs/2609.24971)
- [True Memory: Storage Is Not Memory](https://arxiv.org/abs/2605.04897)
- [SuperLocalMemory 4.0](https://arxiv.org/abs/2608.08253)
- [memorywire](https://arxiv.org/abs/2606.01138)
- [PROJECTMEM](https://arxiv.org/abs/2606.12329)
- [Memory as Infrastructure](https://arxiv.org/abs/2609.05510)

### Product and security sources

- [OpenAI: Dreaming - better memory for ChatGPT](https://openai.com/index/chatgpt-memory-dreaming/)
- [Claude: chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)
- [Letta: Context Repositories](https://www.letta.com/blog/context-repositories/)
- [Cursor: Rules](https://cursor.com/docs/rules)
- [OpenChamber: 3,283-paper memory review](https://openchamber.dev/blog/agent-memory-research/)
- [MCP memory server hardening issue](https://github.com/modelcontextprotocol/servers/issues/4117)
- [CVE-2026-49291: read-only OAuth can write memory](https://github.com/advisories/ghsa-2r68-g678-7qr3)
- [CVE-2026-33010 and CVE-2026-29787: mcp-memory-service](https://pluto.security/blog/total-recall-how-two-cves-let-any-website-read-rewrite-and-wipe-your-ais-memory/)
- [Memory injection across ChatGPT, Claude, and Gemini](https://arxiv.org/abs/2610.28810)
