import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingRuntimeInfo,
  EmbeddingVector,
} from "./types.js";

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

/**
 * Tokens that carry almost no retrieval signal in memory text: English
 * function words plus interrogatives and quantifiers. They appear in
 * nearly every memory, so under a bag-of-features embedding they behave
 * like a constant offset that two unrelated short texts share — the
 * classic motivation for IDF weighting (Weinberger 2009 hashing-trick
 * paper, BM25). Kept deliberately conservative: prepositions that carry
 * real meaning in this domain ("before", "after", "never", "always")
 * stay full weight.
 */
const LOW_INFORMATION_TOKENS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "so",
  "as",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "about",
  "up",
  "out",
  "off",
  "per",
  "via",
  "than",
  "too",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "has",
  "have",
  "had",
  "having",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "it",
  "its",
  "they",
  "them",
  "their",
  "there",
  "here",
  "this",
  "that",
  "these",
  "those",
  "we",
  "our",
  "us",
  "you",
  "your",
  "i",
  "me",
  "my",
  "he",
  "she",
  "his",
  "her",
  "who",
  "whom",
  "what",
  "when",
  "where",
  "why",
  "how",
  "which",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "very",
  "just",
  "also",
]);

/**
 * Weight retained by low-information tokens. 0.5 keeps them from
 * contributing nothing at all (they still bind words into a sentence
 * shape via the bigram features) while halving their pull on the
 * cosine. Measured neutral beyond ~0.4 and degrading past ~0.6, so the
 * exact value is not a tuned constant.
 */
const LOW_INFORMATION_WEIGHT = 0.5;

/**
 * Weight of an adjacent word pair, emitted on the document side only.
 * Phrases are what separate memories that share every unigram.
 */
const WORD_BIGRAM_WEIGHT = 0.35;

/**
 * Weight of the plural-folded form of a token (see {@link foldPlural}).
 * Weaker than the exact token feature: number agreement is weak
 * evidence of relevance, but enough to bridge "installs" ↔ "install".
 */
const PLURAL_FEATURE_WEIGHT = 0.6;

/** Which side of the asymmetric retrieval relation a text is encoded for. */
type LexicalMode = "document" | "query";

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

/**
 * Fold a regular English plural back to its singular form.
 *
 * Sub-word signal is the one thing a hash embedder has going for it, but
 * character n-grams only partially bridge "installs"/"install" — the
 * differing tail grams dilute the shared ones. A shared `plu:` feature
 * makes the match explicit. Deliberately conservative (regular plurals
 * only): a full Porter stemmer over-collapses "running"→"run" and
 * "deploying"→"deploy", which is true here but false for pairs like
 * "meeting"→"meet".
 */
