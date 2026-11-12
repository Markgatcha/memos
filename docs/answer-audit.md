# Answer audit

Retrieval quality is necessary but not sufficient: an answer can cite
nothing, cite the wrong memory, or assert something the store never said.
Answer audit checks the answer itself.

```bash
memos audit-answer "Deployments require two SRE approvals. It also deploys on Fridays." \
  --query "deployment policy"
```

```text
Answer audit: 2 claim(s) — 1 supported, 0 partial, 1 unsupported, 0 contradicted
Coverage: 50.0%  Citations: 0 resolved, 0 unresolved
  [supported 0.95] Deployments require two SRE approvals
      lexical overlap above threshold
      evidence: Production deployments require two SRE approvals.
  [unsupported 0.00] It also deploys on Fridays
      no memory covers this claim
```

## How it works

1. **Split** the answer into claims: sentences, bullets, and numbered items.
   Questions and fragments under three words are dropped — they are not
   assertions.
2. **Score** each claim against candidate memories: 70% containment (how
   much of the claim's vocabulary the memory covers) + 30% Jaccard (which
   penalises memories much larger than the claim). An exact phrase match
   scores 1.
3. **Resolve citations** written as `[mem:abcd]`. A resolved citation with
   lexical overlap counts as support; a citation that resolves but shares
   little vocabulary is `partial` rather than silently trusted.
4. **Check negation**: high overlap with opposite negation is
   `contradicted`, not `supported`.

## Statuses

| Status | Meaning |
| --- | --- |
| `supported` | Score ≥ threshold (default 0.55), or a resolved citation with overlap. |
| `partial` | Score ≥ 0.30 but below the threshold, or a citation with little overlap. |
| `unsupported` | No memory covers the claim. |
| `contradicted` | Score ≥ 0.45 and opposite negation. |

Coverage is `(supported + 0.5 × partial) / claims`.

## CLI

```bash
memos audit-answer "<answer>" [--query <q>] [--ids <id,id>] [--limit <n>] [--threshold <0-1>] [--json]
```

- `--query` searches for candidate evidence.
- `--ids` pins exact memories.
- With neither, the whole store is used (capped at 2000 memories).

## API

```ts
const report = await memos.auditAnswer(answer, {
  query: "deployment policy",   // or memoryIds: [...]
  limit: 10,
  threshold: 0.55,
});

report.coverage;        // 0-1
report.claims;          // per-claim status, score, citations, evidence
report.citationsResolved;
report.citationsUnresolved;
```

Pure helpers (`src/answer-audit.ts`): `splitAnswerClaims`,
`claimSupportScore`, `resolveClaimCitations`, `auditAnswerText`,
`formatAnswerAudit`.

## Auditing a pack (low-token)

A pack can carry a deterministic id so the audit can reuse its evidence
instead of searching again:

```ts
const pack = await memos.contextPack({
  query: "deployment policy",
  tokenBudget: 800,
  audit: "metadata",          // or "line" for text-only hosts
});

// ... model answers ...

const summary = await memos.auditPackAnswer(pack.packId!, answer);
// { coverage, counts, issues, summary: "Audit 67% (2/3 supported, 1 unsupported). ..." }
```

| Mode | Cost | What you get |
| --- | --- | --- |
| `off` (default) | 0 tokens | Byte-identical pack; no id. |
| `metadata` | 0 tokens | `pack.packId` on the returned JSON object. |
| `line` | ~10 tokens | One `# audit-pack: <id>` comment line in serialized output. |

`packId` is a SHA-256 of namespace + query + sorted item ids, so identical
packs produce identical ids — prompt-prefix caching is unaffected. The
evidence for the last 32 packs is kept in memory; auditing is pure lexical
work with **no retrieval, no embeddings, and no search-cache traffic**.

The compact summary is deliberately small: coverage, counts, and at most
three flagged claims (~40–70 tokens), not a full per-claim dump.

MCP callers can pass the id directly:

```json
{ "pack_id": "a1b2c3d4e5f6", "answer": "..." }
```

## MCP

`memos_audit_answer` takes `answer`, optional `query` / `memory_ids` /
`limit` / `threshold`, and returns the same report in
`structuredContent`. It is outside the default core profile.

## Limits

- **Lexical, not semantic.** A correct paraphrase that shares no vocabulary
  scores `unsupported`. This is deliberate: the default path is
  deterministic and offline. Treat `unsupported` as "not verifiable from
  the candidate set", not "false".
- **Shallow contradiction.** Negation flips are detected; deeper
  contradictions ("mandatory" vs "optional") are not. A real NLI pass would
  be an opt-in extension, not the default.
- **No numeric verification.** "Two approvals" vs "four approvals" share
  every token except the number and can score as supported.
- **Candidate set matters.** Auditing against a `--query` result of 10
  memories says nothing about memories the query missed. Use `--ids` or the
  whole-store mode when completeness matters.
