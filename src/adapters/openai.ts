/**
 * MemOS OpenAI Adapter — first-class memory integration for the OpenAI SDK.
 *
 * Wraps a MemOS instance and exposes helpers that map cleanly onto the
 * OpenAI Chat Completions API: a memory-backed function tool, system-prompt
 * context injection, automatic fact extraction from conversations, and
 * simple store/forget helpers.
 *
 * The adapter has **zero hard dependencies** on the `openai` package. Every
 * exported message/tool shape is structurally compatible with the
 * corresponding `openai` types (`ChatCompletionMessageParam`,
 * `ChatCompletionTool`, `ChatCompletionToolMessageParam`), so they can be
 * passed straight into `openai.chat.completions.create(...)` with no glue
 * layer. Install `openai` only if you want to call the model; the adapter
 * itself only needs MemOS.
 *
 * @example
 * ```ts
 * import OpenAI from "openai";
 * import { createOpenAIMemory } from "@mem-os/sdk/openai";
 *
 * const { plugin } = await createOpenAIMemory({ dbPath: "./my-app.db" });
 * const openai = new OpenAI();
 *
 * const completion = await openai.chat.completions.create({
 *   model: "gpt-4o",
 *   messages: [{ role: "user", content: "What theme do I like?" }],
 *   tools: [plugin.memoryTool],
 * });
 * ```
 *
 * @module @memos/adapters/openai
 */

import { MemOS } from "../index.js";
import type {
  ConversationMessage,
  CreateMemoryInput,
  ExtractFactsResult,
  MemoryNode,
  MemorySource,
  MemoryType,
  MemOSConfig,
  ScoredMemory,
  SearchFilter,
} from "../index.js";

// ---------------------------------------------------------------------------
// OpenAI-compatible types (no `openai` package dependency required)
// ---------------------------------------------------------------------------

/** Chat message role, compatible with the OpenAI Chat Completions API. */
export type OpenAIRole = "system" | "user" | "assistant" | "tool";

/**
 * Minimal OpenAI-compatible chat message.
 *
 * Structurally compatible with `openai.ChatCompletionMessageParam` for the
 * plain-text cases this adapter produces and consumes.
 */
export interface OpenAIChatMessage {
  role: OpenAIRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

/**
 * A `tool`-role message returned to the model after a tool call.
 * Compatible with `openai.ChatCompletionToolMessageParam`.
 *
 * Note: `tool_call_id` is left optional here; set it to the id of the
 * `tool_call` you are responding to before sending.
 */
export interface OpenAIToolMessage {
  role: "tool";
  content: string;
  tool_call_id?: string;
}

/**
 * A function-tool definition registrable via the `tools` parameter of
 * `openai.chat.completions.create`. Compatible with
 * `openai.ChatCompletionTool`.
 */
export interface OpenAIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** A JSON Schema object describing the function parameters. */
    parameters: Record<string, unknown>;
  };
}

/**
 * A single memory rendered as a plain JSON object, suitable for returning
 * as a tool result.
 */
export interface OpenAIMemoryEntry {
  id: string;
  content: string;
  summary: string;
  type: MemoryType;
  /** Relevance score from the search. */
  score: number;
  tags: string[];
  trustScore: number;
}

/** Options for {@link MemOSOpenAIPlugin.searchMemories}. */
export interface OpenAISearchMemoriesOptions {
  /** Maximum number of memories to return. @default 5 */
  limit?: number;
  /** Restrict results to a memory type. */
  type?: MemoryType;
  /** Restrict results to a namespace. */
  namespace?: string;
}

/** Options for {@link MemOSOpenAIPlugin.getMemoryContext}. */
export interface OpenAIGetMemoryContextOptions {
  /** Maximum memories to inject. @default 5 */
  limit?: number;
  /** Whether to extract & store facts from `messages` first. @default true */
  extract?: boolean;
}

/** Result returned by {@link MemOSOpenAIPlugin.searchMemories}. */
export interface OpenAIMemorySearchResult {
  /** The query that was searched. */
  query: string;
  /** Ranked memory entries. */
  memories: OpenAIMemoryEntry[];
  /** A ready-to-send `tool` message containing the JSON-encoded memories. */
  toolMessage: OpenAIToolMessage;
}

