declare module "@yarflam/potion-base-8m" {
  export function embed(input: string | string[]): Promise<Float32Array[]>;
  export function cosineSimilarity(
    a: Float32Array | number[],
    b: Float32Array | number[],
  ): number;
  export class SemanticSearch {
    index(sentences: string[]): Promise<SemanticSearch>;
    search(
      query: string,
      options?: { nb_results?: number; threshold?: number },
    ): Promise<Array<{ sentence: string; score: number }>>;
  }
}
