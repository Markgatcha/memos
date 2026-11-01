# MemOS vs Supermemory

> Last updated: 2026-09-17
> Trigger: [supermemory hybrid-mode post](https://x.com/supermemory/status/2100404870281105444)
> (2026-09-17) — "learnings are formed for things that are important… raw
> context is also indexed. If the memories don't include all the information
> the model needs, supermemory will automatically add parts of the previous
> conversations to enrich the context."

This is a technical comparison, not a marketing sheet. Where a number comes
from a vendor's own evaluation, it says so. Where two numbers cannot be
compared, it says that too — that caveat is most of the document, because it
is most of the problem.

---

## TL;DR

| | MemOS | Supermemory |
|---|---|---|
| Hybrid (memories + raw context) | **Yes** — `event`/`note`/`procedure` pools + session/graph expansion | **Yes** — `searchMode: "hybrid"` |
| Benchmarked hybrid mode | **Yes (retrieval)** — LongMemEval-S, ConvoMem, LoCoMo | Yes (claimed, vendor-run) |
| Retrieval accuracy published | **Yes** — 100% Hit@20 LongMemEval-S (100 q), 89.4% Hit@10 ConvoMem, 64.1% Hit@10 LoCoMo | Yes (97% Recall@20 LongMemEval-S) |
| End-to-end QA accuracy published | **Yes, self-judged** — 78% on a 50-question sample (DeepSeek answerer + judge, high reasoning); not comparable to gpt-4o-judged vendor numbers | Yes (85.4% LongMemEval-S, gpt-4o judge) |
| One-call user profile | **Yes** (`profile()`) | Yes (`client.profile()`, ~50ms) |
| Abstains when it doesn't know | **Yes** (`trustFloor`, `shouldAbstain`) | Not advertised |
| Provenance / version timeline | **Yes** (`supersede`, `history`, `contradicts` edges) | Partial |
| Runs fully offline, no key | **Yes** | Yes now (`supermemory local`) |
| Connectors (Drive/Gmail/Notion/GitHub) | No | **Yes** |
| Multimodal ingestion (PDF/OCR/video) | No | **Yes** |

**The uncomfortable summary (updated 2026-10-30):** the evidence gap has
narrowed. MemOS now publishes reproducible retrieval results on all three
datasets Supermemory uses (see [Benchmark Results](benchmark-results.md)):
100% Hit@20 on a 100-question LongMemEval-S sample vs their 97% claim, 89.4%
Hit@10 on a ConvoMem sample, and 64.1% Hit@10 on LoCoMo. What MemOS still lacks
is end-to-end QA accuracy (needs a fixed reader + judge), plus connectors and
document ingestion.

---

## 1. What the tweet is actually claiming

Stripped of marketing, hybrid mode is three mechanisms:

1. **Two indexed layers.** Extracted facts ("learnings") *and* the raw
   conversation/documents they came from.
2. **Fallback enrichment.** If the extracted memories don't contain what the
   model needs, pull raw chunks into context anyway. Recall beats precision
   when the alternative is a wrong answer.
3. **Background promotion.** Once the system sees a raw chunk was needed, it
   forms a durable memory from it — importance discovered by use, not
   predicted upfront.

Supermemory's docs are explicit that this is a *search mode*, not magic:
`searchMode: "hybrid"` returns `({ memory } | { chunk })[]`, and you read
`item.memory || item.chunk`. Memories-only is `searchMode: "memories"`.

## 2. MemOS already implements all three

| Supermemory | MemOS equivalent | Status |
|---|---|---|
| Extracted memories | `note` / `procedure` pools; `memos_extract_facts`; consolidation distils cluster notes | Shipped |
| Raw indexed context | `event` pool — raw episodes retained alongside distillations | Shipped |
| `searchMode: "hybrid"` | Multi-pool retrieval via `SearchFilter.pool` (`event`+`note`+`procedure`) | Shipped |
| `searchMode: "memories"` | `--pool=note,procedure` | Shipped |
| Fallback enrichment | `applySessionExpansion` + `applyGraphExpansion` — pull surrounding session turns / graph neighbours around a hit | Shipped, **on by default since 2026-09-16** |
| Background promotion | `memos_consolidate` on `SessionEnd`; supersede-on-write | Partial — see gap G1 |
| Embrace noise | `relevanceRatio` tail trimming (0.15), `memos_context_pack` token budget | Shipped |

**So the honest response to that post is not "we should build hybrid mode."
It is "we have hybrid mode and never measured whether it helps."** That is now
directly measurable — see §5.

### Gap G1 — importance discovered by use

Supermemory promotes a raw chunk to a memory *because it was retrieved and
turned out to matter*. MemOS consolidates on a schedule (session end), not on
evidence of usefulness. A cheap version: log which recalled `event` nodes were
followed by a successful outcome, and prioritise those for distillation into
`procedure`/`note`. This is a genuinely good idea and is not currently on the
roadmap.

## 3. The benchmark reality check

### Published numbers (all vendor-run unless noted)

| System | Benchmark | Score | Answer model |
|---|---|---|---|
| Supermemory | LongMemEval-S | **85.4%** | not stated (their blog) |
| Supermemory | LongMemEval | 81.6% | gpt-4o |
| Supermemory | LongMemEval | 84.6% | gpt-5 |
| Supermemory | LongMemEval | 85.2% | Gemini-3 Pro |
| Supermemory | LoCoMo | 59.7% P@1 / 83.5% Recall@10 | not stated |
| mem0 | LongMemEval | 94.4% (472/500) | own pipeline |
| mem0 | LoCoMo | 92.5 | own pipeline |
| Mastra Observational Memory | LongMemEval | 84.23% | gpt-4o |
| Mastra Observational Memory | LongMemEval | 94.87% | gpt-5-mini |
| Zep / Graphiti | LongMemEval | 71.2% | gpt-4o |
| Letta | LoCoMo | 74.0 | gpt-4o-mini |
| OpenAI Memory | LoCoMo | 52.9 | — |
| Feather DB | LongMemEval | 69.3% vs 64.0% full-context | gpt-4o |
| **MemOS** | **LoCoMo, retrieval-only** | **hit@10 0.832**, MRR 0.642, nDCG 0.656 | **none — no LLM in the loop** |

### Why almost none of these are comparable

Look at the three Supermemory rows. **Same memory system, same benchmark,
three answer models: 81.6 → 84.6 → 85.2.** Changing the answer model is worth
3.6pp on its own.

Now look at the spread between vendors: mem0 94.4 vs supermemory 85.2 is a
9pp gap. **A third of that gap is smaller than the spread one vendor produces
by swapping its answer model.** Add different judges, different rerankers and
different question subsets and the honest conclusion is:

> The LongMemEval leaderboard currently ranks answer-model choice at least as
> much as it ranks memory systems.

This is why `docs/benchmark-comparison.md` already carries the rule
*publish delta-vs-baseline under the same judge*, and why this document
refuses to put "MemOS vs Supermemory" in a single score cell.

### Two more traps worth naming

- **Recall ≠ accuracy.** Supermemory publishes per-category *recall* figures
  (knowledge-update 99%, assistant 100%, user 97%, multi-session 93%,
  temporal 91%, preference 90%). Those are Recall@15. Their *accuracy* on the
  same benchmark is 85.4%. Quoting the 99% next to someone's accuracy number
  is the single most common error in this space.
- **LoCoMo is contested.** Mastra publicly declined to publish LoCoMo results
  and notes Supermemory publishes only LongMemEval. MemOS's own LoCoMo
  category spread (single-hop .897 → open-domain .533) shows why: the
  open-domain and adversarial categories behave very differently from the
  rest.

### Where MemOS actually stands

One number is trustworthy: **LoCoMo retrieval-only hit@10 = 0.832**
(1986 questions, evidence-ID matching, no LLM). Compare *within* that number:

- Supermemory's LoCoMo **Recall@10 = 83.5%** and MemOS's **evidence
  recall@10 = 0.779** are in the same neighbourhood, but they are different
  metrics on different conventions. Do not put them in one column.
- MemOS has **no end-to-end accuracy number at all.** That is the real gap.
  Not a quality gap — a measurement gap.

## 4. MemOS's actual weakness is precision, not recall

This is the most actionable finding in the whole comparison, and it is not
about supermemory.

| MemOS LoCoMo metric | Value |
|---|---|
| hit@10 | 0.832 |
| MRR | 0.642 |
| **precision@10** | **0.099** |

Hit@10 of 0.832 says MemOS usually finds the answer somewhere in the top ten.
Precision@10 of 0.099 says **only ~10% of what it injects is relevant** —
nine of every ten tokens handed to the model are noise.

Since the entire value proposition is context reduction, precision is the
metric that matters, and it is the metric MemOS is worst at. Supermemory's
answer is to embrace noise (they argue ~10 tokens per fact makes 50 facts
cheap). MemOS's answer should be better: it already has `relevanceRatio` tail
trimming, a relevance gate and `trustFloor` abstention — the machinery exists,
it is simply not tuned or measured.

**Recommendation: make precision@10 the north-star metric for the next
benchmark cycle.** A move from 0.099 to 0.25 at constant hit rate is a bigger
real-world win than any leaderboard position.

## 5. How to produce a citable number

These flags were added to `scripts/bench-longmemeval.ts` on 2026-09-17 for
exactly this purpose.

```bash
# 1. System under test — MemOS hybrid retrieval
BENCH_ANSWER_MODEL=gpt-4o-mini BENCH_JUDGE_MODEL=gpt-4o-mini \
  npx tsx scripts/bench-longmemeval.ts --arm=memory

# 2. The two baselines that make #1 mean something.
#    Same answer model, same judge, same questions. Non-negotiable.
... --arm=full-context   # stuff every session in — the "why have memory?" bar
... --arm=no-memory      # the floor — what the model already knew

# 3. Hybrid ablation — the direct answer to the supermemory post
... --arm=memory                      # all pools (hybrid)
... --arm=memory --pool=note,procedure # distilled memories only
#    then compare with pairedBootstrapDiff (see scripts/lib/bench-stats.ts)

# 4. Always run the full 500. See §6.
```

Every result file now records `answerModel`, `judgeModel`, `temperature`,
`arm`, `pools`, `questionSample`, `categoryMix`, token usage, and bootstrap
95% intervals for the overall score and every category.

## 6. Two benchmark bugs fixed the same day

**Selection bias.** LongMemEval ships sorted by category — questions 0–69 are
all `single-session-user`. `--max-questions=25` therefore returned 25
single-session-user questions and produced **92%**, which landed in
`bench-longmemeval-results.json` looking like a benchmark result. It was not a
small sample of the benchmark; it was a different, easier benchmark. Bootstrap
that 92% and the interval is **[80%, 100%]**.

Partial runs now default to **stratified** sampling across all six categories
(`--sample=prefix` restores the old behaviour), and every results file carries
a `sampleSizeWarning` below 100 questions so this cannot recur silently.

**Unattributed models.** `bench-locomo.ts` and `bench-longmemeval.ts` both
documented one model ("kimi-k2.5") while calling another
("agnes-2.0-flash"), at `temperature: 0.7`, and recorded neither in the
output. End-to-end runs now go through `scripts/lib/bench-llm.ts`, which is
deterministic (temp 0, seeded) and writes provenance into every result.

## 7. What to copy, what to ignore

**Copy:**

1. **User profiles** — one call, static + dynamic. Highest DX-per-line-of-code
   feature in the category. MemOS has nothing equivalent.
2. **The three-hook harness recipe** — session-start → profile, on-message →
   search, on-stop → save. MemOS shipped start/stop; the middle leg is added
   in this change (`plugin/hooks/user-prompt-submit.mjs`).
3. **Importance-by-use promotion** (gap G1).
4. **Publishing discipline.** Whatever you think of their numbers, they have
   them. A number with a baseline beats a better system with no number.

**Ignore:**

1. **Their absolute scores.** Different answer models, judges and subsets.
   Useful only as a sense of the range (70–95%).
2. **"#1 on three benchmarks."** Unfalsifiable as stated; no shared protocol.
3. **Multimodal ingestion as a differentiator** — high cost, low differentiation
   for a memory layer whose job is facts about a user, not document search.

**Watch:**

1. **`supermemory local`** — one binary, local embeddings, Ollama, data in
   `./.supermemory`. This directly attacks "local-first" as MemOS's moat.
   MemOS's remaining edge is *no key required at all* and *no LLM in the
   retrieval path*, which is a real but narrowing advantage.
2. **They ship a Hermes plugin.** The Hermes catalog submission will sit next
   to a direct competitor. MemOS's differentiators there are abstention,
   provenance and zero-config locality — none of which are currently mentioned
   in `plugin/plugin.json`, which still describes only "store durable facts."

---

## Sources

- https://x.com/supermemory/status/2100404870281105444 (hybrid mode, 2026-09-17)
- https://supermemory.ai/docs/concepts/rules (hybrid mode, container tags, harness hooks)
- https://github.com/supermemoryai/supermemory (features, local mode, benchmark claims)
- https://supermemory.ai/blog/supermemory-vs-zep (LongMemEval-S 85.4%, LoCoMo P@1 59.7)
- https://www.maximem.ai/evals (supermemory 81.6 / 84.6 / 85.2 by answer model)
- https://github.com/mem0ai/memory-benchmarks (mem0 94.4% LongMemEval)
- https://mastra.ai/research/observational-memory (84.23% gpt-4o, LoCoMo caveat)
- https://mem0.ai/blog/state-of-ai-agent-memory-2026 (Zep 71.2, Letta 74.0, OpenAI 52.9)
- https://www.getfeather.store/theory/longmemeval-benchmark-results-2026 (69.3 vs 64.0 full-context)
