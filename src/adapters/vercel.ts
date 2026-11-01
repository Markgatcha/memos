/**
 * MemOS Vercel AI SDK Adapter — memory tools and context injection for the
 * Vercel AI SDK (`ai` package, v5+).
 *
 * Exposes MemOS as a set of ready-to-use AI SDK tools plus a system-prompt
 * context builder. Tools use the AI SDK 5 shape (`description`,
 * `inputSchema`, `execute`) — `inputSchema` replaced v4's `parameters`.
 *
 * The adapter has **no hard dependency** on the `ai` package. The tool
 * objects it returns are structurally compatible with what `generateText`
 * and `streamText` accept in their `tools` parameter, so you can pass them
 * straight through. `zod` is a direct dependency of MemOS, so the schemas
 * are real Zod schemas rather than hand-rolled JSON Schema.
 *
 * @example
 * ```ts
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 * import { createVercelMemory } from "@mem-os/sdk/vercel";
 *
 * const { plugin } = await createVercelMemory({ dbPath: "./my-app.db" });
 *
 * const { text } = await generateText({
 *   model: openai("gpt-4o"),
 *   tools: plugin.tools,
 *   prompt: "What theme do I prefer?",
 * });
 * ```
 *
 * @module @mem-os/adapters/vercel
 */

import { z } from "zod";

import { MemOS } from "../index.js";
import type {
  ConversationMessage,
  CreateMemoryInput,
  ExtractFactsResult,
  IngestResult,
  MemoryNode,
  MemorySource,
  MemoryType,
  MemOSConfig,
  ScoredMemory,
  SearchFilter,
} from "../index.js";

// ---------------------------------------------------------------------------
// AI SDK–compatible tool shape (no `ai` package dependency required)
// ---------------------------------------------------------------------------

/**
 * A tool definition compatible with the Vercel AI SDK v5 `Tool` union.
 *
 * `inputSchema` is a Zod schema that the SDK hands to the model as JSON
 * Schema and uses to validate the model's arguments before `execute` runs.
 * `execute` receives the validated, typed input.
 */
export interface VercelTool<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: z.ZodType<Input>;
  execute: (input: Input) => Promise<Output>;
}

/** A single memory as returned by the search tool. */
export interface VercelMemoryEntry {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  score: number;
}

/** Options for {@link MemOSVercelPlugin.searchMemories}. */
export interface VercelSearchMemoriesOptions {
  /** Maximum number of memories to return. */
  limit?: number;
  /** Restrict to a specific memory type. */
  type?: MemoryType;
  /** Namespace to search (experimental). */
  namespace?: string;
}

/** Options for {@link MemOSVercelPlugin.getMemoryContext}. */
export interface VercelGetMemoryContextOptions {
  /** Maximum number of memories to inject. */
  limit?: number;
  /** Extract and store facts from `messages` before searching. */
  extract?: boolean;
}

/** Plugin-level options for {@link MemOSVercelPlugin}. */
export interface MemOSVercelPluginOptions {
  /** Maximum memories injected into context / returned by a search. @default 5 */
  maxContextMemories?: number;
  /**
   * Automatically extract & store facts when `addMessages` or
   * `getMemoryContext` are called. @default true
   */
  autoExtractFacts?: boolean;
  /** Minimum message length (chars) to consider for fact extraction. @default 15 */
  minMessageLength?: number;
  /** Provenance source tag for memories created by this adapter. @default "user_input" */
  source?: MemorySource;
  /** Minimum confidence for an extracted fact to be stored. @default 0.6 */
  minConfidence?: number;
  /** Namespace to store/search memories in (experimental). @default "default" */
  namespace?: string;
}

/** Configuration for {@link createVercelMemory}. */
export interface VercelMemoryConfig extends MemOSConfig {
  /** Plugin-level options. */
  plugin?: MemOSVercelPluginOptions;
}

/** Result of {@link createVercelMemory}. */
export interface CreateVercelMemoryResult {
  /** The initialised MemOS instance. */
  memos: MemOS;
  /** The AI SDK memory plugin bound to that instance. */
  plugin: MemOSVercelPlugin;
}

/**
 * The tool set {@link MemOSVercelPlugin.tools} returns.
 *
 * Declared explicitly rather than as `Record<string, VercelTool>` so each
 * tool keeps its real input/output types: a plain record would widen every
 * `execute` input to `unknown` (function parameters are contravariant).
 */
