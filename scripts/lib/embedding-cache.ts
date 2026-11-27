/**
 * Disk-backed embedding cache for benchmark runs.
 *
 * GPU embedding sweeps re-embed the same corpus once per model, per retrieval
 * configuration, and per rerun after a crash. That is pure waste: embeddings
 * are deterministic for a fixed (provider, model, dimensions, text) tuple.
 *
 * `CachingEmbeddingProvider` wraps any `EmbeddingProvider` and stores vectors
 * in a local SQLite file keyed by a hash of the namespace + query/document
 * role + input text. A warm cache turns repeated ingestion into local reads,
 * so retrieval/rerank ablations can run with the GPU switched off entirely.
 *
 * The cache is disposable: deleting the file only costs a re-embed.
 *
 * Usage from a benchmark:
 *   npx tsx scripts/bench-locomo-noapi.ts \
 *     --provider=openai-compatible --base-url=http://127.0.0.1:8081/v1 \
 *     --model=Qwen/Qwen3-Embedding-8B --dimensions=4096 \
 *     --embedding-cache=.bench-cache/qwen3-8b.sqlite
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type {
  EmbeddingProvider,
  EmbeddingRuntimeInfo,
  EmbeddingVector,
} from "../../src/types.js";

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  writes: number;
}

type Role = "q" | "d";

/** `batchEmbedQueries` is implemented by HTTP providers but is not part of
 *  the base `EmbeddingProvider` contract (which only requires embedQuery). */
type MaybeBatchQueries = {
  batchEmbedQueries?: (texts: string[]) => Promise<EmbeddingVector[]>;
};

