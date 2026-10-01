/**
 * Integration tests for RM3-lite PRF expansion gating in hybridSearch.
 *
 * PRF is opt-in (experimental.prfExpansion or MEMOS_PRF=1) and fires only
 * when: the query has 1–3 content terms, the primary keyword leg is thin
 * (<5 results), and the semantic leg has hits to harvest from. When it
 * fires, expansion-only candidates are appended to the keyword leg (never
 * re-ranking primary hits).
 *
 * Scenario: Memory A matches the query via keyword; Memory B matches only
 * via a harvested expansion term ("controller"). B is invisible to the
 * primary keyword leg and the semantic leg (zero vector), so it appears
 * in results IFF the PRF expansion fires.
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class PrfVectorProvider implements EmbeddingProvider {
  public readonly id = "prf-vector";
  public readonly model = "prf-v1";
  public readonly dimensions = 4;

  async embed(text: string): Promise<EmbeddingVector> {
    // Query and Memory A share a direction; Memory B is the zero vector
    // (invisible to the semantic leg).
    if (
      text === "kubernetes ingress" ||
      text.includes("kubernetes ingress controller")
    ) {
      return [1, 0, 0, 0];
    }
    return [0, 0, 0, 0];
  }
}

async function makePrfMemos(prfExpansion?: boolean): Promise<MemOS> {
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: {
      semanticSearch: true,
      namespaces: true,
      ...(prfExpansion ? { prfExpansion: true } : {}),
    },
    embeddings: { enabled: true, provider: new PrfVectorProvider() },
    embeddingQueue: { synchronous: true },
  });
  await memos.init();
  // A: primary keyword hit ("kubernetes", "ingress") + semantic hit.
  await memos.store("The kubernetes ingress controller");
  // B: matches only the harvested expansion term ("controller").
  await memos.store("The controller configuration guide");
  await memos.flushEmbeddings();
  return memos;
}

function contents(results: { node: { content: string } }[]): string[] {
  return results.map((r) => r.node.content);
}

describe("PRF expansion gating (hybridSearch integration)", () => {
  const OLD_ENV = process.env.MEMOS_PRF;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.MEMOS_PRF;
    else process.env.MEMOS_PRF = OLD_ENV;
  });

  test("default off: expansion candidate absent from results", async () => {
    const memos = await makePrfMemos();
    const results = await memos.search("kubernetes ingress");
    const c = contents(results);
    expect(c).toContain("The kubernetes ingress controller");
    // B is in no leg without PRF: no keyword match, zero semantic vector.
    expect(c).not.toContain("The controller configuration guide");
    await memos.close();
  });

  test("config opt-in (experimental.prfExpansion): expansion candidate appears", async () => {
    const memos = await makePrfMemos(true);
    const results = await memos.search("kubernetes ingress");
    const c = contents(results);
    expect(c).toContain("The kubernetes ingress controller");
    expect(c).toContain("The controller configuration guide");
    // Primary hit still ranks first: PRF appends, never re-ranks.
    expect(c[0]).toBe("The kubernetes ingress controller");
    await memos.close();
  });

  test("env opt-in (MEMOS_PRF=1): expansion candidate appears", async () => {
    process.env.MEMOS_PRF = "1";
    const memos = await makePrfMemos();
    const results = await memos.search("kubernetes ingress");
    expect(contents(results)).toContain("The controller configuration guide");
    await memos.close();
  });

  test("thin-primary-leg gating: rich keyword leg blocks expansion", async () => {
    const memos = await makePrfMemos(true);
    // Flood the primary keyword leg (≥5 hits) so PRF stays off.
    for (let i = 0; i < 5; i++) {
      await memos.store(`kubernetes ingress note ${i}`);
    }
    await memos.flushEmbeddings();
    const results = await memos.search("kubernetes ingress");
    // B would only arrive via expansion; the rich primary leg gates it.
    expect(contents(results)).not.toContain(
      "The controller configuration guide",
    );
    await memos.close();
  });
});
