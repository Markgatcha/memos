#!/usr/bin/env npx tsx
/**
 * Stage-by-stage profile of one hybrid search, run against the real LoCoMo
 * conv-0 data with the production config. Finds where per-query time goes:
 * query embed → FTS leg → semantic leg → fusion → expansions → rerank.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { MemOS } from "../src/memory.ts";
import { SQLiteStorage } from "../src/storage/sqlite.ts";
import { OpenAICompatibleEmbeddingProvider } from "../src/embeddings.ts";

interface LocoChat {
  speaker: string;
  dia_id: string;
  text: string;
}

async function main(): Promise<void> {
  const rows = JSON.parse(
    readFileSync("scripts/dataset/locomo/data/locomo10.json", "utf8"),
  );
  const conv = {
    conversation: {} as Record<string, unknown>,
    qa: [] as (typeof rows)[number]["qa"],
  };
  for (const r of rows) {
    Object.assign(conv.conversation, r.conversation);
    for (const qa of r.qa) conv.qa.push({ ...qa, question: qa.question });
  }
  const provider = new OpenAICompatibleEmbeddingProvider({
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "LFM2.5-Embedding-350M-BF16",
    dimensions: 1024,
    queryPrefix: "query: ",
    documentPrefix: "document: ",
  });

  const storage = new SQLiteStorage(
    join(tmpdir(), `bench-profile-${Date.now()}.db`),
    false,
  );
  const memos = new MemOS({
    storage,
    wal: false,
    autoLinkThreshold: 0,
    experimental: { namespaces: true, semanticSearch: true },
    embeddings: { enabled: true, provider },
    embeddingQueue: { concurrency: 4, batchSize: 16 },
  });
  await memos.init();

  const ingestStart = Date.now();
  const sessionKeys = Object.keys(conv.conversation).filter(
    (k) => k !== "speaker_a" && k !== "speaker_b" && !k.endsWith("_date_time"),
  );
  for (const sessionKey of sessionKeys) {
    const chats = conv.conversation[sessionKey] as unknown as LocoChat[];
    if (!Array.isArray(chats)) continue;
    for (const chat of chats) {
      if (!chat?.dia_id) continue;
      await memos.store(`${chat.speaker}: ${chat.text}`, {
        namespace: "locomo_full",
        metadata: { dia_id: chat.dia_id },
      });
    }
  }
  await memos.flushEmbeddings();
  console.log(`ingest: ${Date.now() - ingestStart}ms`);

  // Profile 5 queries stage by stage using the internal pipeline.
  const anyMemos = memos as unknown as {
    hybridSearch: (f: unknown, o?: unknown) => Promise<unknown[]>;
    applyRerank: (r: unknown[], f: unknown) => Promise<unknown[]>;
    embeddingProvider: { embedQuery: (q: string) => Promise<number[]> };
    storage: {
      queryNodes: (f: unknown) => Promise<unknown[]>;
      querySimilarEmbeddings: (
        v: number[],
        f: unknown,
        l: number,
        t: number,
        m: string,
      ) => Promise<unknown[]>;
    };
  };

  const timings: Record<string, number[]> = {
    embed: [],
    fts: [],
    semantic: [],
    rerank: [],
    full: [],
  };
  const queries = conv.qa.slice(0, 10);
  for (const qa of queries) {
    const t0 = Date.now();
    const qv = await anyMemos.embeddingProvider.embedQuery(qa.question);
    timings.embed.push(Date.now() - t0);

    const t1 = Date.now();
    const [, keyword] = await Promise.all([
      anyMemos.storage.querySimilarEmbeddings(
        qv,
        { namespace: "locomo_full", limit: 200, offset: 0 },
        200,
        0.05,
        provider.model,
      ),
      (async () => {
        const r = await anyMemos.storage.queryNodes({
          query: qa.question,
          namespace: "locomo_full",
          limit: 200,
          offset: 0,
        });
        timings.fts.push(Date.now() - t1);
        return r;
      })(),
    ]);
    const t2 = Date.now();
    const semantic = await anyMemos.storage.querySimilarEmbeddings(
      qv,
      { namespace: "locomo_full", limit: 200, offset: 0 },
      200,
      0.05,
      provider.model,
    );
    timings.semantic.push(Date.now() - t2);
    void keyword;

    const t3 = Date.now();
    const fused = await anyMemos.hybridSearch(
      {
        query: qa.question,
        limit: 10,
        namespace: "locomo_full",
        candidateDepth: 200,
      },
      {},
    );
    timings.rerank.push(Date.now() - t3);
    timings.full.push(Date.now() - t0);
    void fused;
    void semantic;
  }

  const avg = (a: number[]): number =>
    Number((a.reduce((s, x) => s + x, 0) / a.length).toFixed(1));
  console.log("avg per stage (ms):", {
    queryEmbed: avg(timings.embed),
    fts: avg(timings.fts),
    semantic: avg(timings.semantic),
    fullHybridWithRerank: avg(timings.rerank),
    fullQuery: avg(timings.full),
  });
  await memos.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
