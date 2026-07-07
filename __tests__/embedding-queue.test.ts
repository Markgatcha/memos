/**
 * Tests for EmbeddingQueue.
 *
 * Covers: non-blocking enqueue, bounded concurrency, retry with exponential
 * backoff, backpressure (maxQueueSize), lifecycle events, drain on close,
 * and per-job status reporting.
 */

import { EmbeddingQueue } from "../src/embedding-queue";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

// --- Test helpers -----------------------------------------------------------

/** A scripted embedding provider. Each test sets the next response(s). */
class ScriptedProvider implements EmbeddingProvider {
  public readonly id = "scripted";
  public readonly model = "scripted-v1";
  public readonly dimensions = 4;
  public readonly calls: string[] = [];

  /** When set, the next call throws this error. */
  public failNextWith: Error | null = null;
  /** Number of times to fail in a row before succeeding. */
  public failTimes = 0;
  /** When set, the next call resolves to this vector (taken once, then cleared). */
  public resolveNextWith: EmbeddingVector | null = null;
  /** Fixed delay (ms) before each call resolves. */
  public delayMs = 0;

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls.push(text);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error("scripted failure");
    }
    if (this.resolveNextWith) {
      const v = this.resolveNextWith;
      this.resolveNextWith = null;
      return v;
    }
    // Deterministic vector from the text length
    return [text.length, 0, 0, 0];
  }
}

// --- enqueue is non-blocking -------------------------------------------------

describe("EmbeddingQueue.enqueue", () => {
  test("returns a job id immediately without waiting for the provider", async () => {
    const provider = new ScriptedProvider();
    provider.delayMs = 50; // simulate a slow remote call
    const queue = new EmbeddingQueue({ provider, concurrency: 1 });

    const start = Date.now();
    const jobId = queue.enqueue("node-1", "hello world");
    const elapsed = Date.now() - start;

    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);
    // Should be effectively instant — well under 50ms.
    expect(elapsed).toBeLessThan(30);
  });

  test("the job id is unique across enqueues", () => {
    const provider = new ScriptedProvider();
    const queue = new EmbeddingQueue({ provider, concurrency: 1 });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(queue.enqueue(`node-${i}`, `text ${i}`));
    }
    expect(ids.size).toBe(50);
  });

  test("enqueue throws after close()", async () => {
    const provider = new ScriptedProvider();
    const queue = new EmbeddingQueue({ provider, concurrency: 1 });
    await queue.close();
    expect(() => queue.enqueue("n", "t")).toThrow(/closed/i);
  });
});

// --- concurrency -------------------------------------------------------------

describe("EmbeddingQueue concurrency", () => {
  test("respects the concurrency cap (default 2)", async () => {
    const provider = new ScriptedProvider();
    provider.delayMs = 30;
    const queue = new EmbeddingQueue({ provider });

    const t0 = Date.now();
    for (let i = 0; i < 6; i += 1) queue.enqueue(`n${i}`, `t${i}`);
    await queue.flush();
    const elapsed = Date.now() - t0;

    // 6 jobs / concurrency 2 = 3 batches of ~30ms = >= 90ms.
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(provider.calls).toHaveLength(6);
  });

  test("custom concurrency is honored", async () => {
    const provider = new ScriptedProvider();
    provider.delayMs = 30;
    const queue = new EmbeddingQueue({ provider, concurrency: 4 });

    const t0 = Date.now();
    for (let i = 0; i < 8; i += 1) queue.enqueue(`n${i}`, `t${i}`);
    await queue.flush();
    const elapsed = Date.now() - t0;

    // 8 jobs / 4 = 2 batches of ~30ms = ~60ms; allow scheduling slack.
    expect(elapsed).toBeLessThan(250);
  });
});

// --- retry with exponential backoff -----------------------------------------

