/**
 * MCP server for MemOS — Model Context Protocol 2026-07-28.
 *
 * Built on the official `@modelcontextprotocol/server` v2 SDK, which
 * implements the 2026-07-28 spec (stateless core, `server/discover`,
 * per-request `_meta` envelope, `ttlMs`/`cacheScope` on list results,
 * `outputSchema` on tools). The SDK's `serveStdio` entry is dual-era:
 * it speaks the modern 2026-07-28 protocol AND falls back to the legacy
 * 2025-era `initialize` handshake for older clients.
 *
 * Transport: stdio only (the shipped transport). HTTP/SSE is deferred.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { MemOS } from "./memory.js";
import { listReminders } from "./event-memory.js";
import { graphToMermaid } from "./graph-mermaid.js";
import {
  ExplorerUriTemplate,
  buildExplorerFallbackMarkdown,
  buildExplorerHtml,
  buildExplorerSnapshot,
  resolveExplorerMode,
} from "./apps/explorer.js";
import type { MemOSConfig, ScoredMemory } from "./types.js";
import { getSdkVersion } from "./version.js";
import { citationToken } from "./citations.js";
import { decorateTrustFlags, isUntrustedForAgent } from "./provenance.js";

// ---------------------------------------------------------------------------
// Zod schemas for MemoryNode / MemoryEdge / ScoredMemory (output validation)
// ---------------------------------------------------------------------------

const memoryNodeSchema = z.object({
  id: z.string(),
  content: z.string(),
  summary: z.string(),
  type: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  importance: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  accessCount: z.number(),
  lastAccessed: z.number(),
  tags: z.array(z.string()),
  expiresAt: z.number().nullable(),
  namespace: z.string(),
  validFrom: z.number().nullable(),
  validTo: z.number().nullable(),
  source: z.string(),
  trustScore: z.number(),
  confidence: z.number().optional(),
  evidenceCount: z.number().optional(),
  // Provenance-trust layer (optional: third-party storage adapters may
  // not populate them).
  provenance: z.string().optional(),
  quarantined: z.boolean().optional(),
  quarantinedAt: z.number().nullable().optional(),
  quarantineReason: z.string().nullable().optional(),
});

const memoryEdgeSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  relation: z.string(),
  weight: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
});

const scoredMemorySchema = z.object({
  node: memoryNodeSchema,
  score: z.number(),
  scores: z
    .object({
      keyword: z.number().optional(),
      semantic: z.number().optional(),
      hybrid: z.number().optional(),
      provenance: z.number().optional(),
    })
    .optional(),
  // Provenance-trust read-time policy: low-trust channels
  // (imported/tool-output tiers, quarantined-then-released) are flagged
  // so the host agent confirms instead of silently injecting them.
  provenance: z.string().optional(),
  citation: z.string().optional(),
  untrustedSource: z.boolean().optional(),
  untrusted_source: z.boolean().optional(),
});

/**
 * Shape a scored memory for the MCP wire: provenance tier, citable
 * `[mem:hex]` token tracing the memory to its source episode, and the
 * read-time trust flag (`untrusted_source: true` for low-trust
 * channels). `provenance` carries the tier string; `untrusted_source`
 * is the snake_case flag host agents check.
 */
function toMcpResult(r: ScoredMemory): Record<string, unknown> {
  return {
    ...r,
    provenance: r.provenance ?? r.node.provenance,
    citation: r.citation ?? citationToken(r.node.id),
    harness: r.node.harness ?? "unknown",
    untrustedSource: r.untrustedSource ?? isUntrustedForAgent(r.node),
    untrusted_source: r.untrustedSource ?? isUntrustedForAgent(r.node),
  };
}

// Shared multi-scope input (composed into a namespace string in fixed
// order user -> agent -> run; hierarchical match by default).
const scopeInputSchema = z
  .object({
    user: z.string().optional().describe("User scope key."),
    agent: z.string().optional().describe("Agent scope key."),
    run: z.string().optional().describe("Run/session scope key."),
  })
  .optional();

// ---------------------------------------------------------------------------
// MCP tool annotations (readOnlyHint / destructiveHint / idempotentHint /
// openWorldHint), introduced 2025-03-26 and kept in the 2026-07-28 spec.
//
// Annotations are hints, not permissions: annotation-aware clients (Claude
// Desktop, VS Code) use them to decide whether a tool call needs an "Allow"
// prompt. The MCP defaults when annotations are absent are
// readOnlyHint=false, destructiveHint=true, openWorldHint=true, so every
// tool here gets all four hints set explicitly — otherwise pure reads like
// memos_search would still trigger an approval prompt.
//
// All 21 tools operate on the local MemOS database only; nothing reaches
// outside it, so openWorldHint is false everywhere.
// ---------------------------------------------------------------------------

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** Annotation profile for a pure read: no side effects, repeatable. */
const ANNOTATE_READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Annotation profile for a non-destructive write. */
const ANNOTATE_WRITE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * Per-tool annotations, keyed by tool name. Shared by the live server
 * registration (the wire path) and the static TOOL_METADATA below so the
 * two can never disagree.
 */
