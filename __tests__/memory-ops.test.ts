/**
 * Tests for the memory-operations wave:
 *   - multi-scope memory (always-on namespaces + hierarchical scope)
 *   - encryption at rest (cipher driver, wrong-key rejection)
 *   - version timeline (`memos.history`)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { composeScope, parseScopeArg } from "../src/scope";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

/**
 * The cipher driver is an OPTIONAL dependency. When it cannot be loaded
 * (install scripts blocked, platform without prebuilds), the encryption
 * tests skip instead of failing CI — the feature itself already reports
 * a clear "install it with" error at runtime.
 */
let cipherDriverAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("better-sqlite3-multiple-ciphers");
} catch {
  cipherDriverAvailable = false;
}
const maybeDescribe = cipherDriverAvailable ? describe : describe.skip;

class VectorProvider implements EmbeddingProvider {
  public readonly id = "vector";
  public readonly model = "vector-v1";
  public readonly dimensions = 4;
  public readonly vectors = new Map<string, EmbeddingVector>();

  constructor(seed: Record<string, EmbeddingVector> = {}) {
    for (const [k, v] of Object.entries(seed)) this.vectors.set(k, v);
  }

  async embed(text: string): Promise<EmbeddingVector> {
    if (this.vectors.has(text)) return this.vectors.get(text)!;
    for (const [key, vec] of this.vectors) {
      if (text.includes(key)) return vec;
    }
    return [0, 0, 0, 0];
  }
}

const ORTHO = {
  a: [1, 0, 0, 0] as EmbeddingVector,
  b: [0, 1, 0, 0] as EmbeddingVector,
};

async function makeMemos(extra: Record<string, unknown> = {}) {
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { semanticSearch: true },
    embeddings: { enabled: true, provider: new VectorProvider(ORTHO) },
    embeddingQueue: { synchronous: true },
    ...extra,
  });
  await memos.init();
  return memos;
}

// ---------------------------------------------------------------------------
// Scope composition
// ---------------------------------------------------------------------------

describe("composeScope / parseScopeArg", () => {
  test("composes in fixed order user → agent → run", () => {
    expect(composeScope({ run: "r1", user: "alice", agent: "coder" })).toBe(
      "u:alice/a:coder/r:r1",
    );
    expect(composeScope({ agent: "coder" })).toBe("a:coder");
  });

  test("parseScopeArg accepts long and short forms", () => {
    expect(parseScopeArg("user:alice,agent:coder")).toEqual({
      user: "alice",
      agent: "coder",
    });
    expect(parseScopeArg("u:alice/a:coder/r:r1")).toEqual({
      user: "alice",
      agent: "coder",
      run: "r1",
    });
  });
});

describe("multi-scope memory", () => {
  test("scope composes the namespace at write time", async () => {
    const memos = await makeMemos();
    const { node } = await memos.store("Kafka lag playbook", {
      scope: { user: "alice", agent: "coder" },
    });
    expect(node.namespace).toBe("u:alice/a:coder");
  });

  test("hierarchical scope: user query sees agent and run memories", async () => {
    const memos = await makeMemos();
    await memos.store("alice top-level fact", { scope: { user: "alice" } });
    await memos.store("alice coder fact", {
      scope: { user: "alice", agent: "coder" },
    });
    await memos.store("bob private fact", { scope: { user: "bob" } });

    const aliceView = await memos.search({
      query: "fact",
      scope: { user: "alice" },
    });
    const namespaces = aliceView.map((r) => r.node.namespace);
    expect(namespaces).toContain("u:alice");
    expect(namespaces).toContain("u:alice/a:coder");
    expect(namespaces.some((ns) => ns.startsWith("u:bob"))).toBe(false);
  });

  test("exact scope match requires the identical namespace", async () => {
    const memos = await makeMemos();
    await memos.store("alice coder fact", {
      scope: { user: "alice", agent: "coder" },
    });

    const exact = await memos.search({
      query: "fact",
      scope: { user: "alice", agent: "coder" },
      scopeMatch: "exact",
    });
    expect(exact.length).toBe(1);

    const tooNarrow = await memos.search({
      query: "fact",
      scope: { user: "alice", run: "r1" },
      scopeMatch: "exact",
    });
    expect(tooNarrow.length).toBe(0);
  });

  test("plain writes stay in the default namespace (backward compat)", async () => {
    const memos = await makeMemos();
    const { node } = await memos.store("plain fact");
    expect(node.namespace).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

maybeDescribe("encryption at rest", () => {
  test("encrypted store round-trips with the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-cipher-"));
    const dbPath = join(dir, "encrypted.db");
    const memos = new MemOS({
      dbPath,
      cipherKey: "correct-horse-battery",
      embeddings: { enabled: true, provider: new VectorProvider(ORTHO) },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();
    await memos.store("secret: the prod database password is hunter2");
    await memos.close();

    // Raw file must not contain plaintext.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(dbPath).toString("latin1");
    expect(raw.includes("hunter2")).toBe(false);

    // Reopen with the correct key.
    const reopened = new MemOS({
      dbPath,
      cipherKey: "correct-horse-battery",
    });
    await reopened.init();
    const found = await reopened.search({ query: "database password" });
    expect(found.length).toBe(1);
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("wrong key fails with a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-cipher-"));
    const dbPath = join(dir, "encrypted.db");
    const memos = new MemOS({ dbPath, cipherKey: "right-key" });
    await memos.init();
    await memos.store("some fact");
    await memos.close();

    // Fail-fast: a wrongly-keyed database is rejected at open time
    // (the first pragma on a mismatched key raises SQLITE_NOTADB).
    const wrong = new MemOS({ dbPath, cipherKey: "wrong-key" });
    await expect(wrong.init()).rejects.toThrow();
    // init failed mid-open, so the underlying handle is still live —
    // close it (best effort) before removing the temp dir on Windows.
    await wrong.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Version timeline
// ---------------------------------------------------------------------------

describe("memos.history", () => {
  test("links superseded versions in both directions", async () => {
    // Both versions map to the same vector so the similarity threshold
    // treats them as related versions.
    const provider = new VectorProvider({
      "Kafka consumer lag alarm": ORTHO.a,
      "Kafka consumer lag alarm resolved with more partitions": ORTHO.a,
    });
    const memos = await makeMemos({ embeddings: { enabled: true, provider } });

    const v1 = await memos.store("Kafka consumer lag alarm");
    // v1 becomes historical; v2 is the live replacement.
    await memos.setValidity(v1.node.id, null, Date.now());
    const v2 = await memos.store(
      "Kafka consumer lag alarm resolved with more partitions",
    );
    await memos.flushEmbeddings();

    const v2History = await memos.history(v2.node.id);
    expect(v2History.supersedes.map((r) => r.node.id)).toContain(v1.node.id);

    const v1History = await memos.history(v1.node.id);
    expect(v1History.supersededBy.map((r) => r.node.id)).toContain(v2.node.id);
  });

  test("throws for unknown ids", async () => {
    const memos = await makeMemos();
    await expect(memos.history("mem_nope")).rejects.toThrow(/not found/);
  });
});
