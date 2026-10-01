/**
 * Encrypted cross-machine sync (bundle format v2).
 *
 * Export memories to an encrypted bundle file, move it to another machine
 * (via cloud drive, USB, etc.), and import it there. The bundle is encrypted
 * with AES-256-GCM; the storage medium never sees plaintext.
 *
 * ## Threat model (v2)
 *
 * - The sync bundle may be stored on untrusted storage (cloud drives, USB
 *   sticks, email). EVERYTHING about each record — id, content, type,
 *   tags, timestamps, namespace, metadata — is encrypted client-side
 *   before writing the bundle. Each record gets a fresh random nonce.
 * - Bundle metadata (`version`, `exportedAt`, `salt`, `recordCount`) is
 *   plaintext but AUTHENTICATED: it is bound into every record's
 *   AES-GCM additional authenticated data (AAD). Tampering with it
 *   fails decryption.
 * - The encryption key is derived from a user passphrase via PBKDF2
 *   (100k iterations, SHA-256) or read directly from a key file. The key
 *   never leaves the user's devices.
 * - An attacker with the bundle but not the key learns only: the bundle
 *   version, export timestamp, salt, record count, and per-record
 *   ciphertext sizes. They do NOT learn IDs, content, types, tags,
 *   timestamps, or any other memory field.
 * - This does NOT protect against an attacker who obtains the passphrase
 *   or key file. Choose a strong passphrase.
 * - This does NOT hide access patterns (when you sync, how many records).
 *
 * ## Conflict semantics
 *
 * - `skip-existing` (default): records with IDs already in the local store
 *   are skipped. New records are imported with their original IDs and
 *   timestamps.
 * - `last-write-wins`: if a record exists locally, the version with the
 *   newer `updatedAt` wins and replaces the local copy (same ID,
 *   incoming timestamps preserved). On equal timestamps the local copy
 *   is kept (deterministic tiebreak).
 * - Content-identical records are never duplicated: if any local record
 *   already has the same content hash, the incoming record is skipped.
 *
 * ## Local-first
 *
 * The local SQLite database remains the source of truth. Sync is additive:
 * export writes a snapshot, import merges into the local store. Import
 * never deletes records except replacing the single conflicting record
 * under `last-write-wins`.
 *
 * ## Transport
 *
 * Transport is manual: you move the bundle file yourself (cloud drive,
 * USB stick, `scp`, …). There is no network sync backend — the bundle
 * file IS the transport, and the encryption above is what makes that safe.
 *
 * @module @memos/sync
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type {
  MemoryType,
  MemorySource,
  MemoryPool,
  ProvenanceTier,
} from "./types.js";
import type { MemOS } from "./memory.js";

const SYNC_VERSION = 2;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // AES-256
const NONCE_LENGTH = 12; // GCM standard
const SALT_LENGTH = 16;

const MEMORY_TYPES: MemoryType[] = [
  "fact",
  "preference",
  "context",
  "relationship",
  "entity",
  "custom",
];

/**
 * A single memory record as exported in the bundle. Every field lands
 * inside the encrypted payload — nothing record-specific is plaintext.
 */
export interface SyncRecord {
  id: string;
  content: string;
  summary?: string;
  type: MemoryType;
  tags: string[];
  importance: number;
  /** Creation timestamp (Unix ms). */
  createdAt: number;
  /** Last-modified timestamp (Unix ms). */
  updatedAt: number;
  namespace: string;
  metadata: Record<string, unknown>;
  source?: MemorySource;
  provenance?: ProvenanceTier;
  pool?: MemoryPool;
  /** TTL expiration as Unix timestamp (seconds). null = no expiration. */
  expiresAt?: number | null;
  validFrom?: number | null;
  validTo?: number | null;
  harness?: string;
}

/** A single encrypted record in the bundle — opaque bytes only. */
export interface EncryptedRecord {
  /** Base64-encoded nonce for AES-GCM. */
  nonce: string;
  /** Base64-encoded ciphertext (AES-256-GCM). */
  ciphertext: string;
  /** Base64-encoded auth tag. */
  tag: string;
}

