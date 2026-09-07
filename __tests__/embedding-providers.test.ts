/**
 * Tests for HTTP embedding providers: asymmetric query/document prefixes
 * and batched requests on the Ollama and OpenAI-compatible providers.
 *
 * The LFM2.5-Embedding / e5 class of models is trained with a query-side
 * instruction ("query: ") and a document-side tag ("document: "); sending
 * raw text silently degrades retrieval. These tests pin which prefix is
 * applied on which path so the two can never cross-wire.
 *
 * Fetch mocks are hand-rolled (no jest.fn / jest.spyOn) so the suite runs
 * identically under CJS jest and `--experimental-vm-modules` ESM jest,
 * where the `jest` global is not injected into ESM test files. Tests use
 * async/await with restore() in finally so the mock outlives every fetch.
 */

import {
  createEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from "../src/embeddings";

type FetchArgs = { url: string; init: { body: string } };
type FetchMock = ((url: unknown, init?: unknown) => unknown) & {
  calls: FetchArgs[];
};

function createFetchMock(
  respond: (url: string, body: { input: string | string[] }) => unknown,
): FetchMock & { install: () => () => void } {
  const calls: FetchArgs[] = [];
  const fn = ((url: unknown, init?: unknown) => {
    const args: FetchArgs = {
      url: String(url),
      init: init as { body: string },
    };
    calls.push(args);
    return respond(args.url, JSON.parse(args.init.body));
  }) as FetchMock & { install: () => () => void };
  fn.calls = calls;
  fn.install = () => {
    const real = globalThis.fetch;
    globalThis.fetch = fn as unknown as typeof fetch;
    return () => {
      globalThis.fetch = real;
    };
  };
  return fn;
}

/** Mock responder: one vector per input entry, (len, 1). */
function respondWithVectors(url: string, body: { input: string | string[] }) {
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const vectors = inputs.map((text) => [text.length, 1]);
  return {
    ok: true,
    json: async () =>
      url.includes("/api/embed")
        ? { embeddings: vectors }
        : { data: vectors.map((v) => ({ embedding: v })) },
  };
}

function lastBody(mock: FetchMock): { input: string | string[] } {
  const last = mock.calls[mock.calls.length - 1];
  return JSON.parse(last.init.body);
}

describe("OpenAICompatibleEmbeddingProvider prefixes", () => {
  test("embed() applies documentPrefix, embedQuery() applies queryPrefix", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
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
      restore();
    }
  });

  test("no prefixes configured sends text as-is", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      await provider.embed("plain text");
      await provider.embedQuery("plain question");
      expect(lastBody(mock).input).toEqual(["plain question"]);
    } finally {
      restore();
    }
  });

  test("batchEmbed sends one request with array input, preserving order", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
        documentPrefix: "document: ",
      });
      const vectors = await provider.batchEmbed(["a", "bbbb"]);

      expect(mock.calls).toHaveLength(1);
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
      restore();
    }
  });

  test("throws on response length mismatch", async () => {
    const mock = createFetchMock((_url, body) => {
      const count = Array.isArray(body.input) ? body.input.length : 1;
      return {
        ok: true,
        json: async () => ({
          data: Array.from({ length: Math.max(1, count - 1) }, () => ({
            embedding: [1, 0],
          })),
        }),
      };
    });
    const restore = mock.install();
    try {
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: "http://127.0.0.1:8080/v1",
      });
      await expect(provider.batchEmbed(["a", "b"])).rejects.toThrow(
        /length mismatch/,
      );
    } finally {
      restore();
    }
  });
});

describe("OllamaEmbeddingProvider prefixes and batching", () => {
  test("embed() applies documentPrefix, embedQuery() applies queryPrefix only", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
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
      restore();
    }
  });

  test("batchEmbed sends one array-input request to /api/embed", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
    try {
      const provider = new OllamaEmbeddingProvider({
        documentPrefix: "document: ",
      });
      const vectors = await provider.batchEmbed(["one", "two"]);

      expect(mock.calls).toHaveLength(1);
      expect(lastBody(mock).input).toEqual(["document: one", "document: two"]);
      expect(vectors).toHaveLength(2);
    } finally {
      restore();
    }
  });

  test("embedDocuments routes multi-text through batchEmbed", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
    try {
      const provider = new OllamaEmbeddingProvider({});
      await provider.embedDocuments(["one", "two"]);
      expect(mock.calls).toHaveLength(1);

      await provider.embedDocuments(["solo"]);
      expect(mock.calls).toHaveLength(2);
      expect(lastBody(mock).input).toBe("solo");
    } finally {
      restore();
    }
  });
});

describe("createEmbeddingProvider forwards prefix config", () => {
  test("openai-compatible provider receives queryPrefix/documentPrefix", async () => {
    const mock = createFetchMock(respondWithVectors);
    const restore = mock.install();
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
      restore();
    }
  });
});
