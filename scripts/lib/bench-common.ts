/**
 * Shared benchmark infrastructure: provider loading, strict-mode fallback
 * detection, dataset hashing, and reproducibility metadata.
 *
 * Every benchmark script (bench-quality, bench-locomo-noapi, bench-locomo,
 * bench-longmemeval) uses this module so that:
 *   - provider selection is consistent (CLI --provider=... > env var > default);
 *   - an embedding fallback is either VISIBLE (default) or FATAL
 *     (--fail-on-embedding-fallback) — never silent;
 *   - every result JSON records what produced it (schema version, git SHA,
 *     dataset hash, provider, model, dimensions, latency percentiles, OS).
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { platform, release } from "node:os";

import type {
  EmbeddingProvider,
  EmbeddingRuntimeInfo,
} from "../../src/types.js";
import {
  LocalHashEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
  VoyageAIEmbeddingProvider,
  CohereEmbeddingProvider,
  FastEmbedEmbeddingProvider,
} from "../../src/embeddings.js";

// ─── CLI parsing ─────────────────────────────────────────────────────────────

export interface BenchProviderArgs {
  /** e.g. "local-hash" | "fastembed" | "ollama" | ... (CLI --provider=) */
  provider: string;
  /** Model name (CLI --model=). */
  model?: string;
  /** Vector dimensions (CLI --dimensions=). */
  dimensions?: number;
  /** Base URL for HTTP providers (CLI --base-url=, env *_BASE_URL). */
  baseUrl?: string;
  /** API key for HTTP providers (CLI --api-key=, env *_API_KEY). */
  apiKey?: string;
  /** Query-side instruction (CLI --query-prefix=, env EMBEDDING_QUERY_PREFIX).
   *  Asymmetric retrievers (Liquid LFM2.5-Embedding, e5) need e.g. "query: ". */
  queryPrefix?: string;
  /** Document-side tag (CLI --document-prefix=, env EMBEDDING_DOCUMENT_PREFIX),
   *  e.g. "document: " for LFM2.5-Embedding / e5 index text. */
  documentPrefix?: string;
  /** Terminate with error when the requested backend did not load. */
  failOnEmbeddingFallback: boolean;
}

/**
 * Parse provider-related CLI flags (and their env fallbacks) from a raw
 * argv array. CLI flags take precedence over environment variables.
 *
 * Supported flags:
 *   --provider=local-hash|fastembed|ollama|openai-compatible|voyage|cohere
 *   --model=<name>        --dimensions=<n>
 *   --base-url=<url>      --api-key=<key>
 *   --query-prefix=<str>  --document-prefix=<str>
 *   --fail-on-embedding-fallback
 *
 * Env fallbacks: EMBEDDING_PROVIDER, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS,
 * EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_QUERY_PREFIX,
 * EMBEDDING_DOCUMENT_PREFIX (plus provider-specific keys such as
 * VOYAGE_API_KEY / COHERE_API_KEY when the provider is selected).
 */
export function parseProviderArgs(argv: string[]): BenchProviderArgs {
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };

  const provider =
    flag("provider") ?? process.env.EMBEDDING_PROVIDER ?? "local-hash";

  let apiKey = flag("api-key");
  if (!apiKey) {
    if (provider === "voyage") apiKey = process.env.VOYAGE_API_KEY;
    else if (provider === "cohere") apiKey = process.env.COHERE_API_KEY;
    else if (provider === "openai-compatible")
      apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) apiKey = process.env.EMBEDDING_API_KEY;
  }

  const dimensionsStr = flag("dimensions") ?? process.env.EMBEDDING_DIMENSIONS;
  const dimensions = dimensionsStr ? parseInt(dimensionsStr, 10) : undefined;

  return {
    provider,
    model: flag("model") ?? process.env.EMBEDDING_MODEL,
    dimensions: Number.isFinite(dimensions) ? dimensions : undefined,
    baseUrl: flag("base-url") ?? process.env.EMBEDDING_BASE_URL,
    apiKey,
    queryPrefix: flag("query-prefix") ?? process.env.EMBEDDING_QUERY_PREFIX,
    documentPrefix:
      flag("document-prefix") ?? process.env.EMBEDDING_DOCUMENT_PREFIX,
    failOnEmbeddingFallback: argv.includes("--fail-on-embedding-fallback"),
  };
}

// ─── Retrieval-configuration flags (fusion / expansion / embed text) ────────

/**
 * Retrieval-side ablation knobs shared by every benchmark script. All
 * fields optional — unset means "MemOS default", so committed baselines
 * stay reproducible while a single flag can rebalance the fusion for a
 * stronger embedding model.
 */
export interface RetrievalArgs {
  fusion: {
    keywordWeight?: number;
    semanticWeight?: number;
    rrfK?: number;
    trustFloor?: number;
    confidenceWeightStrength?: number;
  };
  /** Which node text to embed at store time. */
  embedText?: "content" | "summary+content";
  /** Forced keyword-leg operator (SearchFilter.ftsOperator). */
  ftsOperator?: "AUTO" | "AND" | "OR";
  /** Session-sibling expansion of fused results. */
  sessionExpansion: boolean;
  /** Graph-edge expansion of fused results. */
  graphExpansion: boolean;
}

