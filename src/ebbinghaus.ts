/**
 * Ebbinghaus forgetting-curve reinforcement for retrieval scoring.
 *
 * From MemoryBank (AAAI 2024): score memories by R = e^(-Δt/S), where
 * Δt is days since last access and S is the access count (strength).
 * Frequently-recalled memories stay strong; untouched old ones fade
 * exponentially. Fixes stale preferences overriding recent corrections.
 *
 * The decay itself uses the POWER law that the forgetting literature
 * converged on (Wixted & Ebbesen 1991; the FSRS retrieval formula
 * R = (1 + t/(9·S))^-1 is the same shape), because the exponential form
 * has a measured failure mode here: e^(-Δt/S) is indistinguishable from
 * zero for anything older than ~2 weeks at one access, so the recency
 * dimension flatlines — three memories 1, 3 and 12 months old all score
 * 0.0000 and the tie is broken arbitrarily. The power law keeps them
 * graded (1 month ≈ 0.23, 3 months ≈ 0.09, a year ≈ 0.02), so the
 * reinforcement term can still discriminate old-but-accessed from
 * old-and-forgotten.
 *
 * Pure arithmetic, no LLM. Blended as a small additive term in scoring.
 * Opt-in via `experimental.ebbinghaus`.
 */

export interface EbbinghausNode {
  accessCount: number;
  lastAccessed: number; // epoch ms
}

/**
 * Stability per access, in days: after this many days of non-use a
 * memory with a single access falls to R = 0.5. Doubles with each
 * additional recorded access, so ten touches hold half strength for
 * ~90 days — the spacing effect, in one constant.
 */
export const EBBINGHAUS_STABILITY_DAYS = 9;

/**
 * Compute the Ebbinghaus recall strength for a node.
 * Returns a value in (0, 1]: 1.0 for just-accessed, decaying with age.
 *
 *   R = 1 / (1 + Δdays / (STABILITY_DAYS * accesses))
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

  // Power-law retrieval curve: monotone, never exactly zero, and flat
  // enough in the tail that old memories stay distinguishable.
  const stability = EBBINGHAUS_STABILITY_DAYS * accessCount;
  if (stability <= 0) return 1;
  return 1 / (1 + deltaDays / stability);
}

/**
 * Weight for blending Ebbinghaus score into fused results.
 * Small by default to be safe; the fused score dominates.
 */
export const EBBINGHAUS_WEIGHT = 0.1;
