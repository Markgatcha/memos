/**
 * ─── Local cross-encoder reranking ──────────────────────────────────────────
 *
 * In-process alternative to the HTTP `/rerank` endpoint path in
 * `MemOS.applyRerank`. Loads a sequence-classification cross-encoder
 * (default `Xenova/bge-reranker-base`, ~280 MB) through
 * `@huggingface/transformers` (falling back to `@xenova/transformers`),
 * scores `[query, document]` pairs, and returns sigmoid-squashed relevance
 * scores in [0,1].
 *
 * Design rules (same as the endpoint path):
 * - Opt-in only: nothing here runs unless `experimental.rerank` selects the
 *   local provider (or `MEMOS_RERANK_LOCAL=1`).
 * - Any failure — missing package, model download failure, inference
 *   error — returns `null` so the caller keeps the fused ranking. A broken
 *   reranker degrades quality, never availability.
 * - The model is loaded once per (model, dtype) and reused; the download
 *   happens on first use, so the first reranked query pays for it.
 */

import { createRequire } from "node:module";

export const DEFAULT_LOCAL_RERANK_MODEL = "Xenova/bge-reranker-base";

/** Default quantization for local rerank inference. q8 is ~4x faster on CPU. */
export const DEFAULT_LOCAL_RERANK_DTYPE = "q8";

export interface LocalRerankOptions {
  /** HuggingFace model id. Default `Xenova/bge-reranker-base`. */
  model?: string;
  /** Weight dtype passed to `from_pretrained` (e.g. "q8", "fp32"). */
  dtype?: string;
  /** Tokenizer max length for each pair. Default 512. */
  maxLength?: number;
}

/** Minimal surface of a loaded sequence-classification model. */
export interface LocalRerankModel {
  /** Raw (pre-sigmoid) relevance logits, one per pair, in input order. */
  scorePairs(pairs: Array<[string, string]>): Promise<number[]>;
}

export type LocalRerankLoader = (
  model: string,
  dtype: string,
  maxLength: number,
) => Promise<LocalRerankModel | null>;

// ─── test seam ──────────────────────────────────────────────────────────────

let testLoader: LocalRerankLoader | null = null;

/** Test-only override for the model loader (stubbed inference, no download). */
export function __setLocalRerankLoaderForTests(
  loader: LocalRerankLoader | null,
): void {
  testLoader = loader;
}

// ─── default loader (createRequire, cached) ─────────────────────────────────

interface TokenizerTensor {
  type: string;
  data: ArrayLike<unknown>;
  dims: number[];
}

interface TokenizerShape {
  (
    texts: string[][],
    opts?: { padding?: boolean; truncation?: boolean; max_length?: number },
  ): Promise<Record<string, TokenizerTensor | undefined>>;
}

interface OrtTensorClass {
  new (
    type: string,
    data: ArrayLike<unknown>,
    dims: number[],
  ): { location: string };
}

interface InferenceSessionShape {
  inputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, TokenizerTensor>>;
}

interface SequenceClassificationModelShape {
  sessions?: Record<string, InferenceSessionShape | undefined>;
  session?: InferenceSessionShape;
}

interface TransformersModuleShape {
  AutoTokenizer: {
    from_pretrained(model: string): Promise<TokenizerShape>;
  };
  AutoModelForSequenceClassification: {
    from_pretrained(
      model: string,
      opts?: { dtype?: string },
    ): Promise<SequenceClassificationModelShape>;
  };
}

const modelCache = new Map<string, Promise<LocalRerankModel | null>>();
let warnedMissingPackage = false;

/**
 * Tokenize (query, doc) pairs for the cross-encoder. Tries the fast batched
 * path first; some tokenizers (XLM-R family in transformers.js v4) throw on
 * batched pair input (`text.replace is not a function`), in which case we
 * fall back to per-pair tokenization with manual padding. Exported for tests.
 */
export async function tokenizePairsForRerank(
  tokenizer: {
    (
      input: unknown,
      options?: Record<string, unknown>,
    ): Promise<Record<string, TokenTensorLike>>;
    pad_token_id?: number;
  },
  pairs: Array<[string, string]>,
  maxLength: number,
): Promise<Record<string, TokenTensorLike>> {
  try {
    return await tokenizer(pairs, {
      padding: true,
      truncation: true,
      max_length: maxLength,
    });
  } catch {
    const allIds: number[][] = [];
    const allMasks: number[][] = [];
    for (const [q, d] of pairs) {
      const t = await tokenizer(q, {
        text_pair: d,
        truncation: true,
        max_length: maxLength,
      });
      allIds.push(Array.from(t["input_ids"]!.data as ArrayLike<number>));
      allMasks.push(Array.from(t["attention_mask"]!.data as ArrayLike<number>));
    }
    const ml = Math.max(...allIds.map((a) => a.length));
    const B = pairs.length;
    const padId = BigInt(tokenizer.pad_token_id ?? 1);
    const inputIds = new BigInt64Array(B * ml);
    const attnMask = new BigInt64Array(B * ml);
    allIds.forEach((arr, i) => {
      for (let j = 0; j < ml; j++) {
        inputIds[i * ml + j] = j < arr.length ? BigInt(arr[j]!) : padId;
        attnMask[i * ml + j] = j < arr.length ? BigInt(allMasks[i]![j]!) : 0n;
      }
    });
    return {
      input_ids: { type: "int64", data: inputIds, dims: [B, ml] },
      attention_mask: { type: "int64", data: attnMask, dims: [B, ml] },
    };
  }
}

