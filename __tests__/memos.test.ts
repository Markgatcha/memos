/**
 * Tests for the MemOS core engine.
 */

import { MemOS } from "../src/memory";
import { GraphEngine, textSimilarity, generateId } from "../src/graph";
import { getMcpTools } from "../src/mcp";
import { MemoryNode } from "../src/types";

// Use in-memory SQLite for tests
const TEST_DB = ":memory:";

describe("GraphEngine", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = new GraphEngine();
  });

  test("add and retrieve nodes", () => {
    const node: MemoryNode = createNode("Test memory");

    engine.addNode(node);
    expect(engine.size).toBe(1);
    expect(engine.getNode(node.id)).toEqual(node);
  });

  test("remove node removes connected edges", () => {
    const node1: MemoryNode = createNode("Node 1");
    const node2: MemoryNode = createNode("Node 2");
    engine.addNode(node1);
    engine.addNode(node2);

    const edge = engine.addEdge({ sourceId: node1.id, targetId: node2.id });
    expect(engine.getAllEdges()).toHaveLength(1);

    engine.removeNode(node1.id);
    expect(engine.getAllEdges()).toHaveLength(0);
    expect(engine.size).toBe(1);
  });

  test("auto-link creates edges for similar content", () => {
    const node1: MemoryNode = createNode(
      "User prefers dark mode in applications",
    );
    const node2: MemoryNode = createNode("User likes dark mode themes");
    const node3: MemoryNode = createNode("The weather is sunny today");

    engine.addNode(node1);
    engine.addNode(node2);
    engine.addNode(node3);

    const links = engine.autoLink(node3, 0.2);
    // node3 should have low similarity with node1 and node2
    expect(links.length).toBeLessThanOrEqual(2);
  });

  test("find clusters groups connected nodes", () => {
    const n1 = createNode("Node A");
    const n2 = createNode("Node B");
    const n3 = createNode("Node C");
    const n4 = createNode("Node D");

    engine.addNode(n1);
    engine.addNode(n2);
    engine.addNode(n3);
    engine.addNode(n4);

    engine.addEdge({ sourceId: n1.id, targetId: n2.id });
    engine.addEdge({ sourceId: n2.id, targetId: n3.id });

    const clusters = engine.findClusters(2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });
});

describe("textSimilarity", () => {
  test("identical texts have similarity 1", () => {
    const sim = textSimilarity("hello world", "hello world");
    expect(sim).toBe(1);
  });

  test("completely different texts have low similarity", () => {
    const sim = textSimilarity(
      "dark mode preference",
      "sunny weather forecast",
    );
    expect(sim).toBeLessThan(0.3);
  });

  test("similar texts have higher similarity", () => {
    const sim = textSimilarity(
      "user prefers dark mode",
      "user likes dark mode themes",
    );
    expect(sim).toBeGreaterThan(0.3);
  });

  test("empty strings return 0", () => {
    expect(textSimilarity("", "hello")).toBe(0);
    expect(textSimilarity("hello", "")).toBe(0);
  });
});

