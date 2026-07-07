/**
 * EmbeddingQueue — bounded, retryable, event-emitting background worker
 * pool for embedding generation.
 *
 * Why this exists: the previous MemOS engine called `provider.embed()` inline
 * from `store()` and `update()`. For local-hash that costs nothing, but the
 * moment a user points MemOS at Ollama, LM Studio, or any OpenAI-compatible
 * endpoint, every write blocks for the full round-trip. This queue lets
 * `store()` return as soon as the node is persisted, with the embedding work
 * happening in the background under a bounded concurrency cap.
 *
 * Design:
 *   - One shared queue per MemOS instance.
 *   - `enqueue()` is fire-and-forget — returns a job id immediately.
 *   - Workers are pulled in FIFO order. Concurrency is bounded by
 *     `EmbeddingQueueConfig.concurrency` (default 2).
 *   - Failures are retried with exponential backoff up to `maxRetries`
 *     (default 3) before the job is marked `failed` and an
 *     `embedding:failed` event fires.
 *   - Backpressure: if `maxQueueSize` is exceeded, `enqueue()` throws
 *     instead of growing memory unbounded. Callers can `await flush()`
 *     to make room.
 *   - Lifecycle events: `embedding:queued`, `embedding:started`,
 *     `embedding:complete`, `embedding:failed`, `embedding:retry`.
 *
 * The queue does not know about storage. It only knows how to call the
 * `EmbeddingProvider`. Persistence of the resulting vector is the
 * responsibility of the caller (a `persist` callback) so this module
 * stays storage-agnostic and easy to test.
 *
 * @module @memos/embedding-queue
 */

import type { EmbeddingProvider, EmbeddingVector } from "./types.js";

/** Lifecycle states an embedding job can be in. */
export type EmbeddingJobStatus =
  "queued" | "running" | "complete" | "failed" | "retrying";

/** Reasons a job can be marked failed. */
export type EmbeddingFailureReason =
  "max_retries" | "aborted" | "provider_error";

/** A single embedding job, exposed for observability. */
export interface EmbeddingJob {
  /** Stable id assigned at enqueue time. */
  id: string;
  /** Memory node this embedding is for. */
  nodeId: string;
  /** Text to embed. */
  text: string;
  /** Current status. */
  status: EmbeddingJobStatus;
  /** Number of times we have called the provider for this job. */
  attempts: number;
  /** Most recent error, if any. */
  lastError: string | null;
  /** Timestamp the job was enqueued (ms). */
  enqueuedAt: number;
  /** Timestamp of the most recent status change (ms). */
  updatedAt: number;
  /** Computed vector, set when status is `complete`. */
  vector: EmbeddingVector | null;
  /** Model id, set when status is `complete`. */
  model: string | null;
}

/** Persist callback — the queue does not know how to write the vector. */
export type PersistEmbeddingFn = (
  nodeId: string,
  vector: EmbeddingVector,
  model: string,
) => Promise<void>;

/** Status-change callback — used by MemOS to track per-node status. */
export type EmbeddingStatusChangeFn = (
  nodeId: string,
  status: EmbeddingJobStatus,
  error: string | null,
) => void | Promise<void>;

