/**
 * Tests for encrypted sync (Feature 5).
 */

import { describe, it, expect } from "@jest/globals";
import {
  deriveKey,
  encryptRecord,
  decryptRecord,
  createBundle,
  decryptBundle,
  writeBundle,
  readBundle,
  resolveSyncKey,
} from "../src/sync.js";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("deriveKey", () => {
  it("derives a 32-byte key", () => {
    const salt = randomBytes(16);
    const key = deriveKey("test-passphrase", salt);
    expect(key.length).toBe(32);
  });

  it("is deterministic for same inputs", () => {
    const salt = randomBytes(16);
    const k1 = deriveKey("pass", salt);
    const k2 = deriveKey("pass", salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it("differs for different passphrases", () => {
    const salt = randomBytes(16);
    const k1 = deriveKey("pass1", salt);
    const k2 = deriveKey("pass2", salt);
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("encryptRecord/decryptRecord", () => {
  it("round-trips correctly", () => {
    const key = randomBytes(32);
    const plaintext = "My secret memory content";
    const encrypted = encryptRecord(plaintext, key);
    expect(encrypted.nonce).toBeDefined();
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.tag).toBeDefined();
    // Ciphertext should not contain plaintext
    expect(encrypted.ciphertext).not.toContain("secret");
    const decrypted = decryptRecord(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const encrypted = encryptRecord("secret", key1);
    expect(() => decryptRecord(encrypted, key2)).toThrow();
  });

  it("fails with tampered ciphertext", () => {
    const key = randomBytes(32);
    const encrypted = encryptRecord("secret", key);
    // Tamper with the ciphertext
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from("tampered-data").toString("base64"),
    };
    expect(() => decryptRecord(tampered, key)).toThrow();
  });

  it("uses random nonce each time", () => {
    const key = randomBytes(32);
    const e1 = encryptRecord("same", key);
    const e2 = encryptRecord("same", key);
    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });
});

describe("createBundle/decryptBundle", () => {
  const records = [
    { id: "id1", content: "Memory one", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "id2", content: "Memory two", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
  ];

  it("round-trips with passphrase", () => {
    const bundle = createBundle(records, "my-passphrase");
    expect(bundle.version).toBe(1);
    expect(bundle.records).toHaveLength(2);
    expect(bundle.salt).toBeDefined();

    const decrypted = decryptBundle(bundle, "my-passphrase");
    expect(decrypted).toHaveLength(2);
    expect(decrypted[0].id).toBe("id1");
    expect(decrypted[0].content).toBe("Memory one");
  });

  it("round-trips with raw key", () => {
    const key = randomBytes(32);
    const bundle = createBundle(records, key);
    const decrypted = decryptBundle(bundle, key);
    expect(decrypted[0].content).toBe("Memory one");
  });

  it("fails with wrong passphrase", () => {
    const bundle = createBundle(records, "correct-pass");
    expect(() => decryptBundle(bundle, "wrong-pass")).toThrow();
  });

  it("does not leak content in bundle JSON", () => {
    const bundle = createBundle(records, "pass");
    const json = JSON.stringify(bundle);
    expect(json).not.toContain("Memory one");
    expect(json).not.toContain("Memory two");
    // IDs are visible (needed for dedup)
    expect(json).toContain("id1");
  });
});

describe("writeBundle/readBundle", () => {
  it("writes and reads a bundle file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
    const path = join(dir, "bundle.json");
    try {
      const bundle = createBundle(
        [{ id: "x", content: "y", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
        "pass",
      );
      writeBundle(path, bundle);
      const read = readBundle(path);
      expect(read.records).toHaveLength(1);
      expect(read.version).toBe(1);
    } finally {
      unlinkSync(path);
    }
  });

  it("throws for missing file", () => {
    expect(() => readBundle("/nonexistent/bundle.json")).toThrow();
  });
});

describe("resolveSyncKey", () => {
  it("uses --key", () => {
    const key = resolveSyncKey({ key: "my-pass" });
    expect(key).toBe("my-pass");
  });

  it("uses --key-file with hex", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-key-test-"));
    const path = join(dir, "key.hex");
    const hex = randomBytes(32).toString("hex");
    writeFileSync(path, hex);
    try {
      const key = resolveSyncKey({ keyFile: path });
      expect(Buffer.isBuffer(key)).toBe(true);
      expect((key as Buffer).length).toBe(32);
    } finally {
      unlinkSync(path);
    }
  });

  it("uses MEMOS_SYNC_KEY env var", () => {
    process.env.MEMOS_SYNC_KEY = "env-pass";
    try {
      const key = resolveSyncKey({});
      expect(key).toBe("env-pass");
    } finally {
      delete process.env.MEMOS_SYNC_KEY;
    }
  });

  it("throws when no key provided", () => {
    expect(() => resolveSyncKey({})).toThrow();
  });
});
