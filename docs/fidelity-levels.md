# Fidelity levels (L0–L3)

Every memory exists at four fidelity levels. The retriever picks the
**cheapest level that satisfies the query** instead of always returning
verbatim text — the single biggest token lever in the system
(measured 6–10x fewer tokens per recall on typical fixtures).

| Level | Content                         | Cost             | How it's made                                            |
| ----- | ------------------------------- | ---------------- | -------------------------------------------------------- |
| L0    | tags + entities                 | ~tens of tokens  | Derived free from the entity index/tags — nothing stored |
| L1    | typed facts (`[type] sentence`) | short statements | Deterministic template extraction at write time (no LLM) |
| L2    | extractive summary              | 2–3 sentences    | TextRank-lite sentence centrality (no LLM)               |
| L3    | verbatim full text              | full             | The existing `content` column                            |

## Zero-LLM guarantee

L1 uses the existing extraction pipeline (`extractQueryEntities` +
`canonicalizeEntities`): entity-bearing sentences become `[type]`
facts. L2 scores sentences by word-overlap centrality (Mihalcea &
Tarau 2004 TextRank) and emits the top sentences in original order.
No embeddings, no model calls — the hot path is pure string math.

A future sleep-time LLM pass may _upgrade_ the L2 slot to an
abstractive summary; the extractive path is the guaranteed floor.

## Storage

L1/L2 are generated at write time (`MemOS.store`) and cached in the
reserved `metadata.fidelity` slot (`{ v: 1, l1, l2 }`), so they travel
with the node on every storage adapter with **zero schema migration**.
`update()` regenerates them when content changes.

Backfill for pre-fidelity memories: `memos compact` generates and
persists missing levels (idempotent). Reads also generate lazily when
the cache is missing, so backfill is an optimization, not a
requirement.

## Query-adaptive routing

`routeFidelity(query)` picks the starting level from cheap local
signals — no LLM:

1. **Entity lookup** (≥1 entity, ≤4 words, no question words) → L0
2. **Entity-anchored factoid** (≥1 entity, not explanatory) → L1
3. **Explanatory / conceptual** (`why`/`how`/`explain`/…) → L3
4. **Summarization request or long query** (≥30 words) → L2
5. **Open question** without entities → L2
6. Fallback → L1

Router entities = the standard pipeline **plus** lowercase
alias-table vocabulary (`BUILTIN_ENTITY_ALIASES`), so `postgres`
counts as an entity reference even uncapitalized.

## In-call escalation

`memos.recall(query, { fidelity, maxFidelity, threshold, minResults })`
scores the level corpus with a local IDF-weighted term-coverage
scorer ([0,1]). If fewer than `minResults` hits clear `threshold`
(default 0.15), it escalates L0→L1→L2→L3 and retries, up to
`maxFidelity`. Each result records the level it was served at and the
levels attempted.

## Defaults (behavior-preserving)

- `recall()` defaults to `fidelity: "L3"` — verbatim text, no routing,
  no escalation. Existing consumers see the same output shape as a
  plain search.
- `contextPack({ fidelity })` defaults to unset — byte-identical packs.
  Opt into `"adaptive"` or a fixed level to save tokens.

Adaptive is opt-in deliberately: level selection changes _which text_
is returned, and that must be a caller choice.

## Context packs

`buildContextPack({ fidelity })` renders item contents at the level,
records `item.fidelity` per item and `pack.fidelity`
(`{ level, adaptive, contentTokens, verbatimTokens }`) in the envelope.
Verbose TOON gains a `# fidelity=L1` header; compact TOON gains
`|f=L1` in the envelope and an optional 8th row field (7-field strings
still parse).

## CLI

```bash
memos compact                  # backfill missing L1/L2 for all memories
memos compact --stats           # avg tokens per level + savings vs verbatim
memos compact --namespace work --limit 100 --dry-run
```

## Measuring savings

```bash
npx tsx scripts/measure-fidelity-tokens.ts
```

Builds a 50-memory fixture, packs it at each level, and prints
tokens-per-level. Typical result: L0 ~90%+, L1 ~70%, L2 ~50% fewer
tokens than verbatim.
