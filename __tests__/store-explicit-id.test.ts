/**
 * `store({ id })` — explicit node identity for deterministic imports and
 * benchmarks. Random UUIDs made exact retrieval-score ties rank differently
 * on every run because MemOS breaks ties by node id.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemOS } from "../src/memory";

describe("store with an explicit id", () => {
  let dir: string;
  let memos: MemOS;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memos-explicit-id-"));
    memos = new MemOS({
      dbPath: join(dir, "memos.db"),
      embeddings: { enabled: false },
    });
    await memos.init();
  });

  afterEach(async () => {
    await memos.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  test("uses the supplied id", async () => {
    const { node } = await memos.store("deterministic memory", {
      id: "locomo_c0_D1_3",
    });
    expect(node.id).toBe("locomo_c0_D1_3");
    expect((await memos.retrieve("locomo_c0_D1_3"))?.id).toBe("locomo_c0_D1_3");
  });

  test("duplicate explicit ids are rejected by storage", async () => {
    await memos.store("first", { id: "dup" });
    await expect(memos.store("second", { id: "dup" })).rejects.toThrow();
  });

  test("omitting id still generates a UUID", async () => {
    const { node } = await memos.store("random id");
    expect(node.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