function foldPlural(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ss")) return token;
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function addFeature(vector: number[], feature: string, weight: number): void {
  if (weight === 0) return;
  const hash = hashToken(feature);
  const index = hash % vector.length;
  // The sign is a deterministic function of the bucket for an even
  // `vector.length`: `hash % n` has the same parity as `hash`, so
  // sign === parity(bucket). Verified over 500k random hashes. That
  // makes the sign a no-op for any cosine comparison (both vectors flip
  // together) and leaves the inner product equal to the unsigned-mass
  // inner product. Replacing it with an independent sign bit — the
  // textbook Weinberger-2009 form — was measured to be WORSE on both
  // the golden corpus and an independent hold-out, so it stays.
  const sign = hash & 1 ? 1 : -1;
  vector[index] += sign * weight;
}

/**
 * Accumulate the deterministic bag-of-features for one already-tokenized
 * text into `vector`. Shared by every hash-based provider in this file so
 * the document side and the query side stay in lockstep.
 *
 * The two modes are asymmetric, mirroring how a trained retriever is
 * given separate query/document encoders:
 *
 * - `"document"` — index-side text. Emits word bigrams: stored memories
 *   are phrased, and a bigram is what tells "dark mode" from "dark
 *   theme". Documents discriminate, so they keep every feature.
 * - `"query"` — retrieval-side text. Suppresses bigrams. A question's
 *   bigrams ("does the", "do we") essentially never occur verbatim in a
 *   stored memory, so under 384-bucket hashing they are pure collision
 *   noise that dilutes the cosine. Queries recall, so they keep only
 *   the concept-level features (unigrams, plural folds, synonyms,
 *   character n-grams for typos and OOV).
 */
function accumulateLexicalFeatures(
  vector: number[],
  tokens: string[],
  mode: LexicalMode,
): void {
  for (const token of new Set(tokens)) {
    addFeature(
      vector,
      `tok:${token}`,
      LOW_INFORMATION_TOKENS.has(token) ? LOW_INFORMATION_WEIGHT : 1,
    );
    const plural = foldPlural(token);
    if (plural !== token) {
      addFeature(vector, `plu:${plural}`, PLURAL_FEATURE_WEIGHT);
    }
    for (let length = 3; length <= Math.min(token.length, 5); length += 1) {
      for (let index = 0; index <= token.length - length; index += 1) {
        addFeature(vector, `ng:${token.slice(index, index + length)}`, 0.12);
      }
    }
    for (const synonym of SYNONYMS[token] ?? []) {
      addFeature(vector, `tok:${synonym}`, 0.45);
    }
  }

  // Bigrams are document-side only: see the mode contract above.
  if (mode === "document") {
    for (let index = 0; index < tokens.length - 1; index += 1) {
      addFeature(
        vector,
        `bi:${tokens[index]}:${tokens[index + 1]}`,
        WORD_BIGRAM_WEIGHT,
      );
    }
  }
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

/**
 * Deterministic, dependency-free feature-hash embedder.
 *
 * Not a trained model: it is a signed-hashed bag of word unigrams,
 * plural folds, hand-maintained synonyms, character 3–5-grams, and (on
 * the document side only) word bigrams, L2-normalized into `dimensions`
 * buckets. Good enough for offline eval, tests, and small corpora; it
 * cannot generalize the way a real sentence embedding does.
 *
 * Query and document encoding are asymmetric — {@link embedQuery} drops
 * bigrams and therefore scores a query differently from the same text
 * fed to {@link embed}. Because of that, `model` carries a scheme
 * suffix: storage keys embeddings by model (see
 * `StorageAdapter.querySimilarEmbeddings`), so a change to the feature
 * scheme must change the key or vectors written by an older build would
 * silently be compared against vectors generated by a newer one. The
 * startup backfill in MemOS re-embeds nodes whose stored model differs,
 * so bumping the suffix is self-healing.
 */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "local-hash";
  public readonly model: string;
  public readonly dimensions: number;

  constructor(options: { dimensions?: number; model?: string } = {}) {
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.model = options.model ?? `local-hash-${this.dimensions}-v2`;
  }

  embed(text: string): Promise<EmbeddingVector> {
    return Promise.resolve(this.encode(text, "document"));
  }

  /**
   * Query-side encoding: same feature space, but bigram-suppressed.
   * `MemOS` routes all search queries here when the method exists, which
   * is what makes the asymmetry bite.
   */
  embedQuery(text: string): Promise<EmbeddingVector> {
    return Promise.resolve(this.encode(text, "query"));
  }

  private encode(text: string, mode: LexicalMode): EmbeddingVector {
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = tokenize(text);
    accumulateLexicalFeatures(vector, tokens, mode);
    return normalizeVector(vector);
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "ollama";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly queryPrefix: string;
  private readonly documentPrefix: string;

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
  private readonly queryPrefix: string;
  private readonly documentPrefix: string;

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
}

/**
 * Voyage AI embedding provider.
 *
 * Voyage's `voyage-3` family is the strongest open-weight-class
 * retrieval model we can hit over HTTP, and it's a common default
 * for serious RAG work. The provider uses the public
 * `https://api.voyageai.com/v1/embeddings` endpoint and Bearer auth.
 *
 * Voyage is an ASYMMETRIC retriever: it prepends a different prompt to
 * query text than to document text, keyed on the `input_type` argument.
 * Leaving `input_type` unset (the API's `null` default) makes the model
 * emit a "direct" vector that is neither query- nor document-tailored,
 * which silently forfeits the whole retrieval gain. So this provider
 * sends `input_type: "document"` on the index side and
 * `input_type: "query"` on the query side. Voyage documents the two as
 * compatible within one space, so no model-version key is needed.
 */
export class VoyageAIEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "voyage";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  /** `input_type` used for index-side text (`embed` / `batchEmbed`). */
  private readonly inputType: string | null;
  /** `input_type` used for retrieval-side text (`embedQuery`). */
  private readonly queryInputType: string | null;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      dimensions?: number;
      baseUrl?: string;
      /** Override the index-side `input_type`. Pass `null` for the raw
       *  API default (no retrieval prompt — not recommended). */
      inputType?: string | null;
      /** Override the query-side `input_type`. Pass `null` to embed
       *  queries exactly like documents. */
      queryInputType?: string | null;
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
    this.inputType =
      options.inputType === undefined ? "document" : options.inputType;
    this.queryInputType =
      options.queryInputType === undefined ? "query" : options.queryInputType;
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return this.callEmbeddings([text], this.inputType).then((v) => v[0]);
  }

  /** Query-side encoding: `input_type: "query"` (see the class doc). */
  embedQuery(text: string): Promise<EmbeddingVector> {
    return this.callEmbeddings([text], this.queryInputType).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbeddings(texts, this.inputType);
  }

  private async callEmbeddings(
    texts: string[],
    inputType: string | null,
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
        // Omitted entirely when null — that is the API's own default.
        ...(inputType === null ? {} : { input_type: inputType }),
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

  const provider = config?.provider ?? "fastembed";
  // NOTE: "fastembed" is the default because a bare `new MemOS()` should
  // give real local semantic search. FastEmbedEmbeddingProvider lazily
  // loads the transformers pipeline on first use and degrades loudly to
  // the deterministic local hash when the optional peer dep isn't
  // installed — so the default is always safe, just sometimes degraded.
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
 *
 * embed-v3 and later are asymmetric: Cohere's own documents state that
 * a corpus must be embedded with `input_type: "search_document"` and
 * every query with `input_type: "search_query"` — the two use different
 * prompts and mixing them degrades retrieval. `embedQuery()` therefore
 * sends `search_query`, while `embed`/`batchEmbed` keep
 * `search_document`. Models that do not support `search_query` can set
 * `queryInputType: null` to fall back to the document form.
 */
export class CohereEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "cohere";
  public readonly model: string;
  public readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  /** `input_type` used for index-side text (`embed` / `batchEmbed`). */
  private readonly inputType: string;
  /** `input_type` used for retrieval-side text (`embedQuery`). */
  private readonly queryInputType: string;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      dimensions?: number;
      baseUrl?: string;
      inputType?: string;
      /** Query-side counterpart of `inputType`. Set to the same value as
       *  `inputType` for a symmetric (non-retrieval) setup. */
      queryInputType?: string;
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
    // `search_document` is the right value for indexing; queries now get
    // the documented `search_query` counterpart instead of requiring a
    // second provider instance (see the class doc).
    this.inputType = options.inputType ?? "search_document";
    this.queryInputType = options.queryInputType ?? "search_query";
  }

  async embed(text: string): Promise<EmbeddingVector> {
    return this.callEmbed([text], this.inputType).then((v) => v[0]);
  }

  /** Query-side encoding: `input_type: "search_query"` (see class doc). */
  embedQuery(text: string): Promise<EmbeddingVector> {
    return this.callEmbed([text], this.queryInputType).then((v) => v[0]);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    return this.callEmbed(texts, this.inputType);
  }

  private async callEmbed(
    texts: string[],
    inputType: string,
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

  constructor(options: { model?: string; dimensions?: number } = {}) {
    this.model = options.model ?? "BAAI/bge-small-en-v1.5";
    this.dimensions = options.dimensions ?? 384;
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
      // `-v2` marks the current local-hash feature scheme (see
      // `LocalHashEmbeddingProvider`): storage keys embedding rows by
      // model, so a scheme change must change the key or the old rows
      // would silently be compared against new query vectors. The
      // startup backfill re-embeds rows whose key no longer matches.
      resolvedModel: this.fallbackReason
        ? `local-hash-fallback-${this.dimensions}-v2`
        : this.model,
      modelRevision: null,
      requestedDimensions: this.dimensions,
      observedDimensions: this.lastObservedDimensions,
      fallbackActive: this.fallbackReason !== null,
      fallbackReason: this.fallbackReason,
    };
  }

  /** Dimensions seen on the most recent embed/batchEmbed result. */
  private lastObservedDimensions: number | null = null;

  /**
   * Lazily resolve the transformers pipeline. We use a dynamic import so
   * the optional dep is only paid for when (and if) the user installs it.
   * Any failure to load silently falls back to the local hash.
   *
   * Tries `@huggingface/transformers` (the maintained successor) first,
   * then falls back to the abandoned `@xenova/transformers` for users who
   * still have it installed.
   */
  private async resolve(): Promise<void> {
    if (this.resolved) return;
    this.resolved = true;
    try {
      // Both packages are optional peer deps — users opt in by installing
      // one of them. We use dynamic imports so they're only paid for when
      // installed. Types are declared in `src/xenova-transformers.d.ts`.
      const mod = (await import("@huggingface/transformers" as string).catch(
        () => null,
      )) as {
        pipeline: (task: string, model: string) => Promise<unknown>;
      } | null;
      const legacyMod = mod
        ? null
        : ((await import("@xenova/transformers" as string).catch(
            () => null,
          )) as {
            pipeline: (task: string, model: string) => Promise<unknown>;
          } | null);
      const resolved = mod ?? legacyMod;
      if (!resolved) {
        // Neither optional peer dep is installed — record WHY so
        // `getRuntimeInfo()` can report the fallback, then fall through
        // to the local hash. (The early return here previously skipped
        // the missing-package reason entirely — the silent-fallback bug.)
        this.fallbackReason =
          "neither @huggingface/transformers nor @xenova/transformers is installed";
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
        "For real embeddings: pnpm add @huggingface/transformers",
    );
  }

  /**
   * Run the resolved real model, or return `null` when the local-hash
   * fallback is in charge. Shared by `embed` and `embedQuery` so the two
   * entry points can differ only in fallback behaviour.
   */
  private async runPipeline(text: string): Promise<EmbeddingVector | null> {
    await this.resolve();
    if (!this.pipeline) return null;
    const out = await this.pipeline(text, {
      pooling: "mean",
      normalize: true,
    });
    this.lastObservedDimensions = out.data.length;
    return Array.from(out.data);
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const viaModel = await this.runPipeline(text);
    return viaModel ?? this.fallbackEmbed(text);
  }

  /**
   * Query-side encoding. The transformers pipelines expose no asymmetric
   * mode, so on the real model this is identical to `embed`; only the
   * deterministic fallback differs (bigram suppression — see
   * {@link fallbackEmbedQuery}).
   */
  async embedQuery(text: string): Promise<EmbeddingVector> {
    const viaModel = await this.runPipeline(text);
    return viaModel ?? this.fallbackEmbedQuery(text);
  }

  async batchEmbed(texts: string[]): Promise<EmbeddingVector[]> {
    await this.resolve();
    if (this.pipeline) {
      // The transformers pipeline runs array input as one batched ONNX
      // session — far cheaper than one session run per text. Batched output
      // is a single Tensor with dims [batch, hidden]; slice it per row.
      // Chunked to bound peak memory on large backfills.
      const CHUNK_SIZE = 32;
      const vectors: EmbeddingVector[] = [];
      for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
        const chunk = texts.slice(i, i + CHUNK_SIZE);
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
    }
    return texts.map((t) => this.fallbackEmbed(t));
  }

  /**
   * Deterministic feature-hash fallback. Produces a `dimensions`-long
   * vector with the same shape (and L2 norm) as a real
   * sentence-transformer embedding, so storage and ranking code is
   * identical to the online path. Uses the same shared feature
   * accumulator as {@link LocalHashEmbeddingProvider}, documents side
   * only — queries go through {@link embedQuery} below.
   */
  private fallbackEmbed(text: string): EmbeddingVector {
    this.lastObservedDimensions = this.dimensions;
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = tokenize(text);
    accumulateLexicalFeatures(vector, tokens, "document");
    return normalizeVector(vector);
  }

  /**
   * Query-side local-hash encoding for the fallback path, so a
   * degraded install still gets the asymmetric query profile instead of
   * scoring queries as if they were documents.
   */
  private fallbackEmbedQuery(text: string): EmbeddingVector {
    this.lastObservedDimensions = this.dimensions;
    const vector = Array.from({ length: this.dimensions }, () => 0);
    const tokens = tokenize(text);
    accumulateLexicalFeatures(vector, tokens, "query");
    return normalizeVector(vector);
  }
}
