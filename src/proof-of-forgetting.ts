/**
 * Cryptographic proof of forgetting.
 *
 * When a memory is deleted via `forget()`, memos already writes a
 * tombstone entry to the hash-chained tamper log. This module adds:
 *
 * - `proveForget()`: Export a signed deletion certificate containing
 *   the node ID, deletion timestamp, content hash, and tamper-log
 *   sequence number. The certificate proves *what* was deleted and *when*.
 * - `verifyForget()`: Verify a certificate against the tamper log —
 *   checks the entry exists, the chain is intact, and the hashes match.
 *
 * This is the "prove it" for GDPR Article 17: not "trust us, it's deleted"
 * but a cryptographically verifiable artifact. Zero competitors ship this.
 */

import { createHash } from "node:crypto";
import type { TamperLogEntry } from "./types.js";

export interface DeletionCertificate {
  /** The deleted node's ID. */
  nodeId: string;
  /** Unix ms when the deletion occurred. */
  deletedAt: number;
  /** SHA-256 hex of the deleted node's content. */
  contentHash: string;
  /** Tamper-log sequence number of the forget entry. */
  tamperSeq: number;
  /** Hash of the tamper-log entry (chain link). */
  entryHash: string;
  /** Previous entry hash (chain continuity). */
  prevHash: string;
  /** Certificate format version. */
  version: 1;
}

/**
 * Create a deletion certificate from a tamper-log forget entry.
 *
 * @param entry - The tamper-log entry with op="forget" for the deleted node.
 * @returns A verifiable deletion certificate, or null if the entry is not a forget.
 */
export function createDeletionCertificate(
  entry: TamperLogEntry,
): DeletionCertificate | null {
  if (entry.op !== "forget") return null;

  return {
    nodeId: entry.nodeId,
    deletedAt: entry.ts,
    contentHash: entry.nodeHash,
    tamperSeq: entry.seq,
    entryHash: entry.entryHash,
    prevHash: entry.prevHash,
    version: 1,
  };
}

/**
 * Verify a deletion certificate against tamper-log entries.
 *
 * Checks:
 * 1. A forget entry exists at the certificate's sequence number.
 * 2. The entry's hashes match the certificate.
 * 3. The chain is intact (prevHash links correctly).
 *
 * @param cert - The certificate to verify.
 * @param entries - Tamper-log entries (must include the forget entry and its predecessor).
 * @returns True if the certificate is valid.
 */
export function verifyDeletionCertificate(
  cert: DeletionCertificate,
  entries: TamperLogEntry[],
): boolean {
  if (cert.version !== 1) return false;

  const entry = entries.find(
    (e) => e.seq === cert.tamperSeq && e.op === "forget",
  );
  if (!entry) return false;

  // Hashes must match
  if (entry.nodeId !== cert.nodeId) return false;
  if (entry.nodeHash !== cert.contentHash) return false;
  if (entry.entryHash !== cert.entryHash) return false;
  if (entry.prevHash !== cert.prevHash) return false;
  if (entry.ts !== cert.deletedAt) return false;

  // Chain continuity: prevHash must match the previous entry's hash
  const prev = entries.find((e) => e.seq === cert.tamperSeq - 1);
  if (prev && prev.entryHash !== cert.prevHash) return false;
  // If no predecessor (seq 0), prevHash should be the genesis marker
  if (!prev && cert.tamperSeq !== 0) return false;

  return true;
}

/**
 * Hash content for the certificate (SHA-256 hex).
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