export interface MemOSVercelTools {
  search_memories: VercelTool<
    { query: string; limit?: number },
    { query: string; memories: VercelMemoryEntry[] }
  >;
  store_memory: VercelTool<
    { content: string; type?: MemoryType; tags?: string[] },
    { id: string; stored: boolean }
  >;
  forget_memory: VercelTool<
    { memoryId: string },
    { id: string; forgotten: boolean }
  >;
  ingest_documents: VercelTool<
    { path: string; namespace?: string },
    IngestResult
  >;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Vercel AI SDK memory plugin backed by MemOS.
 *
 * Wrap an existing MemOS instance, or use {@link createVercelMemory} to
 * construct both in one call. The plugin never calls a model itself — it
 * prepares memory as AI SDK tools and system-prompt text for you to pass
 * into your own `generateText` / `streamText` calls.
 */
export class MemOSVercelPlugin {
  /** The wrapped MemOS instance. */
  readonly memos: MemOS;

  private readonly opts: {
    maxContextMemories: number;
    autoExtractFacts: boolean;
    minMessageLength: number;
    source: MemorySource;
    minConfidence: number;
    namespace: string;
  };

  /**
   * Create a new AI SDK memory plugin.
   *
   * @param memos - An initialised MemOS instance.
   * @param opts  - Plugin options. All fields optional with sensible defaults.
   */
  constructor(memos: MemOS, opts: MemOSVercelPluginOptions = {}) {
    this.memos = memos;
    this.opts = {
      maxContextMemories: opts.maxContextMemories ?? 5,
      autoExtractFacts: opts.autoExtractFacts ?? true,
      minMessageLength: opts.minMessageLength ?? 15,
      source: opts.source ?? "user_input",
      minConfidence: opts.minConfidence ?? 0.6,
      namespace: opts.namespace ?? "default",
    };
  }

  /**
   * AI SDK tools backed by MemOS.
   *
   * Spread straight into a `generateText` / `streamText` call:
   *
   * ```ts
   * const { text } = await generateText({
   *   model,
   *   tools: plugin.tools,
   *   prompt: "What do I prefer?",
   * });
   * ```
   *
   * `search_memories` is the one the model should reach for on personal or
   * preference questions; `store_memory` and `forget_memory` let it write
   * back and correct itself without a round trip through your code.
   */
  get tools(): MemOSVercelTools {
    const namespace = this.opts.namespace;
    const defaultLimit = this.opts.maxContextMemories;

    return {
      search_memories: {
        description:
          "Search the user's persistent MemOS memory for relevant facts, " +
          "preferences, and context. Call this before answering personal or " +
          "preference questions, or when prior context seems relevant.",
        inputSchema: z.object({
          query: z.string().min(1).describe("Natural-language search query."),
          limit: z
            .number()
            .int()
            .positive()
            .max(50)
            .optional()
            .describe("Maximum number of memories to return."),
        }),
        execute: async (input: { query: string; limit?: number }) => {
          const memories = await this.searchMemories(input.query, {
            limit: input.limit ?? defaultLimit,
          });
          return { query: input.query, memories };
        },
      },

      store_memory: {
        description:
          "Store a durable fact, preference, or decision in the user's " +
          "persistent memory so it can be recalled in future sessions. " +
          "Use for stable information, not for transient chatter.",
        inputSchema: z.object({
          content: z
            .string()
            .min(1)
            .describe("The fact to remember, as a self-contained sentence."),
          type: z
            .enum(["fact", "preference", "context", "entity", "relationship"])
            .optional()
            .describe("Semantic category of the memory."),
          tags: z
            .array(z.string())
            .optional()
            .describe("Optional tags for later filtering."),
        }),
        execute: async (input: {
          content: string;
          type?: MemoryType;
          tags?: string[];
        }) => {
          const node = await this.remember(input.content, {
            ...(input.type ? { type: input.type } : {}),
            ...(input.tags ? { tags: input.tags } : {}),
            namespace,
          });
          return { id: node.id, stored: true };
        },
      },

      forget_memory: {
        description:
          "Permanently delete a memory by id. Use when the user asks you to " +
          "forget something, or when a stored fact is confirmed wrong.",
        inputSchema: z.object({
          memoryId: z.string().min(1).describe("Id of the memory to delete."),
        }),
        execute: async (input: { memoryId: string }) => {
          const forgotten = await this.forget(input.memoryId);
          return { id: input.memoryId, forgotten };
        },
      },

      ingest_documents: {
        description:
          "Ingest a file or folder (Markdown, text, HTML, PDF, CSV, JSON) " +
          "into persistent memory. Incremental: unchanged files are skipped " +
          "and deleted files have their chunks removed.",
        inputSchema: z.object({
          path: z.string().min(1).describe("File or folder path to ingest."),
          namespace: z.string().optional().describe("Target namespace."),
        }),
        execute: async (input: { path: string; namespace?: string }) =>
          this.memos.ingest(input.path, {
            ...(input.namespace !== undefined
              ? { namespace: input.namespace }
              : {}),
          }),
      },
    };
  }