export const TOOL_ANNOTATIONS: Record<string, McpToolAnnotations> = {
  // Creates a new memory row: write, non-destructive, not idempotent.
  memos_store: ANNOTATE_WRITE,
  memos_search: ANNOTATE_READ,
  memos_retrieve: ANNOTATE_READ,
  // Deletes a memory by ID. Re-running with the same ID reaches the same
  // end state, so it is also idempotent.
  memos_forget: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Creates a typed edge between two memories.
  memos_link: ANNOTATE_WRITE,
  // Releases a memory from quarantine (reversible state change).
  memos_quarantine_release: ANNOTATE_WRITE,
  memos_graph: ANNOTATE_READ,
  memos_context: ANNOTATE_READ,
  memos_context_pack: ANNOTATE_READ,
  memos_search_temporal: ANNOTATE_READ,
  // Setting the same validity window twice reaches the same end state.
  memos_set_validity: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Marks a memory historical (add-only; never deletes).
  memos_supersede: ANNOTATE_WRITE,
  memos_set_trust: ANNOTATE_WRITE,
  // Pure read by default, but autoStore=true writes — so not read-only.
  memos_extract_facts: ANNOTATE_WRITE,
  memos_diagnostics: ANNOTATE_READ,
  // Re-embed pass: safe to re-run; purgeStale only drops vectors of other
  // models, not memories.
  memos_reindex: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Merges near-duplicates, archives stale memories, supersedes decayed
  // ones. State-changing and not repeatable (dryRun=true skips the writes).
  memos_consolidate: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  memos_usage: ANNOTATE_READ,
  memos_history: ANNOTATE_READ,
  // Closes a validity interval and reactivates a predecessor: state-changing.
  memos_revert: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  memos_reminders: ANNOTATE_READ,
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(server: McpServer, memos: MemOS): void {
  server.registerTool(
    "memos_store",
    {
      title: "Store Memory",
      annotations: TOOL_ANNOTATIONS.memos_store,
      description: "Store a durable local memory in MemOS.",
      inputSchema: z.object({
        content: z.string().describe("Memory text to store."),
        type: z
          .string()
          .optional()
          .describe("Memory type, such as fact, preference, or context."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional tags for filtering."),
        ttl: z.number().optional().describe("Optional expiration in seconds."),
        namespace: z
          .string()
          .optional()
          .describe(
            "Optional namespace when experimental namespaces are enabled.",
          ),
        pool: z
          .enum(["event", "note", "procedure"])
          .optional()
          .describe(
            "Retrieval pool. Default event (raw statements). Use procedure " +
              "for workflow/how-to knowledge.",
          ),
        scope: scopeInputSchema,
        context: z
          .string()
          .optional()
          .describe(
            "One line of situational context (contextual retrieval) — " +
              "prepended to the embedded text and shown in context packs.",
          ),
        provenance: z
          .enum(["user-verified", "user", "tool-output", "chat", "imported"])
          .optional()
          .describe(
            'Provenance tier override. Pass "tool-output" when storing ' +
              'results returned by tools, "imported" for bulk imports. ' +
              "Defaults from the content's origin when omitted.",
          ),
      }),
      outputSchema: z.object({
        node: memoryNodeSchema,
        links: z.array(memoryEdgeSchema),
      }),
    },
    async ({
      content,
      type,
      tags,
      ttl,
      namespace,
      pool,
      context,
      scope,
      provenance,
    }) => {
      const stored = await memos.store(content, {
        type:
          (type as
            | "fact"
            | "preference"
            | "context"
            | "relationship"
            | "entity"
            | "custom") ?? "fact",
        ...(tags ? { tags } : {}),
        ...(ttl !== undefined ? { ttl } : {}),
        ...(namespace ? { namespace } : {}),
        ...(pool ? { pool } : {}),
        ...(context ? { context } : {}),
        ...(scope ? { scope } : {}),
        ...(provenance ? { provenance } : {}),
      });
      return {
        content: [
          { type: "text" as const, text: `Stored memory ${stored.node.id}.` },
        ],
        structuredContent: stored,
      };
    },
  );

  server.registerTool(
    "memos_search",
    {
      title: "Search Memories",
      annotations: TOOL_ANNOTATIONS.memos_search,
      description:
        "Search local memories by full-text query. Pass compact: true for token-lean output. " +
        "Results carry provenance trust flags: `provenance` (tier), `citation` ([mem:hex] token " +
        "tracing the memory to its source episode), and `untrusted_source: true` for low-trust " +
        "channels (imported/tool-output tiers, quarantined-then-released) — confirm those with " +
        "the user instead of silently injecting them as context.",
      inputSchema: z.object({
        query: z.string().describe("Search query."),
        limit: z.number().optional().describe("Maximum result count."),
        tags: z.array(z.string()).optional().describe("Optional tag filter."),
        namespace: z.string().optional().describe("Optional namespace filter."),
        provenance: z
          .enum(["user-verified", "user", "tool-output", "chat", "imported"])
          .optional()
          .describe("Filter by provenance tier."),
        includeQuarantined: z
          .boolean()
          .optional()
          .describe(
            "Include quarantined memories in results. Default false " +
              "(quarantined memories are excluded from recall).",
          ),
        pool: z
          .union([
            z.enum(["event", "note", "procedure"]),
            z.array(z.enum(["event", "note", "procedure"])),
          ])
          .optional()
          .describe("Filter by retrieval pool (event, note, or procedure)."),
        scope: scopeInputSchema,
        harness: z
          .string()
          .optional()
          .describe(
            "Filter by authoring harness (e.g. claude-code, cline, codex). " +
              'Default "all": cross-harness recall.',
          ),
        compact: z
          .boolean()
          .optional()
          .describe(
            "Return trimmed results (id, content, score, type, tags) " +
              "instead of full node objects — far fewer tokens.",
          ),
      }),
      outputSchema: z.union([
        z.object({ results: z.array(scoredMemorySchema) }),
        z.object({
          results: z.array(
            z.object({
              id: z.string(),
              content: z.string(),
              score: z.number(),
              type: z.string().optional(),
              tags: z.array(z.string()).optional(),
              provenance: z.string().optional(),
              citation: z.string().optional(),
              harness: z.string().optional(),
              untrusted_source: z.boolean().optional(),
            }),
          ),
          compact: z.literal(true),
        }),
      ]),
    },
    async ({
      query,
      limit,
      tags,
      namespace,
      provenance,
      includeQuarantined,
      pool,
      scope,
      harness,
      compact,
    }) => {
      const found = await memos.search({
        query,
        limit: limit ?? 10,
        ...(tags ? { tags } : {}),
        ...(namespace ? { namespace } : {}),
        ...(provenance ? { provenance } : {}),
        ...(includeQuarantined !== undefined ? { includeQuarantined } : {}),
        ...(pool !== undefined ? { pool } : {}),
        ...(scope ? { scope } : {}),
        ...(harness ? { harness } : {}),
      });
      // Read-time trust policy: flag low-trust channels so the host
      // agent confirms instead of silently injecting them as context.
      const flagged = decorateTrustFlags(found);
      if (compact) {
        const trimmed = flagged.map((r) => ({
          id: r.node.id,
          content: r.node.content,
          score: Number(r.score.toFixed(4)),
          ...(r.node.type ? { type: r.node.type } : {}),
          ...(r.node.tags.length > 0 ? { tags: r.node.tags } : {}),
          provenance: r.provenance ?? r.node.provenance,
          citation: r.citation ?? citationToken(r.node.id),
          harness: r.node.harness ?? "unknown",
          untrusted_source: r.untrustedSource ?? false,
        }));
        return {
          content: [
            {
              type: "text" as const,
              text:
                trimmed
                  .map(
                    (r) =>
                      `[${r.id.slice(0, 8)}] (${r.score}) ${r.type ?? "fact"}${r.untrusted_source ? ` [untrusted:${r.provenance}]` : ""}: ${r.content}`,
                  )
                  .join("\n") || "No memories found.",
            },
          ],
          structuredContent: { results: trimmed, compact: true },
        };
      }
      return {
        content: [
          { type: "text" as const, text: `Found ${flagged.length} memories.` },
        ],
        structuredContent: { results: flagged.map(toMcpResult) },
      };
    },
  );

  server.registerTool(
    "memos_retrieve",
    {
      title: "Retrieve Memory",
      annotations: TOOL_ANNOTATIONS.memos_retrieve,
      description: "Retrieve one memory by ID.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
      }),
      outputSchema: z.object({
        node: memoryNodeSchema.nullable(),
      }),
    },
    async ({ id }) => {
      const node = await memos.retrieve(id);
      return {
        content: [
          {
            type: "text" as const,
            text: node ? node.content : `Memory not found: ${id}`,
          },
        ],
        structuredContent: { node },
      };
    },
  );

  server.registerTool(
    "memos_forget",
    {
      title: "Forget Memory",
      annotations: TOOL_ANNOTATIONS.memos_forget,
      description: "Delete one memory by ID.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
      }),
      outputSchema: z.object({
        id: z.string(),
        deleted: z.boolean(),
      }),
    },
    async ({ id }) => {
      const deleted = await memos.forget(id);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted ? `Forgot memory ${id}.` : `Memory not found: ${id}.`,
          },
        ],
        structuredContent: { id, deleted },
      };
    },
  );

  server.registerTool(
    "memos_link",
    {
      title: "Link Two Memories",
      annotations: TOOL_ANNOTATIONS.memos_link,
      description:
        "Create a typed edge between two memories (e.g. relates_to, " +
        "supports, contradicts). Used by the MCP Apps explorer's " +
        "UI→tool consent bridge; callable directly too.",
      inputSchema: z.object({
        sourceId: z.string().describe("Source memory ID."),
        targetId: z.string().describe("Target memory ID."),
        relation: z
          .enum([
            "relates_to",
            "contradicts",
            "supports",
            "derived_from",
            "part_of",
            "temporal_precedes",
            "custom",
          ])
          .optional()
          .describe("Relation type. Default relates_to."),
        weight: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Edge weight [0,1]. Default 0.5."),
      }),
      outputSchema: z.object({ edge: memoryEdgeSchema }),
    },
    async ({ sourceId, targetId, relation, weight }) => {
      const edge = await memos.link(
        sourceId,
        targetId,
        relation ?? "relates_to",
        weight ?? 0.5,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Linked ${sourceId} → ${targetId} (${edge.relation}).`,
          },
        ],
        structuredContent: { edge },
      };
    },
  );

  server.registerTool(
    "memos_quarantine_release",
    {
      title: "Release Memory From Quarantine",
      annotations: TOOL_ANNOTATIONS.memos_quarantine_release,
      description:
        "Release a quarantined memory back into recall. Idempotent; the " +
        "quarantine audit trail (quarantinedAt/reason) is preserved. Used " +
        "by the MCP Apps explorer's UI→tool consent bridge.",
      inputSchema: z.object({
        id: z.string().describe("Quarantined memory ID."),
      }),
      outputSchema: z.object({ node: memoryNodeSchema }),
    },
    async ({ id }) => {
      const node = await memos.releaseFromQuarantine(id);
      return {
        content: [
          {
            type: "text" as const,
            text: `Released ${id} from quarantine.`,
          },
        ],
        structuredContent: { node },
      };
    },
  );

  server.registerTool(
    "memos_graph",
    {
      title: "Memory Graph",
      annotations: TOOL_ANNOTATIONS.memos_graph,
      description: "Return the current memory graph.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        nodes: z.array(memoryNodeSchema),
        edges: z.array(memoryEdgeSchema),
      }),
    },
    async () => {
      const graph = await memos.getGraph();
      return {
        content: [
          {
            type: "text" as const,
            text: `Memory graph has ${graph.nodes.length} nodes and ${graph.edges.length} edges.`,
          },
        ],
        structuredContent: graph,
      };
    },
  );

  server.registerTool(
    "memos_context",
    {
      title: "Memory Context",
      annotations: TOOL_ANNOTATIONS.memos_context,
      description: "Build graph-neighbour context around a memory.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
        depth: z.number().optional().describe("Graph walk depth."),
        maxChars: z
          .number()
          .optional()
          .describe("Maximum returned context length."),
      }),
      outputSchema: z.object({
        id: z.string(),
        context: z.string(),
      }),
    },
    async ({ id, depth, maxChars }) => {
      const context = await memos.injectContext(
        id,
        depth ?? 1,
        maxChars ?? 2000,
      );
      return {
        content: [{ type: "text" as const, text: context }],
        structuredContent: { id, context },
      };
    },
  );

  server.registerTool(
    "memos_context_pack",
    {
      title: "Build Context Pack",
      annotations: TOOL_ANNOTATIONS.memos_context_pack,
      description:
        "Build a token-budgeted, relevance-ranked slice of memories for " +
        "injection into a prompt. This is the tool to use when you want " +
        "everything the agent should remember about a topic in one call.",
      inputSchema: z.object({
        query: z.string().describe("What to remember about."),
        tokenBudget: z
          .number()
          .optional()
          .describe("Token budget for the pack (default 2000)."),
        namespace: z.string().optional(),
        scope: scopeInputSchema,
        format: z
          .enum(["json", "toon", "toon-compact"])
          .optional()
          .describe(
            "Serialization format. Default toon-compact — ~70% fewer " +
              "tokens than JSON with identical information; pass " +
              '"json" for human-readable output.',
          ),
        includeSummary: z.boolean().optional(),
        semanticDedup: z
          .boolean()
          .optional()
          .describe("Drop near-duplicate pack items via embedding cosine."),
        multiStream: z
          .boolean()
          .optional()
          .describe(
            "Query each granularity pool (event/note/procedure) separately " +
              "and fuse. Default true; automatically skipped on event-only " +
              "stores.",
          ),
      }),
      outputSchema: z.object({
        pack: z.unknown(),
        format: z.string(),
      }),
    },
    async ({
      query,
      tokenBudget,
      namespace,
      scope,
      format,
      includeSummary,
      semanticDedup,
      multiStream,
    }) => {
      // Token-lean by default: the pack feeds an LLM, not a human.
      const chosenFormat = format ?? "toon-compact";
      const pack = await memos.contextPack({
        query,
        tokenBudget: tokenBudget ?? 2000,
        ...(namespace ? { namespace } : {}),
        ...(scope ? { scope } : {}),
        format: chosenFormat,
        ...(includeSummary !== undefined ? { includeSummary } : {}),
        ...(semanticDedup !== undefined ? { semanticDedup } : {}),
        ...(multiStream !== undefined ? { multiStream } : {}),
      });
      const text =
        typeof pack === "string" ? pack : JSON.stringify(pack, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { pack, format: chosenFormat },
      };
    },
  );

  server.registerTool(
    "memos_search_temporal",
    {
      title: "Search Memories Valid At a Time",
      annotations: TOOL_ANNOTATIONS.memos_search_temporal,
      description:
        "Search memories that were valid at a specific point in time " +
        "(unix ms). Superseded/historical memories stay queryable here.",
      inputSchema: z.object({
        query: z.string(),
        atTime: z
          .number()
          .describe("Unix epoch MILLISECONDS to evaluate validity at."),
        limit: z.number().optional(),
        namespace: z.string().optional(),
      }),
      outputSchema: z.object({ results: z.array(scoredMemorySchema) }),
    },
    async ({ query, atTime, limit, namespace }) => {
      const results = await memos.searchTemporal(query, atTime, {
        ...(limit ? { limit } : {}),
        ...(namespace ? { namespace } : {}),
      });
      const flagged = decorateTrustFlags(results);
      return {
        content: [
          { type: "text" as const, text: `Found ${flagged.length} memories.` },
        ],
        structuredContent: { results: flagged.map(toMcpResult) },
      };
    },
  );

  server.registerTool(
    "memos_set_validity",
    {
      title: "Set Memory Validity Window",
      annotations: TOOL_ANNOTATIONS.memos_set_validity,
      description:
        "Mark a memory's temporal validity window (unix ms). A validTo in " +
        "the past makes the memory historical: excluded from default " +
        "search, still queryable via memos_search_temporal.",
      inputSchema: z.object({
        id: z.string(),
        validFrom: z.number().nullable().optional(),
        validTo: z.number().nullable().optional(),
      }),
      outputSchema: z.object({ node: memoryNodeSchema.nullable() }),
    },
    async ({ id, validFrom, validTo }) => {
      const node = await memos.setValidity(
        id,
        validFrom ?? null,
        validTo ?? null,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: node
              ? `Updated validity for ${id}.`
              : `Memory ${id} not found.`,
          },
        ],
        structuredContent: { node },
      };
    },
  );

  server.registerTool(
    "memos_supersede",
    {
      title: "Supersede Memory",
      annotations: TOOL_ANNOTATIONS.memos_supersede,
      description:
        "Mark a memory as superseded (historical) and optionally link its " +
        "replacement with a temporal_precedes edge.",
      inputSchema: z.object({
        id: z.string().describe("The outdated memory."),
        replacementId: z
          .string()
          .optional()
          .describe("The memory that replaces it."),
      }),
      outputSchema: z.object({ node: memoryNodeSchema.nullable() }),
    },
    async ({ id, replacementId }) => {
      const node = await memos.supersede(id, replacementId);
      return {
        content: [
          {
            type: "text" as const,
            text: node ? `Superseded ${id}.` : `Memory ${id} not found.`,
          },
        ],
        structuredContent: { node },
      };
    },
  );

  server.registerTool(
    "memos_set_trust",
    {
      title: "Set Memory Trust",
      annotations: TOOL_ANNOTATIONS.memos_set_trust,
      description:
        "Set the trust score [0,1] of a memory. High-trust memories rank " +
        "higher in hybrid search.",
      inputSchema: z.object({
        id: z.string(),
        score: z.number().min(0).max(1),
      }),
      outputSchema: z.object({ node: memoryNodeSchema.nullable() }),
    },
    async ({ id, score }) => {
      const node = await memos.setTrust(id, score);
      return {
        content: [
          {
            type: "text" as const,
            text: node
              ? `Trust of ${id} set to ${score}.`
              : `Memory ${id} not found.`,
          },
        ],
        structuredContent: { node },
      };
    },
  );

  server.registerTool(
    "memos_extract_facts",
    {
      title: "Extract Facts From Conversation",
      annotations: TOOL_ANNOTATIONS.memos_extract_facts,
      description:
        "Rule-based local extraction of preferences, entities and facts " +
        "from conversation messages, optionally storing them as memories.",
      inputSchema: z.object({
        messages: z
          .array(
            z.object({
              role: z.string(),
              content: z.string(),
            }),
          )
          .describe("Conversation turns to mine."),
        autoStore: z
          .boolean()
          .optional()
          .describe("Store extracted facts (default false)."),
        minConfidence: z.number().optional(),
        namespace: z.string().optional(),
      }),
      outputSchema: z.object({
        facts: z.array(z.unknown()),
        storedIds: z.array(z.string()),
      }),
    },
    async ({ messages, autoStore, minConfidence, namespace }) => {
      const result = await memos.extractFacts(
        messages.map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        })),
        {
          ...(autoStore !== undefined ? { autoStore } : {}),
          ...(minConfidence !== undefined ? { minConfidence } : {}),
          ...(namespace ? { namespace } : {}),
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Extracted ${result.facts.length} facts (${result.storedIds.length} stored).`,
          },
        ],
        structuredContent: { facts: result.facts, storedIds: result.storedIds },
      };
    },
  );

  server.registerTool(
    "memos_diagnostics",
    {
      title: "Memory Diagnostics",
      annotations: TOOL_ANNOTATIONS.memos_diagnostics,
      description:
        "Health report: counts, embedding coverage, temporal stats, " +
        "storage capabilities and database size.",
      inputSchema: z.object({}),
      outputSchema: z.object({ diagnostics: z.unknown() }),
    },
    async () => {
      const diagnostics = await memos.diagnostics();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(diagnostics, null, 2) },
        ],
        structuredContent: { diagnostics },
      };
    },
  );

  server.registerTool(
    "memos_reindex",
    {
      title: "Re-embed All Memories",
      annotations: TOOL_ANNOTATIONS.memos_reindex,
      description:
        "Re-embed every memory with the currently configured embedding " +
        "model. Required after switching models. Can be slow on large " +
        "stores; purgeStale also deletes vectors from other models.",
      inputSchema: z.object({
        purgeStale: z.boolean().optional(),
      }),
      outputSchema: z.object({
        reembedded: z.number(),
        purged: z.number(),
        failed: z.number(),
        model: z.string(),
      }),
    },
    async ({ purgeStale }) => {
      const summary = await memos.reindexEmbeddings({ purgeStale });
      return {
        content: [
          {
            type: "text" as const,
            text: `Re-embedded ${summary.reembedded} memories (purged ${summary.purged}, failed ${summary.failed}).`,
          },
        ],
        structuredContent: summary,
      };
    },
  );

  server.registerTool(
    "memos_consolidate",
    {
      title: "Consolidate Memories",
      annotations: TOOL_ANNOTATIONS.memos_consolidate,
      description:
        "Offline maintenance pass ('dreaming'): merge near-duplicates, " +
        "archive stale low-importance memories, supersede decayed ones " +
        "(marked historical — never deleted), and distill cluster summary " +
        "notes into the note pool. Run periodically or while idle.",
      inputSchema: z.object({
        namespace: z.string().optional(),
        dryRun: z
          .boolean()
          .optional()
          .describe("Report what would happen without mutating anything."),
        summarize: z
          .boolean()
          .optional()
          .describe("Generate cluster summary notes. Default true."),
        decay: z
          .boolean()
          .optional()
          .describe("Run decay-based forgetting. Default true."),
        decayHalfLifeDays: z
          .number()
          .optional()
          .describe("Recency half-life in days for the retention score."),
        minRetentionScore: z
          .number()
          .optional()
          .describe("Retention scores below this supersede the memory."),
        olderThanDays: z
          .number()
          .optional()
          .describe("Only memories untouched this long are decay-eligible."),
      }),
      outputSchema: z.object({ report: z.unknown() }),
    },
    async (args) => {
      const report = await memos.consolidate({
        ...(args.namespace ? { namespace: args.namespace } : {}),
        ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
        ...(args.summarize !== undefined ? { summarize: args.summarize } : {}),
        ...(args.decay !== undefined ? { decay: args.decay } : {}),
        ...(args.decayHalfLifeDays !== undefined
          ? { decayHalfLifeDays: args.decayHalfLifeDays }
          : {}),
        ...(args.minRetentionScore !== undefined
          ? { minRetentionScore: args.minRetentionScore }
          : {}),
        ...(args.olderThanDays !== undefined
          ? { olderThanDays: args.olderThanDays }
          : {}),
      });
      const text = `Consolidated: ${report.merges.length} merged, ${report.moves.length} archived, ${report.decayed.length} decayed, ${report.clusters.length} note(s)${report.dryRun ? " (dry run — nothing changed)" : ""}.`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { report },
      };
    },
  );

  server.registerTool(
    "memos_usage",
    {
      title: "Token Savings Telemetry",
      annotations: TOOL_ANNOTATIONS.memos_usage,
      description:
        "Lifetime context-pack token telemetry for this server process: " +
        "packs built, tokens actually injected, the naive raw-JSON " +
        "baseline for the same candidates, and the savings percentage.",
      inputSchema: z.object({}),
      outputSchema: z.object({ usage: z.unknown() }),
    },
    async () => {
      const usage = memos.usageStats();
      return {
        content: [
          {
            type: "text" as const,
            text: `${usage.packsBuilt} pack(s) · ${usage.packTokens} tok injected vs ${usage.naiveBaselineTokens} naive (${usage.savedPct}% saved).`,
          },
        ],
        structuredContent: { usage },
      };
    },
  );

  server.registerTool(
    "memos_history",
    {
      title: "Memory Version Timeline",
      annotations: TOOL_ANNOTATIONS.memos_history,
      description:
        "Audit timeline for one memory: the versions it superseded, the " +
        "versions that superseded it, and consolidated notes derived from " +
        "it. Use when recalling something that may be outdated and you " +
        "need the full history.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID."),
        threshold: z
          .number()
          .optional()
          .describe("Similarity threshold for related versions (default 0.8)."),
        limit: z
          .number()
          .optional()
          .describe("Cap on related versions per direction (default 10)."),
      }),
      outputSchema: z.object({ history: z.unknown() }),
    },
    async ({ id, threshold, limit }) => {
      const history = await memos.history(id, {
        ...(threshold !== undefined ? { threshold } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const text = `${history.supersedes.length} older / ${history.supersededBy.length} newer version(s) · ${history.derivedNotes.length} derived note(s).`;
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { history },
      };
    },
  );

  server.registerTool(
    "memos_revert",
    {
      title: "Revert Memory to Previous Version",
      annotations: TOOL_ANNOTATIONS.memos_revert,
      description:
        "Command-driven belief revision: revert a memory to the version " +
        'it superseded ("revert that", "undo what I just told you", ' +
        '"that last thing was wrong"). Closes the target\'s validity ' +
        "interval and reactivates the predecessor — the reverted-away " +
        "version stays in history (add-only, never deleted), and the " +
        "revert is recorded as an audit event. " +
        "CONFIRM SCOPE FIRST: call with dryRun=true (the default) and show " +
        "the would-be target to the user; only call with dryRun=false " +
        "after they confirm.",
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe(
            "Natural-language revert request, e.g. 'revert that' or " +
              "'revert what I said about the dentist'.",
          ),
        id: z.string().optional().describe("Memory ID to revert directly."),
        last: z
          .boolean()
          .optional()
          .describe("Revert the most recent memory in the namespace."),
        about: z
          .string()
          .optional()
          .describe("Entity/topic to resolve the target memory by."),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Resolve and report the target without writing anything. " +
              "Default true — confirm scope before executing.",
          ),
        reason: z
          .string()
          .optional()
          .describe("Why the revert was issued (recorded on the audit event)."),
        actor: z
          .string()
          .optional()
          .describe("Who issued the revert (recorded on the audit event)."),
        namespace: z.string().optional().describe("Namespace (default)."),
      }),
      outputSchema: z.object({ revert: z.unknown() }),
    },
    async ({ text, id, last, about, dryRun, reason, actor, namespace }) => {
      const scope = id
        ? { kind: "id" as const, id }
        : last
          ? { kind: "last" as const }
          : about
            ? { kind: "entity" as const, entity: about }
            : text
              ? { kind: "text" as const, text }
              : null;
      if (!scope) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No revert target given: pass text, id, last, or about.",
            },
          ],
          structuredContent: { revert: { error: "missing scope" } },
        };
      }
      try {
        const result = await memos.revert(scope, {
          dryRun: dryRun ?? true,
          ...(reason !== undefined ? { reason } : {}),
          ...(actor !== undefined ? { actor } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
        });
        const summarize = (n: {
          id: string;
          content: string;
          createdAt: number;
        }) => ({
          id: n.id,
          summary: n.content.slice(0, 120),
          createdAt: n.createdAt,
        });
        const textOut = result.dryRun
          ? `Dry run — would revert ${result.target.id.slice(0, 8)} ("${result.target.content.slice(0, 60)}") and restore predecessor ${result.predecessor.id.slice(0, 8)}. Confirm with dryRun=false to execute.`
          : `Reverted ${result.target.id.slice(0, 8)} — predecessor ${result.predecessor.id.slice(0, 8)} is now the believed version. Audit event: ${result.auditId}.`;
        return {
          content: [{ type: "text" as const, text: textOut }],
          structuredContent: {
            revert: {
              dryRun: result.dryRun,
              target: summarize(result.target),
              predecessor: summarize(result.predecessor),
              alternatives: result.alternatives.map((a) => summarize(a.node)),
              auditId: result.auditId,
              at: result.at,
            },
          },
        };
      } catch (err) {
        const message = (err as Error).message;
        return {
          content: [
            { type: "text" as const, text: `Revert failed: ${message}` },
          ],
          structuredContent: { revert: { error: message } },
        };
      }
    },
  );

  server.registerTool(
    "memos_reminders",
    {
      title: "List Event Reminders",
      annotations: TOOL_ANNOTATIONS.memos_reminders,
      description:
        "List scheduled event reminders from memory (deterministic " +
        "temporal event memory — no LLM involved). Events are extracted " +
        'at store() time from utterances like "I have a meeting tomorrow", ' +
        'and natural-language updates ("that meeting got moved 3 days ' +
        'later", "the meeting is cancelled") reschedule or cancel them ' +
        "across harnesses sharing the same DB file. " +
        "HARNESS POLLING PATTERN: call this on the harness's own schedule " +
        "(e.g. each turn); MemOS surfaces due reminders but does NOT " +
        "push-notify — delivery is the harness's job.",
      inputSchema: z.object({
        due: z
          .boolean()
          .optional()
          .describe(
            "When true, only reminders due as of now (reminder_at <= now). " +
              "Default false: all scheduled reminders, earliest first.",
          ),
        namespace: z.string().optional().describe("Namespace (default)."),
      }),
      outputSchema: z.object({ reminders: z.unknown() }),
    },
    async ({ due, namespace }) => {
      const reminders = await listReminders(memos, {
        now: new Date(),
        dueOnly: due ?? false,
        ...(namespace !== undefined ? { namespace } : {}),
      });
      const lines = reminders.map(
        (r) =>
          `${new Date(r.reminderAt).toLocaleString()} — ${r.label}` +
          (r.due ? " (due)" : ""),
      );
      const text =
        reminders.length === 0
          ? "No scheduled reminders."
          : `${reminders.length} scheduled reminder(s):\n` +
            lines.map((l) => `• ${l}`).join("\n");
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: { reminders },
      };
    },
  );
}

