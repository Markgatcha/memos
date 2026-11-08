# Benchmark Results (plain English)

No judge model. No "vibes" scoring. These numbers ask one question: **when you
ask MemOS about something from the past, does it actually return the right
memory?**

That is retrieval. It is deterministic, so you can re-run it yourself and get
the same answer.

## The three numbers that matter

| Benchmark | What it asks | MemOS |
| --- | --- | --- |
| **LongMemEval-S** | "Find the conversation where this fact was mentioned." | **99.4%** of questions returned the right session in the top 20 (full 500) |
| **ConvoMem** | "Find the exact messages that justify this answer." | **91.0%** hit rate and **89.4%** evidence recall in the top 10 |
| **LoCoMo** | "Find the right line of dialogue across a long chat history." | **65.0%** hit rate in the top 10 (full 1,986 questions) |

Same data, same scoring rules, no LLM in the loop.

## What each one means without jargon

- **LongMemEval-S**: 500 questions, each with ~50 past conversations. We found
  the right conversation in the top 20 for 99.4% of questions, with 98.3%
  evidence recall and 96.4% all-evidence@20.
- **ConvoMem**: 387 scored questions from six categories (facts, preferences,
  changed facts, abstention...). 91.0% of the time the supporting messages were
  in the top 10; evidence recall was 89.4%.
- **LoCoMo**: 10 long conversations, 1,986 questions. 65.0% of the time the
  exact supporting line was in the top 10. On the conversations 0–1 subset
  (304 questions) the same run reaches 79.8% Hit@10; that subset is not the
  headline number.

## How that compares

**LongMemEval-S** is the benchmark Supermemory puts in its headline (their
figure: 97%). The catch: this benchmark is now easy at the top-20 cutoff —
plain keyword search (BM25) scores 99.6% too. Being at 100% is a good sanity
check, not a knockout.

**LoCoMo** is where the real differences show up. There we are mid-pack: below
Contriever (71.8%) and well below Nano-Memory (86.5%). We tested three
explanations. A stronger embedder (bge-small) moved it +0.9pp; adjacent-turn
grouping +1.1pp but ranked worse; adding a context + previous-turn header
gave the best result, **65.8% Hit@10 (+1.7pp)**. Multi-hop evidence recall
stays around 29%, so the gap is how evidence is aggregated across turns, not
the embedder or the window size.

So the honest one-liner:

> **MemOS matches the best published retrieval on LongMemEval-S and is average
> on LoCoMo.** It is not "better than Supermemory at everything".

## What about answer quality?

Retrieval is necessary but not sufficient. We ran the end-to-end path with
DeepSeek V4.1 Flash at high reasoning as both answerer and judge on 50
questions: **78% correct**. Per category: temporal 100%, single-session
assistant 100%, knowledge-update 86%, single-session user 86%, multi-session
57%, preference 0/3.

We re-ran the same 50 questions with an **independent judge** (GLM-5.3,
not the answerer). It also scored **78.0% [66.0-88.0]**, so the number is
not judge-inflated. It is still not a gpt-4o judge, so it is not directly
comparable to vendor figures. Treat it as a sanity check, not a leaderboard
claim. The run is cached, so repeating it costs nothing.

Preference questions are the weak spot: 0/3 in that sample. We added preference
capture and reran the 15-question preference subset — **13.3% with and without
it**. Those questions judge answer style ("recommend resources tailored to
Premiere Pro"), not recall, so a memory pool cannot move them.

## What these numbers do NOT say

- They do **not** measure whether an LLM writes a good final answer. That is a
  separate benchmark family (QA + LLM judge) where scores swing 20+ points
  depending on which model you use as judge.
- The LongMemEval-S row is a 100-question sample, not all 500 (the 95% lower
  bound is still ~96%).
- LoCoMo's own answer key has errors (~6% per an independent audit).

## Reproduce it

```bash
# LongMemEval-S
npx tsx scripts/bench-longmemeval.ts --provider=model2vec --retrieve-only \
  --topk=20 --dataset=/path/to/longmemeval_s

# LoCoMo
npx tsx scripts/bench-locomo-noapi.ts --provider=model2vec --topk=20 \
  --convs=10 --dataset=/path/to/locomo10.json

# ConvoMem (downloads a sample first)
npx tsx scripts/download-convomem.ts --files-per-category=1
npx tsx scripts/bench-convomem.ts --provider=model2vec --topk=20
```

Full methodology, per-category tables, and metric definitions:
[benchmarks/README.md](https://github.com/Markgatcha/memos/blob/main/benchmarks/README.md).