/**
 * The encrypted sync bundle format (v2).
 *
 * `version`, `exportedAt`, `salt`, and `recordCount` are plaintext but
 * authenticated via the GCM AAD of every record (see `buildAAD`).
 */
export interface SyncBundle {
  version: number;
  /** ISO timestamp of export. Authenticated, not secret. */
  exportedAt: string;
  /** Base64-encoded PBKDF2 salt (bundle-wide). Authenticated, not secret. */
  salt: string;
  /** Number of records. Must equal records.length; authenticated. */
  recordCount: number;
  records: EncryptedRecord[];
}

/** Conflict resolution strategy for import. */
export type SyncStrategy = "skip-existing" | "last-write-wins";

/** Result of an import operation. */
export interface SyncImportResult {
  imported: number;
  skipped: number;
  updated: number;
  errors: string[];
}

/**
 * Derive a 32-byte AES key from a passphrase using PBKDF2.
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

/**
 * Build the AES-GCM additional authenticated data for a bundle.
 * Binds the plaintext bundle metadata to every record's ciphertext so
 * any tampering with version/exportedAt/salt/recordCount fails auth.
 * Key order is fixed so encrypt and decrypt compute identical bytes.
 */
export function buildAAD(bundle: {
  version: number;
  exportedAt: string;
  salt: string;
  recordCount: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: bundle.version,
      exportedAt: bundle.exportedAt,
      salt: bundle.salt,
      recordCount: bundle.recordCount,
    }),
    "utf-8",
  );
}

/**
 * Resolve the raw encryption key from a passphrase or key buffer.
 * Raw-key length errors use a constant message (never derived from key
 * material — see the CodeQL js/clear-text-logging note in v1).
 */
