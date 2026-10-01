/**
 * Tests for scoped memory spaces (innovation round 3):
 *   - scoped reads union the shared `default` namespace with the
 *     requested scope(s) (company-brain container semantics)
 *   - multi-namespace (`namespaces`) reads
 *   - `includeSharedScope: false` opt-out (legacy exclusive behavior)
 *   - unscoped searches are untouched by the union machinery
 *     (accuracy gate: no recall loss for default-scope searches)
 *   - `listNamespaceCounts` inventory
 *   - free-form `project:` / `harness:` scope conventions
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

/**
 * Deterministic stub embedder: avoids the ONNX runtime (unavailable in
 * this environment) while keeping the hybrid search path exercised.
 */
class StubEmbedder implements EmbeddingProvider {
  public readonly id = "stub";
  public readonly model = "stub-v1";
  public readonly dimensions = 4;
  async embed(_text: string): Promise<EmbeddingVector> {
    return [0, 0, 0, 0];
  }
}

async function makeMemos() {
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    embeddings: { enabled: true, provider: new StubEmbedder() },
    embeddingQueue: { synchronous: true },
  });
  await memos.init();
  return memos;
}

async function seed(memos: MemOS) {
  await memos.store("The company budget process is annual", {
    type: "fact",
  });
  await memos.store("Project alpha budget approved for Q4", {
    namespace: "project:alpha",
    type: "fact",
  });
  await memos.store("Project beta budget frozen pending review", {
    namespace: "project:beta",
    type: "fact",
  });
  await memos.store("Alice budget forecast for the team", {
    scope: { user: "alice" },
    type: "fact",
  });
  await memos.store("Bob budget forecast for the team", {
    scope: { user: "bob" },
    type: "fact",
  });
}

describe("scoped spaces", () => {
  test("namespace-filtered search unions default + requested namespace", async () => {
    const memos = await makeMemos();
    await seed(memos);

    const results = await memos.search({
      query: "budget",
      namespaces: ["project:alpha"],
    });
    const namespaces = results.map((r) => r.node.namespace);
    expect(namespaces).toContain("default");
    expect(namespaces).toContain("project:alpha");
    expect(namespaces).not.toContain("project:beta");
  });

  test("typed scope search unions default with the scope hierarchy", async () => {
    const memos = await makeMemos();
    await seed(memos);

    const results = await memos.search({
      query: "budget",
      scope: { user: "alice" },
    });
    const namespaces = results.map((r) => r.node.namespace);
    expect(namespaces).toContain("default");
    expect(namespaces).toContain("u:alice");
    expect(namespaces.some((ns) => ns.startsWith("u:bob"))).toBe(false);
    expect(namespaces).not.toContain("project:alpha");
  });

  test("multi-namespace read spans several scopes plus default", async () => {
    const memos = await makeMemos();
    await seed(memos);

    const results = await memos.search({
      query: "budget",
      namespaces: ["project:alpha", "project:beta"],
    });
    const namespaces = results.map((r) => r.node.namespace);
    expect(namespaces).toContain("default");
    expect(namespaces).toContain("project:alpha");
    expect(namespaces).toContain("project:beta");
    expect(namespaces.some((ns) => ns.startsWith("u:"))).toBe(false);
  });

  test("includeSharedScope: false restores exclusive scope filtering", async () => {
    const memos = await makeMemos();
    await seed(memos);

    const results = await memos.search({
      query: "budget",
      namespaces: ["project:alpha"],
      includeSharedScope: false,
    });
    const namespaces = results.map((r) => r.node.namespace);
    expect(namespaces).toContain("project:alpha");
    expect(namespaces).not.toContain("default");
    expect(namespaces).not.toContain("project:beta");
  });

  test("unscoped searches are identical with/without the union flag", async () => {
    const memos = await makeMemos();
    await seed(memos);

    // Accuracy gate: the union machinery must not change default
    // (unscoped) search results at all.
    const plain = await memos.search({ query: "budget" });
    const withFlag = await memos.search({
      query: "budget",
      includeSharedScope: true,
    });
    const withoutFlag = await memos.search({
      query: "budget",
      includeSharedScope: false,
    });
    const ids = (rs: { node: { id: string } }[]) =>
      rs.map((r) => r.node.id).sort();
    expect(ids(withFlag)).toEqual(ids(plain));
    expect(ids(withoutFlag)).toEqual(ids(plain));
  });

  test("exact namespace search unions default too", async () => {
    const memos = await makeMemos();
    await seed(memos);

    const results = await memos.search({
      query: "budget",
      namespace: "project:beta",
    });
    const namespaces = results.map((r) => r.node.namespace);
    expect(namespaces).toContain("default");
    expect(namespaces).toContain("project:beta");
    expect(namespaces).not.toContain("project:alpha");
  });

  test("listNamespaceCounts inventories scopes with live counts", async () => {
    const memos = await makeMemos();
    await seed(memos);

    const counts = await memos.listNamespaceCounts();
    const byNs = new Map(counts.map((c) => [c.namespace, c.count]));
    expect(byNs.get("default")).toBe(1);
    expect(byNs.get("project:alpha")).toBe(1);
    expect(byNs.get("project:beta")).toBe(1);
    expect(byNs.get("u:alice")).toBe(1);
    expect(byNs.get("u:bob")).toBe(1);
  });

  test("plain writes still land in the default namespace (backfill)", async () => {
    const memos = await makeMemos();
    const { node } = await memos.store("plain fact", { type: "fact" });
    expect(node.namespace).toBe("default");

    // Pre-scope rows read back as `default` via the column default.
    const counts = await memos.listNamespaceCounts();
    expect(counts.some((c) => c.namespace === "default")).toBe(true);
  });

  test("harness:<name> free-form scope round-trips", async () => {
    const memos = await makeMemos();
    await memos.store("Harness-specific budget note", {
      namespace: "harness:cline",
      type: "fact",
    });
    await memos.store("Shared budget note", { type: "fact" });

    const results = await memos.search({
      query: "budget",
      namespaces: ["harness:cline"],
    });
    const namespaces = results.map((r) => r.node.namespace);
    expect(namespaces).toContain("harness:cline");
    expect(namespaces).toContain("default");
  });
});
