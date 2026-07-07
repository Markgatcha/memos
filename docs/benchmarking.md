# Benchmarking Plan

MemOS should only publish benchmark claims that can be reproduced from a clean checkout. The most useful comparison is not raw model quality; it is whether a memory layer can store, retrieve, explain, and namespace agent memories with predictable local performance.

## Candidate Comparisons

- mem0
- Zep
- Letta / MemGPT-style memory
- Cognee
- Local-first memory experiments such as MemX-style SQLite/libSQL memory

## Workloads

- Write throughput: store 1,000 short memories, 1,000 long memories, and 1,000 tagged memories.
- Retrieval quality: query for exact keywords, paraphrases, and cross-session facts, then score expected-memory recall at top 3 and top 10.
- Hybrid ranking: compare keyword-only, embedding-only, and hybrid search on the same dataset.
- Namespace isolation: prove one user/session namespace cannot leak memories into another namespace.
- Cold start: open an existing database and run the first search.
- Storage footprint: compare database size after the same number of memories and embeddings.

## Guardrails

- Use the same embedding model for every project when possible.
- Publish hardware, OS, Node/Python versions, and SQLite/vector backend details.
- Keep competitor repos unmodified unless the benchmark notes the exact patch.
- Report failures and unsupported features instead of hiding them.
