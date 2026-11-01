# Preferences

Facts are easy to retrieve: the question names the thing, so keyword and
embedding search both find it. Preferences are not. "What would I enjoy this
weekend?" shares no words with "I love hiking in the rain", so a normal search
returns nothing useful.

MemOS now extracts explicit preference statements and keeps them in their own
tagged pool, so taste questions get evidence even when the wording does not
overlap.

## Capturing preferences

```ts
import { MemOS } from "@mem-os/sdk";

const memos = new MemOS();
await memos.init();

await memos.capturePreferences(
  "I really love hiking in the rain. I hate loud restaurants.",
  { namespace: "profile", sourceId: "chat-42" },
);
```

Each statement is stored as a `preference` memory:

```
User prefers hiking in the rain
User dislikes loud restaurants
```

- type `preference`
- tags `preference`, `auto-extracted`
- metadata `kind`, `polarity`, `sourceId`
- importance `0.85`

## What is recognised

Only first-person, explicit statements, to keep precision high:

| Pattern | Stored as |
| --- | --- |
| I prefer / like / love / enjoy / adore / fancy X | User prefers X |
| I'm interested in / into / a fan of X | User prefers X |
| I'd rather X | User would rather X |
| I hate / dislike / avoid X | User dislikes X |
| I can't stand / don't like X | User dislikes X |
| My favourite X | User's favorite: X |

Third-person text ("She loves hiking") and hypotheticals are ignored.

## Retrieval

```ts
const hits = await memos.searchPreferences("what would I enjoy?", {
  namespace: "profile",
  limit: 5,
});
```

`searchPreferences` first runs a normal tagged search. If that returns fewer
than `limit` results — which is the common case when the question does not share
words with the statement — it fills the remaining slots from the preference
pool by importance and recency. That fallback is what makes taste questions
work at all.

`isPreferenceQuestion(text)` is exported for harnesses and agents that want to
decide when to inject preferences:

```ts
import { isPreferenceQuestion } from "@mem-os/sdk";

if (isPreferenceQuestion(question)) {
  // add searchPreferences(question) ahead of the retrieved context
}
```

## In the benchmark harness

`scripts/bench-longmemeval.ts --preferences` captures preferences while
ingesting sessions and prepends them to the answer context for
preference-seeking questions. `--types=single-session-preference` restricts a
run to that category.

## Honest limits

- **This does not fix LongMemEval preference questions.** Their answers
  describe how the assistant should phrase a reply, not a fact to retrieve.
  Measured: 13.3% with and without capture on 15 questions. Capture is for
  real assistants, not that benchmark category.
- Extraction is lexical. "I'm a morning person" is a preference in spirit but is
  not captured; the pattern list above is what is guaranteed.
- Preferences are stored verbatim, not resolved over time. If a user changes
  their mind, both statements exist; use `supersede` or `contradicts` edges to
  model the change.
- The fallback returns recent/important preferences when nothing matches, so an
  unrelated question can still receive preference context if the caller asks
  for it. Only call `searchPreferences` when the question is preference-seeking.
