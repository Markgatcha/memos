/**
 * Contextual retrieval (document-side): when `embeddings.contextual` is
 * enabled, the text that gets embedded carries a compact situational
 * header derived from metadata — session, timestamp, speaker — while the
 * stored content and the FTS index stay verbatim. This is the cheap
 * "contextual chunk header" trick from the RAG literature, adapted to
 * memory nodes. It is on by default for semantic providers and can be
 * disabled with `contextual: false` (or `MEMOS_CONTEXTUAL=0`).
 */

import { describe, expect, test } from "@jest/globals";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

class CapturingProvider implements EmbeddingProvider {
  public readonly id = "capture";
  public readonly model = "capture-v1";
  public readonly dimensions = 4;
  public readonly calls: string[] = [];

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls.push(text);
    return [1, 0, 0, 0];
  }
}

function makeMemos(provider: CapturingProvider, contextual?: boolean): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    embeddings: {
      enabled: true,
      provider,
      ...(contextual === undefined ? {} : { contextual }),
    },
    embeddingQueue: { synchronous: true },
  });
}

const META = {
  sessionId: "session_2",
  timestamp: "7 May 2023",
  speaker: "Caroline",
};

describe("contextual embedding headers", () => {
  test("derives session · date · speaker from metadata", async () => {
    const provider = new CapturingProvider();
    const memos = makeMemos(provider, true);
    await memos.init();
    await memos.store("Researching adoption agencies.", { metadata: META });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toContain("[session_2 · 7 May 2023 · Caroline]");
    await memos.close();
  });

  test("on by default for semantic providers", async () => {
    const provider = new CapturingProvider();
    const memos = makeMemos(provider);
    await memos.init();
    await memos.store("Researching adoption agencies.", { metadata: META });

    expect(provider.calls[0]).toContain("session_2");
    await memos.close();
  });

  test("can be disabled explicitly", async () => {
    const provider = new CapturingProvider();
    const memos = makeMemos(provider, false);
    await memos.init();
    await memos.store("Researching adoption agencies.", { metadata: META });

    expect(provider.calls[0]).not.toContain("session_2");
    await memos.close();
  });

  test("an explicit context wins over the derived header", async () => {
    const provider = new CapturingProvider();
    const memos = makeMemos(provider, true);
    await memos.init();
    await memos.store("Researching adoption agencies.", {
      context: "[adoption project]",
      metadata: META,
    });

    expect(provider.calls[0]?.startsWith("[adoption project]")).toBe(true);
    expect(provider.calls[0]).not.toContain("session_2");
    await memos.close();
  });

  test("plain facts (no session metadata) are unchanged", async () => {
    const provider = new CapturingProvider();
    const memos = makeMemos(provider, true);
    await memos.init();
    await memos.store("The deploy pipeline uses pnpm.");

    expect(provider.calls[0]?.startsWith("[")).toBe(false);
    await memos.close();
  });

  test("local-hash keeps plain text even with contextual on", async () => {
    // The deterministic fallback hashes tokens; a header would dilute the
    // lexical signal. The automatic header is semantic-provider only.
    class LexicalProvider extends CapturingProvider {
      public readonly id = "local-hash";
    }
    const provider = new LexicalProvider();
    const memos = makeMemos(provider, true);
    await memos.init();
    await memos.store("Researching adoption agencies.", { metadata: META });

    expect(provider.calls[0]).not.toContain("session_2");
    await memos.close();
  });
});
