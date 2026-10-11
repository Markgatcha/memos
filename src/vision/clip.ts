/**
 * CLIP image-embedding provider (Track B of image memory).
 *
 * Encodes images with `Xenova/clip-vit-base-patch32` via
 * `@huggingface/transformers` (the same optional peer dependency the text
 * FastEmbed provider uses), entirely in-process — no API key, no network
 * beyond the first model download (~350 MB, cached on disk like the text
 * model).
 *
 * Design constraints, all deliberate:
 *
 * 1. **Lazy load.** The pipeline is constructed on the FIRST embed call,
 *    not in the constructor — constructing a MemOS instance must never
 *    pay a model download. Mirrors `FastEmbedEmbeddingProvider.resolve()`.
 * 2. **Fail soft.** If the transformers package is missing (or the model
 *    can't be built), `embedImage` throws a typed {@link ClipUnavailableError}
 *    so the write path can record `clipStatus: "failed"` — but the
 *    provider NEVER silently substitutes a text vector for an image
 *    vector. That substitution is the one failure mode that corrupts
 *    retrieval invisibly.
 * 3. **Separate contract from EmbeddingProvider.** CLIP's 512-d space is
 *    not comparable with bge's 384-d text space; the two vector tables
 *    exist precisely so they can never be mixed. The class satisfies
 *    {@link EmbedImageProvider} so it can also be dropped into
 *    `vision.clip.embedImage` directly.
 * 4. **Text side.** `embedImageText` encodes a query through CLIP's text
 *    encoder. Note CLIP's documented limitation: its text encoder is
 *    trained on short captions (<77 tokens) and is a weak text retriever
 *    — it is excellent at cross-modal matching ("a cat on a couch" →
 *    that photo), which is exactly what the image leg uses it for.
 *
 * @module @memos/vision/clip
 */

import { normalizeVector } from "../embeddings.js";
import type { EmbedImageProvider, EmbeddingVector } from "../types.js";

/** Default CLIP model — ViT-B/32, 512-d image space. */
export const DEFAULT_CLIP_MODEL = "Xenova/clip-vit-base-patch32";

/** Default CLIP dimensionality. */
export const DEFAULT_CLIP_DIMENSIONS = 512;

/**
 * Thrown when the CLIP pipeline could not be constructed (missing
 * optional dependency, model load failure, or no callable interface).
 * The write path catches this and records `clipStatus: "failed"`;
 * nothing ever falls back to a text vector.
 */
export class ClipUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClipUnavailableError";
  }
}

/**
 * Minimal shape of the transformers.js image pipeline, narrowed from the
 * installed package at runtime (types are absent when the optional dep
 * isn't installed, hence the structural cast at the import site).
 */
interface ImageExtractionCallable {
  (
    images: unknown,
    opts?: { pool?: boolean },
  ): Promise<{ data: Float32Array; dims: number[] }>;
}

/** Minimal shape of a loaded `RawImage`. */
interface RawImageLike {
  rgb(): RawImageLike;
  resize(width: number, height: number): RawImageLike;
}

export interface ClipEmbeddingProviderOptions {
  model?: string;
  dimensions?: number;
}

/**
 * CLIP image encoder. Lazy, optional-dependency-tolerant, and separate
 * from the text embedding pipeline by construction.
 *
 * @example
 * ```ts
 * const clip = new ClipEmbeddingProvider();
 * const vector = await clip.embedImage(fs.readFileSync("cat.png")); // 512-d
 * const query = await clip.embedImageText("a cat on a couch");       // 512-d
 * ```
 */
export class ClipEmbeddingProvider implements EmbedImageProvider {
  readonly id = "clip";
  readonly model: string;
  readonly dimensions: number;

  private extractor: ImageExtractionCallable | null = null;
  private resolveAttempted = false;
  /** Why the pipeline could not be built, or null when it loaded fine. */
  private failureReason: string | null = null;

  constructor(options: ClipEmbeddingProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_CLIP_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_CLIP_DIMENSIONS;
  }

  /**
   * Why the CLIP pipeline is unavailable, or null when it loaded (or has
   * not been probed yet). The write path records this in
   * `metadata.clip.error` so a degraded install is diagnosable.
   */
  get fallbackReason(): string | null {
    return this.failureReason;
  }

  /** True once the pipeline has been successfully constructed. */
  get available(): boolean {
    return this.extractor !== null;
  }

  /**
   * Lazily resolve the transformers pipeline. Tries
   * `@huggingface/transformers` first, then the legacy
   * `@xenova/transformers`, exactly like the text provider's fallback
   * chain. Resolved at most once — a failure is sticky so repeated
   * embed calls fail fast instead of retrying a doomed model load.
   */
  private async resolve(): Promise<void> {
    if (this.resolveAttempted) return;
    this.resolveAttempted = true;
    try {
      const mod = (await import("@huggingface/transformers" as string).catch(
        () => null,
      )) as {
        pipeline: (task: string, model: string) => Promise<unknown>;
        RawImage?: { read(input: unknown): Promise<RawImageLike> };
      } | null;
      const legacyMod = mod
        ? null
        : ((await import("@xenova/transformers" as string).catch(
            () => null,
          )) as {
            pipeline: (task: string, model: string) => Promise<unknown>;
            RawImage?: { read(input: unknown): Promise<RawImageLike> };
          } | null);
      const resolved = mod ?? legacyMod;
      if (!resolved || typeof resolved.pipeline !== "function") {
        this.failureReason =
          "neither @huggingface/transformers nor @xenova/transformers is installed";
        return;
      }
      const pipeline = await resolved.pipeline(
        "image-feature-extraction",
        this.model,
      );
      // transformers.js v3+/v4 pipelines are Callable instances (the
      // class is wrapped in a function closure); older shapes exposed
      // `._call`. Normalize both behind one callable.
      const callable =
        typeof pipeline === "function"
          ? (pipeline as ImageExtractionCallable)
          : ((
              pipeline as {
                _call?: ImageExtractionCallable;
                feature?: ImageExtractionCallable;
              }
            )._call ??
            (
              pipeline as {
                _call?: ImageExtractionCallable;
                feature?: ImageExtractionCallable;
              }
            ).feature ??
            null);
      if (!callable) {
        this.failureReason = `pipeline for model "${this.model}" exposed no callable image-feature-extraction interface`;
        return;
      }
      this.extractor = callable;
    } catch (err) {
      this.failureReason = `CLIP pipeline construction failed for model "${this.model}": ${String(
        err,
      ).substring(0, 200)}`;
    }
  }