interface TokenTensorLike {
  type: string;
  data:
    | BigInt64Array
    | Float32Array
    | Float64Array
    | Int32Array
    | ArrayLike<number>;
  dims: number[];
}

async function defaultLoader(
  model: string,
  dtype: string,
  maxLength: number,
): Promise<LocalRerankModel | null> {
  const key = `${model}::${dtype}::${maxLength}`;
  let cached = modelCache.get(key);
  if (!cached) {
    cached = (async (): Promise<LocalRerankModel | null> => {
      // Both packages are optional peer deps. We load them with
      // `createRequire` (not dynamic `import()`): the ESM entry of
      // `@huggingface/transformers` v4 does a named import from the CJS
      // `onnxruntime-common` that Node's ESM loader rejects, while the
      // CJS build loads fine.
      const require = createRequire(import.meta.url);
      let spec: string | null = null;
      let resolved: TransformersModuleShape | null = null;
      for (const candidate of [
        "@huggingface/transformers",
        "@xenova/transformers",
      ]) {
        try {
          resolved = require(candidate) as TransformersModuleShape;
          spec = candidate;
          break;
        } catch {
          // try the next package
        }
      }
      if (!resolved || !spec) {
        if (!warnedMissingPackage) {
          warnedMissingPackage = true;
          console.warn(
            "[memos] local rerank unavailable: neither @huggingface/transformers " +
              "nor @xenova/transformers is installed — keeping fused ranking. " +
              "Install one of them to enable local reranking.",
          );
        }
        return null;
      }
      try {
        const tokenizer = await resolved.AutoTokenizer.from_pretrained(model);
        const mdl =
          await resolved.AutoModelForSequenceClassification.from_pretrained(
            model,
            { dtype },
          );
        // Raw InferenceSession: transformers.js v4 wraps input tensors in a
        // way the installed onnxruntime-native binding rejects
        // ("Tensor.location must be a string" — version skew between the
        // wrapper and onnxruntime-node 1.30). Driving the session directly
        // with tensors built from the package's OWN onnxruntime copy avoids
        // the skew entirely.
        const session = mdl.sessions?.["model"] ?? mdl.session;
        if (!session) {
          throw new Error("no inference session exposed on the loaded model");
        }
        const ortRequire = createRequire(require.resolve(spec));
        const ort = ortRequire("onnxruntime-node") as {
          Tensor: OrtTensorClass;
        };
        const inputNames = session.inputNames;

        return {
          async scorePairs(pairs: Array<[string, string]>): Promise<number[]> {
            const batch = await tokenizePairsForRerank(
              tokenizer as Parameters<typeof tokenizePairsForRerank>[0],
              pairs,
              maxLength,
            );
            const feeds: Record<string, unknown> = {};
            const batchDims = batch["input_ids"]?.dims;
            for (const name of inputNames) {
              let t = batch[name];
              if (!t && name === "token_type_ids" && batchDims) {
                // BERT-style models expect segment ids; tokenizers for
                // single-pair cross-encoders sometimes omit them (all zeros
                // is correct for [query, doc] pairs).
                const size = batchDims.reduce((a, b) => a * b, 1);
                t = {
                  type: "int64",
                  data: new BigInt64Array(size),
                  dims: [...batchDims],
                };
              }
              if (!t) continue;
              feeds[name] = new ort.Tensor(t.type, t.data, t.dims);
            }
            const out = await session.run(feeds);
            const logits = out["logits"] ?? out[Object.keys(out)[0]!];
            if (!logits) throw new Error("model returned no outputs");
            const data = logits.data;
            const rowSize =
              logits.dims.length >= 2
                ? logits.dims[logits.dims.length - 1]!
                : 1;
            const result: number[] = [];
            for (let i = 0; i < pairs.length; i += 1) {
              result.push(Number(data[i * rowSize]));
            }
            return result;
          },
        };
      } catch (err) {
        console.error(
          "[memos] local rerank model failed to load " +
            `("${model}", dtype "${dtype}") — keeping fused ranking:`,
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    })();
    modelCache.set(key, cached);
  }
  return cached;
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Score each document against the query with the local cross-encoder.
 * Returns sigmoid-squashed scores in input order, or `null` when the
 * reranker is unavailable — the caller must keep the fused ranking.
 */
export async function scorePairsLocal(
  query: string,
  docs: string[],
  opts: LocalRerankOptions = {},
): Promise<number[] | null> {
  if (docs.length === 0) return [];
  const model = opts.model ?? DEFAULT_LOCAL_RERANK_MODEL;
  const dtype = opts.dtype ?? DEFAULT_LOCAL_RERANK_DTYPE;
  const maxLength = opts.maxLength ?? 512;
  const loader = testLoader ?? defaultLoader;
  let loaded: LocalRerankModel | null;
  try {
    loaded = await loader(model, dtype, maxLength);
  } catch {
    return null;
  }
  if (!loaded) return null;
  try {
    const pairs: Array<[string, string]> = docs.map(
      (doc) => [query, doc] as [string, string],
    );
    const logits = await loaded.scorePairs(pairs);
    if (logits.length !== docs.length) return null;
    return logits.map(sigmoid);
  } catch (err) {
    console.error(
      "[memos] local rerank inference failed — keeping fused ranking:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