const NUMERIC_RETRIEVAL_FLAGS: Array<{
  flag: string;
  key: keyof RetrievalArgs["fusion"];
}> = [
  { flag: "keyword-weight", key: "keywordWeight" },
  { flag: "semantic-weight", key: "semanticWeight" },
  { flag: "rrf-k", key: "rrfK" },
  { flag: "trust-floor", key: "trustFloor" },
  { flag: "confidence-weight-strength", key: "confidenceWeightStrength" },
];

/**
 * Parse retrieval-ablation flags from argv. Unknown flags are ignored
 * (provider flags are handled by `parseProviderArgs`).
 */
export function parseRetrievalArgs(argv: string[]): RetrievalArgs {
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };

  const fusion: RetrievalArgs["fusion"] = {};
  for (const { flag: name, key } of NUMERIC_RETRIEVAL_FLAGS) {
    const raw = flag(name);
    if (raw !== undefined) {
      const value = parseFloat(raw);
      if (Number.isFinite(value)) fusion[key] = value;
    }
  }

  const embedTextRaw = flag("embed-text");
  const embedText =
    embedTextRaw === "content" || embedTextRaw === "summary+content"
      ? embedTextRaw
      : undefined;
  const ftsOperatorRaw = flag("fts-operator");
  const ftsOperator =
    ftsOperatorRaw === "AND" || ftsOperatorRaw === "OR"
      ? ftsOperatorRaw
      : undefined;

  return {
    fusion,
    embedText,
    ftsOperator,
    sessionExpansion: argv.includes("--session-expansion"),
    graphExpansion: argv.includes("--graph-expansion"),
  };
}

/**
 * Build the `MemOS` config fragments for parsed retrieval args: fusion
 * options (forwarded to `fuseResults`), the embed-text selection, and the
 * experimental graph-expansion toggle. Empty when nothing was requested,
 * so default baselines are byte-identical to unconfigured runs.
 */
export function retrievalConfig(args: RetrievalArgs): {
  fusion?: Record<string, number>;
  embeddings?: { embedText: "content" | "summary+content" };
  experimental?: { graphExpansion: { enabled: boolean } };
} {
  const config: ReturnType<typeof retrievalConfig> = {};
  if (Object.keys(args.fusion).length > 0) config.fusion = { ...args.fusion };
  if (args.embedText) config.embeddings = { embedText: args.embedText };
  if (args.graphExpansion) {
    config.experimental = { graphExpansion: { enabled: true } };
  }
  return config;
}

// ─── Provider construction ───────────────────────────────────────────────────

/**
 * Build the embedding provider requested by parsed args. Throws on an
 * UNKNOWN provider name (never silently substitutes a different backend).
 *
 * NOTE: this constructs the provider object; for lazy providers (fastembed)
 * the backend may still fail to load later at first embed — that is what
 * `assertNoFallback()` catches.
 */
export function buildProvider(args: BenchProviderArgs): EmbeddingProvider {
  switch (args.provider) {
    case "local-hash":
      return new LocalHashEmbeddingProvider({
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions ? { dimensions: args.dimensions } : {}),
      });
    case "fastembed":
      return new FastEmbedEmbeddingProvider({
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions ? { dimensions: args.dimensions } : {}),
      });
    case "ollama":
      return new OllamaEmbeddingProvider({
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions ? { dimensions: args.dimensions } : {}),
        ...(args.queryPrefix ? { queryPrefix: args.queryPrefix } : {}),
        ...(args.documentPrefix ? { documentPrefix: args.documentPrefix } : {}),
      });
    case "openai-compatible":
      return new OpenAICompatibleEmbeddingProvider({
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions ? { dimensions: args.dimensions } : {}),
        ...(args.queryPrefix ? { queryPrefix: args.queryPrefix } : {}),
        ...(args.documentPrefix ? { documentPrefix: args.documentPrefix } : {}),
      });
    case "voyage":
      if (!args.apiKey) {
        throw new Error(
          "voyage provider requires --api-key= or VOYAGE_API_KEY",
        );
      }
      return new VoyageAIEmbeddingProvider({
        apiKey: args.apiKey,
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions ? { dimensions: args.dimensions } : {}),
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      });
    case "cohere":
      if (!args.apiKey) {
        throw new Error(
          "cohere provider requires --api-key= or COHERE_API_KEY",
        );
      }
      return new CohereEmbeddingProvider({
        apiKey: args.apiKey,
        ...(args.model ? { model: args.model } : {}),
        ...(args.dimensions ? { dimensions: args.dimensions } : {}),
        ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      });
    default:
      throw new Error(
        `Unknown embedding provider "${args.provider}". ` +
          `Supported: local-hash, fastembed, ollama, openai-compatible, voyage, cohere.`,
      );
  }
}

// ─── Fallback enforcement ────────────────────────────────────────────────────

