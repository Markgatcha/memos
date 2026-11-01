import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared LLM answer/judge client for MemOS benchmarks.
 *
 * Why this module exists: the end-to-end (retrieve → answer → judge) path was
 * copy-pasted into every bench script with hardcoded model names and
 * `temperature: 0.7`. That produced numbers nobody could reproduce or compare:
 *
 *   - the doc comment named one model and the code called another;
 *   - temperature 0.7 makes a run non-deterministic, so a 1-point "improvement"
 *     between two runs could be sampling noise;
 *   - the answer model and judge model were never written into the results
 *     file, so a published score carried no provenance;
 *   - no token accounting, so cost-per-correct-answer was unknowable.
 *
 * This module fixes all four. Every e2e number a MemOS bench emits must route
 * through here so the results file can state, verbatim, which models produced
 * it.
 *
 * Environment:
 *   OPENAI_API_KEY      required (any OpenAI-compatible endpoint)
 *   OPENAI_BASE_URL     default https://api.openai.com/v1
 *   BENCH_ANSWER_MODEL  default gpt-4o-mini
 *   BENCH_JUDGE_MODEL   default BENCH_ANSWER_MODEL
 *   BENCH_LLM_TEMPERATURE  default 0 (deterministic; raise only deliberately)
 *   BENCH_LLM_MAX_TOKENS   default 256
 *   BENCH_LLM_SEED         default 0 (passed when the endpoint supports it)
 */

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  answerModel: string;
  judgeModel: string;
  temperature: number;
  maxTokens: number;
  seed: number;
  /** Sent as `reasoning_effort` when set (e.g. "high"). */
  reasoningEffort: string;
  /** Directory for the local response cache; empty disables it. */
  cacheDir: string;
}

export interface LlmUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the provider's cache (billed cheaper). */
  cachedTokens: number;
  /** Responses served from the local disk cache (no network call). */
  localHits: number;
  errors: number;
}

export function newUsage(): LlmUsage {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    localHits: 0,
    errors: 0,
  };
}

/** Merge `b` into `a` in place (accumulator pattern for parallel-ish loops). */
export function accumulateUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  a.calls += b.calls;
  a.promptTokens += b.promptTokens;
  a.completionTokens += b.completionTokens;
  a.totalTokens += b.totalTokens;
  a.cachedTokens += b.cachedTokens;
  a.localHits += b.localHits;
  a.errors += b.errors;
  return a;
}

export function resolveLlmConfig(): LlmConfig {
  const answerModel = process.env.BENCH_ANSWER_MODEL || "gpt-4o-mini";
  return {
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    answerModel,
    judgeModel: process.env.BENCH_JUDGE_MODEL || answerModel,
    temperature: Number(process.env.BENCH_LLM_TEMPERATURE ?? "0"),
    maxTokens: Number(process.env.BENCH_LLM_MAX_TOKENS ?? "256"),
    seed: Number(process.env.BENCH_LLM_SEED ?? "0"),
    reasoningEffort: process.env.BENCH_LLM_REASONING_EFFORT ?? "",
    cacheDir: process.env.BENCH_LLM_CACHE_DIR ?? ".bench-llm-cache",
  };
}

/**
 * Minimal provenance block for a results file. Without this, a published
 * accuracy figure is unfalsifiable — the single biggest reason cross-vendor
 * memory benchmark numbers are not comparable today.
 */
export function llmProvenance(cfg: LlmConfig): Record<string, unknown> {
  return {
    answerModel: cfg.answerModel,
    judgeModel: cfg.judgeModel,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    seed: cfg.seed,
    reasoningEffort: cfg.reasoningEffort || "default",
    cacheDir: cfg.cacheDir || "disabled",
    /** Endpoint host only — never persist a key. */
    baseUrlHost: safeHost(cfg.baseUrl),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function cachePath(
  cfg: LlmConfig,
  model: string,
  messages: Array<{ role: string; content: string }>,
): string {
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        model,
        messages,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        seed: cfg.seed,
        reasoningEffort: cfg.reasoningEffort,
      }),
    )
    .digest("hex");
  return join(cfg.cacheDir, `${key}.json`);
}

