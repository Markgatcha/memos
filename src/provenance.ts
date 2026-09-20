/**
 * Provenance-tiered trust for MemOS — the provenance-trust security layer.
 *
 * 2026 is the year memory became the attack surface (InjecMEM/COLM 2026:
 * one ordinary interaction poisons memory with 35.6% end-to-end success;
 * Trojan Hippo: dormant payloads persist through 100 benign sessions;
 * AgentPoison >80% ASR at <0.1% poison rate; ClawHavoc poisoned AI skill
 * packages). A local-first memory store should know *where* each memory
 * came from and treat channels unequally — so every memory carries a
 * provenance tier, assigned at write time and fused into recall scoring.
 *
 * Tier ordering (highest trust first):
 *
 * - `user-verified` — explicitly confirmed by the user (never assigned
 *   automatically — only via an explicit `provenance` opt or `verify()`).
 * - `user`          — ordinary user statements (the default for direct
 *   `store()` writes, which carry `source: "user_input"`).
 * - `tool-output`   — results returned by tools (`source: "tool_output"`).
 * - `chat`          — model-generated content (`source: "agent_inferred"`
 *   or `source: "system"`).
 * - `imported`      — bulk imports from ChatGPT/Claude/Slack exports
 *   (`source: "external_data"`).
 *
 * Default rule (documented here and in docs/provenance-trust.md): when
 * `store()` is called without an explicit `provenance`, the tier is
 * derived from `source` via {@link defaultProvenanceForSource}.
 * `user-verified` is the only tier that can never be assigned by the
 * default rule — it requires an explicit user confirmation step.
 *
 * Everything here is dependency-free and LLM-free: tier assignment and
 * trust fusion are pure local computation, safe for the hot path.
 *
 * @module @mem-os/provenance
 */

import { citationToken } from "./citations.js";
import type {
  MemoryNode,
  MemorySource,
  ProvenanceTier,
  ScoredMemory,
} from "./types.js";

/**
 * Canonical tier ordering, highest trust first. The index is the
 * authority for "higher tier wins" comparisons.
 */
export const PROVENANCE_TIER_ORDER: readonly ProvenanceTier[] = [
  "user-verified",
  "user",
  "tool-output",
  "chat",
  "imported",
] as const;

/**
 * Tiers whose content a host agent should confirm before acting on,
 * rather than silently injecting as context. Quarantined-then-released
 * memories are untrusted regardless of tier (see
 * {@link isUntrustedForAgent}).
 */
export const LOW_TRUST_TIERS: ReadonlySet<ProvenanceTier> = new Set([
  "tool-output",
  "imported",
]);

/**
 * Per-tier trust multiplier fused into retrieval scoring (see
 * `fuseResults` in src/retrieval.ts). Deliberately gentle: the top tier
 * is untouched and the bottom tier keeps 72% of its relevance score, so
 * provenance nudges ranking without overriding relevance.
 */
export const PROVENANCE_TRUST: Record<ProvenanceTier, number> = {
  "user-verified": 1.0,
  user: 0.97,
  "tool-output": 0.9,
  chat: 0.82,
  imported: 0.72,
};

/**
 * Default strength of the provenance multiplier in score fusion
 * (`score *= 1 - strength * (1 - tierTrust)`). 0.5 keeps the maximum
 * penalty (imported tier) at ~14% — measurable but never dominant.
 * Override per deployment via `config.fusion.provenanceWeightStrength`
 * (0 disables it).
 */
export const DEFAULT_PROVENANCE_WEIGHT_STRENGTH = 0.5;

/** Metadata key stamped on a memory released from quarantine. */
export const QUARANTINE_RELEASED_METADATA_KEY = "releasedFromQuarantine";

/** Runtime guard for the tier union (storage rows may predate the column). */
export function isProvenanceTier(value: unknown): value is ProvenanceTier {
  return (
    typeof value === "string" &&
    (PROVENANCE_TIER_ORDER as readonly string[]).includes(value)
  );
}