/**
 * Force lazy provider resolution (fastembed) and verify the requested
 * backend actually loaded. In strict mode (--fail-on-embedding-fallback),
 * terminate with a clear error when it did not.
 *
 * Always embeds a probe first so `getRuntimeInfo()` reports the FINAL
 * state (lazy providers resolve on first use). Returns the runtime info
 * actually observed (for the result JSON); providers without
 * `getRuntimeInfo` get a synthesized record from their constructor facts.
 *
 * `hooks.exit` is injectable so tests can assert the strict-mode
 * termination without killing the test runner (defaults to process.exit).
 */
export async function assertNoFallback(
  provider: EmbeddingProvider,
  args: BenchProviderArgs,
  hooks: { exit?: (code: number) => never } = {},
): Promise<EmbeddingRuntimeInfo> {
  // Probe-embed to trigger lazy resolution. Failures here (e.g. HTTP
  // provider with no network) are caught by the caller, not this check —
  // this function only adjudicates FALLBACK state.
  if (provider.getRuntimeInfo) {
    await provider.embed("probe").catch(() => undefined);
  }
  const info =
    provider.getRuntimeInfo?.() ??
    ({
      requestedProvider: args.provider,
      resolvedProvider: provider.id,
      requestedModel: args.model ?? provider.model,
      resolvedModel: provider.model,
      modelRevision: null,
      requestedDimensions: args.dimensions ?? provider.dimensions,
      observedDimensions: null,
      fallbackActive: false,
      fallbackReason: null,
    } satisfies EmbeddingRuntimeInfo);

  if (info.fallbackActive) {
    const msg =
      `Embedding fallback ACTIVE: requested ${info.requestedProvider}` +
      `/${info.requestedModel} but resolved to ${info.resolvedProvider}` +
      `/${info.resolvedModel} (${info.fallbackReason ?? "unknown reason"}).` +
      ` Benchmark results would NOT reflect the requested model.`;
    if (args.failOnEmbeddingFallback) {
      console.error(`[bench] FATAL: ${msg}`);
      (hooks.exit ?? ((code: number) => process.exit(code)))(1);
      // For injectable exits that return; unreachable with process.exit.
      throw new Error(`[bench] FATAL: ${msg}`);
    }
    console.warn(`[bench] WARNING: ${msg}`);
    console.warn(
      "[bench] Scores below were produced by the FALLBACK backend, not the requested model.",
    );
  }

  return info;
}

// ─── Dataset hashing & reproducibility ──────────────────────────────────────

/** SHA-256 of a dataset file, as a hex string. */
export function hashFile(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

/** Current git commit SHA, or "unknown" outside a repo. */
export function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** True when the working tree has uncommitted changes. */
export function gitDirty(): boolean {
  try {
    const out = execSync("git status --porcelain", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

export interface BenchMetadata {
  schemaVersion: number;
  timestamp: string;
  git: { sha: string; dirty: boolean };
  nodeVersion: string;
  os: { platform: string; release: string };
  dataset: { name: string; path: string; sha256: string };
  embedding: EmbeddingRuntimeInfo & {
    /** Provider kind string from CLI/env. */
    providerKind: string;
    /** Query-side prefix (asymmetric retrievers), empty when unset. */
    queryPrefix: string;
    /** Document-side prefix, empty when unset. */
    documentPrefix: string;
  };
  /** Retrieval-ablation settings actually applied (omitted when defaults). */
  retrieval?: Record<string, unknown>;
}

/**
 * Assemble the reproducibility metadata block every benchmark result JSON
 * must carry. Call after provider resolution so fallback state is accurate.
 */
export function benchMetadata(
  args: BenchProviderArgs,
  runtime: EmbeddingRuntimeInfo,
  dataset: { name: string; path: string },
  retrieval?: RetrievalArgs,
): BenchMetadata {
  const retrievalRecord: Record<string, unknown> | undefined = retrieval
    ? {
        ...(Object.keys(retrieval.fusion).length > 0
          ? { fusion: retrieval.fusion }
          : {}),
        ...(retrieval.embedText ? { embedText: retrieval.embedText } : {}),
        ...(retrieval.ftsOperator
          ? { ftsOperator: retrieval.ftsOperator }
          : {}),
        sessionExpansion: retrieval.sessionExpansion,
        graphExpansion: retrieval.graphExpansion,
      }
    : undefined;
  return {
    schemaVersion: 2,
    timestamp: new Date().toISOString(),
    git: { sha: gitSha(), dirty: gitDirty() },
    nodeVersion: process.version,
    os: { platform: platform(), release: release() },
    dataset: {
      name: dataset.name,
      path: dataset.path,
      sha256: existsSync(dataset.path)
        ? hashFile(dataset.path)
        : "file-not-found",
    },
    embedding: {
      ...runtime,
      providerKind: args.provider,
      queryPrefix: args.queryPrefix ?? "",
      documentPrefix: args.documentPrefix ?? "",
    },
    ...(retrievalRecord && Object.keys(retrievalRecord).length > 0
      ? { retrieval: retrievalRecord }
      : {}),
  };
}
