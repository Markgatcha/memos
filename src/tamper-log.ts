/**
 * Tamper-evident mutation log.
 *
 * Every memory mutation (store / import / update / forget) appends one
 * entry to an append-only, hash-chained log stored alongside the nodes
 * in the same database. `verifyTamperLog()` recomputes the chain and —
 * with the deep check — cross-checks each node's current content
 * against the latest log entry, so it detects:
 *
 * - edited, deleted, or reordered log rows (chain linkage breaks),
 * - nodes edited/deleted directly in the DB without a log entry
 *   (content-hash mismatch / missing-entry mismatch),
 * - nodes resurrected after a `forget` entry.
 *
 * Honest threat model: the log is tamper-*evident*, not tamper-*proof*.
 * An attacker with full write access to the database file can rewrite
 * the entire chain from genesis and the log alone cannot tell. What
 * stops that is an externally anchored checkpoint: `memos log
 * checkpoint` prints the tip hash; write it down (paper, another
 * machine, a signed commit) and `memos log verify --expect <hash>`
 * later proves the chain still ends where you left it. Without an
 * external anchor, a full-chain rewrite is undetectable — by anyone,
 * with any local-only scheme.
 */

import { createHash } from "node:crypto";
import type {
  MemoryNode,
  NewTamperLogEntry,
  StorageAdapter,
  TamperLogEntry,
  TamperOp,
} from "./types.js";

/** Fixed `prevHash` for the first entry — a domain-separated constant. */
export const GENESIS_PREV =
  "memos-tamper-log-genesis-v1:" +
  createHash("sha256").update("memos-tamper-log-genesis-v1").digest("hex");

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash of a node's content at mutation time. */
export function contentHash(content: string): string {
  return sha256hex("memos-node-content-v1:" + content);
}

/**
 * Hash of one log entry. Canonical field order and a versioned prefix
 * make the serialization unambiguous — no JSON key-ordering games.
 */
export function entryHash(e: Omit<NewTamperLogEntry, "entryHash">): string {
  return sha256hex(
    [
      "memos-tamper-entry-v1",
      e.ts,
      e.op,
      e.nodeId,
      e.contentHash,
      e.prevHash,
    ].join("|"),
  );
}

/**
 * Append one mutation to the log. Fail-open: when the storage adapter
 * doesn't implement the log, or the write fails, the mutation itself
 * is never blocked — the log is evidence, not a gate.
 */
export async function appendTamperEntry(
  storage: StorageAdapter,
  op: TamperOp,
  node: Pick<MemoryNode, "id" | "content">,
  ts: number = Date.now(),
): Promise<void> {
  if (!storage.appendTamperEntry || !storage.readTamperLog) return;
  try {
    const existing = await storage.readTamperLog();
    const prevHash =
      existing.length > 0
        ? existing[existing.length - 1]!.entryHash
        : GENESIS_PREV;
    const draft: Omit<NewTamperLogEntry, "entryHash"> = {
      ts,
      op,
      nodeId: node.id,
      contentHash: contentHash(node.content),
      prevHash,
    };
    await storage.appendTamperEntry({ ...draft, entryHash: entryHash(draft) });
  } catch {
    // Fail-open: a logging failure must never break the write path.
  }
}

export interface TamperVerifyIssue {
  kind:
    | "broken_chain"
    | "content_mismatch"
    | "deleted_without_log"
    | "resurrected"
    | "tip_mismatch";
  seq?: number;
  nodeId?: string;
  detail: string;
}

export interface TamperVerifyResult {
  ok: boolean;
  supported: boolean;
  entriesChecked: number;
  /** Nodes that exist but predate the log (no entries) — informational. */
  unloggedNodes: number;
  issues: TamperVerifyIssue[];
  tipHash: string | null;
}

/**
 * Verify the log: chain integrity (seq continuity, prev-hash linkage,
 * entry-hash recomputation) plus a deep cross-check of every node's
 * current content against its latest log entry.
 *
 * `expectTip` anchors the chain to an externally recorded checkpoint:
 * verification fails unless the current tip hash equals it.
 */