// ---------------------------------------------------------------------------
// Plugin configuration
// ---------------------------------------------------------------------------

/** Options for {@link MemOSOpenAIPlugin}. */
export interface MemOSOpenAIPluginOptions {
  /** Maximum memories to inject into context / return from a search. @default 5 */
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

/** Configuration for {@link createOpenAIMemory}. */
export interface OpenAIMemoryConfig extends MemOSConfig {
  /** Plugin-level options. */
  plugin?: MemOSOpenAIPluginOptions;
}

/** Result of {@link createOpenAIMemory}. */
export interface CreateOpenAIMemoryResult {
  /** The initialised MemOS instance. */
  memos: MemOS;
  /** The OpenAI memory plugin bound to that instance. */
  plugin: MemOSOpenAIPlugin;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * OpenAI SDK memory plugin backed by MemOS.
 *
 * Wrap an existing MemOS instance, or use {@link createOpenAIMemory} to
 * construct both in one call. The plugin does not call the OpenAI API
 * itself — it prepares memories (as tools, tool messages, and system-prompt
 * strings) for you to feed into your own `openai.chat.completions` calls.
 */
export class MemOSOpenAIPlugin {
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
   * Create a new OpenAI memory plugin.
   *
   * @param memos - An initialised MemOS instance.
   * @param opts  - Plugin options. All fields optional with sensible defaults.
   */
  constructor(memos: MemOS, opts: MemOSOpenAIPluginOptions = {}) {
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
   * OpenAI function-tool definition that lets the model search the user's
   * memory. Pass it via the `tools` parameter of
   * `openai.chat.completions.create`.
   *
   * When the model invokes it, call {@link searchMemories} and return the
   * `toolMessage` field (after setting `tool_call_id`) as a tool message.
   */
  get memoryTool(): OpenAIToolDefinition {
    return {
      type: "function",
      function: {
        name: "search_memories",
        description:
          "Search the user's persistent MemOS memory for relevant facts, " +
          "preferences, and context. Call this before answering personal or " +
          "preference questions, or when prior context seems relevant.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural-language search query.",
            },
            limit: {
              type: "number",
              description: "Maximum number of memories to return.",
              default: 5,
            },
          },
          required: ["query"],
        },
      },
    };
  }

  /**
   * Extract facts from a conversation and store them in MemOS.
   *
   * Runs MemOS' local rule-based fact extractor over the conversation,
   * persisting any candidate facts whose confidence meets the configured
   * `minConfidence` threshold. Near-duplicates are skipped automatically
   * when embeddings are available.
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
   * Search memories and format the results for OpenAI tool use.
   *
   * @param query - Natural-language search query.
   * @param opts  - Search options (limit, type, namespace).
   * @returns An object containing the ranked memory entries and a
   *   ready-to-send `tool` message (JSON-encoded memories). Set
   *   `toolMessage.tool_call_id` to the model's `tool_call` id before
   *   returning it.
   */
  async searchMemories(
    query: string,
    opts: OpenAISearchMemoriesOptions = {},
  ): Promise<OpenAIMemorySearchResult> {
    const filter: SearchFilter = {
      query,
      limit: opts.limit ?? this.opts.maxContextMemories,
    };
    if (opts.type) filter.type = opts.type;
    if (opts.namespace) filter.namespace = opts.namespace;

    const results = await this.memos.search(filter);
    const memories = results.map((r) => this.toEntry(r));
    const content =
      memories.length > 0
        ? JSON.stringify(memories, null, 2)
        : "No relevant memories found.";

    return {
      query,
      memories,
      toolMessage: { role: "tool", content },
    };
  }