  /**
   * Extract facts from a conversation and store them in MemOS.
   *
   * Runs MemOS' local rule-based extractor over the conversation, storing
   * candidates whose confidence meets `minConfidence`. Near-duplicates are
   * skipped when embeddings are available.
   *
   * @param conversation - The messages to extract facts from.
   * @returns The extraction result (candidate facts, stored ids, dup count).
   */
  async addMessages(
    conversation: ConversationMessage[],
  ): Promise<ExtractFactsResult> {
    const candidates = conversation.filter(
      (m) => m.content.trim().length >= this.opts.minMessageLength,
    );
    if (candidates.length === 0) {
      return { facts: [], storedIds: [], duplicates: 0 };
    }
    return this.memos.extractFacts(candidates, {
      autoStore: true,
      minConfidence: this.opts.minConfidence,
      namespace: this.opts.namespace,
      dedupe: true,
    });
  }

  /**
   * Search memories and return them as plain, JSON-serialisable entries.
   *
   * @param query - Natural-language search query.
   * @param opts  - Search options (limit, type, namespace).
   */
  async searchMemories(
    query: string,
    opts: VercelSearchMemoriesOptions = {},
  ): Promise<VercelMemoryEntry[]> {
    const filter: SearchFilter = {
      query,
      limit: opts.limit ?? this.opts.maxContextMemories,
    };
    if (opts.type) filter.type = opts.type;
    if (opts.namespace) filter.namespace = opts.namespace;

    const results = await this.memos.search(filter);
    return results.map((result) => this.toEntry(result));
  }

