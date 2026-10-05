/**
 * Ebbinghaus forgetting-curve reinforcement for retrieval scoring.
 *
 * From MemoryBank (AAAI 2024): score memories by R = e^(-Δt/S), where
 * Δt is days since last access and S is the access count (strength).
 * Frequently-recalled memories stay strong; untouched old ones fade
 * exponentially. Fixes stale preferences overriding recent corrections.
 *
 * Pure arithmetic, no LLM. Blended as a small additive term in scoring.
 * Opt-in via `experimental.ebbinghaus`.
 */

export interface EbbinghausNode {
  accessCount: number;
  lastAccessed: number; // epoch ms
}

/**
 * Compute the Ebbinghaus recall strength for a node.
 * Returns a value in (0, 1]: 1.0 for just-accessed, decaying exponentially.
 *
 * @param node - Node with accessCount and lastAccessed
 * @param now - Current time in epoch ms (defaults to Date.now())
 */
export function recallStrength(
  node: EbbinghausNode,
  now: number = Date.now(),
): number {
  const accessCount = Math.max(1, node.accessCount || 1);
  const lastAccessed = node.lastAccessed || now;

  // Δt in days
  const deltaDays = Math.max(0, (now - lastAccessed) / (1000 * 60 * 60 * 24));

  // R = e^(-Δt/S)
  return Math.exp(-deltaDays / accessCount);
}

/**
 * Weight for blending Ebbinghaus score into fused results.
 * Small by default to be safe; the fused score dominates.
 */
export const EBBINGHAUS_WEIGHT = 0.1;
