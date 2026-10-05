# Making memos retrieval actually better: rerankers, forgetting curves, and an honest null result

I spent the last few days trying to make memos (my local-first AI memory system) retrieve memories more accurately. Here's what worked, what didn't, and the numbers to prove it.

## The baseline

memos uses hybrid retrieval: dense vectors + BM25 + graph, fused together. On a stratified 120-question LongMemEval subset, the fused baseline gets **hit@5 = 0.9583**. That's solid, but I wanted better.

## What worked: bge-reranker-base

I benchmarked two cross-encoder rerankers on Kaggle (T4 GPU) against the frozen 120Q candidate sets:

| Model | hit@5 | Evidence recall | p50 latency |
|---|---|---|---|
| Fused baseline | 0.9583 | 0.8619 | 61 ms |
| bge-reranker-base | **1.0000** | 0.9429 | 3.0 s/query |
| bge-reranker-large | 0.9750 | 0.8905 | 8.7 s/query |

The base model beat the large model on accuracy *and* speed. 120/120 questions correct. It's now the default local reranker in memos (opt-in, since 3s/query isn't free).

## What didn't: rule-based triple extraction

Inspired by Memori's write-time structuring, I built a rule-based triple extractor: parse subject/predicate/object from sentences at write time, store them in metadata, boost candidates whose triples match the query.

Result on the same 120Q: **+0.0000**. 115/120 before, 115/120 after. Only 23 of 4,800 candidates got boosted. The SVO patterns are too sparse for conversational data — questions like "What degree did I graduate with?" don't parse into clean triples.

I'm keeping it as an opt-in experimental flag, but honestly? Rule-based extraction isn't enough. Memori uses LLM-based extraction, which is why theirs works. If I revisit this, it'll need a real parser, not regex.

## What's new: Ebbinghaus reinforcement

From MemoryBank (AAAI 2024): score memories by `e^(-Δt/accessCount)`. Frequently-recalled memories stay strong; old untouched ones fade exponentially. This fixes the classic failure where a 6-month-old preference overrides yesterday's correction.

It's ~50 lines, pure arithmetic, no LLM. Blended at 0.1 weight into the fused score. Opt-in via `experimental.ebbinghaus`.

## What's new: human-readable timestamps

Honcho injects explicit timestamps so the LLM can reason about time. I added `formatMemoryTimestamp()`: instead of raw epochs, memories render as "2026-09-28 — 6 days ago". LLMs are bad at epoch math; this is a 20-line pure rendering change.

## The honest summary

- Reranker: 0.9583 → 1.0000. Real win.
- Triple extraction: +0.0000. Null result, keeping it flagged.
- Ebbinghaus + timestamps: implemented, opt-in, benchmark pending.

Not every experiment works. The triple extraction was a good idea with a weak implementation. I'd rather report the null result than ship something that doesn't help.

All changes are on memos main, behind experimental flags. The reranker is the only one I'd call production-ready.