/**
 * Default provenance tier for a write, derived from its `source`.
 *
 * - `user_input`    → `user` (ordinary user statements)
 * - `tool_output`   → `tool-output`
 * - `agent_inferred`→ `chat` (model-generated)
 * - `system`        → `chat` (machine-generated)
 * - `external_data` → `imported` (bulk imports)
 *
 * `user-verified` is never returned here: explicit user confirmation is
 * the only path to the top tier.
 */
export function defaultProvenanceForSource(
  source: MemorySource,
): ProvenanceTier {
  switch (source) {
    case "tool_output":
      return "tool-output";
    case "agent_inferred":
    case "system":
      return "chat";
    case "external_data":
      return "imported";
    case "user_input":
    default:
      return "user";
  }
}

/**
 * Resolve the provenance tier for a write: an explicit, valid
 * `provenance` option always wins; otherwise the source-derived
 * default applies.
 */
export function resolveProvenance(opts: {
  provenance?: ProvenanceTier;
  source: MemorySource;
}): ProvenanceTier {
  if (opts.provenance && isProvenanceTier(opts.provenance)) {
    return opts.provenance;
  }
  return defaultProvenanceForSource(opts.source);
}

/** Compare two tiers: negative when `a` outranks `b`. */
export function compareProvenanceTier(
  a: ProvenanceTier,
  b: ProvenanceTier,
): number {
  return PROVENANCE_TIER_ORDER.indexOf(a) - PROVENANCE_TIER_ORDER.indexOf(b);
}

/**
 * Whether a memory's provenance channel is low-trust for agent
 * consumption: tier `imported` / `tool-output`, or a memory that was
 * quarantined and later released (its tier alone no longer tells the
 * story — the release marker does).
 */
export function isUntrustedForAgent(
  node: Pick<MemoryNode, "provenance" | "quarantined" | "metadata">,
): boolean {
  if (node.quarantined) return true;
  if (
    isProvenanceTier(node.provenance) &&
    LOW_TRUST_TIERS.has(node.provenance)
  ) {
    return true;
  }
  return (
    isRecord(node.metadata) &&
    node.metadata[QUARANTINE_RELEASED_METADATA_KEY] === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Quarantine visibility for a recall filter. Storage excludes
 * quarantined rows by default (`includeQuarantined` unset or false);
 * `includeQuarantined: true` shows everything; `quarantinedOnly: true`
 * shows only quarantined rows (the review queue).
 */
export function quarantineVisible(
  quarantined: boolean,
  filter: { includeQuarantined?: boolean; quarantinedOnly?: boolean },
): boolean {
  if (filter.quarantinedOnly === true) return quarantined;
  if (filter.includeQuarantined === true) return true;
  return !quarantined;
}

/**
 * The trust multiplier for one tier at a given fusion strength:
 * `1 - strength * (1 - tierTrust)`. Uniform across a result set, so a
 * same-tier corpus (e.g. the retrieval eval's all-`user` facts) keeps
 * byte-identical ranking — the weight is provably neutral there.
 */
export function provenanceMultiplier(
  tier: ProvenanceTier,
  strength: number = DEFAULT_PROVENANCE_WEIGHT_STRENGTH,
): number {
  const trust = PROVENANCE_TRUST[tier] ?? 1.0;
  return 1 - strength * (1 - trust);
}

/**
 * Stamp trust flags onto search results headed for an agent: the
 * provenance tier, a citable `[mem:hex]` token tracing the memory to
 * its source episode, and `untrustedSource` for low-trust channels.
 * Pure — returns new result objects, never mutates the input.
 */
export function decorateTrustFlags(results: ScoredMemory[]): ScoredMemory[] {
  return results.map((r) => ({
    ...r,
    provenance: r.node.provenance,
    citation: citationToken(r.node.id),
    untrustedSource: isUntrustedForAgent(r.node),
  }));
}
