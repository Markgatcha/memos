/**
 * Vision (image memory) module surface.
 *
 * Re-exports the CLIP provider, the offline fake provider, and the CLIP
 * query cache so callers import from `@memos/vision` rather than
 * reaching into individual files.
 *
 * @module @memos/vision
 */

export {
  ClipEmbeddingProvider,
  ClipUnavailableError,
  DEFAULT_CLIP_MODEL,
  DEFAULT_CLIP_DIMENSIONS,
} from "./clip.js";
export type { ClipEmbeddingProviderOptions } from "./clip.js";

export { FakeClipProvider } from "./fake-clip.js";
export type { FakeClipProviderOptions } from "./fake-clip.js";

export {
  ClipQueryCache,
  DEFAULT_CLIP_QUERY_CACHE_MAX,
} from "./clip-query-cache.js";
