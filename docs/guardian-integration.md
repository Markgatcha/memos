# Guardian integration: folded memory packs

LLM Guardian sits between an app and the model. MemOS can supply a
token-budgeted context pack that Guardian injects as a system shard. Guardian
can optionally fold that pack before injection.

- Guardian source: <https://github.com/Markgatcha/llm-guardian>
- Folding design and measured token table:
  <https://github.com/Markgatcha/llm-guardian/blob/main/docs/memory-pack-folding.md>

## What is wired today

| Piece | Status |
| --- | --- |
| MemOS → Guardian memory pack (`createMemOSMemorySource`) | Implemented |
| Automatic injection when `MEMOS_NAMESPACE` / `MEMOS_PATH` is set | Implemented |
| `foldMemoryPack` / `memoryPackBudget` on `orchestrate()` | Implemented |
| `fold` option on the MemOS source adapter | Implemented |
| Paired accuracy run (folded vs verbatim) | Not run — provider balance |

## Measured token side

On the three packs recorded for the MemOS playground, folding at a 120-token
target saved 47.5%, 46.2%, and 20.5%. The saving depends on how prose-like the
pack is. Citations and inline identifiers are not guaranteed to survive
folding, so keep it off for audit-sensitive packs.

## Enable it

```ts
import { orchestrate } from "llm-guardian";

await orchestrate({
  model: "openai/gpt-4o-mini",
  messages,
  memoryPack,
  foldMemoryPack: true,
  memoryPackBudget: 400,
});
```

Or build a folded pack directly:

```ts
import { createMemOSMemorySource } from "llm-guardian/core/memos-memory-source";

const source = await createMemOSMemorySource({ namespace: "work", fold: true });
const pack = await source.getPack("deploy rollback", 1200);
```

The request exposes `optimization.memoryPackTokensBefore` and
`optimization.memoryPackTokens`, so the token delta is observable even when
accuracy is not being measured.