  /** Reference to the lazily-resolved `RawImage`, or null. */
  private async resolveRawImage(): Promise<{
    read(input: unknown): Promise<RawImageLike>;
  } | null> {
    const mod = (await import("@huggingface/transformers" as string).catch(
      () => null,
    )) as { RawImage?: { read(input: unknown): Promise<RawImageLike> } } | null;
    if (mod?.RawImage) return mod.RawImage;
    const legacy = (await import("@xenova/transformers" as string).catch(
      () => null,
    )) as { RawImage?: { read(input: unknown): Promise<RawImageLike> } } | null;
    return legacy?.RawImage ?? null;
  }

  /**
   * Encode image bytes (or a path/URL) into the CLIP image space.
   *
   * A `Buffer` is wrapped in a `Blob` because `RawImage.read` accepts
   * `RawImage | string | URL | Blob | canvas` natively — a raw Node
   * Buffer is not one of those.
   *
   * @throws {@link ClipUnavailableError} when the pipeline is missing.
   */
  async embedImage(image: Buffer | string): Promise<EmbeddingVector> {
    await this.resolve();
    if (!this.extractor) {
      throw new ClipUnavailableError(
        `CLIP image encoding unavailable: ${this.failureReason ?? "pipeline not resolved"}`,
      );
    }
    let decoded: unknown = image;
    if (typeof image !== "string") {
      // Node Buffer → Blob. No mime known at this layer; the decoder
      // sniffs the format from the header, same as a file path would be.
      const blob = new Blob([new Uint8Array(image)]);
      const RawImage = await this.resolveRawImage();
      if (RawImage) {
        try {
          decoded = await RawImage.read(blob);
        } catch (err) {
          throw new ClipUnavailableError(
            `CLIP image decode failed for model "${this.model}": ${String(
              err,
            ).substring(0, 200)}`,
            err,
          );
        }
      } else {
        decoded = blob;
      }
    }
    let out: { data: Float32Array; dims: number[] };
    try {
      out = await this.extractor(decoded);
    } catch (err) {
      // An encode failure (unsupported/corrupt image bytes, ONNX
      // runtime error) is a REAL failure the write path must see —
      // wrap it so callers catch one typed error, never a bare Error
      // they might mistake for something else. The provider still
      // never substitutes a text vector.
      throw new ClipUnavailableError(
        `CLIP image encoding failed for model "${this.model}": ${String(
          err,
        ).substring(0, 200)}`,
        err,
      );
    }
    if (!out || !out.data || out.data.length === 0) {
      throw new ClipUnavailableError(
        `CLIP image encoding produced an empty tensor for model "${this.model}"`,
      );
    }
    if (out.data.length !== this.dimensions) {
      // A projection mismatch means the configured dimensions no longer
      // describe the model's output space — refuse rather than persist
      // vectors that querySimilarImages would filter out or, worse,
      // score against the wrong space.
      throw new ClipUnavailableError(
        `CLIP model "${this.model}" produced ${out.data.length} dims, expected ${this.dimensions}`,
      );
    }
    return normalizeVector(Array.from(out.data));
  }

  /**
   * Encode a text query into the CLIP image space, so a text→image
   * cosine query works. Uses the `feature-extraction` pipeline (CLIP's
   * text encoder).
   *
   * When unavailable, the caller should degrade to the caption leg
   * (Track A) rather than fail the query.
   *
   * @throws {@link ClipUnavailableError} when the text pipeline is missing.
   */
  async embedImageText(query: string): Promise<EmbeddingVector> {
    await this.resolve();
    if (!this.extractor) {
      throw new ClipUnavailableError(
        `CLIP text encoding unavailable: ${this.failureReason ?? "pipeline not resolved"}`,
      );
    }
    let out: { data: Float32Array; dims: number[] };
    try {
      out = await this.extractor(query);
    } catch (err) {
      throw new ClipUnavailableError(
        `CLIP text encoding failed for model "${this.model}": ${String(
          err,
        ).substring(0, 200)}`,
        err,
      );
    }
    if (!out || !out.data || out.data.length === 0) {
      throw new ClipUnavailableError(
        `CLIP text encoding produced an empty tensor for model "${this.model}"`,
      );
    }
    if (out.data.length !== this.dimensions) {
      throw new ClipUnavailableError(
        `CLIP text model "${this.model}" produced ${out.data.length} dims, expected ${this.dimensions}`,
      );
    }
    return normalizeVector(Array.from(out.data));
  }
}
