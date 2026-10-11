/**
 * Fake CLIP provider — the offline test seam for the image-embedding
 * foundation.
 *
 * Produces a DETERMINISTIC 512-d normalized vector from the pixel bytes
 * (a feature hash over the buffer), with no model download, no network,
 * and no `@huggingface/transformers` dependency. It exists so the rest
 * of the image-memory suite (storage isolation, querySimilarImages,
 * the vectorCache namespace guarantee) can run offline and
 * deterministically — exactly the role the FastEmbed local-hash
 * fallback plays for text.
 *
 * It is deliberately NOT wired into production code: it is exported for
 * tests and for callers who want a deterministic stand-in. Real installs
 * use {@link ClipEmbeddingProvider} via `vision.clip.embedImage` or the
 * lazy default.
 *
 * Semantics:
 * - `embedImage(bytes)` hashes the raw bytes → 512-d, normalized.
 * - `embedImageText(query)` hashes the query STRING → 512-d, normalized.
 * - Same input always gives the same vector (assert-able in tests).
 * - `embedImageText` with a query whose text matches a previously
 *   embedded image's content produces a related-but-distinct vector —
 *   the fake is a hash, not a similarity model, so cross-modal
 *   "similarity" is only what tests choose to construct.
 *
 * @module @memos/vision/fake-clip
 */

import { normalizeVector } from "../embeddings.js";
import type { EmbedImageProvider, EmbeddingVector } from "../types.js";

/** Feature-hash weight table shared by image and text sides. */
const FEATURE_WEIGHT = 1;
const NGRAM_WEIGHT = 0.12;
const BIGRAM_WEIGHT = 0.35;

/**
 * Deterministic feature-hash vector, mirroring the text local-hash
 * fallback's construction so the two spaces behave the same way under
 * test (same norm, same shape, same determinism).
 */
function hashVector(source: Uint8Array, dims: number): EmbeddingVector {
  const vector = new Array<number>(dims).fill(0);
  const add = (feature: string, weight: number): void => {
    // FNV-1a 32-bit over the feature string, folded into the dims range.
    let hash = 0x811c9dc5;
    for (let i = 0; i < feature.length; i += 1) {
      hash ^= feature.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const slot = hash % dims;
    const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
    vector[slot] += sign * weight;
  };
  // Byte-level bigrams over the raw buffer: stable, cheap, and sensitive
  // to both ordering and content (so two different images hash
  // differently, and the same bytes always hash identically).
  for (let i = 0; i + 1 < source.length; i += 2) {
    add(`b${source[i]}:${source[i + 1]}`, FEATURE_WEIGHT);
  }
  // Structural n-grams of the first 4 bytes (header signature) — a
  // coarse, real-ish signal that two JPEGs share more than two random
  // PNGs do, without pretending to be a vision model.
  if (source.length >= 4) {
    add(`h${source[0]}:${source[1]}:${source[2]}:${source[3]}`, NGRAM_WEIGHT);
    add(`h${source[0]}:${source[1]}`, BIGRAM_WEIGHT);
  }
  // Length signature: guards against short inputs hashing to the
  // all-zero vector (an empty normalized vector scores 0 against
  // everything and would make two distinct short inputs look equal).
  add(`len:${source.length}`, FEATURE_WEIGHT);
  if (source.length === 0) {
    // A truly empty input still gets a deterministic non-zero vector so
    // it never collides with another short input's zero vector.
    vector[0] += FEATURE_WEIGHT;
  }
  return normalizeVector(vector);
}

/** Hash a string into the same feature space. */
function hashText(text: string, dims: number): EmbeddingVector {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i * 2] = text.charCodeAt(i) & 0xff;
    bytes[i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xff;
  }
  return hashVector(bytes, dims);
}

export interface FakeClipProviderOptions {
  model?: string;
  dimensions?: number;
}

/**
 * Deterministic offline stand-in for {@link ClipEmbeddingProvider}.
 *
 * @example
 * ```ts
 * const clip = new FakeClipProvider();
 * const v = await clip.embedImage(Buffer.from([0xff, 0xd8, 0xff])); // 512-d
 * ```
 */
export class FakeClipProvider implements EmbedImageProvider {
  readonly id = "fake-clip";
  readonly model: string;
  readonly dimensions: number;

  /** Counts embedImage calls — useful for asserting cache behavior. */
  imageCalls = 0;
  /** Counts embedImageText calls. */
  textCalls = 0;

  constructor(options: FakeClipProviderOptions = {}) {
    this.model = options.model ?? "fake-clip-vit-base-patch32";
    this.dimensions = options.dimensions ?? 512;
  }

  async embedImage(image: Buffer | string): Promise<EmbeddingVector> {
    this.imageCalls += 1;
    const bytes =
      typeof image === "string"
        ? new TextEncoder().encode(image)
        : new Uint8Array(image);
    return hashVector(bytes, this.dimensions);
  }

  async embedImageText(query: string): Promise<EmbeddingVector> {
    this.textCalls += 1;
    // The model id is mixed into the hash so two fake providers with
    // different model names (but identical query text) produce
    // DIFFERENT vectors — that's what proves the cache is keyed by
    // model, not by query alone.
    return hashText(`${this.model}\u0000${query}`, this.dimensions);
  }
}
