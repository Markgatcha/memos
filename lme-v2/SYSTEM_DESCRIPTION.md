# MemOS for LongMemEval-V2

## System

MemOS is a local-first memory layer over SQLite. For LongMemEval-V2, each
trajectory is written into three pools that mirror the benchmark's abilities:

| LME-V2 ability    | MemOS pool                  | What is stored                                               |
| ----------------- | --------------------------- | ------------------------------------------------------------ |
| Static state      | `event`                     | Per-step AXTree state, URL, action, thought, screenshot path |
| Dynamic state     | `event` + temporal metadata | Step order, trajectory id, timestamp, action sequence        |
| Workflow          | `procedure`                 | Goal, start URL, ordered action sequence                     |
| Gotchas           | `procedure`                 | Error/failed/denied/captcha/timeout lines plus outcome       |
| Premise awareness | `note` + trust/provenance   | Trajectory note with goal, outcome, and state index          |

At query time MemOS runs a hybrid retrieval pipeline: SQLite FTS5 keyword,
semantic embeddings, entity/leg fusion, bounded graph expansion, and an
optional cross-encoder rerank. The selected evidence is emitted as a
token-budgeted context pack with `[mem:hex]` citations. Screenshot paths for
retrieved states are returned as `image` context items, so the reader can see
the actual page state.

## Why this maps to LME-V2

- **Compact evidence, not a transcript dump.** The context pack is budgeted
  (`token_budget`) and the adapter never injects the full trajectory.
- **Workflow and gotcha pools.** These are the categories where RAG-only
  baselines lose; MemOS stores them explicitly instead of hoping a state slice
  is retrieved.
- **Latency.** Retrieval is one local SQLite process. The bridge is persistent,
  so the Python harness pays process startup once per memory instance, not per
  query.
- **Auditability.** Every evidence item carries a citation token and a
  provenance tier; the reader can trace an answer back to a trajectory/state.

## Configuration

- Embeddings: Qwen3-Embedding-8B through an OpenAI-compatible endpoint
  (`LME_EMBEDDING_BASE_URL` / `LME_EMBEDDING_MODEL`), or MemOS's zero-dependency
  Model2Vec default for an offline run.
- Profiles: `fast` (40k tokens, top-12), `balanced` (120k, top-20),
  `accurate` (200k, top-40). These are separate latency operating points.
- Reader/judge: the official Qwen3.5-9B reader and gpt-5.2 judge are required
  for a leaderboard package; this adapter does not change them.

## Known limitations

- The adapter uses text AXTree evidence plus screenshot paths. It does not
  enable CLIP pixel search by default (that would add a model download and a
  second vector index).
- The procedure/gotcha notes are deterministic summaries, not controller-LLM
  syntheses. On workflow/gotcha categories, an LLM-written note may be more
  concise; this is the next ablation.
- The bridge owns one SQLite database per memory instance. It is not designed
  for multiple concurrent Python workers writing the same DB.