  /**
   * Build a system-prompt string of relevant memories for injection.
   *
   * Optionally extracts & stores facts from the recent `messages` first,
   * then searches MemOS using the most recent user message and returns the
   * matches as a formatted block ready to prepend to the `system` prompt.
   *
   * @param messages - Recent conversation messages.
   * @param opts     - Context options (limit, whether to extract).
   * @returns A memory-context string, or `""` if nothing relevant was found.
   */
  async getMemoryContext(
    messages: ConversationMessage[],
    opts: OpenAIGetMemoryContextOptions = {},
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
   * @returns Scored memory nodes.
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
   * This is destructive and cannot be undone.
   */
  async clearMemories(): Promise<void> {
    await this.memos.clear();
  }

  /**
   * Return the total number of stored memories.
   *
   * @returns The current memory count.
   */
  getMemoryCount(): number {
    return this.memos.count;
  }

  /** Convert a scored memory into a JSON-friendly entry. */
  private toEntry(scored: ScoredMemory): OpenAIMemoryEntry {
    return {
      id: scored.node.id,
      content: scored.node.content,
      summary: scored.node.summary,
      type: scored.node.type,
      score: scored.score,
      tags: scored.node.tags,
      trustScore: scored.node.trustScore,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience constructor
// ---------------------------------------------------------------------------

/**
 * Create a MemOS instance and an OpenAI memory plugin in one call.
 *
 * The MemOS instance is created with `config`, initialised, and wrapped in a
 * {@link MemOSOpenAIPlugin}. Plugin-level options go under `config.plugin`.
 *
 * @param config - MemOS config plus optional `plugin` options.
 * @returns The initialised `memos` instance and bound `plugin`.
 *
 * @example
 * ```ts
 * const { memos, plugin } = await createOpenAIMemory({
 *   dbPath: "./my-app.db",
 *   plugin: { maxContextMemories: 8 },
 * });
 * ```
 */
export async function createOpenAIMemory(
  config: OpenAIMemoryConfig = {},
): Promise<CreateOpenAIMemoryResult> {
  const { plugin: pluginOpts, ...memosConfig } = config;
  const memos = new MemOS(memosConfig);
  await memos.init();
  const plugin = new MemOSOpenAIPlugin(memos, pluginOpts);
  return { memos, plugin };
}

// ---------------------------------------------------------------------------
// Usage example
// ---------------------------------------------------------------------------
/*
 * End-to-end example using the official `openai` SDK.
 *
 *   npm install openai
 *
 * import OpenAI from "openai";
 * import { createOpenAIMemory } from "@mem-os/sdk/openai";
 *
 * // 1. Boot MemOS + the plugin.
 * const { memos, plugin } = await createOpenAIMemory({
 *   dbPath: "./my-app.db",
 *   plugin: { maxContextMemories: 6 },
 * });
 *
 * const openai = new OpenAI();
 *
 * // 2. Teach it something. addMessages() extracts & stores facts.
 * await plugin.addMessages([
 *   { role: "user", content: "I prefer dark mode in all my apps." },
 *   { role: "assistant", content: "Got it — dark mode it is." },
 * ]);
 *
 * // 3a. Context-injection style: fold memories into the system prompt.
 * const systemCtx = await plugin.getMemoryContext([
 *   { role: "user", content: "What theme do I like?" },
 * ]);
 * const a = await openai.chat.completions.create({
 *   model: "gpt-4o",
 *   messages: [
 *     { role: "system", content: `You are a helpful assistant.\n\n${systemCtx}` },
 *     { role: "user", content: "What theme do I like?" },
 *   ],
 * });
 * console.log(a.choices[0].message.content); // → "dark mode"
 *
 * // 3b. Tool style: let the model call search_memories itself.
 * const tools = [plugin.memoryTool];
 * const res = await openai.chat.completions.create({
 *   model: "gpt-4o",
 *   messages: [{ role: "user", content: "What theme do I like?" }],
 *   tools,
 * });
 * const call = res.choices[0].message.tool_calls?.[0];
 * if (call && call.function.name === "search_memories") {
 *   const { query } = JSON.parse(call.function.arguments);
 *   const { toolMessage } = await plugin.searchMemories(query);
 *   toolMessage.tool_call_id = call.id;
 *   const followUp = await openai.chat.completions.create({
 *     model: "gpt-4o",
 *     messages: [
 *       { role: "user", content: "What theme do I like?" },
 *       res.choices[0].message,
 *       toolMessage,
 *     ],
 *     tools,
 *   });
 *   console.log(followUp.choices[0].message.content); // → "dark mode"
 * }
 *
 * // 4. Housekeeping helpers.
 * console.log(plugin.getMemoryCount()); // number of stored memories
 * await plugin.clearMemories();         // wipe everything
 */
