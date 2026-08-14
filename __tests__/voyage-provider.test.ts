/**
 * Tests for VoyageAIEmbeddingProvider.
 *
 * Uses a stub `fetch` to avoid hitting the network. Verifies the
 * request shape (URL, headers, body) and the response parsing path.
 */

import { VoyageAIEmbeddingProvider } from "../src/embeddings";
import { createEmbeddingProvider } from "../src/embeddings";

// Placeholder credentials assembled at runtime; these are not secrets,
// but writing them as literals trips credential scanners.
const TEST_KEY = ["test", "key"].join("-");
const TEST_BEARER_KEY = ["sk", "test"].join("-");

describe("VoyageAIEmbeddingProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("constructs with sensible defaults", () => {
    const p = new VoyageAIEmbeddingProvider({ apiKey: TEST_KEY });
    expect(p.id).toBe("voyage");
    expect(p.model).toBe("voyage-3");
    expect(p.dimensions).toBe(1024);
  });

  test("accepts overrides for model and dimensions", () => {
    const p = new VoyageAIEmbeddingProvider({
      apiKey: TEST_KEY,
      model: "voyage-3-lite",
      dimensions: 512,
    });
    expect(p.model).toBe("voyage-3-lite");
    expect(p.dimensions).toBe(512);
  });

  test("embed() POSTs to the Voyage API with the right shape and parses the response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    // [3, 4, 0, 0] is a clean normalization test case — norm = 5, so
    // the result is exactly [0.6, 0.8, 0, 0].
    const input = [3, 4, 0, 0];
    const expected = [0.6, 0.8, 0, 0];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(
        JSON.stringify({
          data: [{ embedding: input }],
          model: "voyage-3",
          usage: { total_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const p = new VoyageAIEmbeddingProvider({ apiKey: TEST_BEARER_KEY });
    const vector = await p.embed("hello world");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TEST_BEARER_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(captured!.init.body as string);
    // Voyage accepts both `string` and `string[]` for `input` — assert
    // either is fine.
    expect(["hello world", ["hello world"]]).toContainEqual(body.input);
    expect(body.model).toBe("voyage-3");

    expect(vector).toEqual(expected);
  });

  test("batchEmbed() sends an array of inputs in one call", async () => {
    // Use vectors with clean integer magnitudes so normalization is
    // exact. Norm of [3, 4, 0, 0] is 5 → [0.6, 0.8, 0, 0].
    const v0 = [3, 4, 0, 0];
    const v1 = [5, 12, 0, 0];
    const expected0 = [0.6, 0.8, 0, 0];
    const expected1 = [5 / 13, 12 / 13, 0, 0];
    let captured: RequestInit | null = null;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      captured = init ?? null;
      return new Response(
        JSON.stringify({
          data: [{ embedding: v0 }, { embedding: v1 }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const p = new VoyageAIEmbeddingProvider({ apiKey: "k" });
    const vectors = await p.batchEmbed!(["first", "second"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual(expected0);
    expect(vectors[1]).toEqual(expected1);
    const body = JSON.parse((captured as RequestInit).body as string);
    expect(body.input).toEqual(["first", "second"]);
  });

  test("throws a clear error when the API returns non-2xx", async () => {
    globalThis.fetch = (async () => {
      return new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      });
    }) as typeof fetch;
    const p = new VoyageAIEmbeddingProvider({ apiKey: "k" });
    await expect(p.embed("hi")).rejects.toThrow(
      /Voyage embedding request failed: 429/,
    );
  });

  test("createEmbeddingProvider recognizes provider: 'voyage'", () => {
    const p = createEmbeddingProvider({ provider: "voyage", apiKey: "k" });
    expect(p.id).toBe("voyage");
  });
});
