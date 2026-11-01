import {
  cosineSimilarity,
  createEmbeddingProvider,
  Model2VecEmbeddingProvider,
} from "../src/embeddings";

describe("zero-dependency default embeddings (Model2Vec)", () => {
  test("the default provider is model2vec, not the hash fallback", () => {
    const provider = createEmbeddingProvider(undefined);
    expect(provider.id).toBe("model2vec");
    expect(provider.model).toBe("potion-base-8M");
    expect(provider.dimensions).toBe(256);
  });

  test("produces normalized 256-d vectors and separates topics", async () => {
    const provider = new Model2VecEmbeddingProvider();
    const [dark, light, deploy] = await provider.batchEmbed([
      "the user prefers dark mode",
      "the user likes light themes",
      "the deploy window is Friday",
    ]);
    expect(dark).toHaveLength(256);
    expect(Math.hypot(...dark)).toBeCloseTo(1, 4);
    expect(cosineSimilarity(dark, light)).toBeGreaterThan(
      cosineSimilarity(dark, deploy),
    );
  });

  test("single and batch paths agree", async () => {
    const provider = new Model2VecEmbeddingProvider();
    const single = await provider.embed("a durable fact");
    const [batched] = await provider.batchEmbed(["a durable fact"]);
    expect(batched).toEqual(single);
  });
});
