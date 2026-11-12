/**
 * Retrieval Flight Recorder test suite:
 * - Disabled path records nothing (default off)
 * - Opt-in via `trace: true`, `MEMOS_TRACE=1`, and `config.retrieval.trace`
 * - SQLite `recall_traces` round-trip (`write -> read -> identical`)
 * - Default IDs+scores privacy vs `captureText: true` opt-in
 * - Retention pruning on write (default 500, configurable cap)
 * - `explainRecall` + `formatExplainRecall` + MCP `memos_explain_recall` (excluded from core set)
 * - Counterfactual `replayRecall` (fusionMode, weights, MMR lambda, relevance gate, rerank on/off)
 * - Strict byte-for-byte determinism across repeated runs and shuffled candidate orders
 * - End-to-end CLI `explain-recall` and `replay`
 */

import { jest } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { MemOS } from "../src/memory.js";
import { SQLiteStorage } from "../src/storage/sqlite.js";
import {
  DEFAULT_MAX_RECALL_TRACES,
  explainRecallTrace,
  formatExplainRecall,
  formatReplayRecall,
  replayRecallTrace,
  serializeCanonicalJson,
} from "../src/flight-recorder.js";
import {
  createMcpServer,
  getMcpTools,
  MCP_CORE_TOOL_NAMES,
} from "../src/mcp.js";
import { FakeClipProvider } from "../src/vision/fake-clip.js";
import type {
  EmbeddingProvider,
  EmbeddingVector,
  RecallTraceRecord,
} from "../src/types.js";

const CLI_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Controlled deterministic embedding provider where tests can steer exact
 * cosine similarities per text substring while tracking `embed()` call count.
 */
class ControlledEmbeddingProvider implements EmbeddingProvider {
  public readonly id = "controlled";
  public readonly model = "controlled-v1";
  public readonly dimensions = 4;
  public calls = 0;

  async embed(text: string): Promise<EmbeddingVector> {
    this.calls += 1;
    const lower = text.trim().toLowerCase();
    // Paraphrase match: highest cosine on axis 0, zero keyword overlap
    if (lower.includes("canary rollout checklist")) {
      return [0.985, 0.12, 0.12, 0];
    }
    // Moderate semantic + strong keyword match
    if (lower.includes("deployment") && lower.includes("steps")) {
      return [0.55, 0.75, 0.36, 0];
    }
    // Weak semantic tail match
    if (lower.includes("legacy jenkins")) {
      return [0.18, 0.2, 0.96, 0];
    }
    // Query vector points strongly along axis 0
    if (lower.includes("deployment runbook")) {
      return [0.98, 0.14, 0.14, 0];
    }
    // Orthogonal (zero similarity -> below SEMANTIC_FUSION_THRESHOLD 0.05)
    return [0, 0, 0, 1];
  }
}

function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  } catch {
    // Windows WAL/SHM handle release can briefly lag process teardown.
  }
}