export async function verifyTamperLog(
  storage: StorageAdapter,
  opts: { expectTip?: string } = {},
): Promise<TamperVerifyResult> {
  const empty: TamperVerifyResult = {
    ok: true,
    supported: true,
    entriesChecked: 0,
    unloggedNodes: 0,
    issues: [],
    tipHash: null,
  };
  if (!storage.readTamperLog) {
    return { ...empty, supported: false };
  }

  let entries: TamperLogEntry[];
  try {
    entries = await storage.readTamperLog();
  } catch {
    return { ...empty, supported: false };
  }
  const result: TamperVerifyResult = {
    ...empty,
    entriesChecked: entries.length,
    tipHash: entries.length > 0 ? entries[entries.length - 1]!.entryHash : null,
  };
  const fail = (issue: TamperVerifyIssue) => {
    result.ok = false;
    result.issues.push(issue);
  };

  // --- Chain integrity -------------------------------------------------
  let prev = GENESIS_PREV;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const expectedSeq = i + 1;
    if (e.seq !== expectedSeq) {
      fail({
        kind: "broken_chain",
        seq: e.seq,
        detail: `sequence break at row ${i + 1}: expected seq ${expectedSeq}, found ${e.seq} (rows deleted or reordered)`,
      });
      break;
    }
    if (e.prevHash !== prev) {
      fail({
        kind: "broken_chain",
        seq: e.seq,
        detail: `prevHash mismatch at seq ${e.seq}: chain was edited or reordered`,
      });
      break;
    }
    const recomputed = entryHash({
      ts: e.ts,
      op: e.op,
      nodeId: e.nodeId,
      contentHash: e.contentHash,
      prevHash: e.prevHash,
    });
    if (recomputed !== e.entryHash) {
      fail({
        kind: "broken_chain",
        seq: e.seq,
        nodeId: e.nodeId,
        detail: `entry hash mismatch at seq ${e.seq}: row was edited in place`,
      });
      break;
    }
    prev = e.entryHash;
  }

  // --- Deep cross-check: DB state vs latest log entry per node ---------
  if (result.ok && typeof storage.queryNodes === "function") {
    const latest = new Map<string, TamperLogEntry>();
    for (const e of entries) latest.set(e.nodeId, e);
    try {
      const rows = await storage.queryNodes({ limit: 100_000 });
      const live = new Map<string, MemoryNode>();
      for (const r of rows) live.set(r.node.id, r.node);

      for (const [nodeId, entry] of latest) {
        const node = live.get(nodeId);
        if (entry.op === "forget") {
          if (node) {
            fail({
              kind: "resurrected",
              seq: entry.seq,
              nodeId,
              detail: `node ${nodeId.slice(0, 8)} has a forget entry (seq ${entry.seq}) but still exists in the DB`,
            });
          }
          continue;
        }
        if (!node) {
          fail({
            kind: "deleted_without_log",
            seq: entry.seq,
            nodeId,
            detail: `node ${nodeId.slice(0, 8)} is gone from the DB but its latest log entry (seq ${entry.seq}, op ${entry.op}) is not a forget`,
          });
          continue;
        }
        if (contentHash(node.content) !== entry.contentHash) {
          fail({
            kind: "content_mismatch",
            seq: entry.seq,
            nodeId,
            detail: `node ${nodeId.slice(0, 8)} content does not match its latest log entry (seq ${entry.seq}, op ${entry.op}): edited without logging`,
          });
        }
      }
      for (const nodeId of live.keys()) {
        if (!latest.has(nodeId)) result.unloggedNodes += 1;
      }
    } catch {
      // Deep check is best-effort; chain verification above stands alone.
    }
  }

  // --- External checkpoint anchor --------------------------------------
  if (opts.expectTip && result.tipHash !== opts.expectTip) {
    fail({
      kind: "tip_mismatch",
      detail: `tip hash ${result.tipHash ?? "(empty log)"} does not match the expected checkpoint ${opts.expectTip}: the chain was rewritten after the checkpoint`,
    });
  }

  return result;
}