function readCache(cfg: LlmConfig, path: string): string | null {
  if (!cfg.cacheDir) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { content?: string };
    return typeof parsed.content === "string" ? parsed.content : null;
  } catch {
    return null;
  }
}

function writeCache(cfg: LlmConfig, path: string, content: string): void {
  if (!cfg.cacheDir) return;
  try {
    mkdirSync(cfg.cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ content }), "utf8");
  } catch {
    // A cache miss is always safe; never fail a run because of it.
  }
}

/**
 * One chat completion. Retries on 429/402/403 with exponential backoff.
 * `temperature` and `seed` are always sent so runs are reproducible on
 * endpoints that honour them.
 */
export async function chat(
  cfg: LlmConfig,
  model: string,
  messages: Array<{ role: string; content: string }>,
  usage: LlmUsage,
  maxRetries = 3,
): Promise<string> {
  if (!cfg.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. End-to-end scoring requires an " +
        "OpenAI-compatible endpoint; use --retrieve-only for the " +
        "deterministic (no-LLM) path.",
    );
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const cacheFile = cachePath(cfg, model, messages);
    const cached = readCache(cfg, cacheFile);
    if (cached !== null) {
      usage.localHits++;
      return cached;
    }
    let resp: Response;
    try {
      resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: cfg.temperature,
          seed: cfg.seed,
          max_tokens: cfg.maxTokens,
          ...(cfg.reasoningEffort
            ? { reasoning_effort: cfg.reasoningEffort }
            : {}),
        }),
      });
    } catch (e) {
      usage.errors++;
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 2000);
        continue;
      }
      throw new Error(
        `Network error after ${maxRetries} retries: ${String(e)}`,
      );
    }

    if (!resp.ok) {
      const errText = (await resp.text()).substring(0, 200);
      const retryable = [429, 402, 403, 500, 502, 503, 504].includes(
        resp.status,
      );
      usage.errors++;
      if (retryable && attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 2000);
        continue;
      }
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }

    const data = (await resp.json()) as ChatResponse;
    usage.calls++;
    usage.promptTokens += data.usage?.prompt_tokens ?? 0;
    usage.completionTokens += data.usage?.completion_tokens ?? 0;
    usage.totalTokens +=
      data.usage?.total_tokens ??
      (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0);
    usage.cachedTokens += data.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const choice = data.choices?.[0]?.message;
    const content = (choice?.content || choice?.reasoning_content || "").trim();
    writeCache(cfg, cacheFile, content);
    return content;
  }

  throw new Error("Max retries exceeded");
}

export interface ContextItem {
  content: string;
  timestamp?: string;
  /** Optional provenance label, e.g. "memory" vs "raw session chunk". */
  source?: string;
}

/**
 * Answer `question` using only the provided context. `arm` selects the
 * comparison condition so that every published accuracy is a *delta against a
 * baseline measured with the same answer model and the same judge*:
 *
 *   "memory"       — MemOS-retrieved context (the system under test)
 *   "full-context" — every haystack session, truncated (upper-bound baseline)
 *   "no-memory"    — no context at all (lower-bound floor)
 *
 * A memory layer that scores 80% means nothing until you know full-context
 * scores 72% and no-memory scores 30%.
 */