describe("Retrieval Flight Recorder", () => {
  const prevTraceEnv = process.env.MEMOS_TRACE;
  const prevMcpTools = process.env.MEMOS_MCP_TOOLS;

  afterEach(() => {
    if (prevTraceEnv === undefined) delete process.env.MEMOS_TRACE;
    else process.env.MEMOS_TRACE = prevTraceEnv;

    if (prevMcpTools === undefined) delete process.env.MEMOS_MCP_TOOLS;
    else process.env.MEMOS_MCP_TOOLS = prevMcpTools;
  });

  test("disabled path records nothing by default", async () => {
    delete process.env.MEMOS_TRACE;
    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();

    await memos.store("Standard deployment steps for production services", {
      tags: ["ops"],
    });
    await memos.store("Canary rollout checklist for zero-downtime releases", {
      tags: ["release"],
    });

    const hits = await memos.search("deployment runbook");
    expect(hits.length).toBeGreaterThan(0);
    expect(memos.getLastTraceId()).toBeNull();

    const traces = await memos.listRecallTraces();
    expect(traces).toEqual([]);

    await memos.close();
  });

  test("trace round-trip (write -> read -> identical) across SQLite restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-trace-rt-"));
    const dbPath = join(dir, "trace.db");
    try {
      const provider = new ControlledEmbeddingProvider();
      const memos = new MemOS({
        dbPath,
        embeddings: { enabled: true, provider },
        embeddingQueue: { synchronous: true },
      });
      await memos.init();

      const a = await memos.store(
        "Deployment steps require database migration approval",
        { id: "mem_deploy_steps", tags: ["postgres", "deploy"] },
      );
      const b = await memos.store(
        "Canary rollout checklist verifies health endpoints",
        { id: "mem_canary", tags: ["canary"] },
      );
      await memos.link(a.node.id, b.node.id, "related_to");

      await memos.search({
        query: "deployment runbook postgres",
        trace: true,
        traceSessionId: "sess_alpha",
        limit: 5,
      });
      const traceId = memos.getLastTraceId();
      expect(traceId).toMatch(/^tr_/);

      const inProcessTrace = await memos.getRecallTrace(traceId!);
      expect(inProcessTrace).not.toBeNull();
      await memos.close();

      // Reopen fresh SQLiteStorage directly and verify round-trip identity
      const storage = new SQLiteStorage(dbPath);
      await storage.init();
      const readBack = await storage.getRecallTrace(traceId!);
      expect(readBack).toEqual(inProcessTrace);

      // Re-saving the exact record and reading back again is strictly identical
      await storage.saveRecallTrace(readBack!);
      const readTwice = await storage.getRecallTrace(traceId!);
      expect(readTwice).toEqual(inProcessTrace);
      expect(serializeCanonicalJson(readTwice)).toBe(
        serializeCanonicalJson(inProcessTrace),
      );
      await storage.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("MEMOS_TRACE=1 enables tracing and excludes memory text unless captureText: true", async () => {
    const storage = new SQLiteStorage(":memory:");
    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      storage,
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();

    const secretSentinel = "ULTRA_SECRET_SENTINEL_PAYLOAD_9941";
    await memos.store(
      `Deployment steps include token ${secretSentinel} for staging`,
      { id: "mem_secret" },
    );

    process.env.MEMOS_TRACE = "1";
    await memos.search("deployment runbook");
    const defaultTraceId = memos.getLastTraceId()!;
    expect(defaultTraceId).toBeTruthy();

    const defaultTrace = await memos.getRecallTrace(defaultTraceId);
    expect(defaultTrace).not.toBeNull();
    expect(defaultTrace!.payload.captureText).toBe(false);
    const serializedDefault = JSON.stringify(defaultTrace);
    expect(serializedDefault).not.toContain(secretSentinel);
    for (const c of defaultTrace!.payload.candidates) {
      expect(c.text).toBeUndefined();
    }

    // Opt-in captureText: true stores summary + content for debugging
    await memos.search({
      query: "deployment runbook",
      trace: true,
      captureText: true,
    });
    const textTraceId = memos.getLastTraceId()!;
    expect(textTraceId).not.toBe(defaultTraceId);

    const textTrace = await memos.getRecallTrace(textTraceId);
    expect(textTrace!.payload.captureText).toBe(true);
    expect(JSON.stringify(textTrace)).toContain(secretSentinel);

    // Explicit trace: false suppresses tracing even when MEMOS_TRACE=1
    await memos.search({ query: "deployment runbook", trace: false });
    expect(memos.getLastTraceId()).toBe(textTraceId);
    const allTraces = await memos.listRecallTraces();
    expect(allTraces).toHaveLength(2);

    await memos.close();
  });

  test("enforces retention limit (default 500) and prunes oldest traces on write", async () => {
    expect(DEFAULT_MAX_RECALL_TRACES).toBe(500);

    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
      retrieval: {
        trace: {
          enabled: true,
          maxTraces: 3,
        },
      },
    });
    await memos.init();
    await memos.store("Deployment steps for retention test", {
      id: "mem_ret_1",
    });

    const recordedIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      await memos.search(`deployment runbook ${i}`);
      recordedIds.push(memos.getLastTraceId()!);
    }

    const listed = await memos.listRecallTraces({ limit: 20 });
    expect(listed).toHaveLength(3);
    // Newest 3 kept in newest-first order
    expect(listed.map((t) => t.id)).toEqual([
      recordedIds[6],
      recordedIds[5],
      recordedIds[4],
    ]);

    // Pruned traces are gone
    expect(await memos.getRecallTrace(recordedIds[0]!)).toBeNull();
    expect(await memos.getRecallTrace(recordedIds[3]!)).toBeNull();
    expect(await memos.getRecallTrace(recordedIds[6]!)).not.toBeNull();

    await memos.close();
  });

  test("records per-leg candidates (FTS, semantic, entity, graph, CLIP) and explains them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-trace-legs-"));
    try {
      const provider = new ControlledEmbeddingProvider();
      const fakeClip = new FakeClipProvider();
      const memos = new MemOS({
        dbPath: join(dir, "legs.db"),
        embeddings: { enabled: true, provider },
        embeddingQueue: { synchronous: true },
        vision: {
          enabled: true,
          storeRoot: join(dir, "blobs"),
          clip: {
            enabled: true,
            embedImage: fakeClip,
          },
        },
      });
      await memos.init();

      const ftsHit = await memos.store(
        "Deployment runbook steps for Kubernetes production",
        { id: "mem_fts_hit", tags: ["kubernetes"] },
      );
      const semHit = await memos.store(
        "Canary rollout checklist for zero-downtime cuts",
        { id: "mem_sem_hit" },
      );
      const graphNeighbour = await memos.store(
        "Post-mortem note attached via explicit graph edge",
        { id: "mem_graph_neighbour" },
      );
      await memos.link(ftsHit.node.id, graphNeighbour.node.id, "related_to");

      await memos.addImageMemory(PNG_1X1, {
        caption: "Architecture diagram for deployment runbook",
        kind: "diagram",
      });
      await memos.flushEmbeddings();

      const results = await memos.search({
        query: "deployment runbook Kubernetes",
        trace: true,
        limit: 10,
      });
      expect(results.length).toBeGreaterThanOrEqual(3);

      const traceId = memos.getLastTraceId()!;
      const explanation = await memos.explainRecall(traceId);

      expect(explanation.traceId).toBe(traceId);
      expect(explanation.query).toBe("deployment runbook Kubernetes");
      expect(explanation.latencyMs).toBeGreaterThanOrEqual(0);
      expect(explanation.legs.fts.candidates.length).toBeGreaterThan(0);
      expect(explanation.legs.semantic.candidates.length).toBeGreaterThan(0);
      expect(explanation.legs.entity.candidates.length).toBeGreaterThan(0);
      expect(
        explanation.legs.graph.candidates.some(
          (c) => c.id === graphNeighbour.node.id,
        ),
      ).toBe(true);
      expect(explanation.legs.clip).toBeDefined();

      // Verify introducedBy attribution
      const semItem = explanation.finalItems.find(
        (i) => i.id === semHit.node.id,
      );
      expect(semItem?.introducedBy).toBe("semantic");
      const graphItem = explanation.finalItems.find(
        (i) => i.id === graphNeighbour.node.id,
      );
      expect(graphItem?.introducedBy).toBe("graph");

      const formatted = formatExplainRecall(explanation);
      expect(formatted).toContain(traceId);
      expect(formatted).toContain("Per-leg candidates & timings:");
      expect(formatted).toContain("Final ranking");
      expect(formatted).toContain("introduced=semantic");
      expect(formatted).toContain("introduced=graph");

      await memos.close();
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("counterfactual replay recomputes from stored scores without DB/embedder and diffs accurately", async () => {
    const storage = new SQLiteStorage(":memory:");
    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      storage,
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();

    // Candidate 1: strong keyword match + moderate semantic match
    await memos.store(
      "Deployment runbook steps and deployment runbook verification",
      { id: "cand_kw_strong" },
    );
    // Candidate 2: paraphrase with near-1.0 cosine, zero keyword match
    await memos.store("Canary rollout checklist for staged service cutovers", {
      id: "cand_sem_strong",
    });
    // Candidate 3: near-duplicate of Candidate 1 (for MMR diversification test)
    await memos.store(
      "Deployment runbook steps and deployment runbook validation",
      { id: "cand_kw_dup" },
    );
    // Candidate 4: weaker keyword + weak semantic tail candidate
    await memos.store("Legacy jenkins deployment notes from three years ago", {
      id: "cand_tail",
    });

    const liveHits = await memos.search({
      query: "deployment runbook",
      trace: true,
      limit: 3,
    });
    expect(liveHits).toHaveLength(3);
    const traceId = memos.getLastTraceId()!;
    const storedTrace = (await memos.getRecallTrace(traceId))!;

    // Reset embedder call counter and spy on queryNodes to prove ZERO DB/embed calls during replay
    provider.calls = 0;
    const querySpy = jest.spyOn(storage, "queryNodes");

    // 1. Identity replay (same config) -> exact same ranking, 0 diff
    const identityReplay = await memos.replayRecall(traceId, {});
    expect(provider.calls).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
    expect(identityReplay.replayFinalIds).toEqual(storedTrace.payload.finalIds);
    expect(identityReplay.diff.added).toEqual([]);
    expect(identityReplay.diff.removed).toEqual([]);
    expect(identityReplay.diff.reordered).toEqual([]);

    // 2a. Override fusionMode ONLY ("convex" -> "rrf"):
    // Under default convex min-max normalization, the lowest-ranked FTS item
    // (`cand_tail`, rank #3 of 3) normalizes to 0.0 on the FTS leg and loses to
    // semantic-only #1 (`cand_sem_strong`, normalized 1.0). Under RRF rank
    // voting (`0.8 / 63` > `0.2 / 61`), `cand_tail`'s keyword rank vote beats
    // `cand_sem_strong`'s lone semantic vote — visibly changing top-3!
    const rrfModeReplay = await memos.replayRecall(traceId, {
      fusionMode: "rrf",
    });
    expect(provider.calls).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
    expect(rrfModeReplay.replayFinalIds).not.toEqual(
      storedTrace.payload.finalIds,
    );
    expect(
      rrfModeReplay.diff.added.length +
        rrfModeReplay.diff.removed.length +
        rrfModeReplay.diff.reordered.length,
    ).toBeGreaterThan(0);

    // 2b. Override fusion weights in convex mode (pure semantic weight) -> cand_sem_strong becomes #1!
    const semHeavyReplay = await memos.replayRecall(traceId, {
      fusionMode: "convex",
      adaptiveWeighting: false,
      keywordWeight: 0.05,
      semanticWeight: 0.95,
    });
    expect(provider.calls).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
    expect(semHeavyReplay.replayFinalIds[0]).toBe("cand_sem_strong");
    expect(
      semHeavyReplay.diff.added.length + semHeavyReplay.diff.reordered.length,
    ).toBeGreaterThan(0);

    // 3. Override MMR lambda -> rank #1 is kept, and its near-duplicate at rank #2
    // is demoted in favor of the distinct paraphrase `cand_sem_strong` — even with captureText=false!
    const mmrReplay = await memos.replayRecall(traceId, {
      mmrLambda: 0.2,
    });
    expect(mmrReplay.effectiveConfig.mmr.enabled).toBe(true);
    expect(mmrReplay.effectiveConfig.mmr.lambda).toBe(0.2);
    expect(mmrReplay.replayFinalIds[0]).toBe(storedTrace.payload.finalIds[0]);
    expect(mmrReplay.replayFinalIds[1]).toBe("cand_sem_strong");
    expect(
      mmrReplay.diff.added.length + mmrReplay.diff.reordered.length,
    ).toBeGreaterThan(0);

    // 4. Override relevanceGateThreshold -> trims lower-scoring tail candidates
    const gateReplay = await memos.replayRecall(traceId, {
      relevanceGateThreshold: 0.85,
    });
    expect(gateReplay.gate.trimmed).toBe(true);
    expect(gateReplay.diff.removed.length).toBeGreaterThan(0);
    expect(
      gateReplay.diff.removed.every((r) => r.reason === "gate_trimmed"),
    ).toBe(true);

    // 5. Override rerank on/off on a trace carrying cross-encoder scores
    const syntheticRerankedTrace: RecallTraceRecord = {
      ...storedTrace,
      payload: {
        ...storedTrace.payload,
        config: {
          ...storedTrace.payload.config,
          rerank: { enabled: true, candidates: 20 },
        },
        candidates: storedTrace.payload.candidates.map((c) => ({
          ...c,
          attributes: {
            ...c.attributes,
            rerankScore: c.id === "cand_tail" ? 0.99 : 0.12,
          },
        })),
      },
    };
    const withRerankOn = replayRecallTrace(syntheticRerankedTrace, {
      rerank: true,
    });
    const withRerankOff = replayRecallTrace(syntheticRerankedTrace, {
      rerank: false,
    });
    expect(withRerankOn.replayFinalIds[0]).toBe("cand_tail");
    expect(withRerankOff.replayFinalIds[0]).not.toBe("cand_tail");

    querySpy.mockRestore();
    await memos.close();
  });

  test("replay is strictly byte-identical across repeated runs and candidate-array permutations", async () => {
    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();

    await memos.store("Deployment runbook steps for staging", { id: "id_a" });
    await memos.store("Canary rollout checklist for production", {
      id: "id_b",
    });
    await memos.store("Legacy jenkins pipeline notes", { id: "id_c" });

    await memos.search({ query: "deployment runbook", trace: true });
    const trace = (await memos.getRecallTrace(memos.getLastTraceId()!))!;

    const override = {
      fusionMode: "rrf" as const,
      keywordWeight: 0.35,
      semanticWeight: 0.65,
      mmrLambda: 0.45,
      relevanceGateThreshold: 0.2,
    };

    const baselineReport = replayRecallTrace(trace, override);
    const baselineJson = JSON.stringify(baselineReport);
    const baselineFormatted = formatReplayRecall(baselineReport);

    // Reverse internal candidate & similarity pair arrays to test map-iteration sorting
    const permutedTrace: RecallTraceRecord = {
      ...trace,
      payload: {
        ...trace.payload,
        candidates: [...trace.payload.candidates].reverse(),
        pairwiseSimilarity: [...trace.payload.pairwiseSimilarity].reverse(),
      },
    };

    for (let i = 0; i < 10; i += 1) {
      const rep = replayRecallTrace(
        i % 2 === 0 ? trace : permutedTrace,
        override,
      );
      expect(JSON.stringify(rep)).toBe(baselineJson);
      expect(formatReplayRecall(rep)).toBe(baselineFormatted);
    }

    await memos.close();
  });

  test("memos_explain_recall MCP tool is excluded from default core set and works on wire when enabled", async () => {
    delete process.env.MEMOS_MCP_TOOLS;
    expect(MCP_CORE_TOOL_NAMES).not.toContain("memos_explain_recall");
    expect(getMcpTools().map((t) => t.name)).not.toContain(
      "memos_explain_recall",
    );

    process.env.MEMOS_MCP_TOOLS = "all";
    expect(getMcpTools().map((t) => t.name)).toContain("memos_explain_recall");

    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();
    await memos.store("Deployment runbook steps via MCP", { id: "mcp_node_1" });
    await memos.search({ query: "deployment runbook", trace: true });
    const traceId = memos.getLastTraceId()!;

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const serverHandle = serveStdio(() => createMcpServer(memos), {
      transport: serverTransport,
    });

    try {
      const callResponse = await new Promise<{
        result?: {
          isError?: boolean;
          structuredContent?: {
            explanation?: { traceId?: string; query?: string };
          };
        };
        error?: unknown;
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("MCP tools/call timed out")),
          10_000,
        );
        clientTransport.onmessage = (msg: unknown) => {
          const m = msg as { id?: number; result?: unknown; error?: unknown };
          if (m.id === 77) {
            clearTimeout(timer);
            resolve(m as never);
          }
        };
        void clientTransport.start().then(() =>
          clientTransport.send({
            jsonrpc: "2.0",
            id: 77,
            method: "tools/call",
            params: {
              name: "memos_explain_recall",
              arguments: { traceId },
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {
                  name: "flight-recorder-test",
                  version: "1.0.0",
                },
              },
            },
          }),
        );
      });

      expect(callResponse.error).toBeUndefined();
      expect(callResponse.result?.isError).not.toBe(true);
      expect(callResponse.result?.structuredContent?.explanation?.traceId).toBe(
        traceId,
      );
      expect(callResponse.result?.structuredContent?.explanation?.query).toBe(
        "deployment runbook",
      );
    } finally {
      await serverHandle.close();
      await clientTransport.close();
      await memos.close();
    }
  });

  test("CLI end-to-end: search --trace -> explain-recall -> replay --config", () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-cli-fr-"));
    const dbPath = join(dir, "cli-fr.db");
    const cfgPath = join(dir, "replay-override.json");
    try {
      const runCli = (
        cliArgs: string[],
        extraEnv: Record<string, string> = {},
      ): string =>
        execFileSync(
          process.execPath,
          ["--import", "tsx", CLI_ENTRY, ...cliArgs, "--db", dbPath],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              MEMOS_EMBEDDING_PROVIDER: "local",
              ...extraEnv,
            },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60_000,
          },
        );

      runCli([
        "store",
        "Kubernetes production cluster runs in us-east-1 with three worker pools",
        "--tag",
        "k8s",
      ]);
      runCli([
        "store",
        "PostgreSQL primary database backup runs nightly at 02:00 UTC",
        "--tag",
        "postgres",
      ]);
      runCli([
        "store",
        "Kubernetes staging cluster uses spot nodes for preview environments",
        "--tag",
        "k8s",
      ]);

      const searchOut = runCli(["search", "kubernetes cluster", "--trace"]);
      const match = searchOut.match(/Trace ID:\s*(tr_[0-9a-f-]+)/i);
      expect(match).not.toBeNull();
      const traceId = match![1]!;

      const explainOut = runCli(["explain-recall", traceId]);
      expect(explainOut).toContain(`Trace:       ${traceId}`);
      expect(explainOut).toContain("Per-leg candidates & timings:");
      expect(explainOut).toContain("Final ranking");

      writeFileSync(
        cfgPath,
        "\uFEFF" +
          JSON.stringify(
            {
              fusionMode: "rrf",
              keywordWeight: 0.2,
              semanticWeight: 0.8,
              mmrLambda: 0.4,
            },
            null,
            2,
          ),
      );

      const replayOut1 = runCli(["replay", traceId, "--config", cfgPath]);
      const replayOut2 = runCli(["replay", traceId, "--config", cfgPath]);
      expect(replayOut1).toContain(`Replay trace:  ${traceId}`);
      expect(replayOut1).toContain("fusionMode");
      expect(replayOut1).toBe(replayOut2);
    } finally {
      cleanupTempDir(dir);
    }
  });

  test("replay relevanceGate abstains below similarity floor unless rescued by exactTermMatch", async () => {
    const provider = new ControlledEmbeddingProvider();
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: true, provider },
      embeddingQueue: { synchronous: true },
    });
    await memos.init();

    // Paraphrase only (no literal >=3-char query term overlap with "runbook" or "deployment")
    await memos.store("Canary rollout checklist for staged cuts", {
      id: "paraphrase_only",
    });

    await memos.search({ query: "deployment runbook", trace: true });
    const paraphraseTraceId = memos.getLastTraceId()!;

    // Cosine (~0.9996) < 0.9999 and no exact term match -> gate abstains
    const abstained = await memos.replayRecall(paraphraseTraceId, {
      abstainSimilarity: 0.9999,
    });
    expect(abstained.gate.abstained).toBe(true);
    expect(abstained.replayFinalIds).toEqual([]);
    expect(abstained.diff.removed[0]?.reason).toBe("gate_abstained");

    // Now add a literal query-term match ("runbook") and re-search
    await memos.store("Legacy jenkins runbook archive", {
      id: "literal_rescue",
    });
    await memos.search({ query: "deployment runbook", trace: true });
    const rescuedTraceId = memos.getLastTraceId()!;

    const rescued = await memos.replayRecall(rescuedTraceId, {
      abstainSimilarity: 0.9999,
    });
    expect(rescued.gate.abstained).toBe(false);
    expect(rescued.replayFinalIds.length).toBeGreaterThan(0);

    await memos.close();
  });

  test("FTS-only store (embeddings disabled) supports opt-in tracing and explainRecall", async () => {
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: false },
    });
    await memos.init();

    await memos.store("PostgreSQL replica lag alert playbook", {
      id: "fts_only_1",
    });
    const hits = await memos.search({
      query: "PostgreSQL replica",
      trace: true,
    });
    expect(hits).toHaveLength(1);

    const traceId = memos.getLastTraceId()!;
    const report = await memos.explainRecall(traceId);
    expect(report.legs.semantic.enabled).toBe(false);
    expect(report.legs.fts.candidates).toHaveLength(1);
    expect(report.finalItems[0]?.introducedBy).toBe("fts");

    await memos.close();
  });
});
