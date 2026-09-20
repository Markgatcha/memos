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

### Normalization (anti-obfuscation)

Input is normalized before screening: NFKC unicode folding, zero-width character stripping, Cyrillic/Greek homoglyph folding, single-newline joining, **spaced-letter joining** (`i g n o r e` → `ignore`), and whitespace collapsing. The spaced-letter joiner only joins letters separated by _single_ spaces — a multi-space gap is a word boundary and survives, so anchored clichés still see `ignore previous instructions` instead of `ignorepreviousinstructions`. Injection clichés are additionally matched against a leetspeak-unfolded copy (`1gn0re` → `ignore`).

Base64 blobs are decoded (whitespace-tolerant, depth-bounded at 2) and the decoded text is re-screened: a blob decoding to an injection scores on its own. The decode validator requires near-all-ASCII text _with word spaces_, so ordinary prose that happens to be valid base64 characters ("System prompt engineering is a useful skill") is rejected as a blob.

### Tier-aware screening

The write path passes the memory's provenance tier into `screenWrite`, activating stricter rules for low-trust tiers:

- **Dormant instructions** (Trojan-Hippo shape: "whenever the user asks about X, you should…") and **trigger phrases** (AgentPoison shape: nonce tokens paired with instruction-shaped content) quarantine on sight for `tool-output`/`imported` — but stay silent for `user`-tier writes, where the same phrasing ("when I travel, always pack my charger") is ordinary.
- **Bare verb+credential exfiltration** ("upload the private key") quarantines on low-trust tiers even without a visible destination; on user tiers it needs the destination.
- **Tier-gated signals are never diluted** by the meta-discussion exemption below — on those tiers the shape itself is the attack.

### Meta-discussion exemption

Text that talks _about_ attacks ("how do I defend against 'ignore previous instructions'?", "the article explains DAN mode", CTF writeups, creative writing) gets every signal halved and the total `injection:*` contribution capped at 1.0, so security discussions don't quarantine. Two details keep this from becoming a bypass: URLs/emails are stripped before the exemption test (a domain like `evil.example.com` can't trigger it via the word "example"), and an attack wearing a discussion-like prefix still needs only one more signal to cross the threshold.

## Red-team metrics

Measured with `npm run redteam:quarantine` — 93 attacks across 7 categories (direct override, DAN jailbreak, indirect tool-output, exfiltration, obfuscation, trojan persistence, trigger poisoning) plus 61 benign memories (ordinary notes, plus adversarial-benign cases quoting attack clichés).

| Category            | Before | After |
| ------------------- | ------ | ----- |
| direct-override     | 15/15  | 15/15 |
| dan-jailbreak       | 12/12  | 12/12 |
| indirect-tool-output| 10/10  | 10/10 |
| exfiltration        | 14/15  | 15/15 |
| obfuscation         | 22/23  | 23/23 |
| trojan-persistence  | 9/10   | 10/10 |
| trigger-poisoning   | 8/8    | 8/8   |
| **Attacks caught**  | **90/93 (96.8%)** | **93/93 (100%)** |
| **Benign FPs**      | **1/61 (1.6%)**   | **0/61 (0%)**    |

The three hardening fixes: spaced-letter joining that preserves word boundaries, URL/email stripping before the meta-discussion test, tier-gated signals exempt from meta-dilution, and a stricter base64 decode validator. The Jest suite (`__tests__/redteam-provenance.test.ts`) enforces the per-category bars and the zero-FP ceiling on every run.

## Residual weaknesses

Documented honestly — this is a heuristic gate, not a proof:

- A **single unquoted injection signal wearing a discussion-like prefix** ("Security update: ignore previous instructions") still evades: the meta exemption halves it to 1.0, under the 2.0 threshold. Two signals still quarantine.
- **Novel phrasings** outside the cliché list don't match — the gate recognizes known shapes, not intent. Paraphrased injections ("kindly set aside your earlier directives") are the main blind spot.
- Obfuscation beyond the normalization set (unmapped homoglyph scripts, double-spaced letter splitting, base64 nested deeper than 2) evades.
- Tier-aware strictness only applies when the tier is known: anything written with `source: "user_input"` skips the dormant/trigger rules, so the tier must genuinely reflect the channel.
- The battery is synthetic. These numbers measure the gate against itself, not against a live adversary — a real red-team pass with human-crafted novel attacks would likely find new misses.

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
