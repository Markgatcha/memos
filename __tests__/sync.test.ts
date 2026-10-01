/**
 * Tests for encrypted sync v2 (Feature 5 redesign).
 *
 * Covers: key derivation, AES-GCM round-trips with AAD, full-record
 * bundle round-trips, ciphertext-leakage (no plaintext anywhere in the
 * bundle JSON), envelope tamper rejection, v1 bundle rejection,
 * and end-to-end two-database sync (identity/metadata preservation,
 * conflict strategies, content-hash dedup).
 */

import { describe, it, expect } from "@jest/globals";
import {
  deriveKey,
  encryptRecord,
  decryptRecord,
  buildAAD,
  createBundle,
  decryptBundle,
  writeBundle,
  readBundle,
  resolveSyncKey,
  contentHash,
  importRecords,
  type SyncRecord,
  type SyncBundle,
} from "../src/sync.js";
import { MemOS } from "../src/memory.js";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeRecord(overrides: Partial<SyncRecord> = {}): SyncRecord {
  return {
    id: "rec-1",
    content: "The user prefers dark mode",
    summary: "prefers dark mode",
    type: "preference",
    tags: ["ui", "settings"],
    importance: 0.8,
    createdAt: 1727745600000,
    updatedAt: 1727745700000,
    namespace: "project:alpha",
    metadata: { source: "chat", confidence: 0.9 },
    source: "user_input",
    provenance: "user",
    pool: "event",
    expiresAt: null,
    validFrom: null,
    validTo: null,
    harness: "claude-code",
    ...overrides,
  };
}

function tempDb(prefix = "memos-sync-"): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, "memos.db") };
}

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

  it("uses random nonces", () => {
    const key = randomBytes(32);
    const e1 = encryptRecord("same", key);
    const e2 = encryptRecord("same", key);
    expect(e1.nonce).not.toBe(e2.nonce);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  it("authenticates AAD: tampered AAD fails decryption", () => {
    const key = randomBytes(32);
    const aad = Buffer.from("bundle-meta");
    const encrypted = encryptRecord("secret", key, aad);
    expect(decryptRecord(encrypted, key, aad)).toBe("secret");
    expect(() =>
      decryptRecord(encrypted, key, Buffer.from("tampered")),
    ).toThrow();
    expect(() => decryptRecord(encrypted, key)).toThrow();
  });
});

