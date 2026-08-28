// Optional peer dependency type shims. `@huggingface/transformers`
// (the maintained successor) and `@xenova/transformers` (abandoned,
// kept as a fallback) are loaded dynamically by
// FastEmbedEmbeddingProvider when the user has installed one of them.
// We declare a minimal surface here so the project builds even when
// neither package is in the dependency graph.

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