  /**
   * Build a system-prompt block of relevant memories.
   *
   * Optionally extracts & stores facts from `messages` first, then searches
   * using the most recent user message. Returns `""` when nothing relevant
   * was found, so it is safe to concatenate unconditionally.
   *
   * @param messages - Recent conversation messages.
   * @param opts     - Context options (limit, whether to extract).
   */
  async getMemoryContext(
    messages: ConversationMessage[],
    opts: VercelGetMemoryContextOptions = {},
  ): Promise<string> {
    const shouldExtract = opts.extract ?? this.opts.autoExtractFacts;
    if (shouldExtract && messages.length > 0) {
      await this.addMessages(messages);
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const query = lastUser?.content.trim() ?? "";
    if (!query) return "";

    const results = await this.memos.search({
      query,
      limit: opts.limit ?? this.opts.maxContextMemories,
    });
    if (results.length === 0) return "";

    const lines = ["Relevant memories from prior conversations:"];
    results.forEach((m, i) => {
      lines.push(`  ${i + 1}. [${m.node.type}] ${m.node.content}`);
    });
    return lines.join("\n");
  }

  /**
   * Manually store a memory.
   *
   * @param content - Text to remember.
   * @param opts    - Additional memory parameters (type, tags, importance…).
   * @returns The created memory node.
   */
  async remember(
    content: string,
    opts: Omit<CreateMemoryInput, "content"> = {},
  ): Promise<MemoryNode> {
    const { node } = await this.memos.store(content, {
      ...opts,
      source: opts.source ?? this.opts.source,
      namespace: opts.namespace ?? this.opts.namespace,
    });
    return node;
  }

  /**
   * Search for relevant memories.
   *
   * @param query - Search query.
   * @param limit - Maximum number of results. @default 5
   */
  async recall(query: string, limit: number = 5): Promise<ScoredMemory[]> {
    return this.memos.search({ query, limit });
  }

  /**
   * Permanently forget a memory.
   *
   * @param memoryId - ID of the memory to delete.
   * @returns `true` if the memory existed and was deleted.
   */
  async forget(memoryId: string): Promise<boolean> {
    return this.memos.forget(memoryId);
  }

  /**
   * Remove all memories and edges from the underlying MemOS instance.
   *
   * Destructive and cannot be undone.
   */
  async clearMemories(): Promise<void> {
    await this.memos.clear();
  }

  /**
   * Return the total number of stored memories.
   */
  getMemoryCount(): number {
    return this.memos.count;
  }

  /** Project a scored memory onto the serialisable entry shape. */
  private toEntry(result: ScoredMemory): VercelMemoryEntry {
    return {
      id: result.node.id,
      content: result.node.content,
      type: result.node.type,
      tags: result.node.tags ?? [],
      score: result.score,
    };
  }
}

/**
 * Create an initialised MemOS instance together with an AI SDK memory
 * plugin bound to it.
 *
 * @param config - MemOS configuration plus optional `plugin` options.
 * @returns The MemOS instance and its plugin.
 */
export async function createVercelMemory(
  config: VercelMemoryConfig = {},
): Promise<CreateVercelMemoryResult> {
  const { plugin: pluginOpts, ...memosConfig } = config;
  const memos = new MemOS(memosConfig);
  await memos.init();
  return { memos, plugin: new MemOSVercelPlugin(memos, pluginOpts) };
}

// ---------------------------------------------------------------------------
// Language-model middleware (AI SDK v5 `wrapLanguageModel`)
// ---------------------------------------------------------------------------

/** A message shape accepted by the AI SDK prompt array. */
export interface AISDKPromptMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

/** The parts of `LanguageModelV2CallOptions` this middleware touches. */
export interface AISDKCallParams {
  prompt?: AISDKPromptMessage[];
  [key: string]: unknown;
}

/**
 * Structural equivalent of the AI SDK's `LanguageModelV2Middleware`.
 * Declared locally so `@mem-os/sdk` keeps no hard dependency on `ai`.
 */
export interface AISDKRecallMiddleware {
  transformParams?: (options: {
    type: "generate" | "stream" | string;
    params: AISDKCallParams;
    model: unknown;
  }) => Promise<AISDKCallParams>;
}

/** Options for {@link memosRecallMiddleware}. */
export interface MemOSRecallMiddlewareOptions {
  /** Plugin bound to the memory store. */
  plugin: MemOSVercelPlugin;
  /** Fixed query. When omitted, the latest user message is used. */
  query?: string;
  /** Maximum memories to inject. Default 5. */
  limit?: number;
  /** Heading placed before the recall block. */
  prefix?: string;
  /** Store facts from the prompt before recalling. Default false. */
  extract?: boolean;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * AI SDK middleware that injects a memory pack before every model call.
 *
 * ```ts
 * import { wrapLanguageModel, generateText } from "ai";
 * import { createVercelMemory, memosRecallMiddleware } from "@mem-os/sdk/vercel";
 *
 * const { plugin } = await createVercelMemory();
 * const model = wrapLanguageModel({
 *   model: openai("gpt-4o"),
 *   middleware: memosRecallMiddleware({ plugin }),
 * });
 * ```
 *
 * The middleware never throws into the model call: a memory failure
 * degrades to the unmodified prompt.
 */
export function memosRecallMiddleware(
  opts: MemOSRecallMiddlewareOptions,
): AISDKRecallMiddleware {
  return {
    transformParams: async ({ params }) => {
      try {
        const prompt = params.prompt ?? [];
        const lastUser = [...prompt]
          .reverse()
          .find((message) => message.role === "user");
        const query = opts.query ?? contentText(lastUser?.content) ?? "";
        if (!query.trim()) return params;

        const context = await opts.plugin.getMemoryContext(
          [{ role: "user", content: query }],
          {
            extract: opts.extract ?? false,
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          },
        );
        if (!context) return params;

        const prefix = opts.prefix ?? "Relevant memory from prior sessions:";
        return {
          ...params,
          prompt: [
            { role: "system", content: `${prefix}\n${context}` },
            ...prompt,
          ],
        };
      } catch {
        return params;
      }
    },
  };
}