function resolveKey(keyOrPassphrase: Buffer | string, salt: Buffer): Buffer {
  if (typeof keyOrPassphrase === "string") {
    return deriveKey(keyOrPassphrase, salt);
  }
  if (keyOrPassphrase.length !== KEY_LENGTH) {
    throw new Error(`raw key must be ${KEY_LENGTH} bytes`);
  }
  return keyOrPassphrase;
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * `aad`, when given, is authenticated but not encrypted.
 * Returns { nonce, ciphertext, tag } as base64 strings.
 */
export function encryptRecord(
  plaintext: string,
  key: Buffer,
  aad?: Buffer,
): { nonce: string; ciphertext: string; tag: string } {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/**
 * Decrypt a record. Throws if the key is wrong, data is tampered,
 * or the AAD does not match.
 */
export function decryptRecord(
  encrypted: { nonce: string; ciphertext: string; tag: string },
  key: Buffer,
  aad?: Buffer,
): string {
  const nonce = Buffer.from(encrypted.nonce, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}

/**
 * Content hash for dedup: SHA-256 over the record's content.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Validate a decrypted record's shape; throws on mismatch. */
function validateSyncRecord(data: unknown): SyncRecord {
  if (!data || typeof data !== "object") {
    throw new Error("bundle contains a malformed record");
  }
  const r = data as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) {
    throw new Error("bundle record has an invalid id");
  }
  if (typeof r.content !== "string") {
    throw new Error(`bundle record ${r.id} has invalid content`);
  }
  if (
    typeof r.type !== "string" ||
    !MEMORY_TYPES.includes(r.type as MemoryType)
  ) {
    throw new Error(`bundle record ${r.id} has invalid type`);
  }
  if (typeof r.createdAt !== "number" || typeof r.updatedAt !== "number") {
    throw new Error(`bundle record ${r.id} has invalid timestamps`);
  }
  return {
    id: r.id,
    content: r.content,
    summary: typeof r.summary === "string" ? r.summary : undefined,
    type: r.type as MemoryType,
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === "string")
      : [],
    importance: typeof r.importance === "number" ? r.importance : 0.5,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    namespace: typeof r.namespace === "string" ? r.namespace : "default",
    metadata:
      r.metadata && typeof r.metadata === "object"
        ? (r.metadata as Record<string, unknown>)
        : {},
    source:
      typeof r.source === "string" ? (r.source as MemorySource) : undefined,
    provenance:
      typeof r.provenance === "string"
        ? (r.provenance as ProvenanceTier)
        : undefined,
    pool: r.pool === "note" || r.pool === "procedure" ? r.pool : "event",
    expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
    validFrom: typeof r.validFrom === "number" ? r.validFrom : null,
    validTo: typeof r.validTo === "number" ? r.validTo : null,
    harness: typeof r.harness === "string" ? r.harness : undefined,
  };
}

/**
 * Create an encrypted sync bundle (v2) from memory records.
 *
 * Every record field is encrypted; only the bundle envelope
 * (version/exportedAt/salt/recordCount) is plaintext, and it is
 * authenticated via GCM AAD.
 */
export function createBundle(
  records: SyncRecord[],
  keyOrPassphrase: Buffer | string,
): SyncBundle {
  const salt = randomBytes(SALT_LENGTH);
  const key = resolveKey(keyOrPassphrase, salt);
  const exportedAt = new Date().toISOString();
  const aad = buildAAD({
    version: SYNC_VERSION,
    exportedAt,
    salt: salt.toString("base64"),
    recordCount: records.length,
  });

  const encryptedRecords: EncryptedRecord[] = records.map((r) => {
    const plaintext = JSON.stringify({
      id: r.id,
      content: r.content,
      summary: r.summary,
      type: r.type,
      tags: r.tags,
      importance: r.importance,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      namespace: r.namespace,
      metadata: r.metadata,
      source: r.source,
      provenance: r.provenance,
      pool: r.pool,
      expiresAt: r.expiresAt ?? null,
      validFrom: r.validFrom ?? null,
      validTo: r.validTo ?? null,
      harness: r.harness,
    });
    const { nonce, ciphertext, tag } = encryptRecord(plaintext, key, aad);
    return { nonce, ciphertext, tag };
  });

  return {
    version: SYNC_VERSION,
    exportedAt,
    salt: salt.toString("base64"),
    recordCount: records.length,
    records: encryptedRecords,
  };
}

/**
 * Decrypt all records in a bundle. Returns validated SyncRecords with
 * their original IDs and timestamps.
 *
 * Rejects v1 bundles outright: v1 left record IDs and timestamps in
 * plaintext and cannot be upgraded safely — re-export from the source
 * machine with the current memos.
 */
export function decryptBundle(
  bundle: SyncBundle,
  keyOrPassphrase: Buffer | string,
): SyncRecord[] {
  if (bundle.version === 1) {
    throw new Error(
      "unsupported bundle version 1: v1 bundles expose record IDs and " +
        "timestamps in plaintext and cannot be imported. Re-export from the " +
        "source machine with the current memos version.",
    );
  }
  if (bundle.version !== SYNC_VERSION) {
    throw new Error(`unsupported bundle version: ${bundle.version}`);
  }
  if (
    !Array.isArray(bundle.records) ||
    bundle.recordCount !== bundle.records.length
  ) {
    throw new Error(
      "bundle metadata mismatch: recordCount does not match records",
    );
  }
  const salt = Buffer.from(bundle.salt, "base64");
  const key = resolveKey(keyOrPassphrase, salt);
  const aad = buildAAD(bundle);

  return bundle.records.map((r) => {
    const plaintext = decryptRecord(
      { nonce: r.nonce, ciphertext: r.ciphertext, tag: r.tag },
      key,
      aad,
    );
    return validateSyncRecord(JSON.parse(plaintext));
  });
}

/**
 * Write a bundle to a file (JSON).
 */
export function writeBundle(path: string, bundle: SyncBundle): void {
  writeFileSync(path, JSON.stringify(bundle, null, 2), "utf-8");
}

/**
 * Read a bundle from a file. Validates the envelope shape only —
 * decryption (which authenticates the envelope) happens in
 * `decryptBundle`.
 */
export function readBundle(path: string): SyncBundle {
  if (!existsSync(path)) {
    throw new Error(`bundle file not found: ${path}`);
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (
    typeof data.version !== "number" ||
    typeof data.exportedAt !== "string" ||
    typeof data.salt !== "string" ||
    typeof data.recordCount !== "number" ||
    !Array.isArray(data.records)
  ) {
    throw new Error("invalid sync bundle format");
  }
  return data as SyncBundle;
}

/**
 * Merge decrypted records into a MemOS instance, preserving original
 * IDs and timestamps.
 *
 * - Content-identical records (by SHA-256 of content) are never
 *   duplicated: skipped when any local record already has the hash.
 * - `skip-existing`: IDs already present are skipped.
 * - `last-write-wins`: when the incoming `updatedAt` is newer than the
 *   local one, the local record is replaced (same ID, incoming
 *   timestamps preserved). Equal timestamps keep the local copy.
 */
export async function importRecords(
  memos: MemOS,
  records: SyncRecord[],
  strategy: SyncStrategy,
): Promise<SyncImportResult> {
  const result: SyncImportResult = {
    imported: 0,
    skipped: 0,
    updated: 0,
    errors: [],
  };

  const graph = await memos.getGraph();
  const nodes = graph.nodes ?? [];
  const updatedAtById = new Map<string, number>();
  const hashes = new Set<string>();
  for (const n of nodes) {
    updatedAtById.set(n.id, n.updatedAt ?? 0);
    hashes.add(contentHash(n.content));
  }

  for (const r of records) {
    try {
      // Content-hash dedup first: identical content is never duplicated,
      // regardless of ID or strategy.
      if (hashes.has(contentHash(r.content))) {
        result.skipped++;
        continue;
      }
      const existingUpdatedAt = updatedAtById.get(r.id);
      if (existingUpdatedAt === undefined) {
        await memos.importRecord(r);
        updatedAtById.set(r.id, r.updatedAt);
        hashes.add(contentHash(r.content));
        result.imported++;
        continue;
      }
      if (strategy === "last-write-wins" && r.updatedAt > existingUpdatedAt) {
        await memos.forget(r.id);
        await memos.importRecord(r);
        updatedAtById.set(r.id, r.updatedAt);
        hashes.add(contentHash(r.content));
        result.updated++;
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.errors.push(
        `${r.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/**
 * Resolve the sync key from CLI options.
 * Priority: --key-file > --key > MEMOS_SYNC_KEY env var.
 * When none is provided, throws — the CLI prompts interactively on a TTY.
 */
/**
 * Resolve the sync key from CLI options.
 * Priority: --passphrase-file > --passphrase > MEMOS_SYNC_KEY env var.
 * When none is provided, throws — the CLI prompts interactively on a TTY.
 *
 * Note: the flag is --passphrase (not --key) because --key is already the
 * global at-rest database encryption key in the CLI.
 */
export function resolveSyncKey(opts: {
  passphrase?: string;
  passphraseFile?: string;
}): Buffer | string {
  if (opts.passphraseFile) {
    const keyData = readFileSync(opts.passphraseFile);
    // Allow both raw 32-byte keys and hex-encoded keys
    const hex = keyData.toString("utf-8").trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return Buffer.from(hex, "hex");
    }
    if (keyData.length === KEY_LENGTH) {
      return keyData;
    }
    throw new Error(
      `key file must contain a 32-byte raw key or 64-char hex string, got ${keyData.length} bytes`,
    );
  }
  if (opts.passphrase) return opts.passphrase;
  const envKey = process.env.MEMOS_SYNC_KEY;
  if (envKey) return envKey;
  throw new Error(
    "sync key required: use --passphrase <passphrase>, --passphrase-file <path>, or MEMOS_SYNC_KEY env var",
  );
}