describe("EmbeddingQueue retry", () => {
  test("retries up to maxRetries and then marks the job failed", async () => {
    const provider = new ScriptedProvider();
    provider.failTimes = 99; // always fail
    const queue = new EmbeddingQueue({
      provider,
      concurrency: 1,
      maxRetries: 2,
      retryBackoffMs: 10,
    });

    queue.enqueue("n", "t");
    await queue.flush();
    const jobs = queue.pendingJobs();
    const failed = [...queue["jobs"].values()].find((j) => j.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.attempts).toBe(3); // 1 initial + 2 retries
    expect(jobs.filter((j) => j.status === "failed")).toHaveLength(0); // terminal
  });

  test("retries until the provider succeeds, then marks complete", async () => {
    const provider = new ScriptedProvider();
    provider.failTimes = 2; // fail twice, then succeed
    const queue = new EmbeddingQueue({
      provider,
      concurrency: 1,
      maxRetries: 3,
      retryBackoffMs: 5,
    });

    queue.enqueue("n", "t");
    await queue.flush();
    const job = [...queue["jobs"].values()][0];
    expect(job.status).toBe("complete");
    expect(job.attempts).toBe(3);
  });
});

// --- backpressure -----------------------------------------------------------

describe("EmbeddingQueue backpressure", () => {
  test("enqueue throws when maxQueueSize is exceeded", async () => {
    const provider = new ScriptedProvider();
    provider.delayMs = 100;
    const queue = new EmbeddingQueue({
      provider,
      concurrency: 1,
      maxQueueSize: 3,
    });

    // 1 running, 2 pending -> max 3 in the system. Next enqueue must throw.
    queue.enqueue("n1", "t1");
    queue.enqueue("n2", "t2");
    queue.enqueue("n3", "t3");
    expect(() => queue.enqueue("n4", "t4")).toThrow(/full/i);
    await queue.close();
  });
});

// --- persistence callback ---------------------------------------------------

describe("EmbeddingQueue.onPersist", () => {
  test("invokes onPersist with vector and model on success", async () => {
    const provider = new ScriptedProvider();
    provider.resolveNextWith = [0.1, 0.2, 0.3, 0.4];
    const persisted: Array<{ nodeId: string; vector: EmbeddingVector; model: string }> = [];
    const queue = new EmbeddingQueue({
      provider,
      onPersist: async (nodeId, vector, model) => {
        persisted.push({ nodeId, vector, model });
      },
    });

    queue.enqueue("node-x", "hello");
    await queue.flush();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].nodeId).toBe("node-x");
    expect(persisted[0].vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(persisted[0].model).toBe("scripted-v1");
  });
});

// --- status callback --------------------------------------------------------

describe("EmbeddingQueue.onStatusChange", () => {
  test("fires queued, running, complete for a successful job", async () => {
    const provider = new ScriptedProvider();
    const events: Array<{ nodeId: string; status: string; error: string | null }> = [];
    const queue = new EmbeddingQueue({
      provider,
      onStatusChange: (nodeId, status, error) => {
        events.push({ nodeId, status, error });
      },
    });

    queue.enqueue("n", "t");
    await queue.flush();
    const statuses = events.map((e) => e.status);
    expect(statuses).toEqual(["queued", "running", "complete"]);
  });

  test("fires retrying before complete on transient failure", async () => {
    const provider = new ScriptedProvider();
    provider.failTimes = 1;
    const events: string[] = [];
    const queue = new EmbeddingQueue({
      provider,
      maxRetries: 2,
      retryBackoffMs: 1,
      onStatusChange: (_n, status) => {
        events.push(status);
      },
    });

    queue.enqueue("n", "t");
    await queue.flush();
    expect(events).toEqual(["queued", "running", "retrying", "running", "complete"]);
  });
});

// --- drain and close --------------------------------------------------------

describe("EmbeddingQueue flush and close", () => {
  test("flush() resolves when the queue is empty", async () => {
    const provider = new ScriptedProvider();
    const queue = new EmbeddingQueue({ provider });
    await queue.flush();
    // No enqueue at all -> resolves immediately.
    expect(queue.size()).toBe(0);
  });

  test("close() drains in-flight work", async () => {
    const provider = new ScriptedProvider();
    provider.delayMs = 20;
    const queue = new EmbeddingQueue({ provider, concurrency: 1 });
    for (let i = 0; i < 5; i += 1) queue.enqueue(`n${i}`, `t${i}`);
    await queue.close();
    expect(queue.size()).toBe(0);
    expect(provider.calls).toHaveLength(5);
  });
});
