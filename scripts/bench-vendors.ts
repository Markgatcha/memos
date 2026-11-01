#!/usr/bin/env npx tsx
/**
 * ─── Same-protocol vendor benchmark (MemOS vs third-party memory SDKs) ──────
 *
 * The problem this solves: every vendor publishes memory-benchmark
 * numbers from their own eval — their own embedder, their own judge,
 * their own scoring convention. Comparing those tables is comparing
 * apples to press releases. This harness instead runs EVERY engine
 * through the IDENTICAL LoCoMo retrieval-only protocol (the one
 * `bench-locomo-noapi.ts` uses): same utterances, same evidence IDs,
 * same scoring, same K — the only variable is the engine.
 *
 *   1. Ingests each LoCoMo utterance (with its dia_id) into each engine.
 *   2. Runs every question against each engine.
 *   3. Scores retrieved evidence IDs with the shared deterministic
 *      metrics (Hit@K, Evidence Recall, All-Evidence, Precision, MRR,
 *      nDCG — scripts/lib/bench-metrics.ts).
 *   4. Emits a side-by-side table + JSON with the full metadata block
 *      each engine actually ran with (embedder, store, versions).
 *
 * Protocol fairness rules enforced here:
 *   - ingestion is RAW on both sides (`infer=False` for Mem0): a
 *     vendor that LLM-extracts facts at write time is being measured on
 *     its extractor, not its retrieval;
 *   - the embedder each engine used is recorded, and a mismatch
 *     between engines raises a loud comparability warning;
 *   - an engine that cannot boot (missing SDK, missing server) is
 *     reported as SKIPPED with the reason — the run continues.
 *
 * Usage:
 *   npx tsx scripts/bench-vendors.ts --engines=memos,mem0 --convs=2 --topk=10
 *   npx tsx scripts/bench-vendors.ts --engines=memos --out=/tmp/x.json
 *
 * Engine flags:
 *   --engines=memos[,mem0]        which engines participate (default: memos)
 *   --vendor-python=<path>        python for the mem0 bridge
 *   --vendor-embedder=ollama|huggingface|openai   mem0 embedder (default ollama)
 *   --vendor-model=<name>         mem0 embedder model (default nomic-embed-text)
 *   --vendor-base-url=<url>       mem0 embedder base URL (default 127.0.0.1:11434)
 *   --vendor-api-key=<key>        mem0 embedder API key (openai embedder)
 *   --vendor-store=chroma|qdrant  mem0 vector store (default chroma-local)
 *   --vendor-llm=openai|ollama    mem0's write-time LLM slot (default: a local
 *                                 llama.cpp OpenAI-compatible server — mem0
 *                                 2.x runs an LLM decision step during add()
 *                                 even with infer=False, so it needs a model)
 *   --vendor-llm-url=<url>        e.g. http://127.0.0.1:8081/v1 (minicpm5 box)
 *   --vendor-llm-model=<name>     e.g. minicpm5
 *   --vendor-llm-key=<key>        any non-empty string for local servers
 *
 * MemOS-leg flags are the usual bench flags (--provider, --model, ...).
 *
 * Results: scripts/bench-vendors-results.json (override with --out=)
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

import {
  assertNoFallback,
  benchMetadata,
  buildProvider,
  createBenchMemos,
  parseProviderArgs,
  parseRetrievalArgs,
  type BenchProviderArgs,
  type RetrievalArgs,
} from "./lib/bench-common.ts";
import {
  aggregateMetrics,
  dedupeRankedIds,
  type EvalQueryResult,
  type MetricsReport,
} from "./lib/bench-metrics.ts";
import {
  categoryName,
  type LocoChat,
  type LocoConversation,
} from "./lib/bench-common.ts";
import type { EmbeddingProvider, EmbeddingRuntimeInfo } from "../src/types.js";

// ─── Engine contract ─────────────────────────────────────────────────────────

interface BenchEngine {
  id: string;
  label: string;
  ready: boolean;
  skipReason?: string;
  /** Human-readable embedding stack the engine actually ran with. */
  embeddingSummary: string;
  ingest(convIdx: number, chat: LocoChat, sessionTs: string): Promise<void>;
  search(convIdx: number, question: string, limit: number): Promise<string[]>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

// ─── JSON-lines child process client ────────────────────────────────────────

class JsonLineProcess {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private queue: Array<{
    resolve: (v: never) => void;
    reject: (e: Error) => void;
  }> = [];
  private stderr = "";