// ---------------------------------------------------------------------------
// Resources & prompts
// ---------------------------------------------------------------------------

/**
 * Resources give MCP clients pull-based access to memory state (some
 * harnesses surface resources natively rather than calling tools); prompts
 * are reusable templates the client can launch with one argument.
 */
function registerResourcesAndPrompts(server: McpServer, memos: MemOS): void {
  server.registerResource(
    "context",
    "memos://context",
    {
      title: "Memory Brief",
      description:
        "Zero-query snapshot of what MemOS remembers: a summary plus the " +
        "most recent memories. Pull this at session start for instant context.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      const summary = await memos.summarize();
      const graph = await memos.getGraph();
      const recent = [...graph.nodes]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 20);
      const sections = [
        "# MemOS memory brief",
        "",
        summary,
        "",
        `## Recent memories (${recent.length})`,
        "",
        ...recent.map(
          (node) =>
            `- [${node.type}] ${node.content} _(trust ${node.trustScore.toFixed(2)})_`,
        ),
      ];
      return {
        contents: [
          {
            uri: uri.href,
            text: sections.join("\n"),
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );

  server.registerResource(
    "graph",
    "memos://graph",
    {
      title: "Memory Graph (Mermaid)",
      description:
        "The full memory graph — nodes are memories, edges are relations — " +
        "rendered as a Mermaid flowchart.",
      mimeType: "text/plain",
    },
    async (uri) => {
      const graph = await memos.getGraph();
      return {
        contents: [
          {
            uri: uri.href,
            text: graphToMermaid(graph),
            mimeType: "text/plain",
          },
        ],
      };
    },
  );

  server.registerResource(
    "explorer",
    new ResourceTemplate(new ExplorerUriTemplate(), { list: undefined }),
    {
      title: "MemOS Memory Explorer (MCP App)",
      description:
        "Interactive memory-graph explorer (MCP App): nodes colored by " +
        "provenance tier, edges labeled by relation, plus a bitemporal " +
        "as-of scrubber for time-travel. Query variables: asOf (unix ms, " +
        "render the graph at a past timestamp), mode (app forces the HTML " +
        "app, text forces the markdown fallback), nodeLimit, edgeLimit. " +
        "Without ?mode=app — or a host MCP Apps signal in _meta — this " +
        "serves a text/markdown fallback (mermaid + summary) instead of " +
        "HTML. Mutating UI actions arrive as intents translated to normal " +
        "tool calls (memos_forget, memos_link, memos_quarantine_release) " +
        "under the host's consent UI; the app itself cannot write.",
      mimeType: "text/html",
    },
    async (uri, variables, ctx) => {
      const strVar = (v: unknown): string | null =>
        typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : null;
      const asOfRaw = strVar(variables.asOf);
      const asOf = asOfRaw !== null && asOfRaw !== "" ? Number(asOfRaw) : NaN;
      const hasAsOf = Number.isFinite(asOf);
      const nodeLimitRaw = strVar(variables.nodeLimit);
      const edgeLimitRaw = strVar(variables.edgeLimit);
      const nodeLimit =
        nodeLimitRaw !== null && nodeLimitRaw !== ""
          ? Number(nodeLimitRaw)
          : undefined;
      const edgeLimit =
        edgeLimitRaw !== null && edgeLimitRaw !== ""
          ? Number(edgeLimitRaw)
          : undefined;

      const graph = hasAsOf
        ? await memos.getGraphAtTime(asOf)
        : await memos.getGraph();
      const snapshot = buildExplorerSnapshot(graph, {
        ...(nodeLimit !== undefined ? { nodeCap: nodeLimit } : {}),
        ...(edgeLimit !== undefined ? { edgeCap: edgeLimit } : {}),
        ...(hasAsOf ? { asOf } : {}),
      });
      const mode = resolveExplorerMode({
        modeParam: strVar(variables.mode),
        meta: ctx.mcpReq._meta,
      });
      if (mode === "app") {
        return {
          contents: [
            {
              uri: uri.href,
              text: buildExplorerHtml(snapshot, {
                ...(hasAsOf ? { asOf } : {}),
              }),
              mimeType: "text/html",
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            text: buildExplorerFallbackMarkdown(snapshot, {
              ...(hasAsOf ? { asOf } : {}),
            }),
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "recall",
    {
      title: "Recall Memories",
      description:
        "Search MemOS for memories about a topic and summarize findings " +
        "with trust and recency caveats.",
      argsSchema: {
        topic: z
          .string()
          .describe("What to recall, e.g. 'deployment preferences'."),
      },
    },
    ({ topic }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Search MemOS for memories relevant to: ${topic}\n\n` +
              "1. Call memos_search with the topic, then refine with a " +
              "second query if the first pass looks thin.\n" +
              "2. Summarize what you found as a short bulleted list.\n" +
              "3. Flag each bullet's trust score and age — say explicitly " +
              "when a memory is old or low-trust rather than presenting it " +
              "as current fact.\n" +
              "4. If nothing relevant is stored, say so plainly.",
          },
        },
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured McpServer instance for MemOS.
 * Exported for testing and advanced use cases.
 */
export function createMcpServer(memos: MemOS): McpServer {
  const server = new McpServer(
    { name: "memos", version: getSdkVersion() },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        "MemOS local-first persistent memory. PROACTIVELY store durable " +
        "facts (user preferences, project decisions, environment setup, " +
        "corrections) with memos_store, and recall them with " +
        "memos_context_pack before answering questions that may depend on " +
        "prior sessions. memos_search finds raw results; " +
        "memos_context_pack returns a token-budgeted slice ready for " +
        "prompt injection. Superseded facts stay queryable via " +
        "memos_search_temporal. All data stays on this machine.",
      cacheHints: {
        "tools/list": { ttlMs: 300_000, cacheScope: "private" },
        "server/discover": { ttlMs: 600_000, cacheScope: "private" },
      },
    },
  );
  registerTools(server, memos);
  registerResourcesAndPrompts(server, memos);
  return server;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the MemOS MCP server over stdio.
 *
 * Speaks MCP protocol revision 2026-07-28 (modern stateless core with
 * `server/discover`) and falls back to the legacy 2025-era `initialize`
 * handshake for older clients. Blocks until the connection closes.
 */
export async function runMcpServer(config: MemOSConfig = {}): Promise<void> {
  const memos = new MemOS({
    // Embeddings default to on anyway; stating it here keeps the MCP
    // server's semantic search working even if the SDK default changes.
    embeddings: { enabled: true },
    ...config,
    experimental: {
      graphViz: true,
      namespaces: true,
      contextInjection: true,
      ...config.experimental,
    },
  });
  await memos.init();

  const handle = serveStdio(() => createMcpServer(memos));

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await handle.close();
    await memos.close();
  };

  process.once("SIGINT", () => {
    void cleanup().then(() => process.exit(0));
  });

  // Block until stdin closes (client disconnects). The StdioServerTransport
  // keeps the event loop alive via its stdin "data" listener; when the
  // client disconnects, stdin emits "end" and we clean up.
  await new Promise<void>((resolve) => {
    process.stdin.once("end", () => resolve());
  });

  await cleanup();
}

// ---------------------------------------------------------------------------
// Static tool metadata (for programmatic consumers / tests)
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  name: string;
  description: string;
  annotations: McpToolAnnotations;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

const TOOL_METADATA: McpToolInfo[] = [
  {
    name: "memos_store",
    annotations: TOOL_ANNOTATIONS.memos_store,
    description: "Store a durable local memory in MemOS.",
    inputSchema: z.toJSONSchema(
      z.object({
        content: z.string(),
        type: z.string().optional(),
        tags: z.array(z.string()).optional(),
        ttl: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema, links: z.array(memoryEdgeSchema) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_search",
    annotations: TOOL_ANNOTATIONS.memos_search,
    description:
      "Search local memories by full-text query. Pass compact: true for token-lean output.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        limit: z.number().optional(),
        tags: z.array(z.string()).optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ results: z.array(scoredMemorySchema) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_retrieve",
    annotations: TOOL_ANNOTATIONS.memos_retrieve,
    description: "Retrieve one memory by ID.",
    inputSchema: z.toJSONSchema(z.object({ id: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema.nullable() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_forget",
    annotations: TOOL_ANNOTATIONS.memos_forget,
    description: "Delete one memory by ID.",
    inputSchema: z.toJSONSchema(z.object({ id: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(
      z.object({ id: z.string(), deleted: z.boolean() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_link",
    annotations: TOOL_ANNOTATIONS.memos_link,
    description: "Create a typed edge between two memories.",
    inputSchema: z.toJSONSchema(
      z.object({
        sourceId: z.string(),
        targetId: z.string(),
        relation: z
          .enum([
            "relates_to",
            "contradicts",
            "supports",
            "derived_from",
            "part_of",
            "temporal_precedes",
            "custom",
          ])
          .optional(),
        weight: z.number().min(0).max(1).optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ edge: memoryEdgeSchema }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_quarantine_release",
    annotations: TOOL_ANNOTATIONS.memos_quarantine_release,
    description: "Release a quarantined memory back into recall.",
    inputSchema: z.toJSONSchema(z.object({ id: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_graph",
    annotations: TOOL_ANNOTATIONS.memos_graph,
    description: "Return the current memory graph.",
    inputSchema: z.toJSONSchema(z.object({})) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        nodes: z.array(memoryNodeSchema),
        edges: z.array(memoryEdgeSchema),
      }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_context",
    annotations: TOOL_ANNOTATIONS.memos_context,
    description: "Build graph-neighbour context around a memory.",
    inputSchema: z.toJSONSchema(
      z.object({
        id: z.string(),
        depth: z.number().optional(),
        maxChars: z.number().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ id: z.string(), context: z.string() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_context_pack",
    annotations: TOOL_ANNOTATIONS.memos_context_pack,
    description:
      "Build a token-budgeted, relevance-ranked slice of memories for " +
      "injection into a prompt. This is the tool to use when you want " +
      "everything the agent should remember about a topic in one call.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        tokenBudget: z.number().optional(),
        namespace: z.string().optional(),
        format: z.enum(["json", "toon", "toon-compact"]).optional(),
        includeSummary: z.boolean().optional(),
        semanticDedup: z.boolean().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ pack: z.unknown(), format: z.string() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_search_temporal",
    annotations: TOOL_ANNOTATIONS.memos_search_temporal,
    description:
      "Search memories that were valid at a specific point in time " +
      "(unix ms). Superseded/historical memories stay queryable here.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        atTime: z.number(),
        limit: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ results: z.array(scoredMemorySchema) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_set_validity",
    annotations: TOOL_ANNOTATIONS.memos_set_validity,
    description:
      "Mark a memory's temporal validity window (unix ms). A validTo in " +
      "the past makes the memory historical: excluded from default " +
      "search, still queryable via memos_search_temporal.",
    inputSchema: z.toJSONSchema(
      z.object({
        id: z.string(),
        validFrom: z.number().nullable().optional(),
        validTo: z.number().nullable().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema.nullable() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_supersede",
    annotations: TOOL_ANNOTATIONS.memos_supersede,
    description:
      "Mark a memory as superseded (historical) and optionally link its " +
      "replacement with a temporal_precedes edge.",
    inputSchema: z.toJSONSchema(
      z.object({
        id: z.string(),
        replacementId: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema.nullable() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_set_trust",
    annotations: TOOL_ANNOTATIONS.memos_set_trust,
    description:
      "Set the trust score [0,1] of a memory. High-trust memories rank " +
      "higher in hybrid search.",
    inputSchema: z.toJSONSchema(
      z.object({ id: z.string(), score: z.number().min(0).max(1) }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema.nullable() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_extract_facts",
    annotations: TOOL_ANNOTATIONS.memos_extract_facts,
    description:
      "Rule-based local extraction of preferences, entities and facts " +
      "from conversation messages, optionally storing them as memories.",
    inputSchema: z.toJSONSchema(
      z.object({
        messages: z.array(z.object({ role: z.string(), content: z.string() })),
        autoStore: z.boolean().optional(),
        minConfidence: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ facts: z.array(z.unknown()), storedIds: z.array(z.string()) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_diagnostics",
    annotations: TOOL_ANNOTATIONS.memos_diagnostics,
    description:
      "Health report: counts, embedding coverage, temporal stats, " +
      "storage capabilities and database size.",
    inputSchema: z.toJSONSchema(z.object({})) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ diagnostics: z.unknown() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_reindex",
    annotations: TOOL_ANNOTATIONS.memos_reindex,
    description:
      "Re-embed every memory with the currently configured embedding " +
      "model. Required after switching models. Can be slow on large " +
      "stores; purgeStale also deletes vectors from other models.",
    inputSchema: z.toJSONSchema(
      z.object({ purgeStale: z.boolean().optional() }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        reembedded: z.number(),
        purged: z.number(),
        failed: z.number(),
        model: z.string(),
      }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_consolidate",
    annotations: TOOL_ANNOTATIONS.memos_consolidate,
    description:
      "Offline maintenance pass ('dreaming'): merge near-duplicates, " +
      "archive stale low-importance memories, supersede decayed ones " +
      "(marked historical — never deleted), and distill cluster summary " +
      "notes into the note pool. Run periodically or while idle.",
    inputSchema: z.toJSONSchema(
      z.object({
        namespace: z.string().optional(),
        dryRun: z.boolean().optional(),
        summarize: z.boolean().optional(),
        decay: z.boolean().optional(),
        decayHalfLifeDays: z.number().optional(),
        minRetentionScore: z.number().optional(),
        olderThanDays: z.number().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ report: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_usage",
    annotations: TOOL_ANNOTATIONS.memos_usage,
    description:
      "Lifetime context-pack token telemetry for this server process: " +
      "packs built, tokens injected, naive raw-JSON baseline, savings %.",
    inputSchema: z.toJSONSchema(z.object({})) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ usage: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_history",
    annotations: TOOL_ANNOTATIONS.memos_history,
    description:
      "Audit timeline for one memory: supersedes, superseded by, derived notes.",
    inputSchema: z.toJSONSchema(
      z.object({
        id: z.string(),
        threshold: z.number().optional(),
        limit: z.number().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ history: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_revert",
    annotations: TOOL_ANNOTATIONS.memos_revert,
    description:
      "Revert a memory to the version it superseded (command-driven belief " +
      "revision). Closes the target's validity interval and reactivates the " +
      "predecessor; the reverted-away version stays in history (add-only) " +
      "and the revert is recorded as an audit event. Confirm scope first: " +
      "call with dryRun=true (default) and show the would-be target, then " +
      "call again with dryRun=false to execute.",
    inputSchema: z.toJSONSchema(
      z.object({
        text: z.string().optional(),
        id: z.string().optional(),
        last: z.boolean().optional(),
        about: z.string().optional(),
        dryRun: z.boolean().optional(),
        reason: z.string().optional(),
        actor: z.string().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ revert: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_reminders",
    annotations: TOOL_ANNOTATIONS.memos_reminders,
    description:
      "List scheduled event reminders (deterministic temporal event memory). " +
      "Pass due=true for reminders due as of now; otherwise all scheduled " +
      "reminders, earliest first. Poll on the harness's own schedule — " +
      "MemOS surfaces due reminders but does not push-notify.",
    inputSchema: z.toJSONSchema(
      z.object({
        due: z.boolean().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ reminders: z.unknown() }),
    ) as Record<string, unknown>,
  },
];

/**
 * Return static metadata about the MCP tools exposed by MemOS.
 * Useful for programmatic consumers and tests that need tool definitions
 * without spinning up a live server connection.
 */
export function getMcpTools(): readonly McpToolInfo[] {
  return TOOL_METADATA;
}
