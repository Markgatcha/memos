import { MemOS } from "../src/memory";
import type { EmbeddingProvider } from "../src/types";

function fakeProvider(): EmbeddingProvider {
  return {
    id: "fake-embedder",
    model: "fake-embedder-v1",
    dimensions: 3,
    async embed() {
      return [1, 0, 0];
    },
    async batchEmbed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
  };
}

describe("embedding health", () => {
  test("reports disabled when embeddings are off", async () => {
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: false },
    });
    await memos.init();
    try {
      const health = memos.getEmbeddingHealth();
      expect(health.status).toBe("disabled");
      expect(health.enabled).toBe(false);
      expect(health.fix).toContain("embeddings.enabled");

      const diagnostics = await memos.diagnostics();
      expect(diagnostics.embeddingHealth.status).toBe("disabled");
      expect(diagnostics.embeddingRuntime).toBeNull();

      const report = await memos.health();
      expect(report.embeddingHealth.status).toBe("disabled");
      expect(
        report.findings.some((f) => f.id === "semantic-search-disabled"),
      ).toBe(true);
    } finally {
      await memos.close();
    }
  });

  test("flags the local-hash baseline as degraded", async () => {
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { provider: "local-hash" },
    });
    await memos.init();
    try {
      const health = memos.getEmbeddingHealth();
      expect(health.status).toBe("degraded");
      expect(health.provider).toBe("local-hash");
      expect(health.fix).toContain("nomic-embed-text");

      const report = await memos.health();
      const finding = report.findings.find(
        (f) => f.id === "semantic-search-degraded",
      );
      expect(finding?.severity).toBe("critical");
    } finally {
      await memos.close();
    }
  });

  test("reports ok for a real provider and carries it through diagnostics", async () => {
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { provider: fakeProvider() },
    });
    await memos.init();
    try {
      await memos.store("The deploy window is Friday at 14:00 UTC.");
      const health = memos.getEmbeddingHealth();
      expect(health.status).toBe("ok");
      expect(health.provider).toBe("fake-embedder");
      expect(health.model).toBe("fake-embedder-v1");
      expect(health.dimensions).toBe(3);

      const diagnostics = await memos.diagnostics();
      expect(diagnostics.embeddingHealth.status).toBe("ok");
      expect(diagnostics.embeddingRuntime?.resolvedProvider).toBe(
        "fake-embedder",
      );

      const report = await memos.health();
      expect(report.embeddingHealth.status).toBe("ok");
      expect(
        report.findings.some((f) => f.id === "semantic-search-degraded"),
      ).toBe(false);
    } finally {
      await memos.close();
    }
  });
});