describe("createBundle/decryptBundle (v2)", () => {
  const records = [
    makeRecord(),
    makeRecord({
      id: "rec-2",
      content: "Second memory",
      type: "fact",
      tags: [],
    }),
  ];

  it("round-trips with passphrase, preserving every field", () => {
    const bundle = createBundle(records, "my-passphrase");
    expect(bundle.version).toBe(2);
    expect(bundle.records).toHaveLength(2);
    expect(bundle.recordCount).toBe(2);
    expect(bundle.salt).toBeDefined();
    expect(bundle.exportedAt).toBeDefined();

    const decrypted = decryptBundle(bundle, "my-passphrase");
    expect(decrypted).toHaveLength(2);
    expect(decrypted[0]).toEqual(records[0]);
    expect(decrypted[1].id).toBe("rec-2");
    expect(decrypted[1].type).toBe("fact");
    // Timestamps are numbers (Unix ms), preserved exactly
    expect(decrypted[0].createdAt).toBe(1727745600000);
    expect(decrypted[0].updatedAt).toBe(1727745700000);
  });

  it("round-trips with raw key", () => {
    const key = randomBytes(32);
    const bundle = createBundle(records, key);
    const decrypted = decryptBundle(bundle, key);
    expect(decrypted[0].content).toBe("The user prefers dark mode");
  });

  it("fails with wrong passphrase", () => {
    const bundle = createBundle(records, "correct-pass");
    expect(() => decryptBundle(bundle, "wrong-pass")).toThrow();
  });

  it("leaks no plaintext anywhere in the bundle JSON", () => {
    const bundle = createBundle(records, "pass");
    const json = JSON.stringify(bundle);
    // Content, IDs, tags, namespace, metadata — all must be absent
    expect(json).not.toContain("dark mode");
    expect(json).not.toContain("Second memory");
    expect(json).not.toContain("rec-1");
    expect(json).not.toContain("rec-2");
    expect(json).not.toContain("project:alpha");
    expect(json).not.toContain("settings");
    expect(json).not.toContain("claude-code");
    // Only envelope metadata is visible
    expect(json).toContain('"version":2');
    expect(json).toContain('"recordCount":2');
  });

  it("rejects tampering with recordCount", () => {
    const bundle = createBundle(records, "pass");
    const tampered: SyncBundle = { ...bundle, recordCount: 999 };
    expect(() => decryptBundle(tampered, "pass")).toThrow(/recordCount/);
  });

  it("rejects tampering with exportedAt (AAD-bound)", () => {
    const bundle = createBundle(records, "pass");
    const tampered: SyncBundle = {
      ...bundle,
      exportedAt: "2000-01-01T00:00:00.000Z",
    };
    expect(() => decryptBundle(tampered, "pass")).toThrow();
  });

  it("rejects tampering with the salt (AAD-bound)", () => {
    const bundle = createBundle(records, "pass");
    const tampered: SyncBundle = {
      ...bundle,
      salt: Buffer.from(randomBytes(16)).toString("base64"),
    };
    expect(() => decryptBundle(tampered, "pass")).toThrow();
  });

  it("rejects v1 bundles with a clear message", () => {
    const v1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      salt: "abc",
      records: [],
    } as unknown as SyncBundle;
    expect(() => decryptBundle(v1, "pass")).toThrow(/version 1/);
  });

  it("rejects unknown versions", () => {
    const bundle = createBundle(records, "pass");
    const bad = { ...bundle, version: 99 };
    expect(() => decryptBundle(bad, "pass")).toThrow(
      /unsupported bundle version/,
    );
  });

  it("rejects a record with an invalid type", () => {
    const key = randomBytes(32);
    const bundle = createBundle(records, key);
    const salt = Buffer.from(bundle.salt, "base64");
    const k = deriveKey("x", salt); // not used; craft manually below
    void k;
    // Re-encrypt a bad record with the same AAD
    const aad = buildAAD(bundle);
    const badPlaintext = JSON.stringify({
      ...makeRecord(),
      type: "not-a-real-type",
    });
    const enc = encryptRecord(badPlaintext, key, aad);
    const badBundle: SyncBundle = {
      ...bundle,
      records: [enc],
      recordCount: 1,
    };
    // recordCount mismatch trips first; fix it via a fresh envelope
    const fixedAad = buildAAD({ ...bundle, recordCount: 1 });
    const enc2 = encryptRecord(badPlaintext, key, fixedAad);
    const badBundle2: SyncBundle = {
      version: 2,
      exportedAt: bundle.exportedAt,
      salt: bundle.salt,
      recordCount: 1,
      records: [enc2],
    };
    expect(() => decryptBundle(badBundle, key)).toThrow();
    expect(() => decryptBundle(badBundle2, key)).toThrow(/invalid type/);
  });

  it("rejects a short raw key with a constant error (no key material in the message)", () => {
    const shortKey = randomBytes(16);
    let message = "";
    try {
      createBundle(records, shortKey);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe("raw key must be 32 bytes");
    expect(message).not.toContain(shortKey.toString("hex"));
  });
});

