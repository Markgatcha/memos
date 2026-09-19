---
description: "Show a timeline of what MemOS has learned recently"
argument-hint: "[limit — default 10]"
---

Show me a timeline of what MemOS has learned recently.

1. Call `memos_graph` to get all memory nodes.
2. Sort the nodes by `createdAt` descending and take the most recent $ARGUMENTS (default 10 if I gave no number).
3. Present as a timeline: date, memory type, and a one-line summary of each.
4. Cite each memory's ID like `[mem:abc12345]` so I can `/forget` anything I don't want kept.

If there are no memories yet, say so and suggest something worth remembering first.