/** Configuration for EmbeddingQueue. */
export interface EmbeddingQueueConfig {
  /** Embedding provider. Required. */
  provider: EmbeddingProvider;
  /** Maximum number of concurrent in-flight embed calls. Default 2. */
  concurrency?: number;
  /** Maximum number of jobs buffered when workers are saturated. Default 10000. */
  maxQueueSize?: number;
  /** Maximum number of retry attempts per job. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms; retries use exponential backoff. Default 250. */
  retryBackoffMs?: number;
  /** Persist callback — invoked once per job on success. Optional. */
  onPersist?: PersistEmbeddingFn;
  /** Status-change callback — fires on every state transition. Optional. */
  onStatusChange?: EmbeddingStatusChangeFn;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BACKOFF_MS = 250;

/** Generate a short, unique job id without pulling in a uuid dep. */
function generateJobId(): string {
  return `emb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type InternalJob = EmbeddingJob;

/**
 * Bounded, retryable, non-blocking embedding queue.
 *
 * @example
 * ```ts
 * const queue = new EmbeddingQueue({
 *   provider,
 *   concurrency: 4,
 *   onPersist: async (nodeId, vector, model) => {
 *     await storage.saveEmbedding(nodeId, vector, model);
 *   },
 * });
 *
 * const jobId = queue.enqueue(node.id, text);
 * await queue.flush();
 * await queue.close();
 * ```
 */
export class EmbeddingQueue {
  private readonly provider: EmbeddingProvider;
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly onPersist?: PersistEmbeddingFn;
  private readonly onStatusChange?: EmbeddingStatusChangeFn;

  /** Pending jobs not yet picked up by a worker. */
  private pending: InternalJob[] = [];
  /** Currently running jobs, by worker slot index. */
  private readonly running: Array<InternalJob | null>;
  /** Job index by id, for status queries. */
  private readonly jobs: Map<string, InternalJob> = new Map();
  /** Resolvers for `flush()` callers, resolved when the queue drains. */
  private readonly drainWaiters: Array<() => void> = [];
  /** Set true after `close()` so enqueue can reject and workers exit. */
  private closed = false;

  constructor(config: EmbeddingQueueConfig) {
    this.provider = config.provider;
    this.concurrency = Math.max(1, config.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxQueueSize = Math.max(
      1,
      config.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
    );
    this.maxRetries = Math.max(0, config.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBackoffMs = Math.max(
      0,
      config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS,
    );
    this.onPersist = config.onPersist;
    this.onStatusChange = config.onStatusChange;
    this.running = new Array<InternalJob | null>(this.concurrency).fill(null);
  }

  /**
   * Enqueue an embedding job. Returns a job id immediately.
   *
   * @throws if the queue is full or has been closed.
   */
  enqueue(nodeId: string, text: string): string {
    if (this.closed) {
      throw new Error("EmbeddingQueue is closed.");
    }
    if (this.pending.length + this.activeCount() >= this.maxQueueSize) {
      throw new Error(
        `EmbeddingQueue is full (${this.maxQueueSize} jobs). ` +
          `Call await queue.flush() to make room.`,
      );
    }
    const job: InternalJob = {
      id: generateJobId(),
      nodeId,
      text,
      status: "queued",
      attempts: 0,
      lastError: null,
      enqueuedAt: Date.now(),
      updatedAt: Date.now(),
      vector: null,
      model: null,
    };
    this.pending.push(job);
    this.jobs.set(job.id, job);
    this.notifyStatus(job, "queued", null);
    this.schedule();
    return job.id;
  }

  /** Number of jobs currently waiting or running. */
  size(): number {
    return this.pending.length + this.activeCount();
  }

  /** Number of jobs currently being processed. */
  activeCount(): number {
    let n = 0;
    for (const r of this.running) if (r) n += 1;
    return n;
  }

  /** Return a snapshot of a job by id, or null if unknown. */
  getJob(id: string): EmbeddingJob | null {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  /** Return all jobs that are not in a terminal state. */
  pendingJobs(): EmbeddingJob[] {
    const out: EmbeddingJob[] = [];
    for (const j of this.jobs.values()) {
      if (
        j.status === "queued" ||
        j.status === "running" ||
        j.status === "retrying"
      ) {
        out.push({ ...j });
      }
    }
    return out;
  }

  /**
   * Wait for the queue to drain. Resolves when both `pending` and
   * `running` are empty. If the queue is already drained, resolves on
   * the next microtask.
   */
  async flush(): Promise<void> {
    if (this.size() === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  /**
   * Permanently stop the queue. In-flight jobs are allowed to finish
   * (and their persist callbacks run) but no new work is accepted.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private notifyStatus(
    job: InternalJob,
    status: EmbeddingJobStatus,
    error: string | null,
  ): void {
    job.status = status;
    job.updatedAt = Date.now();
    job.lastError = error;
    if (this.onStatusChange) {
      try {
        const result = this.onStatusChange(job.nodeId, status, error);
        if (result && typeof (result as Promise<void>).then === "function") {
          // Best-effort: do not await persistence callbacks in status notify.
          (result as Promise<void>).catch(() => undefined);
        }
      } catch {
        // Status-callback errors are non-fatal.
      }
    }
  }

  /** Pull the next pending job into an idle worker slot, if any. */
  private schedule(): void {
    for (let i = 0; i < this.running.length; i += 1) {
      if (this.running[i] !== null) continue;
      const job = this.pending.shift();
      if (!job) break;
      this.running[i] = job;
      // Fire-and-forget worker loop.
      void this.runJob(i, job);
    }
  }

  private async runJob(slot: number, job: InternalJob): Promise<void> {
    this.notifyStatus(job, "running", null);
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      attempt += 1;
      job.attempts = attempt;
      try {
        const vector = await this.provider.embed(job.text);
        job.vector = vector;
        job.model = this.provider.model;
        if (this.onPersist) {
          await this.onPersist(job.nodeId, vector, this.provider.model);
        }
        this.notifyStatus(job, "complete", null);
        this.running[slot] = null;
        this.afterJob();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt > this.maxRetries) break;
        const delay = this.retryBackoffMs * Math.pow(2, attempt - 1);
        this.notifyStatus(job, "retrying", lastError.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Mark the next attempt as running so observers see the transition.
        this.notifyStatus(job, "running", null);
      }
    }

    this.notifyStatus(
      job,
      "failed",
      lastError ? lastError.message : "unknown error",
    );
    this.running[slot] = null;
    this.afterJob();
  }

  /** After a worker slot frees, schedule the next pending job and
   *  resolve any flush() waiters that are now satisfied. */
  private afterJob(): void {
    this.schedule();
    if (this.size() === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
      for (const w of waiters) w();
    }
  }
}
