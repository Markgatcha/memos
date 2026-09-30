/**
 * Encrypted cross-machine sync.
 *
 * Export memories to an encrypted bundle file, move it to another machine
 * (via cloud drive, USB, etc.), and import it there. The bundle is encrypted
 * with AES-256-GCM; the storage medium never sees plaintext.
 *
 * ## Threat model
 *
 * - The sync bundle may be stored on untrusted storage (cloud drives, USB
 *   sticks, email). All memory content is encrypted client-side before
 *   writing the bundle.
 * - The encryption key is derived from a user passphrase via PBKDF2
 *   (100k iterations, SHA-256) or read directly from a key file. The key
 *   never leaves the user's devices.
 * - An attacker with the bundle but not the key learns: record IDs,
 *   timestamps, ciphertext sizes, and the number of records. They do NOT
 *   learn content, types, tags, or any other memory fields.
 * - This does NOT protect against an attacker who obtains the passphrase
 *   or key file. Choose a strong passphrase.
 * - This does NOT hide access patterns (when you sync, how many records).
 *
 * ## Conflict semantics
 *
 * - `skip-existing` (default): records with IDs already in the local store
 *   are skipped. New records are imported.
 * - `last-write-wins`: if a record exists locally, the version with the
 *   newer `updatedAt` wins.
 * - Content-identical records are never duplicated (compared by hash).
 *
 * ## Local-first
 *
 * The local SQLite database remains the source of truth. Sync is additive:
 * export writes a snapshot, import merges into the local store. Nothing is
 * ever deleted by a sync operation.
 *
 * @module @memos/sync
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SYNC_VERSION = 1;
const PBKDF2_ITERATIONS = 100_000;
const KEY_LENGTH = 32; // AES-256
const NONCE_LENGTH = 12; // GCM standard
const SALT_LENGTH = 16;

/** A single encrypted record in the bundle. */
export interface EncryptedRecord {
  /** Memory ID (plaintext, for dedup/indexing). */
  id: string;
  /** Base64-encoded salt for PBKDF2 (per-bundle, stored once). */
  salt?: string;
  /** Base64-encoded nonce for AES-GCM. */
  nonce: string;
  /** Base64-encoded ciphertext (AES-256-GCM). */
  ciphertext: string;
  /** Base64-encoded auth tag (appended by GCM). */
  tag: string;
  /** ISO timestamp of when the memory was created. */
  createdAt: string;
  /** ISO timestamp of when the memory was last updated. */
  updatedAt: string;
}

/** The encrypted sync bundle format. */
export interface SyncBundle {
  version: number;
  exportedAt: string;
  /** Base64-encoded PBKDF2 salt (bundle-wide). */
  salt: string;
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
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns { nonce, ciphertext, tag } as base64 strings.
 */
export function encryptRecord(
  plaintext: string,
  key: Buffer,
): { nonce: string; ciphertext: string; tag: string } {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
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
 * Decrypt a record. Throws if the key is wrong or data is tampered.
 */
export function decryptRecord(
  encrypted: { nonce: string; ciphertext: string; tag: string },
  key: Buffer,
): string {
  const nonce = Buffer.from(encrypted.nonce, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
}

/**
 * Create an encrypted sync bundle from memory records.
 *
 * @param records Array of { id, content, createdAt, updatedAt } objects.
 * @param keyOrPassphrase Either a 32-byte Buffer (raw key) or a string passphrase.
 */
export function createBundle(
  records: Array<{
    id: string;
    content: string;
    createdAt: string;
    updatedAt: string;
  }>,
  keyOrPassphrase: Buffer | string,
): SyncBundle {
  const salt = randomBytes(SALT_LENGTH);
  const key =
    typeof keyOrPassphrase === "string"
      ? deriveKey(keyOrPassphrase, salt)
      : keyOrPassphrase;

  if (key.length !== KEY_LENGTH) {
    throw new Error(`key must be ${KEY_LENGTH} bytes, got ${key.length}`);
  }

  const encryptedRecords: EncryptedRecord[] = records.map((r) => {
    const plaintext = JSON.stringify({
      id: r.id,
      content: r.content,
    });
    const { nonce, ciphertext, tag } = encryptRecord(plaintext, key);
    return {
      id: r.id,
      nonce,
      ciphertext,
      tag,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });

  return {
    version: SYNC_VERSION,
    exportedAt: new Date().toISOString(),
    salt: salt.toString("base64"),
    records: encryptedRecords,
  };
}

/**
 * Decrypt all records in a bundle.
 * Returns array of { id, content, createdAt, updatedAt }.
 * Throws if the key is wrong.
 */
export function decryptBundle(
  bundle: SyncBundle,
  keyOrPassphrase: Buffer | string,
): Array<{
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}> {
  if (bundle.version !== SYNC_VERSION) {
    throw new Error(`unsupported bundle version: ${bundle.version}`);
  }
  const salt = Buffer.from(bundle.salt, "base64");
  const key =
    typeof keyOrPassphrase === "string"
      ? deriveKey(keyOrPassphrase, salt)
      : keyOrPassphrase;

  return bundle.records.map((r) => {
    const plaintext = decryptRecord(
      { nonce: r.nonce, ciphertext: r.ciphertext, tag: r.tag },
      key,
    );
    const data = JSON.parse(plaintext);
    return {
      id: data.id,
      content: data.content,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

/**
 * Write a bundle to a file (JSON).
 */
export function writeBundle(path: string, bundle: SyncBundle): void {
  writeFileSync(path, JSON.stringify(bundle, null, 2), "utf-8");
}

/**
 * Read a bundle from a file.
 */
export function readBundle(path: string): SyncBundle {
  if (!existsSync(path)) {
    throw new Error(`bundle file not found: ${path}`);
  }
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (data.version !== SYNC_VERSION || !Array.isArray(data.records)) {
    throw new Error("invalid sync bundle format");
  }
  return data as SyncBundle;
}

/**
 * Resolve the sync key from CLI options.
 * Priority: --key-file > --key > MEMOS_SYNC_KEY env var.
 */
export function resolveSyncKey(opts: {
  key?: string;
  keyFile?: string;
}): Buffer | string {
  if (opts.keyFile) {
    const keyData = readFileSync(opts.keyFile);
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
  if (opts.key) return opts.key;
  const envKey = process.env.MEMOS_SYNC_KEY;
  if (envKey) return envKey;
  throw new Error(
    "sync key required: use --key <passphrase>, --key-file <path>, or MEMOS_SYNC_KEY env var",
  );
}
