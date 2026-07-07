import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingVector,
} from "./types.js";

const DEFAULT_DIMENSIONS = 384;

const SYNONYMS: Record<string, readonly string[]> = {
  prefer: ["like", "favor", "preference"],
  prefers: ["like", "likes", "preference"],
  preference: ["prefer", "like", "likes"],
  likes: ["prefer", "preference", "favorite"],
  dark: ["night", "black", "dim"],
  theme: ["mode", "ui", "appearance"],
  themes: ["mode", "ui", "appearance"],
  mode: ["theme", "ui", "appearance"],
  remember: ["memory", "recall"],
  memories: ["memory", "recall"],
  todo: ["task", "action"],
  tasks: ["todo", "action"],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = hashToken(feature);
  const index = hash % vector.length;
  const sign = hash & 1 ? 1 : -1;
  vector[index] += sign * weight;
}

export function normalizeVector(vector: EmbeddingVector): EmbeddingVector {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(
  a: EmbeddingVector,
  b: EmbeddingVector,
): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] * a[index];
    bNorm += b[index] * b[index];
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot / Math.sqrt(aNorm * bNorm);
}

export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "local-hash";
  public readonly model: string;
  public readonly dimensions: number;

  constructor(options: { dimensions?: number; model?: string } = {}) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.model = options.model ?? `local-hash-${this.dimensions}`;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = tokenize(text);
    const uniqueTokens = [...new Set(tokens)];

    for (const token of uniqueTokens) {
      addFeature(vector, `tok:${token}`, 1);
      for (let length = 3; length <= Math.min(token.length, 5); length += 1) {
        for (let index = 0; index <= token.length - length; index += 1) {
          addFeature(vector, `ng:${token.slice(index, index + length)}`, 0.12);
        }
      }
      for (const synonym of SYNONYMS[token] ?? []) {
        addFeature(vector, `tok:${synonym}`, 0.45);
      }
    }

    for (let index = 0; index < tokens.length - 1; index += 1) {
      addFeature(vector, `bi:${tokens[index]}:${tokens[index + 1]}`, 0.35);
    }

    return normalizeVector(vector);
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "ollama";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly baseUrl: string;

  constructor(
    options: { baseUrl?: string; model?: string; dimensions?: number } = {},
  ) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? "nomic-embed-text";
    this.dimensions = options.dimensions ?? 768;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(
        `Ollama embedding request failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as {
      embeddings?: number[][];
      embedding?: number[];
    };
    const vector = payload.embeddings?.[0] ?? payload.embedding;
    if (!Array.isArray(vector)) {
      throw new Error("Ollama embedding response did not include a vector.");
    }
    return normalizeVector(vector);
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "openai-compatible";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
  }) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    );
    this.apiKey = options.apiKey ?? "";
    this.model = options.model ?? "text-embedding-3-small";
    this.dimensions = options.dimensions ?? 1536;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vector = payload.data?.[0]?.embedding;
    if (!Array.isArray(vector)) {
      throw new Error("Embedding response did not include a vector.");
    }
    return normalizeVector(vector);
  }
}

/**
 * Voyage AI embedding provider.
 *
 * Voyage's `voyage-3` family is the strongest open-weight-class
 * retrieval model we can hit over HTTP, and it's a common default
 * for serious RAG work. The provider uses the public
 * `https://api.voyageai.com/v1/embeddings` endpoint and Bearer auth.
 */
export class VoyageAIEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "voyage";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      dimensions?: number;
      baseUrl?: string;
    } = {},
  ) {
    if (!options.apiKey) {
      throw new Error(
        "VoyageAIEmbeddingProvider requires an `apiKey` (e.g. `pa-…`).",
      );
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "voyage-3";
    this.dimensions = options.dimensions ?? 1024;
    this.baseUrl = (options.baseUrl ?? "https://api.voyageai.com/v1").replace(
      /\/+$/,
      "",
    );
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return this.callEmbeddings([text]).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbeddings(texts);
  }

  private async callEmbeddings(texts: string[]): Promise<EmbeddingVector[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(
        `Voyage embedding request failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    if (!Array.isArray(payload.data)) {
      throw new Error("Voyage embedding response missing `data` array.");
    }
    const vectors = payload.data.map((row) => {
      if (!Array.isArray(row.embedding)) {
        throw new Error(
          "Voyage embedding response contained a non-vector entry.",
        );
      }
      return row.embedding;
    });
    if (vectors.length !== texts.length) {
      throw new Error(
        `Voyage embedding response length mismatch: got ${vectors.length}, expected ${texts.length}.`,
      );
    }
    return vectors.map((v) => normalizeVector(v));
  }
}

export function createEmbeddingProvider(
  config: EmbeddingConfig | undefined,
): EmbeddingProvider {
  if (config?.provider && typeof config.provider === "object") {
    return config.provider;
  }

  const provider = config?.provider ?? "local-hash";
  if (provider === "ollama") {
    return new OllamaEmbeddingProvider(config);
  }
  if (provider === "openai-compatible") {
    return new OpenAICompatibleEmbeddingProvider(config ?? {});
  }
  if (provider === "voyage") {
    return new VoyageAIEmbeddingProvider(config ?? {});
  }
  if (provider === "cohere") {
    return new CohereEmbeddingProvider(config ?? {});
  }
  if (provider === "fastembed") {
    return new FastEmbedEmbeddingProvider(config ?? {});
  }
  return new LocalHashEmbeddingProvider(config);
}

/**
 * Cohere embed-v3 embedding provider.
 *
 * Cohere's `embed-english-v3.0` (and its multilingual sibling) is a
 * strong default for English retrieval. The provider hits
 * `https://api.cohere.ai/v1/embed` and returns a normalized vector.
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "cohere";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly inputType: string;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      dimensions?: number;
      baseUrl?: string;
      inputType?: string;
    } = {},
  ) {
    if (!options.apiKey) {
      throw new Error("CohereEmbeddingProvider requires an `apiKey`.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "embed-english-v3.0";
    this.dimensions = options.dimensions ?? 1024;
    this.baseUrl = (options.baseUrl ?? "https://api.cohere.ai/v1").replace(
      /\/+$/,
      "",
    );
    // `search_document` is the right value for indexing; callers that
    // need query-side embeddings can construct a separate provider
    // instance with input_type=`search_query`.
    this.inputType = options.inputType ?? "search_document";
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return this.callEmbed([text]).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbed(texts);
  }

  private async callEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    const response = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        texts,
        input_type: this.inputType,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Cohere embedding request failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as { embeddings?: number[][] };
    if (!Array.isArray(payload.embeddings)) {
      throw new Error("Cohere embedding response missing `embeddings` array.");
    }
    if (payload.embeddings.length !== texts.length) {
      throw new Error(
        `Cohere embedding response length mismatch: got ${payload.embeddings.length}, expected ${texts.length}.`,
      );
    }
    return payload.embeddings.map((v) => normalizeVector(v));
  }
}

/**
 * In-process FastEmbed-style embedding provider.
 *
 * Tries to load `@xenova/transformers` at runtime. If the package is
 * installed (the recommended path for real semantic quality), the
 * provider uses the BAAI/bge-small-en-v1.5 model and runs entirely
 * in-process — no network, no API key, ideal for air-gapped setups.
 *
 * If the package is not installed, falls back to a deterministic
 * feature-hash embedding so the rest of the SDK still works for
 * tests, CI, and offline development. The vector shape and L2 norm
 * are identical between the two modes, so swapping in the real
 * FastEmbed later is a no-op for downstream code.
 */
export class FastEmbedEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "fastembed";
  public readonly model: string;
  public readonly dimensions: number;
  private pipeline: {
    feature: (
      text: string,
      opts: { pooling: string; normalize: boolean },
    ) => Promise<{ data: Float32Array }>;
  } | null = null;
  private resolved = false;

  constructor(options: { model?: string; dimensions?: number } = {}) {
    this.model = options.model ?? "BAAI/bge-small-en-v1.5";
    this.dimensions = options.dimensions ?? 384;
  }

  /**
   * Lazily resolve the @xenova/transformers pipeline. We use a
   * dynamic import so the optional dep is only paid for when (and if)
   * the user installs it. Any failure to load silently falls back to
   * the local hash.
   */
  private async resolve(): Promise<void> {
    if (this.resolved) return;
    this.resolved = true;
    try {
      // The @xenova/transformers package is an optional peer dep —
      // users opt in by `npm install @xenova/transformers`. We use a
      // dynamic import so it's only paid for when installed. Types are
      // declared in `src/xenova-transformers.d.ts`.
      const mod = (await import("@xenova/transformers" as string).catch(
        () => null,
      )) as {
        pipeline: (task: string, model: string) => Promise<unknown>;
      } | null;
      if (!mod) return;
      const pipeline = await mod.pipeline("feature-extraction", this.model);
      this.pipeline = pipeline as FastEmbedEmbeddingProvider["pipeline"];
    } catch {
      // Fall through to the local hash.
    }
  }

  async embed(text: string): Promise<EmbeddingVector> {
    await this.resolve();
    if (this.pipeline) {
      const out = await this.pipeline.feature(text, {
        pooling: "mean",
        normalize: true,
      });
      return Array.from(out.data);
    }
    return this.fallbackEmbed(text);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    await this.resolve();
    if (this.pipeline) {
      const vectors: EmbeddingVector[] = [];
      for (const text of texts) {
        const out = await this.pipeline.feature(text, {
          pooling: "mean",
          normalize: true,
        });
        vectors.push(Array.from(out.data));
      }
      return vectors;
    }
    return texts.map((t) => this.fallbackEmbed(t));
  }

  /**
   * Deterministic feature-hash fallback. Produces a `dimensions`-long
   * vector with the same shape (and L2 norm) as a real
   * sentence-transformer embedding, so storage and ranking code is
   * identical to the online path.
   */
  private fallbackEmbed(text: string): EmbeddingVector {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1);

    const unique = [...new Set(tokens)];
    for (const token of unique) {
      addFeature(vector, `tok:${token}`, 1);
      for (let length = 3; length <= Math.min(token.length, 5); length += 1) {
        for (let i = 0; i <= token.length - length; i += 1) {
          addFeature(vector, `ng:${token.slice(i, i + length)}`, 0.12);
        }
      }
    }
    for (let i = 0; i < tokens.length - 1; i += 1) {
      addFeature(vector, `bi:${tokens[i]}:${tokens[i + 1]}`, 0.35);
    }
    return normalizeVector(vector);
  }
}