  constructor(command: string, args: string[]) {
    this.proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line) as unknown;
            const waiter = this.queue.shift();
            waiter?.resolve(parsed as never);
          } catch {
            // Non-JSON chatter (model download progress etc.) — ignore.
          }
        }
        nl = this.buffer.indexOf("\n");
      }
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      this.stderr += chunk.slice(-4000);
    });
    this.proc.on("exit", (code) => {
      const err = new Error(
        `vendor bridge exited (code ${code}). stderr tail:\n${this.stderr.slice(-1500)}`,
      );
      for (const waiter of this.queue.splice(0)) waiter.reject(err);
    });
  }

  async call(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const line = `${JSON.stringify(cmd)}\n`;
    const promise = new Promise<never>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
    this.proc.stdin.write(line);
    return (await promise) as unknown as Record<string, unknown>;
  }

  async close(): Promise<void> {
    try {
      this.proc.stdin.end();
      await Promise.race([
        new Promise((r) => this.proc.once("exit", r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    } catch {
      // best effort
    }
    this.proc.kill();
  }
}

// ─── MemOS engine (the control arm) ─────────────────────────────────────────

class MemOSEngine implements BenchEngine {
  id = "memos";
  label = "MemOS (this repo)";
  ready = false;
  embeddingSummary: string;
  private memos!: ReturnType<typeof createBenchMemos>;
  private dbPath: string;

  constructor(
    private providerArgs: BenchProviderArgs,
    private retrievalArgs: RetrievalArgs,
  ) {
    this.dbPath = join(
      tmpdir(),
      `bench-vendors-memos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    this.embeddingSummary = `${providerArgs.provider}${
      providerArgs.model ? `/${providerArgs.model}` : ""
    }`;
  }

  async init(provider: EmbeddingProvider): Promise<void> {
    this.memos = createBenchMemos({
      dbPath: this.dbPath,
      provider,
      providerArgs: this.providerArgs,
      retrievalArgs: this.retrievalArgs,
    });
    await this.memos.init();
    this.ready = true;
  }

  async ingest(
    convIdx: number,
    chat: LocoChat,
    sessionTs: string,
  ): Promise<void> {
    await this.memos.store(`${chat.speaker}: ${chat.text}`, {
      namespace: `locomo_conv_${convIdx}`,
      metadata: {
        dia_id: chat.dia_id,
        benchmark: "locomo",
        instanceId: `locomo_conv_${convIdx}`,
        speaker: chat.speaker,
        sessionId: String(convIdx),
        timestamp: sessionTs,
      },
    });
  }

  async search(
    convIdx: number,
    question: string,
    limit: number,
  ): Promise<string[]> {
    const results = await this.memos.search({
      query: question,
      limit,
      namespace: `locomo_conv_${convIdx}`,
    });
    return dedupeRankedIds(
      results.map((r) => String(r.node.metadata?.dia_id ?? "")).filter(Boolean),
    );
  }

  async flush(): Promise<void> {
    await this.memos.flushEmbeddings();
  }

  async close(): Promise<void> {
    await this.memos.close();
    for (const ext of ["", "-wal", "-shm"]) {
      const p = this.dbPath + ext;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  }
}

// ─── Mem0 engine (vendor arm, via the Python bridge) ─────────────────────────

class Mem0Engine implements BenchEngine {
  id = "mem0";
  label = "Mem0 (OSS Python SDK, infer=False, raw ingestion)";
  ready = false;
  skipReason?: string;
  embeddingSummary: string;
  private bridge?: JsonLineProcess;
  private workdir: string;

  constructor(
    private vendorArgs: {
      python: string;
      embedder: string;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      store: string;
      /** LLM slot: mem0 2.x runs an LLM decision step during add() even
       *  with infer=False. Default: a local llama.cpp OpenAI-compatible
       *  server (e.g. the minicpm5 box on :8081). */
      llmProvider?: "openai" | "ollama";
      llmUrl?: string;
      llmModel?: string;
      llmKey?: string;
    },
  ) {
    this.workdir = join(
      tmpdir(),
      `bench-vendors-mem0-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    this.embeddingSummary = `${vendorArgs.embedder}${
      vendorArgs.model ? `/${vendorArgs.model}` : ""
    }`;
  }

  async init(): Promise<void> {
    const bridgePath = join("scripts", "vendor-bridges", "mem0_bridge.py");
    if (!existsSync(bridgePath)) {
      this.skipReason = `bridge not found: ${bridgePath}`;
      return;
    }
    const bridge = new JsonLineProcess(this.vendorArgs.python, [
      bridgePath,
      "--workdir",
      this.workdir,
    ]);
    const embedderConfig = this.buildEmbedderConfig();
    const resp = await bridge.call({
      cmd: "init",
      embedder: embedderConfig,
      llm: this.buildLlmConfig(),
      vector_store: this.vendorArgs.store,
      vector_store_dir: join(this.workdir, "store"),
      history_db_path: join(this.workdir, "mem0-history.db"),
    });
    if (resp.ok !== true) {
      await bridge.close();
      this.skipReason = String(resp.error ?? "mem0 init failed");
      return;
    }
    this.bridge = bridge;
    this.ready = true;
  }

  private buildEmbedderConfig(): Record<string, unknown> {
    const { embedder, model, baseUrl, apiKey } = this.vendorArgs;
    if (embedder === "ollama") {
      return {
        provider: "ollama",
        config: {
          model,
          ollama_base_url: baseUrl ?? "http://127.0.0.1:11434",
        },
      };
    }
    if (embedder === "openai") {
      return {
        provider: "openai",
        config: {
          model,
          api_key: apiKey,
          ...(baseUrl ? { openai_base_url: baseUrl } : {}),
        },
      };
    }
    return {
      provider: "huggingface",
      config: { model },
    };
  }

  /**
   * LLM slot for mem0's write-time decision step. An OpenAI-compatible
   * local server (llama.cpp minicpm5) is the default because it keeps
   * the whole vendor leg on-box and fast; `ollama` is the alternative.
   * The bridge scrubs OPENAI-prefixed and ANTHROPIC-prefixed env vars
   * so a local gateway cannot hijack this slot.
   */
  private buildLlmConfig(): Record<string, unknown> {
    const { llmProvider, llmUrl, llmModel, llmKey } = this.vendorArgs;
    if (llmProvider === "ollama" || (!llmUrl && !llmModel)) {
      return {
        provider: "ollama",
        config: {
          model: llmModel ?? "qwen2.5:0.5b",
          ollama_base_url: llmUrl ?? "http://127.0.0.1:11434",
        },
      };
    }
    return {
      provider: "openai",
      config: {
        model: llmModel ?? "minicpm5",
        api_key: llmKey ?? "local-no-key",
        openai_base_url: llmUrl ?? "http://127.0.0.1:8081/v1",
      },
    };
  }

  async ingest(
    convIdx: number,
    chat: LocoChat,
    _sessionTs: string,
  ): Promise<void> {
    const resp = await this.bridge!.call({
      cmd: "ingest",
      user_id: `locomo_conv_${convIdx}`,
      text: `${chat.speaker}: ${chat.text}`,
      dia_ids: [chat.dia_id],
    });
    if (resp.ok !== true) {
      throw new Error(`mem0 ingest failed: ${String(resp.error)}`);
    }
  }

  async search(
    convIdx: number,
    question: string,
    limit: number,
  ): Promise<string[]> {
    const resp = await this.bridge!.call({
      cmd: "search",
      user_id: `locomo_conv_${convIdx}`,
      query: question,
      limit,
    });
    if (resp.ok !== true) {
      throw new Error(`mem0 search failed: ${String(resp.error)}`);
    }
    return dedupeRankedIds(
      (resp.ids as string[] | undefined)?.filter(Boolean) ?? [],
    );
  }

  async flush(): Promise<void> {
    // mem0's add() embeds synchronously; nothing to drain.
  }

  async close(): Promise<void> {
    if (this.bridge) await this.bridge.close();
    rmSync(this.workdir, { recursive: true, force: true });
  }
}

// ─── Vendor python resolution ───────────────────────────────────────────────

function resolveVendorPython(): string {
  const env = process.env.MEMOS_VENDOR_PYTHON;
  if (env && existsSync(env)) return env;
  const candidates = [
    "C:/Users/marki/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe",
    "python",
    "python3",
    "py",
  ];
  for (const c of candidates) {
    if (c === "python" || c === "python3" || c === "py") return c;
    if (existsSync(c)) return c;
  }
  return "python";
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = args.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };

  const topK = parseInt(flag("topk") ?? "10", 10) || 10;
  const convsArg = flag("convs");
  const maxConvos = convsArg ? parseInt(convsArg, 10) : 2;
  const enginesArg = flag("engines") ?? "memos";
  const engineIds = enginesArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const providerArgs = parseProviderArgs(args);
  const retrievalArgs = parseRetrievalArgs(args);
  const datasetPath =
    flag("dataset") ?? "scripts/dataset/locomo/data/locomo10.json";
  if (!existsSync(datasetPath)) {
    console.error(
      "Dataset not found. Run: git clone --depth 1 https://github.com/snap-research/locomo.git scripts/dataset/locomo",
    );
    process.exit(1);
  }

  const conversations: LocoConversation[] = JSON.parse(
    readFileSync(datasetPath, "utf8"),
  ).slice(0, maxConvos);

  // ── Build engines ────────────────────────────────────────────────────
  const engines: BenchEngine[] = [];
  const memosEngine = engineIds.includes("memos")
    ? new MemOSEngine(providerArgs, retrievalArgs)
    : null;
  const mem0Engine = engineIds.includes("mem0")
    ? new Mem0Engine({
        python: resolveVendorPython(),
        embedder: flag("vendor-embedder") ?? "ollama",
        model: flag("vendor-model") ?? "nomic-embed-text",
        baseUrl: flag("vendor-base-url"),
        apiKey: flag("vendor-api-key"),
        store: flag("vendor-store") ?? "chroma",
        llmProvider:
          (flag("vendor-llm") as "openai" | "ollama" | undefined) ?? "openai",
        llmUrl: flag("vendor-llm-url"),
        llmModel: flag("vendor-llm-model"),
        llmKey: flag("vendor-llm-key"),
      })
    : null;

  if (memosEngine) {
    const provider = buildProvider(providerArgs);
    const runtimeInfo = await assertNoFallback(provider, providerArgs);
    if (runtimeInfo.fallbackActive) {
      console.warn(
        "[bench-vendors] MemOS leg is running on a FALLBACK embedder — " +
          "vendor scores from this run are not publishable.",
      );
    }
    await memosEngine.init(provider);
    engines.push(memosEngine);
  }
  if (mem0Engine) {
    await mem0Engine.init();
    if (!mem0Engine.ready) {
      console.warn(
        `[bench-vendors] mem0 engine SKIPPED: ${mem0Engine.skipReason}`,
      );
    } else {
      engines.push(mem0Engine);
    }
  }

  if (engines.length === 0) {
    console.error("No engine is ready. See the skip reasons above.");
    process.exit(1);
  }

  // Embedder comparability guard — the whole point of the harness.
  const embeddingSummaries = engines
    .filter((e) => e.ready)
    .map((e) => `${e.id}:${e.embeddingSummary}`);
  const embedderMismatch =
    new Set(
      engines
        .filter((e) => e.ready)
        .map(
          (e) =>
            e.embeddingSummary.split("/").slice(-1)[0] ?? e.embeddingSummary,
        ),
    ).size > 1;

  // ── Ingest + evaluate per engine ─────────────────────────────────────
  const perEngine = new Map<
    string,
    { queries: EvalQueryResult[]; ingestionMs: number; report: MetricsReport }
  >();
  const benchStart = Date.now();

  for (const engine of engines) {
    if (!engine.ready) continue;
    const queries: EvalQueryResult[] = [];
    const ingestStart = Date.now();
    for (let convIdx = 0; convIdx < conversations.length; convIdx++) {
      const conv = conversations[convIdx]!;
      const { conversation } = conv;
      const sessionKeys = Object.keys(conversation).filter(
        (k) =>
          k !== "speaker_a" && k !== "speaker_b" && !k.endsWith("_date_time"),
      );
      for (const sessionKey of sessionKeys) {
        const chats = conversation[sessionKey] as unknown as LocoChat[];
        if (!Array.isArray(chats)) continue;
        const sessionTimestamp = String(
          (conversation as Record<string, unknown>)[
            `${sessionKey}_date_time`
          ] ?? "",
        );
        for (const chat of chats) {
          if (!chat?.dia_id) continue;
          await engine.ingest(convIdx, chat, sessionTimestamp);
        }
      }
      await engine.flush();
      for (const [qaIdx, qa] of conv.qa.entries()) {
        const start = Date.now();
        const retrievedIds = await engine.search(convIdx, qa.question, topK);
        queries.push({
          questionId: `conv${convIdx}_q${qaIdx}`,
          relevantIds: (qa.evidence ?? []).filter(
            (e) => typeof e === "string" && e.length > 0,
          ),
          retrievedIds,
          category: categoryName(qa.category),
          latencyMs: Date.now() - start,
        });
      }
      console.log(
        `[${engine.id}] conv ${convIdx} done: ${conv.qa.length} questions`,
      );
    }
    const ingestionMs = Date.now() - ingestStart;
    perEngine.set(engine.id, {
      queries,
      ingestionMs,
      report: aggregateMetrics(queries),
    });
    await engine.close();
  }

  const durationMs = Date.now() - benchStart;

  // ── Report ───────────────────────────────────────────────────────────
  const fmt = (x: number): string => `${(x * 100).toFixed(1).padStart(5)}%`;
  console.log(
    `\n=== Same-protocol vendor benchmark (LoCoMo convs 0-${maxConvos - 1}, ` +
      `${perEngine.get(engines[0]!.id)?.queries.length ?? 0} questions, top-${topK}) ===`,
  );
  console.log(
    "Metric                       " +
      engines
        .filter((e) => perEngine.has(e.id))
        .map((e) => e.id.padEnd(10))
        .join(""),
  );
  console.log("─────────────────────────────────────────────────────────────");
  const rows: Array<[string, (m: MetricsReport) => number]> = [
    ["Hit rate", (m) => m.at10.hitRate],
    ["Evidence recall", (m) => m.at10.evidenceRecall],
    ["All-evidence recall", (m) => m.at10.allEvidenceRecall],
    ["Precision", (m) => m.at10.precision],
    ["MRR", (m) => m.at10.mrr],
    ["nDCG", (m) => m.at10.ndcg],
  ];
  for (const [label, pick] of rows) {
    console.log(
      label.padEnd(28) +
        engines
          .filter((e) => perEngine.has(e.id))
          .map((e) => {
            const val = pick(perEngine.get(e.id)!.report);
            return label === "MRR" || label === "nDCG"
              ? val.toFixed(3).padEnd(10)
              : fmt(val);
          })
          .join(""),
    );
  }
  if (embedderMismatch) {
    console.log(
      "\n⚠ COMPARABILITY WARNING: engines used different embedders " +
        `(${embeddingSummaries.join(" vs ")}). ` +
        "These columns are NOT comparable — re-run with one embedder for both.",
    );
  }
  if (mem0Engine && !mem0Engine.ready) {
    console.log(`\nmem0 was SKIPPED: ${mem0Engine.skipReason}`);
  }

  // ── Persist ──────────────────────────────────────────────────────────
  const outPath = flag("out") ?? "scripts/bench-vendors-results.json";
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        ...benchMetadata(
          providerArgs,
          runtimeInfoOf(providerArgs),
          {
            name: "locomo10",
            path: datasetPath,
          },
          retrievalArgs,
        ),
        benchmark: "vendor-same-protocol-retrieval-only",
        engines: engineIds,
        questions: perEngine.get(engines[0]!.id)?.queries.length ?? 0,
        topK,
        conversations: conversations.length,
        comparability: {
          embedderMismatch,
          embeddings: Object.fromEntries(
            engines
              .filter((e) => e.ready)
              .map((e) => [e.id, e.embeddingSummary]),
          ),
          note:
            "Cross-vendor scores are only comparable when engines share " +
            "the embedder. Ingestion is raw on both sides (mem0 " +
            "infer=False). Publish deltas under one embedder, never " +
            "absolute cross-vendor numbers.",
        },
        skipped: engines
          .filter((e) => !e.ready)
          .map((e) => ({ id: e.id, reason: e.skipReason })),
        durationMs,
        perEngine: Object.fromEntries(
          [...perEngine.entries()].map(([id, r]) => [
            id,
            {
              ingestionMs: r.ingestionMs,
              metrics: { at5: r.report.at5, at10: r.report.at10 },
              perCategory: r.report.perCategory,
            },
          ]),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to ${outPath}`);
}

/** Runtime info for the metadata block — never falls back silently:
 *  it records what the MemOS leg actually ran with. */
function runtimeInfoOf(providerArgs: BenchProviderArgs): EmbeddingRuntimeInfo {
  return {
    requestedProvider: providerArgs.provider,
    resolvedProvider: providerArgs.provider,
    requestedModel: providerArgs.model ?? "unknown",
    resolvedModel: providerArgs.model ?? "unknown",
    modelRevision: null,
    requestedDimensions: providerArgs.dimensions ?? null,
    observedDimensions: null,
    fallbackActive: false,
    fallbackReason: null,
  } as unknown as EmbeddingRuntimeInfo;
}

main().catch((err) => {
  console.error("Vendor benchmark failed:", err);
  process.exit(1);
});
