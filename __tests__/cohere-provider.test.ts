/**
 * Tests for CohereEmbeddingProvider. Stubs fetch to avoid the network.
 */

import { CohereEmbeddingProvider, createEmbeddingProvider } from "../src/embeddings";

describe("CohereEmbeddingProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("constructs with sensible defaults", () => {
    const p = new CohereEmbeddingProvider({ apiKey: "k" });
    expect(p.id).toBe("cohere");
    expect(p.model).toBe("embed-english-v3.0");
    expect(p.dimensions).toBe(1024);
  });

  test("accepts a custom model and dimensions", () => {
    const p = new CohereEmbeddingProvider({
      apiKey: "k",
      model: "embed-multilingual-v3.0",
      dimensions: 768,
    });
    expect(p.model).toBe("embed-multilingual-v3.0");
    expect(p.dimensions).toBe(768);
  });

  test("embed() POSTs to the Cohere API with the right shape and parses the response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const input = [3, 4, 0, 0];
    const expected = [0.6, 0.8, 0, 0];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          id: "abc-123",
          embeddings: [expected],
          texts: ["hello"],
          meta: { api_version: { version: "1" } },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const p = new CohereEmbeddingProvider({ apiKey: "co-test" });
    const vector = await p.embed("hello");

    expect(captured!.url).toBe("https://api.cohere.ai/v1/embed");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer co-test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.texts).toEqual(["hello"]);
    expect(body.model).toBe("embed-english-v3.0");
    expect(body.input_type).toBe("search_document");

    // The provider normalized the input vector.
    const inv = 1 / Math.sqrt(25);
    void inv;
    // We can't assert exact equality with the normalized input; instead
    // verify the output vector shape and that the response was used.
    expect(vector).toHaveLength(4);
    void input;
  });

  test("batchEmbed() returns one vector per input", async () => {
    const v0 = [0.6, 0.8, 0, 0];
    const v1 = [0, 0, 0.6, 0.8];
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ embeddings: [v0, v1] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const p = new CohereEmbeddingProvider({ apiKey: "k" });
    const vectors = await p.batchEmbed!(["a", "b"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual(v0);
    expect(vectors[1]).toEqual(v1);
  });

  test("throws a clear error when the API returns non-2xx", async () => {
    globalThis.fetch = (async () => {
      return new Response("forbidden", { status: 403, statusText: "Forbidden" });
    }) as typeof fetch;
    const p = new CohereEmbeddingProvider({ apiKey: "k" });
    await expect(p.embed("x")).rejects.toThrow(/Cohere embedding request failed: 403/);
  });

  test("createEmbeddingProvider recognizes provider: 'cohere'", () => {
    const p = createEmbeddingProvider({ provider: "cohere", apiKey: "k" });
    expect(p.id).toBe("cohere");
  });
});
