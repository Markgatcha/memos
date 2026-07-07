// Optional peer dependency type shim. `@xenova/transformers` is
// loaded dynamically by FastEmbedEmbeddingProvider when the user
// has installed it. We declare a minimal surface here so the
// project builds even when the package isn't in the dependency
// graph.

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