interface CachedRow {
  vec: Buffer;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vectors (
    key TEXT PRIMARY KEY,
    vec BLOB NOT NULL
  ) WITHOUT ROWID;
`;

function toBlob(vector: number[]): Buffer {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function fromBlob(blob: Buffer, expectedDimensions: number): number[] | null {
  if (blob.byteLength !== expectedDimensions * 4) return null;
  // Copy into an aligned ArrayBuffer: better-sqlite3 Buffers can start at an
  // arbitrary byte offset inside a pooled ArrayBuffer.
  const aligned = new ArrayBuffer(blob.byteLength);
  new Uint8Array(aligned).set(blob);
  return Array.from(new Float32Array(aligned));
}

export class CachingEmbeddingProvider implements EmbeddingProvider {
  public readonly id: string;
  public readonly model: string;
  public readonly dimensions: number;
  public readonly queryPrefix?: string;
  public readonly documentPrefix?: string;

  private readonly inner: EmbeddingProvider;
  private readonly db: Database.Database;
  private readonly namespace: string;
  private readonly keyOf: (role: Role, text: string) => string;
  private readonly readStmt: Database.Statement<[string], CachedRow>;
  private readonly writeStmt: Database.Statement<[string, Buffer]>;
  private readonly deleteStmt: Database.Statement<[string]>;
  private readonly insertMany: (rows: Array<[string, Buffer]>) => void;
  private readonly stats: EmbeddingCacheStats = {
    hits: 0,
    misses: 0,
    writes: 0,
  };
  private closed = false;

  /** Only present when the wrapped provider can batch, so wrapping a
   *  non-batching provider does not change the embedding queue's grouping. */
  batchEmbed?: (texts: string[]) => Promise<EmbeddingVector[]>;
  batchEmbedQueries?: (texts: string[]) => Promise<EmbeddingVector[]>;
  embedDocuments?: (texts: string[]) => Promise<EmbeddingVector[]>;

  constructor(
    inner: EmbeddingProvider,
    cachePath: string,
    opts: { namespace?: string } = {},
  ) {
    this.inner = inner;
    this.id = inner.id;
    this.model = inner.model;
    this.dimensions = inner.dimensions;
    this.queryPrefix = inner.queryPrefix;
    this.documentPrefix = inner.documentPrefix;
    this.namespace =
      opts.namespace ??
      [inner.id, inner.model, String(inner.dimensions)].join("|");

    this.db = new Database(cachePath);
    // The cache is rebuildable; durability buys nothing and fsync per batch
    // would dominate small runs.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);

    this.keyOf = (role, text) =>
      createHash("sha256")
        .update(this.namespace)
        .update("\0")
        .update(role)
        .update("\0")
        .update(text)
        .digest("hex");

    this.readStmt = this.db.prepare<[string], CachedRow>(
      "SELECT vec FROM vectors WHERE key = ?",
    );
    this.writeStmt = this.db.prepare<[string, Buffer]>(
      "INSERT OR REPLACE INTO vectors (key, vec) VALUES (?, ?)",
    );
    this.deleteStmt = this.db.prepare<[string]>(
      "DELETE FROM vectors WHERE key = ?",
    );
    this.insertMany = this.db.transaction((rows: Array<[string, Buffer]>) => {
      for (const [key, vec] of rows) this.writeStmt.run(key, vec);
    });

    if (inner.batchEmbed) {
      this.batchEmbed = (texts) => this.batch("d", texts, (misses) => {
        return inner.batchEmbed!(misses);
      });
    }
    const batchQueries = (inner as MaybeBatchQueries).batchEmbedQueries;
    if (batchQueries) {
      this.batchEmbedQueries = (texts) =>
        this.batch("q", texts, (misses) => batchQueries.call(inner, misses));
    }
    if (inner.embedDocuments) {
      this.embedDocuments = (texts) =>
        this.batch("d", texts, (misses) => inner.embedDocuments!(misses));
    }
  }

  /** Cache hit/miss counters for the run metadata or a final log line. */
  cacheStats(): EmbeddingCacheStats {
    return { ...this.stats };
  }

  /** Flush WAL and release the file handle (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  getRuntimeInfo(): EmbeddingRuntimeInfo {
    return (
      this.inner.getRuntimeInfo?.() ?? {
        requestedProvider: this.id,
        resolvedProvider: this.id,
        requestedModel: this.model,
        resolvedModel: this.model,
        modelRevision: null,
        requestedDimensions: this.dimensions,
        observedDimensions: this.dimensions,
        fallbackActive: false,
        fallbackReason: null,
      }
    );
  }

  private get(role: Role, text: string): number[] | null {
    const key = this.keyOf(role, text);
    const row = this.readStmt.get(key);
    if (!row) {
      this.stats.misses += 1;
      return null;
    }
    const vector = fromBlob(row.vec, this.dimensions);
    if (!vector) {
      // A model swap or a partial write left an unusable row.
      this.deleteStmt.run(key);
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    return vector;
  }

  private put(role: Role, text: string, vector: number[]): void {
    this.writeStmt.run(this.keyOf(role, text), toBlob(vector));
    this.stats.writes += 1;
  }

  private async batch(
    role: Role,
    texts: string[],
    compute: (misses: string[]) => Promise<EmbeddingVector[]>,
  ): Promise<EmbeddingVector[]> {
    const out = new Array<EmbeddingVector | undefined>(texts.length);
    const missTexts: string[] = [];
    const missIndexes: number[] = [];

    for (let i = 0; i < texts.length; i += 1) {
      const cached = this.get(role, texts[i]!);
      if (cached) out[i] = cached;
      else {
        missTexts.push(texts[i]!);
        missIndexes.push(i);
      }
    }
    if (missTexts.length === 0) return out as EmbeddingVector[];

    const computed = await compute(missTexts);
    if (computed.length !== missTexts.length) {
      throw new Error(
        `embedding cache: provider returned ${computed.length} vectors for ${missTexts.length} inputs`,
      );
    }
    const rows: Array<[string, Buffer]> = [];
    for (let j = 0; j < missTexts.length; j += 1) {
      const vector = computed[j]!;
      out[missIndexes[j]!] = vector;
      rows.push([this.keyOf(role, missTexts[j]!), toBlob(vector)]);
    }
    this.insertMany(rows);
    this.stats.writes += rows.length;
    return out as EmbeddingVector[];
  }

  async embed(text: string): Promise<EmbeddingVector> {
    const cached = this.get("d", text);
    if (cached) return cached;
    const vector = await this.inner.embed(text);
    this.put("d", text, vector);
    return vector;
  }

  async embedQuery(text: string): Promise<EmbeddingVector> {
    const cached = this.get("q", text);
    if (cached) return cached;
    const vector = this.inner.embedQuery
      ? await this.inner.embedQuery(text)
      : await this.inner.embed(text);
    this.put("q", text, vector);
    return vector;
  }
}

/** Wrap a provider when a cache path was supplied; otherwise pass it through. */
export function withOptionalEmbeddingCache(
  provider: EmbeddingProvider,
  cachePath: string | undefined,
  namespace?: string,
): EmbeddingProvider {
  if (!cachePath) return provider;
  return new CachingEmbeddingProvider(provider, cachePath, { namespace });
}