export async function answerFromContext(
  cfg: LlmConfig,
  question: string,
  contexts: ContextItem[],
  usage: LlmUsage,
  arm: "memory" | "full-context" | "no-memory" = "memory",
): Promise<string> {
  if (arm === "no-memory" || contexts.length === 0) {
    const prompt =
      `You are an intelligent memory assistant. Answer the question ` +
      `concisely using only your general knowledge. If you cannot know the ` +
      `answer, reply exactly: UNKNOWN.\n\nQuestion: ${question}\n\n` +
      `Answer (be concise, 1-5 words if possible):`;
    return safeChat(cfg, cfg.answerModel, prompt, usage, "answer");
  }

  const memoryContext = contexts
    .map((m, i) => {
      const tag = m.timestamp ? `[${m.timestamp}]` : "";
      const src = m.source ? `<${m.source}>` : "";
      return `${i + 1}. ${src}${tag} ${m.content}`.replace(/\s+/g, " ");
    })
    .join("\n");

  const prompt =
    `You are an intelligent memory assistant. Given the following ` +
    `conversation memories, answer the question concisely.\n\n` +
    `Memories:\n${memoryContext}\n\nQuestion: ${question}\n\n` +
    `Answer (be concise, 1-5 words if possible):`;

  return safeChat(cfg, cfg.answerModel, prompt, usage, "answer");
}

/**
 * Score a prediction against ground truth. Returns 1 or 0.
 * Failures score 0 — never `null` — so a broken judge can only ever *lower*
 * the reported number, never silently drop questions from the denominator.
 */
/**
 * LLM query decomposition for retrieval. Returns a short list of
 * sub-queries/entity strings that cover different aspects of a
 * multi-session question ("How many instruments do I own?" →
 * "guitar", "piano", "drum set", "instruments I own"). The caller runs
 * each against the memory index and fuses by reciprocal rank; this is the
 * query-side analogue of the paper's key expansion and is cheap (one
 * completion per question). Empty array on any parse failure — retrieval
 * then falls back to the original query alone.
 */
export async function expandQuery(
  question: string,
  cfg: LlmConfig,
  usage: LlmUsage,
): Promise<string[]> {
  const prompt =
    `You expand a question into search queries for a long chat-history ` +
    `memory store. The history is many separate conversations; the answer ` +
    `may require facts from several of them.\n\n` +
    `Question: ${question}\n\n` +
    `Return ONLY a JSON array of 3 to 6 short search strings. Include ` +
    `distinct entities, synonyms, and aspects that might appear in a ` +
    `relevant conversation. Do not answer the question. Example: ` +
    `["guitar I own","piano","drum set","musical instruments"].`;
  try {
    const raw = await chat(
      cfg,
      cfg.answerModel,
      [{ role: "user", content: prompt }],
      usage,
      2,
    );
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter((x) => x.length > 1)
      .slice(0, 6);
  } catch {
    return [];
  }
}

export async function judgeCorrect(
  cfg: LlmConfig,
  question: string,
  groundTruth: string,
  predicted: string,
  usage: LlmUsage,
): Promise<number> {
  if (!predicted.trim()) return 0;

  const prompt =
    `You are an impartial judge evaluating whether an AI system correctly ` +
    `answered a question based on retrieved memories.\n\n` +
    `Question: ${question}\n\n` +
    `Ground truth answer: ${groundTruth}\n\n` +
    `Predicted answer: ${predicted}\n\n` +
    `Does the predicted answer correctly answer the question and match the ` +
    `ground truth? Consider semantic equivalence, not exact string matching. ` +
    `Score: 1 if the predicted answer is correct (matches or is a valid ` +
    `paraphrase of the ground truth), 0 if incorrect.\n` +
    `Only output a single digit: 1 or 0.`;

  const text = await safeChat(cfg, cfg.judgeModel, prompt, usage, "judge");
  const match = text.match(/[01]/);
  return match ? parseInt(match[0] ?? "0", 10) : 0;
}

async function safeChat(
  cfg: LlmConfig,
  model: string,
  prompt: string,
  usage: LlmUsage,
  label: string,
): Promise<string> {
  try {
    return await chat(cfg, model, [{ role: "user", content: prompt }], usage);
  } catch (e) {
    usage.errors++;
    console.error(`[bench-llm] ${label} error: ${String(e).substring(0, 160)}`);
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
