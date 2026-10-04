# The Reranker That Beat Its Big Brother: 100% Retrieval on LongMemEval

*2026-10-04 — How a 278MB cross-encoder fixed memos' retrieval, and what Memori and Honcho taught us about what comes next.*

## The problem

memos' fused hybrid retrieval (dense + BM25 + graph expansion) hits 95.8% hit@5 on LongMemEval. Good, not great. The misses weren't random — they were systematic. Our first reranker attempt, MiniLM-L-6-v2, made things *worse*: hit@5 collapsed to 72%. It wasn't a tuning problem. It was a domain problem. MiniLM was trained on MS MARCO web passages; it promoted fluent distractor sessions over the actual evidence. Wrong training distribution, wrong answers. It failed our accuracy gate and got cut.

## The experiment

We benchmarked two BGE cross-encoders on a stratified 120-question LongMemEval set (20 per category), reranking the top-40 fused candidates per query on Kaggle T4 GPUs:

| Model | Hit@5 | Evidence recall | All-evidence@5 | Latency |
|---|---|---|---|---|
| Fused baseline | 0.958 | 0.862 | 0.825 | 61ms |
| bge-reranker-base (278M) | **1.000** | **0.943** | **0.917** | 3.0s/q |
| bge-reranker-large (560M) | 0.975 | 0.891 | 0.892 | 8.7s/q |

The base model beat the large model on accuracy *and* speed. 120/120. Bigger isn't better when the smaller model's training distribution matches your task.

## What the stars taught us

We looked at why Memori (~16.7K stars) and Honcho (~7.4K) dominate the AI memory space:

**Memori** published a peer-reviewed paper with head-to-head numbers — 81.95% on LoCoMo, beating Zep, LangMem, and Mem0 *by name* — at 1,294 tokens/query. Their core trick: convert dialogue into semantic triples + summaries *at write time*, not just store raw text. Structure at ingestion beats clever retrieval. They're also an official Hermes provider.

**Honcho** differentiates on reasoning about memory — a background model that "dreams" over stored data to build deductions and persistent user models. Not just store-and-retrieve; think about what you know.

The pattern: publish named head-to-heads, report tokens/query alongside accuracy, ship a clear technical differentiator, and meet builders where they are (Hermes, MCP).

## What shipped

As of this week, memos' local reranker defaults to `Xenova/bge-reranker-base` when you opt in — replacing MiniLM, which failed the gate. It's still default-off experimental (278MB download, ~60s/question on CPU), but it's the first reranker that clears the accuracy bar on every metric. Enable it with `experimental.rerank.provider: "local"`. A GPU or a `/rerank` endpoint makes it interactive.

## What's next

The reranker fixes retrieval. Write-time structuring (Memori-style triples at ingestion) and background reasoning (Honcho-style dreaming over stored memories) are the next frontiers. We're benchmarking both. Numbers first, claims after — that's the rule.
