import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { MemoryNode } from "../src/types";

function makeNode(id: string, content: string): MemoryNode {
  return {
    id,
    content,
    summary: content,
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessed: 0,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  };
}

describe("sqlite-vec ANN index", () => {
  let dir: string;
  let storage: SQLiteStorage;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "memos-ann-"));
    storage = new SQLiteStorage(join(dir, "test.db"), true, {
      semanticScan: "ann",
    });
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads the extension and returns nearest neighbours", async () => {
    const status = storage.getVectorIndexStatus();
    expect(status.mode).toBe("ann");
    expect(status.error).toBeNull();
    expect(status.enabled).toBe(true);

    const a = makeNode("ann-a", "dark mode");
    const b = makeNode("ann-b", "light mode");
    const c = makeNode("ann-c", "deploy window");
    for (const node of [a, b, c]) await storage.saveNode(node);
    await storage.saveEmbedding(a.id, [1, 0, 0], "test-model", "");
    await storage.saveEmbedding(b.id, [0.8, 0.2, 0], "test-model", "");
    await storage.saveEmbedding(c.id, [0, 0, 1], "test-model", "");

    const hits = await storage.querySimilarEmbeddings(
      [1, 0, 0],
      {},
      2,
      0,
      "test-model",
      "",
    );
    expect(hits.map((hit) => hit.node.id)).toEqual([a.id, b.id]);
  });

  test("node deletion removes the ANN row", async () => {
    const a = makeNode("ann-delete-a", "dark mode");
    const b = makeNode("ann-delete-b", "light mode");
    await storage.saveNode(a);
    await storage.saveNode(b);
    await storage.saveEmbedding(a.id, [1, 0, 0], "test-model", "");
    await storage.saveEmbedding(b.id, [0, 1, 0], "test-model", "");

    await storage.deleteNode(a.id);
    const hits = await storage.querySimilarEmbeddings(
      [1, 0, 0],
      {},
      5,
      0,
      "test-model",
      "",
    );
    expect(hits.map((hit) => hit.node.id)).toEqual([b.id]);
  });
});