describe("writeBundle/readBundle", () => {
  it("writes and reads a bundle file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
    const path = join(dir, "bundle.json");
    try {
      const bundle = createBundle([makeRecord({ id: "x" })], "pass");
      writeBundle(path, bundle);
      const read = readBundle(path);
      expect(read.records).toHaveLength(1);
      expect(read.version).toBe(2);
      expect(read.recordCount).toBe(1);
    } finally {
      unlinkSync(path);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws for missing file", () => {
    expect(() => readBundle("/nonexistent/bundle.json")).toThrow();
  });

  it("throws for malformed envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-test-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ version: 2 }));
    try {
      expect(() => readBundle(path)).toThrow(/invalid sync bundle/);
    } finally {
      unlinkSync(path);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSyncKey", () => {
  it("uses --passphrase", () => {
    const key = resolveSyncKey({ passphrase: "my-pass" });
    expect(key).toBe("my-pass");
  });

  it("uses --passphrase-file with hex", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-key-test-"));
    const path = join(dir, "key.hex");
    const hex = randomBytes(32).toString("hex");
    writeFileSync(path, hex);
    try {
      const key = resolveSyncKey({ passphraseFile: path });
      expect(Buffer.isBuffer(key)).toBe(true);
      expect((key as Buffer).length).toBe(32);
      expect((key as Buffer).toString("hex")).toBe(hex);
    } finally {
      unlinkSync(path);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses --passphrase-file with raw 32 bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-key-test-"));
    const path = join(dir, "key.raw");
    const raw = randomBytes(32);
    writeFileSync(path, raw);
    try {
      const key = resolveSyncKey({ passphraseFile: path });
      expect(Buffer.isBuffer(key)).toBe(true);
      expect((key as Buffer).equals(raw)).toBe(true);
    } finally {
      unlinkSync(path);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers --passphrase-file over --passphrase", () => {
    const dir = mkdtempSync(join(tmpdir(), "sync-key-test-"));
    const path = join(dir, "key.hex");
    const hex = randomBytes(32).toString("hex");
    writeFileSync(path, hex);
    try {
      const key = resolveSyncKey({
        passphraseFile: path,
        passphrase: "ignored",
      });
      expect((key as Buffer).toString("hex")).toBe(hex);
    } finally {
      unlinkSync(path);
      rmSync(dir, { recursive: true, force: true });
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
    expect(() => resolveSyncKey({})).toThrow(/sync key required/);
  });
});

describe("contentHash", () => {
  it("is deterministic and content-sensitive", () => {
    expect(contentHash("a")).toBe(contentHash("a"));
    expect(contentHash("a")).not.toBe(contentHash("b"));
    expect(contentHash("a")).toHaveLength(64);
  });
});

describe("importRecords: two-database end-to-end", () => {
  async function seedSource(): Promise<{ memos: MemOS; dir: string }> {
    const { dir, dbPath } = tempDb("memos-sync-a-");
    const memos = new MemOS({ dbPath, embeddings: { enabled: false } });
    await memos.init();
    // Store via importRecord to control IDs/timestamps exactly
    await memos.importRecord(
      makeRecord({ id: "a1", content: "Alice likes TypeScript" }),
    );
    await memos.importRecord(
      makeRecord({
        id: "a2",
        content: "Deploy with pnpm deploy",
        type: "context",
        tags: ["deploy"],
        namespace: "project:beta",
        metadata: { priority: "high" },
        createdAt: 1727745600001,
        updatedAt: 1727745700001,
      }),
    );
    return { memos, dir };
  }

  async function exportRecords(memos: MemOS): Promise<SyncRecord[]> {
    const graph = await memos.getGraph();
    return (graph.nodes ?? []).map((n) => ({
      id: n.id,
      content: n.content,
      summary: n.summary,
      type: n.type,
      tags: n.tags ?? [],
      importance: n.importance ?? 0.5,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      namespace: n.namespace ?? "default",
      metadata: n.metadata ?? {},
      source: n.source,
      provenance: n.provenance,
      pool: n.pool,
      expiresAt: n.expiresAt ?? null,
      validFrom: n.validFrom ?? null,
      validTo: n.validTo ?? null,
      harness: n.harness,
    }));
  }

  it("preserves IDs, timestamps, type, tags, namespace, metadata", async () => {
    const src = await seedSource();
    const dst = tempDb("memos-sync-b-");
    const target = new MemOS({
      dbPath: dst.dbPath,
      embeddings: { enabled: false },
    });
    await target.init();
    try {
      const records = await exportRecords(src.memos);
      const bundle = createBundle(records, "pass");
      const decrypted = decryptBundle(bundle, "pass");
      const res = await importRecords(target, decrypted, "skip-existing");
      expect(res).toEqual({ imported: 2, skipped: 0, updated: 0, errors: [] });

      const n1 = await target.retrieve("a1");
      expect(n1).not.toBeNull();
      expect(n1!.content).toBe("Alice likes TypeScript");
      expect(n1!.createdAt).toBe(1727745600000);
      expect(n1!.updatedAt).toBe(1727745700000);
      expect(n1!.type).toBe("preference");
      expect(n1!.tags).toEqual(["ui", "settings"]);
      expect(n1!.namespace).toBe("project:alpha");
      expect(n1!.metadata).toMatchObject({ source: "chat" });

      const n2 = await target.retrieve("a2");
      expect(n2!.type).toBe("context");
      expect(n2!.tags).toEqual(["deploy"]);
      expect(n2!.namespace).toBe("project:beta");
    } finally {
      await src.memos.close();
      await target.close();
      rmSync(src.dir, { recursive: true, force: true });
      rmSync(dst.dir, { recursive: true, force: true });
    }
  });

  it("skip-existing: second import of the same bundle skips everything", async () => {
    const src = await seedSource();
    const dst = tempDb("memos-sync-b-");
    const target = new MemOS({
      dbPath: dst.dbPath,
      embeddings: { enabled: false },
    });
    await target.init();
    try {
      const bundle = createBundle(await exportRecords(src.memos), "pass");
      const decrypted = decryptBundle(bundle, "pass");
      const first = await importRecords(target, decrypted, "skip-existing");
      expect(first.imported).toBe(2);
      const second = await importRecords(target, decrypted, "skip-existing");
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.errors).toEqual([]);
      // Still exactly 2 nodes — no duplicates created
      const graph = await target.getGraph();
      expect(graph.nodes).toHaveLength(2);
    } finally {
      await src.memos.close();
      await target.close();
      rmSync(src.dir, { recursive: true, force: true });
      rmSync(dst.dir, { recursive: true, force: true });
    }
  });

  it("last-write-wins: newer incoming version replaces, ID and timestamps preserved", async () => {
    const src = await seedSource();
    const dst = tempDb("memos-sync-b-");
    const target = new MemOS({
      dbPath: dst.dbPath,
      embeddings: { enabled: false },
    });
    await target.init();
    try {
      const bundle = createBundle(await exportRecords(src.memos), "pass");
      await importRecords(
        target,
        decryptBundle(bundle, "pass"),
        "skip-existing",
      );

      // Incoming newer version of a1
      const newer = makeRecord({
        id: "a1",
        content: "Alice likes TypeScript and Rust",
        updatedAt: 1727745800000,
      });
      const res = await importRecords(target, [newer], "last-write-wins");
      expect(res).toEqual({ imported: 0, skipped: 0, updated: 1, errors: [] });

      const n1 = await target.retrieve("a1");
      expect(n1!.id).toBe("a1");
      expect(n1!.content).toBe("Alice likes TypeScript and Rust");
      expect(n1!.updatedAt).toBe(1727745800000);
      expect(n1!.createdAt).toBe(1727745600000);
    } finally {
      await src.memos.close();
      await target.close();
      rmSync(src.dir, { recursive: true, force: true });
      rmSync(dst.dir, { recursive: true, force: true });
    }
  });

  it("last-write-wins: older incoming version is skipped", async () => {
    const src = await seedSource();
    const dst = tempDb("memos-sync-b-");
    const target = new MemOS({
      dbPath: dst.dbPath,
      embeddings: { enabled: false },
    });
    await target.init();
    try {
      const bundle = createBundle(await exportRecords(src.memos), "pass");
      await importRecords(
        target,
        decryptBundle(bundle, "pass"),
        "skip-existing",
      );

      const older = makeRecord({
        id: "a1",
        content: "Stale version",
        updatedAt: 1000,
      });
      const res = await importRecords(target, [older], "last-write-wins");
      expect(res.updated).toBe(0);
      expect(res.skipped).toBe(1);
      const n1 = await target.retrieve("a1");
      expect(n1!.content).toBe("Alice likes TypeScript");
    } finally {
      await src.memos.close();
      await target.close();
      rmSync(src.dir, { recursive: true, force: true });
      rmSync(dst.dir, { recursive: true, force: true });
    }
  });

  it("last-write-wins: equal timestamps keep the local copy (deterministic tiebreak)", async () => {
    const src = await seedSource();
    const dst = tempDb("memos-sync-b-");
    const target = new MemOS({
      dbPath: dst.dbPath,
      embeddings: { enabled: false },
    });
    await target.init();
    try {
      const bundle = createBundle(await exportRecords(src.memos), "pass");
      await importRecords(
        target,
        decryptBundle(bundle, "pass"),
        "skip-existing",
      );

      const tied = makeRecord({
        id: "a1",
        content: "Tied version",
        updatedAt: 1727745700000, // same as local
      });
      const res = await importRecords(target, [tied], "last-write-wins");
      expect(res.updated).toBe(0);
      expect(res.skipped).toBe(1);
      const n1 = await target.retrieve("a1");
      expect(n1!.content).toBe("Alice likes TypeScript");
    } finally {
      await src.memos.close();
      await target.close();
      rmSync(src.dir, { recursive: true, force: true });
      rmSync(dst.dir, { recursive: true, force: true });
    }
  });

  it("content-hash dedup: identical content under a different ID is skipped", async () => {
    const src = await seedSource();
    const dst = tempDb("memos-sync-b-");
    const target = new MemOS({
      dbPath: dst.dbPath,
      embeddings: { enabled: false },
    });
    await target.init();
    try {
      const bundle = createBundle(await exportRecords(src.memos), "pass");
      await importRecords(
        target,
        decryptBundle(bundle, "pass"),
        "skip-existing",
      );

      const dupe = makeRecord({
        id: "brand-new-id",
        content: "Alice likes TypeScript", // same content as a1
      });
      const res = await importRecords(target, [dupe], "skip-existing");
      expect(res.imported).toBe(0);
      expect(res.skipped).toBe(1);
      const graph = await target.getGraph();
      expect(graph.nodes).toHaveLength(2);
    } finally {
      await src.memos.close();
      await target.close();
      rmSync(src.dir, { recursive: true, force: true });
      rmSync(dst.dir, { recursive: true, force: true });
    }
  });
});
