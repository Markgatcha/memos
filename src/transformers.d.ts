// Optional peer dependency type shims. `@huggingface/transformers`
// (the maintained successor) and `@xenova/transformers` (abandoned,
// kept as a fallback) are loaded dynamically by
// FastEmbedEmbeddingProvider and ClipEmbeddingProvider when the user has
// installed one of them. We declare a minimal surface here so the
// project builds even when neither package is in the dependency graph.
//
// The shapes below were verified against the installed
// @huggingface/transformers v4.2.0 type declarations:
//  - `RawImage.read(input)` accepts `RawImage | string | URL | Blob |
//    HTMLCanvasElement | OffscreenCanvas` (utils/image.d.ts).
//  - `pipeline("image-feature-extraction", model)` returns a Callable
//    that resolves to a Tensor; for CLIP-B/32 the tensor dims are
//    `[1, 512]` with a flat `Float32Array` payload.
//  - `pipeline("feature-extraction", model)` (the text side) is already
//    used by FastEmbedEmbeddingProvider.
// NOTE: the shim intentionally stays minimal — when the real package IS
// installed its own types are used at the import site via dynamic
// import with an `as` cast, never through this file.

declare module "@huggingface/transformers" {
  export interface FeatureExtractionOutput {
    data: Float32Array;
  }
  export interface FeatureExtractionPipeline {
    feature(
      text: string,
      opts: { pooling: string; normalize: boolean },
    ): Promise<FeatureExtractionOutput>;
  }
  export function pipeline(
    task: "feature-extraction",
    model: string,
  ): Promise<FeatureExtractionPipeline>;
}

declare module "@xenova/transformers" {
  export interface FeatureExtractionOutput {
    data: Float32Array;
  }
  export interface FeatureExtractionPipeline {
    feature(
      text: string,
      opts: { pooling: string; normalize: boolean },
    ): Promise<FeatureExtractionOutput>;
  }
  export function pipeline(
    task: "feature-extraction",
    model: string,
  ): Promise<FeatureExtractionPipeline>;
}