describe("generateId", () => {
  test("generates valid UUID v4", () => {
    const id = generateId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("MemOS MCP adapter", () => {
  test("exposes the core memory tools", () => {
    const toolNames = getMcpTools().map((tool) => tool.name);

    expect(toolNames).toEqual([
      "memos_store",
      "memos_search",
      "memos_retrieve",
      "memos_forget",
      "memos_graph",
      "memos_context",
    ]);
  });
});

describe("MemOS", () => {
  let memos: MemOS;

  beforeEach(async () => {
    memos = new MemOS({ dbPath: TEST_DB });
    await memos.init();
  });

  afterEach(async () => {
    await memos.close();
  });

  test("store and retrieve", async () => {
    const { node } = await memos.store("Test memory content");
    expect(node.id).toBeDefined();
    expect(node.content).toBe("Test memory content");
    expect(node.tags).toEqual([]);
    expect(node.expiresAt).toBeNull();
    expect(node.namespace).toBe("default");

    const retrieved = await memos.retrieve(node.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Test memory content");
  });

  test("store with tags", async () => {
    const { node } = await memos.store("Tagged memory", {
      tags: ["work", "important"],
    });
    expect(node.tags).toEqual(["work", "important"]);

    const retrieved = await memos.retrieve(node.id);
    expect(retrieved!.tags).toEqual(["work", "important"]);
  });

  test("store with TTL", async () => {
    const { node } = await memos.store("Expiring memory", { ttl: 3600 });
    expect(node.expiresAt).not.toBeNull();
    expect(node.expiresAt!).toBeGreaterThan(Date.now() / 1000);
  });

  test("setTTL and clearTTL", async () => {
    const { node } = await memos.store("Memory");
    expect(node.expiresAt).toBeNull();

    await memos.setTTL(node.id, 3600);
    const afterSet = await memos.retrieve(node.id);
    expect(afterSet!.expiresAt).not.toBeNull();

    await memos.clearTTL(node.id);
    const afterClear = await memos.retrieve(node.id);
    expect(afterClear!.expiresAt).toBeNull();
  });

  test("tag and untag", async () => {
    const { node } = await memos.store("Memory");

    await memos.tag(node.id, ["work", "urgent"]);
    const tagged = await memos.retrieve(node.id);
    expect(tagged!.tags).toContain("work");
    expect(tagged!.tags).toContain("urgent");

    await memos.untag(node.id, ["urgent"]);
    const untagged = await memos.retrieve(node.id);
    expect(untagged!.tags).toContain("work");
    expect(untagged!.tags).not.toContain("urgent");
  });

  test("listByTag", async () => {
    await memos.store("Memory 1", { tags: ["work"] });
    await memos.store("Memory 2", { tags: ["work", "important"] });
    await memos.store("Memory 3", { tags: ["personal"] });

    const workMemories = await memos.listByTag("work");
    expect(workMemories).toHaveLength(2);
  });

  test("search with tags filter", async () => {
    await memos.store("Dark mode preference", { tags: ["ui", "preference"] });
    await memos.store("Dark mode theme config", { tags: ["config"] });
    await memos.store("Light mode preference", { tags: ["ui", "preference"] });

    const uiResults = await memos.search({ query: "dark mode", tags: ["ui"] });
    expect(uiResults).toHaveLength(1);
    expect(uiResults[0].node.tags).toContain("ui");
  });

  test("export as json", async () => {
    await memos.store("Memory 1", { tags: ["work"] });
    await memos.store("Memory 2");

    const result = await memos.export({ format: "json" });
    expect(result.format).toBe("json");
    expect(result.count).toBe(2);
    const parsed = JSON.parse(result.data);
    expect(parsed).toHaveLength(2);
  });

  test("export with tag filter", async () => {
    await memos.store("Memory 1", { tags: ["work"] });
    await memos.store("Memory 2", { tags: ["personal"] });

    const result = await memos.export({ format: "json", tag: "work" });
    expect(result.count).toBe(1);
  });

  test("search returns results", async () => {
    await memos.store("User prefers dark mode");
    await memos.store("Project uses TypeScript");
    await memos.store("Dark mode is enabled");

    const results = await memos.search("dark mode");
    expect(results.length).toBeGreaterThan(0);
  });

  test("forget removes memory", async () => {
    const { node } = await memos.store("Temporary memory");
    const deleted = await memos.forget(node.id);
    expect(deleted).toBe(true);

    const retrieved = await memos.retrieve(node.id);
    expect(retrieved).toBeNull();
  });

  test("summarize returns a summary", async () => {
    await memos.store("Memory one content here");
    await memos.store("Memory two content here");

    const summary = await memos.summarize();
    expect(summary).toBeDefined();
    expect(summary.length).toBeGreaterThan(0);
  });

  test("link creates edge between nodes", async () => {
    const { node: n1 } = await memos.store("Node A");
    const { node: n2 } = await memos.store("Node B");

    const edge = await memos.link(n1.id, n2.id, "relates_to", 0.8);
    expect(edge.sourceId).toBe(n1.id);
    expect(edge.targetId).toBe(n2.id);
    expect(edge.weight).toBe(0.8);
  });

  test("count returns number of memories", async () => {
    expect(memos.count).toBe(0);
    await memos.store("Memory 1");
    expect(memos.count).toBe(1);
    await memos.store("Memory 2");
    expect(memos.count).toBe(2);
  });

  test("clear removes all memories", async () => {
    await memos.store("Memory 1");
    await memos.store("Memory 2");
    expect(memos.count).toBe(2);

    await memos.clear();
    expect(memos.count).toBe(0);
  });

  test("events fire correctly", async () => {
    const created: unknown[] = [];
    memos.on("node:created", (data) => created.push(data));

    await memos.store("Event test");
    expect(created).toHaveLength(1);
  });
});

describe("MemOS Experimental", () => {
  test("semantic search requires experimental flag", async () => {
    const memos = new MemOS({ dbPath: TEST_DB });
    await memos.init();
    await memos.store("Test");

    await expect(memos.semanticSearch("test")).rejects.toThrow(
      "Semantic search is experimental",
    );
    await memos.close();
  });

  test("semantic search works when enabled", async () => {
    const memos = new MemOS({
      dbPath: TEST_DB,
      experimental: { semanticSearch: true },
    });
    await memos.init();
    await memos.store("User prefers dark mode");
    await memos.store("Project uses TypeScript");
    await memos.store("Dark mode settings configuration");

    const results = await memos.semanticSearch("dark mode", 10, 0.1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    await memos.close();
  });

  test("graphViz requires experimental flag", async () => {
    const memos = new MemOS({ dbPath: TEST_DB });
    await memos.init();

    await expect(memos.graphViz()).rejects.toThrow(
      "Graph visualization is experimental",
    );
    await memos.close();
  });

  test("graphViz produces DOT output", async () => {
    const memos = new MemOS({
      dbPath: TEST_DB,
      experimental: { graphViz: true },
    });
    await memos.init();
    const { node: n1 } = await memos.store("Node A");
    const { node: n2 } = await memos.store("Node B");
    await memos.link(n1.id, n2.id);

    const dot = await memos.graphViz();
    expect(dot).toContain("digraph MemOS");
    expect(dot).toContain("->");
    await memos.close();
  });

  test("namespaces require experimental flag", async () => {
    const memos = new MemOS({ dbPath: TEST_DB });
    await memos.init();

    await expect(memos.listNamespaces()).rejects.toThrow(
      "Namespaces are experimental",
    );
    await memos.close();
  });

  test("namespaces work when enabled", async () => {
    const memos = new MemOS({
      dbPath: TEST_DB,
      experimental: { namespaces: true },
    });
    await memos.init();
    await memos.store("Default namespace", { namespace: "default" });
    await memos.store("Work namespace", { namespace: "work" });

    const namespaces = await memos.listNamespaces();
    expect(namespaces).toContain("default");
    expect(namespaces).toContain("work");

    const count = await memos.namespaceCount("work");
    expect(count).toBe(1);
    await memos.close();
  });

  test("context injection requires experimental flag", async () => {
    const memos = new MemOS({ dbPath: TEST_DB });
    await memos.init();
    const { node } = await memos.store("Test");

    await expect(memos.injectContext(node.id)).rejects.toThrow(
      "Context injection is experimental",
    );
    await memos.close();
  });

  test("context injection returns context string", async () => {
    const memos = new MemOS({
      dbPath: TEST_DB,
      experimental: { contextInjection: true },
    });
    await memos.init();
    const { node: n1 } = await memos.store("User prefers dark mode");
    const { node: n2 } = await memos.store("Dark mode configuration");
    await memos.link(n1.id, n2.id);

    const context = await memos.injectContext(n1.id, 1, 2000);
    expect(context).toContain("User prefers dark mode");
    expect(context).toContain("Related memory");
    await memos.close();
  });
});

// Helper
function createNode(content: string): MemoryNode {
  return {
    id: generateId(),
    content,
    summary: content.slice(0, 50),
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessCount: 0,
    lastAccessed: Date.now(),
    tags: [],
    expiresAt: null,
    namespace: "default",
  };
}
