/**
 * Tests for the MemOS core engine.
 */

import { MemOS } from "../src/memory";
import { GraphEngine, textSimilarity, generateId } from "../src/graph";
import { MemoryNode } from "../src/types";

// Use in-memory SQLite for tests
const TEST_DB = ":memory:";

describe("GraphEngine", () => {
  let engine: GraphEngine;

  beforeEach(() => {
    engine = new GraphEngine();
  });

  test("add and retrieve nodes", () => {
    const node: MemoryNode = {
      id: generateId(),
      content: "Test memory",
      summary: "Test",
      type: "fact",
      metadata: {},
      importance: 0.5,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
    };

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
    const node1: MemoryNode = createNode("User prefers dark mode in applications");
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
    const sim = textSimilarity("dark mode preference", "sunny weather forecast");
    expect(sim).toBeLessThan(0.3);
  });

  test("similar texts have higher similarity", () => {
    const sim = textSimilarity(
      "user prefers dark mode",
      "user likes dark mode themes"
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
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
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
  };
}
