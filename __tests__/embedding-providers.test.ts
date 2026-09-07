/**
 * Tests for HTTP embedding providers: asymmetric query/document prefixes
 * and batched requests on the Ollama and OpenAI-compatible providers.
 *
 * The LFM2.5-Embedding / e5 class of models is trained with a query-side
 * instruction ("query: ") and a document-side tag ("document: "); sending
 * raw text silently degrades retrieval. These tests pin which prefix is
 * applied on which path so the two can never cross-wire.
 */

import {
  createEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from "../src/embeddings";

type FetchMock = jest.Mock;

/** Install a fetch mock returning one vector per input entry. */
function mockFetchWithVectors(mock: FetchMock, dim = 2): void {
  mock.mockImplementation(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const data = inputs.map((text) => ({ embedding: [text.length, 1] }));
    return {
      ok: true,
      json: async () =>
        urlIncludes(_url, "/api/embed")
          ? { embeddings: data.map((d) => d.embedding) }
          : { data },
    };
  });
}

function urlIncludes(url: string, fragment: string): boolean {
  return url.includes(fragment);
}

function lastBody(mock: FetchMock): {
  input: string | string[];
  model?: string;
} {
  const lastCall = mock.mock.calls[mock.mock.calls.length - 1];
  return JSON.parse((lastCall?.[1] as { body: string }).body);
}

describe("OpenAICompatibleEmbeddingProvider prefixes", () => {
  test("embed() applies documentPrefix, embedQuery() applies queryPrefix", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "LFM2.5-Embedding-350M",
        dimensions: 1024,
        queryPrefix: "query: ",
        documentPrefix: "document: ",
      });

      await provider.embed("user likes dark mode");
      expect(lastBody(mock).input).toEqual(["document: user likes dark mode"]);

      await provider.embedQuery("what does the user like?");
      expect(lastBody(mock).input).toEqual(["query: what does the user like?"]);
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });

  test("no prefixes configured sends text as-is", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      await provider.embed("plain text");
      await provider.embedQuery("plain question");
      expect(lastBody(mock).input).toEqual(["plain question"]);
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });

  test("batchEmbed sends one request with array input, preserving order", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
        documentPrefix: "document: ",
      });
      const vectors = await provider.batchEmbed(["a", "bbbb"]);

      expect(mock).toHaveBeenCalledTimes(1);
      expect(lastBody(mock).input).toEqual(["document: a", "document: bbbb"]);
      // Vectors arrive in input order, unit-normalized.
      expect(vectors).toHaveLength(2);
      for (const v of vectors) {
        const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
        expect(norm).toBeCloseTo(1, 5);
      }
      // Input order preserved: the longer text has the larger raw component.
      expect(vectors[1][0]).toBeGreaterThan(vectors[0][0]);
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });

  test("throws on response length mismatch", async () => {
    const mock = jest.fn() as FetchMock;
    mock.mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { input: string[] };
      return {
        ok: true,
        json: async () => ({
          data: body.input.map(() => ({ embedding: [1, 0] })).slice(0, 1),
        }),
      };
    });
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      await expect(provider.batchEmbed(["a", "b"])).rejects.toThrow(
        /length mismatch/,
      );
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });
});

describe("OllamaEmbeddingProvider prefixes and batching", () => {
  test("embed() applies documentPrefix, embedQuery() applies queryPrefix only", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OllamaEmbeddingProvider({
        queryPrefix: "query: ",
        documentPrefix: "document: ",
      });

      await provider.embed("a fact");
      expect(lastBody(mock).input).toBe("document: a fact");

      await provider.embedQuery("a question");
      expect(lastBody(mock).input).toBe("query: a question");
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });

  test("batchEmbed sends one array-input request to /api/embed", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OllamaEmbeddingProvider({
        documentPrefix: "document: ",
      });
      const vectors = await provider.batchEmbed(["one", "two"]);

      expect(mock).toHaveBeenCalledTimes(1);
      expect(lastBody(mock).input).toEqual(["document: one", "document: two"]);
      expect(vectors).toHaveLength(2);
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });

  test("embedDocuments routes multi-text through batchEmbed", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = new OllamaEmbeddingProvider({});
      await provider.embedDocuments(["one", "two"]);
      expect(mock).toHaveBeenCalledTimes(1);

      await provider.embedDocuments(["solo"]);
      expect(mock).toHaveBeenCalledTimes(2);
      expect(lastBody(mock).input).toBe("solo");
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });
});

describe("createEmbeddingProvider forwards prefix config", () => {
  test("openai-compatible provider receives queryPrefix/documentPrefix", async () => {
    const mock = jest.fn() as FetchMock;
    mockFetchWithVectors(mock);
    jest.spyOn(global, "fetch").mockImplementation(mock as never);
    try {
      const provider = createEmbeddingProvider({
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8080/v1",
        queryPrefix: "query: ",
        documentPrefix: "document: ",
      });
      expect(provider.id).toBe("openai-compatible");
      await provider.embedQuery("q");
      expect(lastBody(mock).input).toEqual(["query: q"]);
    } finally {
      (global.fetch as unknown as FetchMock).mockRestore();
    }
  });
});
