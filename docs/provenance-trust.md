# Provenance Trust

**The write-gate that keeps poisoned content out of your agent's recall — no cloud, no LLM on the hot path.**

MemOS stores memories from many channels: things _you_ typed, tool output, pasted chat logs, bulk imports from ChatGPT/Claude/Slack. Not all of those deserve the same trust. The provenance-trust layer does three things:

1. **Tiers** — every memory gets a provenance tier derived from its channel.
2. **Write-gate quarantine** — a local heuristic classifier screens every write for prompt-injection and exfiltration patterns; flagged memories are stored but excluded from recall until reviewed.
3. **Read-time trust policy** — agent-facing surfaces (MCP, context packs) flag low-trust memories with `untrusted_source: true` + a `[mem:hex]` citation, so the host agent confirms them instead of silently injecting them as context.

Everything runs locally and synchronously. No network, no LLM, no async hooks on the write path.

## Provenance tiers

Highest to lowest:

| Tier            | Meaning                       | Typical channel                                                             |
| --------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `user-verified` | You explicitly confirmed it   | `setProvenance(id, "user-verified")`                                        |
| `user`          | Came straight from you        | `source: "user_input"` (default)                                            |
| `tool-output`   | Returned by a tool/API        | `source: "tool_output"`, MCP `memos_store` with `provenance: "tool-output"` |
| `chat`          | Agent-inferred or system text | `source: "agent_inferred"`, `source: "system"`                              |
| `imported`      | Bulk import or external dump  | `source: "external_data"`, `memos import`                                   |

The tier is assigned at write time: an explicit `store(content, { provenance })` option wins, otherwise it derives from `source`. **`user-verified` is never assigned automatically** — only the explicit `setProvenance()` call (or the `provenance` option you pass yourself) creates it.

```typescript
await memos.store("API returned 42 rows", { source: "tool_output" });
// → tier "tool-output"
await memos.setProvenance(id, "user-verified");
// → tier "user-verified"
```

## Trust-weighted recall

Trust fusion already weights memories by their numeric `trustScore`. Provenance adds a gentle per-tier multiplier on top:

```
multiplier = 1 - strength × (1 - tierTrust)
```

Default tier trusts: `user-verified` 1.00, `user` 0.97, `tool-output` 0.90, `chat` 0.82, `imported` 0.72, with `strength` 0.5. That caps the default penalty at ~14% for imported memories — enough to break ties between otherwise-equal matches, never enough to swamp semantic relevance.

The knob is `fusion.provenanceWeightStrength` (SDK config) or per-query `{ fusion: { provenanceWeightStrength: 0 } }` to disable it. Same-tier corpora keep identical relative ordering, so the default setting is benchmark-neutral on ordinary workloads.

## Write-gate quarantine

Before every write, `screenWrite()` scores the content against local regex/scoring heuristics — injection clichés ("ignore previous instructions", role/prompt overrides), imperative exfiltration ("send your API key to …"), secret-shaped material (tokens, private keys, credential assignments), and dormant-payload signals (long base64 blobs). Score ≥ 2 flags the memory.

Flagged memories are **still stored** (add-only is sacred) but marked `quarantined: true`:

- excluded from default recall on _every_ leg — SQL keyword, semantic, entity leg, graph expansion, PPR, session siblings, context packs;
- `includeQuarantined: true` (search API) or `memos quarantine list` shows them for review.

The classifier is tuned to avoid false positives: "ignore the previous instructions" (with _previous_/_prior_ required) flags; "my password is …" or "send me the photos" does not; an ordinary URL alone does not.

### Review and release

```bash
memos quarantine list          # review queue, most recently flagged first
memos quarantine release <id>  # make it recallable again
```

`releaseFromQuarantine(id)` (SDK) keeps the audit trail: the original `quarantinedAt`/`quarantineReason` are preserved, and the node gains `metadata.releasedFromQuarantine: true`. Released memories still report `untrusted_source: true` to agents until a human promotes their provenance tier — release restores recall, it doesn't launder trust.

## Read-time trust policy

Search results returned to agents carry three fields:

- **`provenance`** — the tier string.
- **`citation`** — a `[mem:hex]` token tracing the memory to its source episode; `memos cite [mem:xxxx]` resolves it.
- **`untrusted_source: true`** — set for `imported` / `tool-output` tiers and quarantined-then-released memories.

MCP `memos_search` (full and compact modes) and `memos_search_temporal` include all three; compact text shows `[untrusted:imported]` inline. Context packs (`memos.contextPack`) include `provenance` + `untrustedSource` per item with citations when requested. Policy: when you see `untrusted_source: true`, confirm with the user before acting on that memory.

## No-LLM guarantee

The classifier is pure synchronous regex scoring in `src/quarantine.ts`. It has no network access, no async work, and no dependency on any model — it runs even in hermetic test mode and cannot be rate-limited, billed, or poisoned by an upstream prompt. Tier derivation and score fusion are equally offline.
