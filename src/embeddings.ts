import { createRequire } from "node:module";
import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingProviderKind,
  EmbeddingRuntimeInfo,
  EmbeddingVector,
} from "./types.js";
import { resolveEmbeddingPrefixes } from "./embedding-prefixes.js";

/**
 * Load the transformers runtime through CommonJS.
 *
 * `import("@huggingface/transformers")` fails on Node 26 because its ESM
 * entry imports named exports from the CommonJS `onnxruntime-common` package
 * ("Named export 'Tensor' not found"). The package ships a working CJS entry,
 * and `createRequire` selects it. This was the difference between a bare
 * `new MemOS()` using real embeddings and silently falling back to the hash.
 */
const nodeRequire = createRequire(import.meta.url);

/**
 * Strip all trailing slash characters from a URL/base path without using a
 * regular expression. Avoids a ReDoS-flagged `/+$/` pattern on user-supplied
 * input (CodeQL js/regular-expression-polynomial-redos).
 */
export function stripTrailingSlashes(url: string): string {
  let result = url;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

const DEFAULT_DIMENSIONS = 384;

const SYNONYMS: Record<string, readonly string[]> = {
  // Preference language
  prefer: ["like", "favor", "preference"],
  prefers: ["like", "likes", "preference"],
  preference: ["prefer", "like", "likes"],
  preferences: ["prefer", "likes", "favorite"],
  likes: ["prefer", "preference", "favorite"],
  favorite: ["favourite", "preferred", "likes"],
  // UI / appearance
  dark: ["night", "black", "dim"],
  theme: ["mode", "ui", "appearance"],
  themes: ["mode", "ui", "appearance"],
  mode: ["theme", "ui", "appearance"],
  // Memory vocabulary
  remember: ["memory", "recall"],
  remembers: ["memory", "recall"],
  memories: ["memory", "recall"],
  // Tasks
  todo: ["task", "action"],
  tasks: ["todo", "action"],
  // Exercise & fitness — paraphrases like "exercise routine" must reach
  // memories phrased as "runs 5k three times a week".
  exercise: ["workout", "training", "fitness", "runs", "running", "gym"],
  exercises: ["workout", "training", "fitness", "running"],
  workout: ["exercise", "training", "fitness", "gym"],
  runs: ["running", "jogging", "exercise"],
  running: ["runs", "jogging", "exercise"],
  routine: ["schedule", "habit", "regular"],
  routines: ["schedule", "habit", "regular"],
  habit: ["routine", "regular"],
  habits: ["routine", "regular"],
  gym: ["workout", "exercise", "fitness"],
  // Reading & books — "book author preferences" must reach "reads sci-fi,
  // especially Le Guin".
  book: ["books", "reads", "reading", "novel", "author", "literature"],
  books: ["book", "reading", "novel", "literature"],
  author: ["writer", "novelist", "book", "books"],
  authors: ["writers", "book", "books"],
  reads: ["reading", "book", "books"],
  reading: ["reads", "book", "books"],
  novel: ["book", "fiction", "literature"],
  // Media
  podcast: ["show", "audio", "episode"],
  music: ["song", "songs", "listening"],
  // Travel
  vacation: ["trip", "travel", "holiday"],
  holiday: ["vacation", "trip", "travel"],
  trip: ["travel", "vacation", "journey"],
  travel: ["trip", "vacation", "journey"],
  // Work
  job: ["work", "employment", "company", "employer", "career"],
  works: ["work", "job", "employment"],
  company: ["employer", "workplace", "business"],
  employer: ["company", "workplace"],
  career: ["job", "work", "profession"],
  // Relationships & family
  partner: ["spouse", "wife", "husband", "girlfriend", "boyfriend"],
  siblings: ["sister", "brother", "family"],
  sibling: ["sister", "brother", "family"],
  sister: ["sibling", "family"],
  brother: ["sibling", "family"],
  // Health
  allergies: ["allergic", "allergy", "intolerance", "reaction"],
  allergy: ["allergic", "intolerance"],
  allergic: ["allergy", "intolerance"],
  health: ["healthy", "wellness", "medical"],
  // Transport
  transportation: ["transport", "commute", "commuting"],
  commute: ["commuting", "transport"],
  bike: ["bicycle", "cycling"],
  bicycle: ["bike", "cycling"],
  // Hobbies & games
  hobby: ["hobbies", "pastime", "interest"],
  hobbies: ["hobby", "pastime", "interests"],
  games: ["game", "gaming", "playing"],
  gaming: ["games", "playing"],
  skill: ["level", "rating", "ability"],
  rating: ["score", "rank", "level"],
  // Instruments
  instrument: ["piano", "guitar", "musical"],
  piano: ["instrument", "keyboard", "musical"],
  guitar: ["instrument", "musical"],
  // Pets
  dog: ["pet", "puppy"],
  cat: ["pet", "kitten"],
  pet: ["dog", "cat", "animal"],
  // Food & drink
  coffee: ["espresso", "caffeine"],
  drinks: ["drink", "beverage"],
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
  a: ArrayLike<number>,
  b: ArrayLike<number>,
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

/**
 * Zero-native-dependency semantic embeddings.
 *
 * Model2Vec's potion-base-8M is a static embedding table: tokenize, look up
 * each token vector, mean-pool, normalize. No ONNX, no native addons, no
 * install scripts, no model download at runtime. It is the SDK default so a
 * bare `new MemOS()` actually has semantic recall instead of silently
 * degrading to the lexical hash.
 *
 * Quality is below a task-tuned neural embedder (Nomic/BGE), so the docs and
 * `memos doctor` point users at Ollama/FastEmbed for higher accuracy. The
 * important guarantee is that the default is real semantic search and cannot
 * fail on a missing native runtime.
 */
export class Model2VecEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "model2vec";
  public readonly model: string;
  public readonly dimensions: number;
  public readonly queryPrefix = "";
  public readonly documentPrefix = "";
  private modulePromise: Promise<{
    embed(input: string | string[]): Promise<Float32Array[]>;
  }> | null = null;

  constructor(options: { model?: string; dimensions?: number } = {}) {
    this.model = options.model ?? "potion-base-8M";
    this.dimensions = options.dimensions ?? 256;
  }

  getRuntimeInfo(): EmbeddingRuntimeInfo {
    return {
      requestedProvider: "model2vec",
      resolvedProvider: "model2vec",
      requestedModel: this.model,
      resolvedModel: this.model,
      modelRevision: null,
      requestedDimensions: this.dimensions,
      observedDimensions: this.dimensions,
      fallbackActive: false,
      fallbackReason: null,
      queryPrefix: "",
      documentPrefix: "",
    };
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const module = await this.load();
    const [vector] = await module.embed(text);
    if (!vector) throw new Error("Model2Vec returned no embedding.");
    return Array.from(vector);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 0) return [];
    const module = await this.load();
    const vectors = await module.embed(texts);
    return vectors.map((vector) => Array.from(vector));
  }

  private load(): Promise<{
    embed(input: string | string[]): Promise<Float32Array[]>;
  }> {
    this.modulePromise ??= import("@yarflam/potion-base-8m").then(
      (module) =>
        module as unknown as {
          embed(input: string | string[]): Promise<Float32Array[]>;
        },
    );
    return this.modulePromise;
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "ollama";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly baseUrl: string;
  public readonly queryPrefix: string;
  public readonly documentPrefix: string;

  constructor(
    options: {
      baseUrl?: string;
      model?: string;
      dimensions?: number;
      /** Optional string prepended to QUERY text before embedding. Many
       *  retrieval models (Liquid E / e5, nomic with a prompt) are
       *  trained for an asymmetric query/document setting and expect an
       *  instruction on the query side, e.g. "query: ". Empty by default
       *  = backward compatible. */
      queryPrefix?: string;
      /** Optional string prepended to DOCUMENT text (the index-side
       *  content) before embedding, e.g. "document: " for Liquid
       *  LFM2.5-Embedding / e5. Applied by `embed()`/`batchEmbed()` but
       *  NOT by `embedQuery()`, which applies `queryPrefix` only. Empty
       *  by default = backward compatible. */
      documentPrefix?: string;
    } = {},
  ) {
    this.baseUrl = stripTrailingSlashes(
      options.baseUrl ?? "http://127.0.0.1:11434",
    );
    this.model = options.model ?? "nomic-embed-text";
    this.dimensions = options.dimensions ?? 768;
    this.queryPrefix = options.queryPrefix ?? "";
    this.documentPrefix = options.documentPrefix ?? "";
  }

  private async callEmbed(
    input: string | string[],
  ): Promise<EmbeddingVector[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input }),
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
    const vectors =
      payload.embeddings ??
      (payload.embedding ? [payload.embedding] : undefined);
    if (!Array.isArray(vectors)) {
      throw new Error("Ollama embedding response did not include a vector.");
    }
    if (Array.isArray(input) && vectors.length !== input.length) {
      throw new Error(
        `Ollama embedding response length mismatch: got ${vectors.length}, expected ${input.length}.`,
      );
    }
    return vectors.map((v) => normalizeVector(v));
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const input = this.documentPrefix ? `${this.documentPrefix}${text}` : text;
    return this.callEmbed(input).then((v) => v[0]);
  }

  /**
   * Query embedding applies the configured `queryPrefix`, when set, so the
   * retrieval question is embedded in the model's query mode. Documents are
   * embedded WITHOUT the prefix (plain indexing text).
   */
  embedQuery(text: string): Promise<EmbeddingVector> {
    const input = this.queryPrefix ? `${this.queryPrefix}${text}` : text;
    return this.callEmbed(input).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    const input = this.documentPrefix
      ? texts.map((t) => `${this.documentPrefix}${t}`)
      : texts;
    return this.callEmbed(input);
  }

  /**
   * Batch form of `embedQuery`: applies `queryPrefix` (never
   * `documentPrefix`) to every text, one request for the whole batch.
   * Vectors are identical to N separate `embedQuery` calls — asymmetry is
   * a text transform, not a request-shape thing.
   */
  async batchEmbedQueries(texts: string[]): Promise<EmbeddingVector[]> {
    const input = this.queryPrefix
      ? texts.map((t) => `${this.queryPrefix}${t}`)
      : texts;
    return this.callEmbed(input);
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    if (texts.length === 1) {
      return this.embed(texts[0]).then((v) => [v]);
    }
    return this.batchEmbed(texts);
  }
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "openai-compatible";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  public readonly queryPrefix: string;
  public readonly documentPrefix: string;

  constructor(options: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
    /** Prepended to QUERY text by `embedQuery()`. Asymmetric retrieval
     *  models served over OpenAI-compatible endpoints (e.g. Liquid
     *  LFM2.5-Embedding via llama.cpp, e5 via vLLM) are trained with a
     *  query-side instruction — e.g. "query: " — and silently degrade
     *  without it. Empty by default = backward compatible. */
    queryPrefix?: string;
    /** Prepended to DOCUMENT text by `embed()`/`batchEmbed()` — e.g.
     *  "document: " for Liquid LFM2.5-Embedding / e5 index-side text.
     *  `embedQuery()` applies `queryPrefix` only. Empty by default. */
    documentPrefix?: string;
  }) {
    this.baseUrl = stripTrailingSlashes(
      options.baseUrl ?? "https://api.openai.com/v1",
    );
    this.apiKey = options.apiKey ?? "";
    this.model = options.model ?? "text-embedding-3-small";
    this.dimensions = options.dimensions ?? 1536;
    this.queryPrefix = options.queryPrefix ?? "";
    this.documentPrefix = options.documentPrefix ?? "";
  }

  private async callEmbeddings(input: string[]): Promise<EmbeddingVector[]> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input }),
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed: ${response.status} ${response.statusText}`,
      );
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    if (!Array.isArray(payload.data)) {
      throw new Error("Embedding response did not include a `data` array.");
    }
    if (payload.data.length !== input.length) {
      throw new Error(
        `Embedding response length mismatch: got ${payload.data.length}, expected ${input.length}.`,
      );
    }
    return payload.data.map((row) => {
      if (!Array.isArray(row.embedding)) {
        throw new Error("Embedding response contained a non-vector entry.");
      }
      return normalizeVector(row.embedding);
    });
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const input = this.documentPrefix ? `${this.documentPrefix}${text}` : text;
    return this.callEmbeddings([input]).then((v) => v[0]);
  }

  embedQuery(text: string): Promise<EmbeddingVector> {
    const input = this.queryPrefix ? `${this.queryPrefix}${text}` : text;
    return this.callEmbeddings([input]).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    const input = this.documentPrefix
      ? texts.map((t) => `${this.documentPrefix}${t}`)
      : texts;
    return this.callEmbeddings(input);
  }

  /**
   * Batch form of `embedQuery`: applies `queryPrefix` (never
   * `documentPrefix`) to every text, one request for the whole batch.
   */
  async batchEmbedQueries(texts: string[]): Promise<EmbeddingVector[]> {
    const input = this.queryPrefix
      ? texts.map((t) => `${this.queryPrefix}${t}`)
      : texts;
    return this.callEmbeddings(input);
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
    this.baseUrl = stripTrailingSlashes(
      options.baseUrl ?? "https://api.voyageai.com/v1",
    );
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return this.callEmbeddings([text]).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbeddings(texts);
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    return this.callEmbeddings([text], "query").then((v) => v[0]);
  }

  async batchEmbedQueries(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbeddings(texts, "query");
  }

  private async callEmbeddings(
    texts: string[],
    inputType: "document" | "query" = "document",
  ): Promise<EmbeddingVector[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        input_type: inputType,
      }),
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

  const provider =
    (config?.provider as EmbeddingProviderKind | undefined) ?? "model2vec";
  // NOTE: "model2vec" is the default because a bare `new MemOS()` must give
  // real local semantic search without ONNX, native addons, install scripts,
  // or a network model download. potion-base-8M is ~30 MB of static vectors
  // and runs in pure JavaScript. Users who want higher accuracy can opt into
  // `ollama`/`nomic-embed-text`, `fastembed`, or an API provider.
  const defaultModel =
    provider === "model2vec"
      ? "potion-base-8M"
      : provider === "ollama"
        ? "nomic-embed-text"
        : provider === "openai-compatible"
          ? "text-embedding-3-small"
          : provider === "voyage"
            ? "voyage-3"
            : provider === "cohere"
              ? "embed-english-v3.0"
              : provider === "fastembed"
                ? "BAAI/bge-small-en-v1.5"
                : undefined;
  const model = config?.model ?? defaultModel;
  const prefixes = resolveEmbeddingPrefixes({
    provider,
    model,
    queryPrefix: config?.queryPrefix,
    documentPrefix: config?.documentPrefix,
  });
  const resolved: EmbeddingConfig = {
    ...(config ?? {}),
    ...(model ? { model } : {}),
    queryPrefix: prefixes.queryPrefix,
    documentPrefix: prefixes.documentPrefix,
  };

  if (provider === "model2vec") {
    return new Model2VecEmbeddingProvider(resolved);
  }
  if (provider === "ollama") {
    return new OllamaEmbeddingProvider(resolved);
  }
  if (provider === "openai-compatible") {
    return new OpenAICompatibleEmbeddingProvider(resolved);
  }
  if (provider === "voyage") {
    return new VoyageAIEmbeddingProvider(resolved);
  }
  if (provider === "cohere") {
    return new CohereEmbeddingProvider(resolved);
  }
  if (provider === "fastembed") {
    return new FastEmbedEmbeddingProvider(resolved);
  }
  return new LocalHashEmbeddingProvider(resolved);
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
    this.baseUrl = stripTrailingSlashes(
      options.baseUrl ?? "https://api.cohere.ai/v1",
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

  async embedQuery(text: string): Promise<EmbeddingVector> {
    return this.callEmbed([text], "search_query").then((v) => v[0]);
  }

  async batchEmbedQueries(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbed(texts, "search_query");
  }

  private async callEmbed(
    texts: string[],
    inputType: string = this.inputType,
  ): Promise<EmbeddingVector[]> {
    const response = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        texts,
        input_type: inputType,
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
/**
 * Warn-once flag for the FastEmbed local-hash fallback. The fallback keeps
 * the SDK working with zero extra installs, but users deserve to know
 * their "semantic" search is degraded — and exactly how to fix it.
 */
let warnedEmbeddingFallback = false;

export class FastEmbedEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "fastembed";
  public readonly model: string;
  public readonly dimensions: number;
  public readonly queryPrefix: string;
  public readonly documentPrefix: string;
  private pipeline:
    | ((
        text: string | string[],
        opts: { pooling: string; normalize: boolean },
      ) => Promise<{ data: Float32Array; dims: number[] }>)
    | null = null;
  private resolved = false;
  /**
   * Set when the transformers pipeline could NOT be loaded and the
   * deterministic local hash fallback is serving embeddings instead.
   * Null while unresolved or when the real model loaded fine. Exposed
   * via `getRuntimeInfo()` so benchmarks can detect — and optionally
   * refuse to run on — the fallback.
   */
  private fallbackReason: string | null = null;

  constructor(
    options: {
      model?: string;
      dimensions?: number;
      queryPrefix?: string;
      documentPrefix?: string;
    } = {},
  ) {
    this.model = options.model ?? "BAAI/bge-small-en-v1.5";
    this.dimensions = options.dimensions ?? 384;
    this.queryPrefix = options.queryPrefix ?? "";
    this.documentPrefix = options.documentPrefix ?? "";
  }

  /**
   * Runtime resolution metadata. `fallbackActive` is only meaningful after
   * the first `embed()` call (or an explicit probe) has triggered
   * `resolve()`; before that it reports `false` with a null reason, which
   * callers should read as "not yet known" rather than "no fallback".
   */
  getRuntimeInfo(): EmbeddingRuntimeInfo {
    return {
      requestedProvider: "fastembed",
      resolvedProvider: this.fallbackReason
        ? "local-hash-fallback"
        : "fastembed",
      requestedModel: this.model,
      resolvedModel: this.fallbackReason
        ? `local-hash-fallback-${this.dimensions}`
        : this.model,
      modelRevision: null,
      requestedDimensions: this.dimensions,
      observedDimensions: this.lastObservedDimensions,
      fallbackActive: this.fallbackReason !== null,
      fallbackReason: this.fallbackReason,
      queryPrefix: this.queryPrefix,
      documentPrefix: this.documentPrefix,
    };
  }

  /** Dimensions seen on the most recent embed/batchEmbed result. */
  private lastObservedDimensions: number | null = null;

  /**
   * Lazily resolve the transformers pipeline.
   *
   * Loads through CommonJS (`createRequire`) because the ESM entry of
   * `@huggingface/transformers` fails on Node 26 with a named-export
   * interop error from `onnxruntime-common`. The CJS entry works.
   *
   * Tries `@huggingface/transformers` (the maintained successor) first,
   * then falls back to the older `@xenova/transformers` for users who
   * still have it installed. Any failure degrades to the local hash, but
   * the exact load error is preserved for `memos doctor` and crash reports.
   */
  private async resolve(): Promise<void> {
    if (this.resolved) return;
    this.resolved = true;
    try {
      const loadErrors: string[] = [];
      const load = (
        name: string,
      ): {
        pipeline?: (task: string, model: string) => Promise<unknown>;
      } | null => {
        try {
          return nodeRequire(name) as {
            pipeline?: (task: string, model: string) => Promise<unknown>;
          };
        } catch (err) {
          loadErrors.push(
            `${name}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
      };
      const mod = load("@huggingface/transformers");
      const legacyMod = mod?.pipeline ? null : load("@xenova/transformers");
      const resolved = mod?.pipeline
        ? mod
        : legacyMod?.pipeline
          ? legacyMod
          : null;
      if (!resolved?.pipeline) {
        this.fallbackReason =
          loadErrors.length > 0
            ? `embedding runtime could not load (${loadErrors.join("; ").slice(0, 300)})`
            : "no embedding runtime installed";
        this.warnFallbackOnce();
        return;
      }
      const pipeline = await resolved.pipeline(
        "feature-extraction",
        this.model,
      );
      // @huggingface/transformers v3+/v4 pipelines are callable directly;
      // older shapes exposed `.feature`. Normalize both behind one function.
      this.pipeline =
        typeof pipeline === "function"
          ? (pipeline as FastEmbedEmbeddingProvider["pipeline"])
          : ((pipeline as { feature?: FastEmbedEmbeddingProvider["pipeline"] })
              .feature ?? null);
      if (!this.pipeline) {
        this.fallbackReason = `pipeline for model "${this.model}" exposed no callable feature-extraction interface`;
        this.warnFallbackOnce();
      }
    } catch (err) {
      // Record the failure for runtime info, then fall through to the
      // local hash. The SDK keeps its resilient default behavior — but
      // benchmarks can now SEE the fallback instead of silently scoring it.
      this.fallbackReason = `pipeline construction failed for model "${this.model}": ${String(
        err,
      ).substring(0, 200)}`;
      this.warnFallbackOnce();
    }
  }

  /**
   * One-time loud warning when the local-hash fallback activates. Silent
   * degradation is the worst plug-in experience: everything "works" but
   * semantic search quietly returns garbage.
   */
  private warnFallbackOnce(): void {
    if (warnedEmbeddingFallback) return;
    warnedEmbeddingFallback = true;
    console.warn(
      `[memos] embedding fallback: ${this.fallbackReason}. ` +
        "Semantic search is degraded to a deterministic local hash. " +
        "Install `@huggingface/transformers`, configure Ollama, or run " +
        "`memos doctor` for the exact fix.",
    );
  }

  /** Document-side embedding. Applies the model's document instruction. */
  async embed(text: string): Promise<EmbeddingVector> {
    return this.embedWithPrefix(text, this.documentPrefix);
  }

  /** Query-side embedding. Applies the model's query instruction. */
  async embedQuery(text: string): Promise<EmbeddingVector> {
    return this.embedWithPrefix(text, this.queryPrefix);
  }

  async batchEmbedQueries(texts: string[]): Promise<EmbeddingVector[]> {
    return this.batchEmbedWithPrefix(texts, this.queryPrefix);
  }

  async embedDocuments(texts: string[]): Promise<EmbeddingVector[]> {
    return this.batchEmbedWithPrefix(texts, this.documentPrefix);
  }

  private async embedWithPrefix(
    text: string,
    prefix: string,
  ): Promise<EmbeddingVector> {
    const input = `${prefix}${text}`;
    await this.resolve();
    if (this.pipeline) {
      try {
        const out = await this.pipeline(input, {
          pooling: "mean",
          normalize: true,
        });
        this.lastObservedDimensions = out.data.length;
        return Array.from(out.data);
      } catch (err) {
        this.fallbackReason =
          `ONNX inference failed for model "${this.model}": ` +
          `${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        this.pipeline = null;
        this.warnFallbackOnce();
      }
    }
    return this.fallbackEmbed(input);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    return this.batchEmbedWithPrefix(texts, this.documentPrefix);
  }

  private async batchEmbedWithPrefix(
    texts: string[],
    prefix: string,
  ): Promise<EmbeddingVector[]> {
    const inputs = texts.map((text) => `${prefix}${text}`);
    await this.resolve();
    if (this.pipeline) {
      try {
        // The transformers pipeline runs array input as one batched ONNX
        // session — far cheaper than one session run per text. Batched output
        // is a single Tensor with dims [batch, hidden]; slice it per row.
        // Chunked to bound peak memory on large backfills.
        const CHUNK_SIZE = 32;
        const vectors: EmbeddingVector[] = [];
        for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
          const chunk = inputs.slice(i, i + CHUNK_SIZE);
          const out = await this.pipeline(chunk, {
            pooling: "mean",
            normalize: true,
          });
          const hidden = out.dims[out.dims.length - 1];
          this.lastObservedDimensions = hidden;
          for (let r = 0; r < chunk.length; r += 1) {
            vectors.push(
              Array.from(out.data.slice(r * hidden, (r + 1) * hidden)),
            );
          }
        }
        return vectors;
      } catch (err) {
        this.fallbackReason =
          `ONNX batch inference failed for model "${this.model}": ` +
          `${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
        this.pipeline = null;
        this.warnFallbackOnce();
      }
    }
    return inputs.map((input) => this.fallbackEmbed(input));
  }

  /**
   * Deterministic feature-hash fallback. Produces a `dimensions`-long
   * vector with the same shape (and L2 norm) as a real
   * sentence-transformer embedding, so storage and ranking code is
   * identical to the online path.
   */
  private fallbackEmbed(text: string): EmbeddingVector {
    this.lastObservedDimensions = this.dimensions;
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
