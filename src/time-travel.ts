/**
 * Memory time-travel: point-in-time reconstruction.
 *
 * The tamper log records every mutation as a hash-chained entry, but only
 * stores hashes — not full state. This module adds snapshot capture: on
 * every logged mutation, the node's full state (content, tags, importance,
 * metadata, etc.) is saved alongside the tamper-log sequence number.
 *
 * `replayAt(timestamp)` reconstructs what the agent believed at any moment
 * by finding the latest snapshot for each node before the timestamp.
 *
 * "What did you know about my project last March?" — no competitor can
 * answer this. The data is the moat.
 */

import type { MemoryNode, TamperLogEntry } from "./types.js";

export interface NodeSnapshot {
  /** Tamper-log sequence number this snapshot corresponds to. */
  seq: number;
  /** Unix ms when the snapshot was taken. */
  ts: number;
  /** The operation that created this snapshot. */
  op: string;
  /** Full node state at this point in time. */
  node: MemoryNode;
}

/**
 * Reconstruct the set of nodes as they existed at a given timestamp.
 *
 * For each node, finds the latest snapshot with ts <= target. Nodes with
 * a "forget" op as their latest snapshot are excluded (they didn't exist
 * at the target time).
 *
 * @param snapshots - All snapshots, ordered by seq.
 * @param targetTs - The timestamp to reconstruct (Unix ms).
 * @returns The nodes as they existed at targetTs.
 */
export function replayAt(
  snapshots: NodeSnapshot[],
  targetTs: number,
): MemoryNode[] {
  // Group by nodeId, find latest snapshot <= targetTs for each
  const latest = new Map<string, NodeSnapshot>();

  for (const snap of snapshots) {
    if (snap.ts > targetTs) continue;
    const existing = latest.get(snap.node.id);
    if (!existing || snap.seq > existing.seq) {
      latest.set(snap.node.id, snap);
    }
  }

  // Exclude nodes whose latest snapshot is a deletion
  const result: MemoryNode[] = [];
  for (const snap of latest.values()) {
    if (snap.op !== "forget") {
      result.push(snap.node);
    }
  }

  return result;
}
