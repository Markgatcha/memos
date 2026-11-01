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
 * Transport: stdio (default) and Streamable HTTP (`startMcpHttpServer`).
 *
 * HTTP is opt-in because stdio is the right default for a local-first
 * tool: nothing listens, nothing is exposed. The HTTP listener binds
 * loopback unless a host is passed explicitly.
 */

import {
  McpServer,
  ResourceTemplate,
  createMcpHandler,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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
import { buildSelfEvalCases, runRetrievalEval } from "./eval.js";
import { asMemOSError, errorPayload, formatErrorCard } from "./errors.js";

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
// All tools operate on the local MemOS database only; nothing reaches
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
  // Writes chunks for a file/folder; re-running on unchanged files is a no-op.
  memos_ingest: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  memos_search: ANNOTATE_READ,
  // Pure read: builds (and caches) a profile slice of the store.
  memos_profile: ANNOTATE_READ,
  memos_retrieve: ANNOTATE_READ,
  // Deletes a memory by ID. Re-running with the same ID reaches the same
  // end state, so it is also idempotent.
  memos_forget: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Deletes every memory from one source. Re-running after deletion
  // matches nothing and reaches the same end state.
  memos_forget_source: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Reports whether a node is present, deleted (with a certificate), or
  // unknown. Pure read.
  memos_deletion_status: ANNOTATE_READ,
  // Review queue: list is read-only, approve mutates, reject deletes.
  memos_review: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
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
  // Image memory: `add` writes a node plus a blob (content-addressed,
  // so re-storing identical bytes is a no-op → idempotent);
  // `recall`/`search` are pure reads.
  memos_image_add: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  memos_image_recall: ANNOTATE_READ,
  memos_image_search: ANNOTATE_READ,
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
  // Recall inspector: pure read over the retrieval pipeline.
  memos_explain: ANNOTATE_READ,
  // Outcome feedback: appends an evidence batch; re-running with a new
  // batch is a new observation, so not idempotent.
  memos_feedback: ANNOTATE_WRITE,
  // Health report: pure read.
  memos_health: ANNOTATE_READ,
  // Store overview: pure read.
  memos_overview: ANNOTATE_READ,
  // Task trigger: pure read over procedural lessons.
  memos_trigger: ANNOTATE_READ,
  // Per-subject brief: pure read, recomputed on call.
  memos_brief: ANNOTATE_READ,
  // Knowledge pages: list/get are reads; save/delete mutate.
  memos_page: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  // Handoff/audit/eval are read-only artifacts.
  memos_handoff: ANNOTATE_READ,
  memos_audit: ANNOTATE_READ,
  memos_eval: ANNOTATE_READ,
  // Promotion writes additive lessons when `apply` is true; it never deletes
  // or overwrites, and duplicate lessons are skipped.
  memos_promote: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * The tools every MCP client gets by default.
 *
 * The full surface is 40 tools, which is a large context tax before the model
 * has read the user's message (a 2026 MCP community measurement puts verbose
 * schemas at roughly 466 tokens per tool). The core set covers the daily loop:
 * store, recall, inspect, give feedback, and check health. Advanced tools stay
 * available with `MEMOS_MCP_TOOLS=all`.
 */
export const MCP_CORE_TOOL_NAMES = [
  "memos_store",
  "memos_ingest",
  "memos_search",
  "memos_retrieve",
  "memos_forget",
  "memos_context_pack",
  "memos_profile",
  "memos_handoff",
  "memos_explain",
  "memos_feedback",
  "memos_health",
  "memos_overview",
] as const;

export type McpToolProfile = "standard" | "all" | "none";

/**
 * Resolve which MCP tools should be visible.
 *
 * - unset / `standard` / `core` -> the core set (default)
 * - `all` / `*` -> the full 40-tool surface
 * - `none` -> no tools (resources/prompts still work)
 * - a comma-separated list -> exactly those tools
 *
 * Returns `null` for "all", so callers do not need a special case.
 */
export function resolveMcpToolSet(
  raw: string | undefined = process.env.MEMOS_MCP_TOOLS,
): Set<string> | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "all" || value === "*") return null;
  if (value === "none") return new Set();
  if (value === "" || value === "standard" || value === "core") {
    return new Set(MCP_CORE_TOOL_NAMES);
  }
  return new Set(
    value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export function isMcpToolEnabled(
  name: string,
  raw: string | undefined = process.env.MEMOS_MCP_TOOLS,
): boolean {
  const enabled = resolveMcpToolSet(raw);
  return enabled === null || enabled.has(name);
}

function toolErrorResult(tool: string, error: unknown) {
  const structured = asMemOSError(error, "MEMOS_MCP_TOOL_FAILED", { tool });
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: formatErrorCard(structured) }],
    structuredContent: errorPayload(structured),
  };
}

function registerTools(server: McpServer, memos: MemOS): void {
  const enabledTools = resolveMcpToolSet();

  if (enabledTools === null || enabledTools.has("memos_store"))
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
          ttl: z
            .number()
            .optional()
            .describe("Optional expiration in seconds."),
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
              "Situational context for the EMBEDDED text (contextual " +
                "retrieval). Include the session/topic/date and the previous " +
                "turn when storing a conversation answer; it is never " +
                "returned in search results.",
            ),
          metadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "Structured metadata. sessionId enables session-neighbour " +
                "expansion; timestamp + speaker enable the automatic " +
                "contextual header; event marks a calendar/event memory.",
            ),
          provenance: z
            .enum(["user-verified", "user", "tool-output", "chat", "imported"])
            .optional()
            .describe(
              'Provenance tier override. Pass "tool-output" when storing ' +
                'results returned by tools, "imported" for bulk imports. ' +
                "Defaults from the content's origin when omitted.",
            ),
          filter_retain: z
            .boolean()
            .optional()
            .describe(
              "Run the write-side salience triage before storing: trivial " +
                "acknowledgements and near-duplicates are skipped (the tool " +
                "returns a skip notice instead of a node). Default false — " +
                "agent writes are never silently dropped unless opted in.",
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
        metadata,
        scope,
        provenance,
        filter_retain,
      }) => {
        let stored;
        try {
          stored = await memos.store(content, {
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
            ...(metadata ? { metadata } : {}),
            ...(scope ? { scope } : {}),
            ...(provenance ? { provenance } : {}),
            ...(filter_retain ? { filterRetain: true } : {}),
          });
        } catch (err) {
          // Salience triage skip: surface as a plain-text notice, not a
          // protocol error — the write was judged not worth keeping.
          if (
            filter_retain &&
            err instanceof Error &&
            err.name === "MemorySkippedError"
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Skipped by the salience triage (${err.message}). ` +
                    `Re-send with filter_retain=false to store it anyway.`,
                },
              ],
              structuredContent: { skipped: true, reason: err.message },
            };
          }
          throw err;
        }
        return {
          content: [
            { type: "text" as const, text: `Stored memory ${stored.node.id}.` },
          ],
          structuredContent: stored,
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_ingest"))
    server.registerTool(
      "memos_ingest",
      {
        title: "Ingest Documents",
        annotations: TOOL_ANNOTATIONS.memos_ingest,
        description:
          "Ingest a file or folder (Markdown, text, HTML, PDF) into memory. " +
          "Incremental: unchanged files are skipped, edited files replace their " +
          "chunks, deleted files remove theirs. Returns counts of what changed.",
        inputSchema: z.object({
          path: z.string().describe("File or directory to ingest."),
          namespace: z
            .string()
            .optional()
            .describe("Target namespace (default documents)."),
          chunk_chars: z
            .number()
            .optional()
            .describe("Max characters per chunk (default 1200)."),
          extensions: z
            .array(z.string())
            .optional()
            .describe("Restrict to extensions, e.g. ['.md', '.pdf']."),
        }),
        outputSchema: z.object({
          added: z.number(),
          updated: z.number(),
          unchanged: z.number(),
          removed: z.number(),
          skipped: z.number(),
          errors: z.number(),
          chunks: z.number(),
        }),
      },
      async ({ path, namespace, chunk_chars, extensions }) => {
        try {
          const result = await memos.ingest(path, {
            ...(namespace ? { namespace } : {}),
            ...(chunk_chars ? { chunkChars: chunk_chars } : {}),
            ...(extensions ? { extensions } : {}),
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (err) {
          return toolErrorResult("memos_ingest", err);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_search"))
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
          namespace: z
            .string()
            .optional()
            .describe("Optional namespace filter."),
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
          namespaces: z
            .array(z.string())
            .optional()
            .describe(
              "Read across several raw namespaces at once (e.g. " +
                '["project:alpha", "project:beta"]). The shared `default` ' +
                "namespace is always unioned in, like `scope`.",
            ),
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
        namespaces,
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
          ...(namespaces && namespaces.length > 0 ? { namespaces } : {}),
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
            {
              type: "text" as const,
              text: `Found ${flagged.length} memories.`,
            },
          ],
          structuredContent: { results: flagged.map(toMcpResult) },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_profile"))
    server.registerTool(
      "memos_profile",
      {
        title: "User Profile",
        annotations: TOOL_ANNOTATIONS.memos_profile,
        description:
          "One-call user profile: durable facts (static) plus recent " +
          "activity (dynamic) — the block to inject at session start so " +
          "the agent knows who it is talking to before the first turn.",
        inputSchema: z.object({
          query: z
            .string()
            .optional()
            .describe(
              "Optional topic query. The static half is led by the " +
                "memories most relevant to it (scope-tuned profile).",
            ),
          max_static: z
            .number()
            .optional()
            .describe("Max durable items. Default 25."),
          max_dynamic: z
            .number()
            .optional()
            .describe("Max recent-activity items. Default 10."),
          recent_days: z
            .number()
            .optional()
            .describe(
              "Recency window for the dynamic half, in days. Default 7.",
            ),
          namespace: z
            .string()
            .optional()
            .describe("Optional namespace filter."),
          scope: scopeInputSchema,
        }),
        outputSchema: z.object({
          static: z.array(memoryNodeSchema),
          dynamic: z.array(memoryNodeSchema),
          generatedAt: z.number(),
          cached: z.boolean(),
          totalStatic: z.number(),
          totalDynamic: z.number(),
        }),
      },
      async ({
        query,
        max_static,
        max_dynamic,
        recent_days,
        namespace,
        scope,
      }) => {
        const profile = await memos.profile({
          ...(query ? { query } : {}),
          ...(max_static !== undefined ? { maxStatic: max_static } : {}),
          ...(max_dynamic !== undefined ? { maxDynamic: max_dynamic } : {}),
          ...(recent_days !== undefined ? { recentDays: recent_days } : {}),
          ...(namespace ? { namespace } : {}),
          ...(scope ? { scope } : {}),
        });
        const lines = [
          ...profile.static.map((n) => `• ${n.content}`),
          ...(profile.dynamic.length > 0 ? ["— recent —"] : []),
          ...profile.dynamic.map((n) => `• ${n.content}`),
        ];
        return {
          content: [
            {
              type: "text" as const,
              text:
                lines.join("\n") ||
                "No profile memories yet — store a few preferences first.",
            },
          ],
          structuredContent: profile,
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_retrieve"))
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

  if (enabledTools === null || enabledTools.has("memos_forget"))
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
              text: deleted
                ? `Forgot memory ${id}.`
                : `Memory not found: ${id}.`,
            },
          ],
          structuredContent: { id, deleted },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_forget_source"))
    server.registerTool(
      "memos_forget_source",
      {
        title: "Forget Everything From a Source",
        annotations: TOOL_ANNOTATIONS.memos_forget_source,
        description:
          "Delete every memory that came from one source (file, folder, URL, " +
          "import id, harness, or source value). Writes hash-chained " +
          "tombstones and returns proof-of-forgetting certificates. Use " +
          "dryRun=true to preview. Destructive.",
        inputSchema: z.object({
          source: z
            .string()
            .min(1)
            .describe("Path, URL, source id, harness, or source value."),
          field: z
            .string()
            .optional()
            .describe(
              "Metadata field to match (default: sourcePath, sourceId, url, source, harness).",
            ),
          prefix: z
            .boolean()
            .optional()
            .describe("Match by prefix, e.g. a whole folder or URL tree."),
          namespace: z.string().optional(),
          dryRun: z.boolean().optional(),
        }),
        outputSchema: z.object({ result: z.unknown() }),
      },
      async (input) => {
        try {
          const result = await memos.forgetSource(input.source, {
            ...(input.field !== undefined ? { field: input.field } : {}),
            ...(input.prefix !== undefined ? { prefix: input.prefix } : {}),
            ...(input.namespace !== undefined
              ? { namespace: input.namespace }
              : {}),
            ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
          });
          const text = result.dryRun
            ? `Would delete ${result.matched} memor${result.matched === 1 ? "y" : "ies"} from "${result.source}".`
            : `Deleted ${result.deleted} of ${result.matched} memor${result.matched === 1 ? "y" : "ies"} from "${result.source}"; ${result.certificates.length} certificate(s).`;
          return {
            content: [
              {
                type: "text" as const,
                text: `${text}\n\n${JSON.stringify(result, null, 2)}`,
              },
            ],
            structuredContent: { result },
          };
        } catch (error) {
          return toolErrorResult("memos_forget_source", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_deletion_status"))
    server.registerTool(
      "memos_deletion_status",
      {
        title: "Deletion Status",
        annotations: TOOL_ANNOTATIONS.memos_deletion_status,
        description:
          "Check whether a memory is present, deleted (with a proof-of-" +
          "forgetting certificate), or unknown. Read-only.",
        inputSchema: z.object({
          id: z.string().describe("Memory ID."),
        }),
        outputSchema: z.object({ status: z.unknown() }),
      },
      async ({ id }) => {
        const status = await memos.deletionStatus(id);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${id}: ${status.status}` +
                (status.certificate
                  ? ` at ${new Date(status.certificate.deletedAt).toISOString()} (tamper seq ${status.certificate.tamperSeq})`
                  : ""),
            },
          ],
          structuredContent: { status },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_review"))
    server.registerTool(
      "memos_review",
      {
        title: "Review Inferred Memories",
        annotations: TOOL_ANNOTATIONS.memos_review,
        description:
          "List memories waiting for approval, then approve or reject them. " +
          "Pending rows are stored but excluded from recall until approved. " +
          "Use action=list, approve, or reject.",
        inputSchema: z.object({
          action: z.enum(["list", "approve", "reject"]),
          id: z
            .string()
            .optional()
            .describe("Required for approve and reject."),
          namespace: z.string().optional(),
        }),
        outputSchema: z.object({ result: z.unknown() }),
      },
      async ({ action, id, namespace }) => {
        try {
          if (action === "list") {
            const items = await memos.reviewQueue(
              namespace !== undefined ? { namespace } : {},
            );
            const text =
              items.length === 0
                ? "No memories are waiting for review."
                : items
                    .map(
                      (item) =>
                        `${item.id} · ${item.type} · ${item.content.slice(0, 120)}`,
                    )
                    .join("\n");
            return {
              content: [{ type: "text" as const, text }],
              structuredContent: { result: { items, count: items.length } },
            };
          }
          if (!id) {
            throw new Error(`action=${action} requires an id.`);
          }
          if (action === "approve") {
            const node = await memos.reviewApprove(id);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Approved ${node.id}; it is recallable now.`,
                },
              ],
              structuredContent: { result: node },
            };
          }
          const deleted = await memos.reviewReject(id);
          return {
            content: [
              {
                type: "text" as const,
                text: deleted
                  ? `Rejected and deleted ${id}.`
                  : `Rejected ${id}, but it was already gone.`,
              },
            ],
            structuredContent: { result: { id, deleted } },
          };
        } catch (error) {
          return toolErrorResult("memos_review", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_link"))
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

  if (enabledTools === null || enabledTools.has("memos_quarantine_release"))
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

  if (enabledTools === null || enabledTools.has("memos_graph"))
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

  if (enabledTools === null || enabledTools.has("memos_context"))
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

  if (enabledTools === null || enabledTools.has("memos_context_pack"))
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

  if (enabledTools === null || enabledTools.has("memos_search_temporal"))
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
            {
              type: "text" as const,
              text: `Found ${flagged.length} memories.`,
            },
          ],
          structuredContent: { results: flagged.map(toMcpResult) },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_set_validity"))
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

  if (enabledTools === null || enabledTools.has("memos_supersede"))
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

  if (enabledTools === null || enabledTools.has("memos_set_trust"))
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

  if (enabledTools === null || enabledTools.has("memos_extract_facts"))
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
          structuredContent: {
            facts: result.facts,
            storedIds: result.storedIds,
          },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_diagnostics"))
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
            {
              type: "text" as const,
              text: JSON.stringify(diagnostics, null, 2),
            },
          ],
          structuredContent: { diagnostics },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_reindex"))
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

  if (enabledTools === null || enabledTools.has("memos_consolidate"))
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
          ...(args.summarize !== undefined
            ? { summarize: args.summarize }
            : {}),
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

  if (enabledTools === null || enabledTools.has("memos_usage"))
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

  if (enabledTools === null || enabledTools.has("memos_history"))
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
            .describe(
              "Similarity threshold for related versions (default 0.8).",
            ),
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

  if (enabledTools === null || enabledTools.has("memos_revert"))
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
            .describe(
              "Why the revert was issued (recorded on the audit event).",
            ),
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

  if (enabledTools === null || enabledTools.has("memos_reminders"))
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

  // ---- Image memory (vision) -------------------------------------------
  //
  // Three tools mirroring the CLI's `image` subcommands. They are
  // always registered (so the tool list is stable) but fail soft with a
  // plain message when vision is disabled, rather than vanishing from
  // the surface — an agent that sees the tool knows it exists and how
  // to turn it on.

  if (enabledTools === null || enabledTools.has("memos_image_add"))
    server.registerTool(
      "memos_image_add",
      {
        title: "Store Image Memory",
        annotations: TOOL_ANNOTATIONS.memos_image_add,
        description:
          "Store an image as a durable memory. The image is written to a " +
          "content-addressed blob next to the database (identical bytes " +
          "are stored once) and a caption becomes the memory's text, so " +
          "ordinary search and context packs find it. Requires the MemOS " +
          "instance to be constructed with vision: { enabled: true }. " +
          "Pass `data` as base64 plus `mime`, or `path`/`url` to fetch. " +
          "Use a DESCRIPTIVE caption: it is what text retrieval matches, " +
          "and with CLIP disabled (the default) it is the only way the " +
          "image is found.",
        inputSchema: z.object({
          path: z
            .string()
            .optional()
            .describe("Filesystem path to the image (or a data: URL)."),
          url: z
            .string()
            .optional()
            .describe("http(s)/file URL to fetch the image from."),
          data: z
            .string()
            .optional()
            .describe("Base64-encoded image bytes (with `mime`)."),
          mime: z
            .string()
            .optional()
            .describe("MIME type for `data` (e.g. image/png)."),
          caption: z
            .string()
            .optional()
            .describe(
              "What the image shows. Be specific — this is the searchable text.",
            ),
          kind: z
            .enum([
              "photo",
              "screenshot",
              "chart",
              "diagram",
              "memo",
              "meme",
              "other",
            ])
            .optional()
            .describe("Coarse taxonomy. Defaults from the image format."),
          tags: z
            .array(z.string())
            .optional()
            .describe("Optional filter tags."),
          namespace: z.string().optional().describe("Target namespace."),
          conversationId: z
            .string()
            .optional()
            .describe("Conversation this image was shared in."),
        }),
        outputSchema: z.object({
          node: memoryNodeSchema,
          ref: z.string(),
          kind: z.string(),
          width: z.number(),
          height: z.number(),
          bytes: z.number(),
          mime: z.string(),
          clipStatus: z.string(),
          deduped: z.boolean(),
        }),
      },
      async ({
        path,
        url,
        data,
        mime,
        caption,
        kind,
        tags,
        namespace,
        conversationId,
      }) => {
        const input =
          data !== undefined
            ? { data, mime: mime ?? "image/png" }
            : url !== undefined
              ? { url }
              : path;
        if (input === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Provide `path`, `url`, or `data`+`mime`.",
              },
            ],
            isError: true,
          };
        }
        try {
          const result = await memos.addImageMemory(input, {
            ...(caption !== undefined ? { caption } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(tags ? { tags } : {}),
            ...(namespace !== undefined ? { namespace } : {}),
            ...(conversationId !== undefined ? { conversationId } : {}),
          });
          const text = result.deduped
            ? `Image already stored: ${result.image.ref} (node ${result.node.id})`
            : `Stored image ${result.image.ref} ` +
              `(${result.image.kind}, ${result.image.width}x${result.image.height}, ` +
              `${result.image.bytes} bytes) as node ${result.node.id}.` +
              (result.clipStatus !== "skipped"
                ? ` CLIP: ${result.clipStatus}.`
                : "");
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: {
              node: result.node as unknown as Record<string, unknown>,
              ref: result.image.ref,
              kind: result.image.kind,
              width: result.image.width,
              height: result.image.height,
              bytes: result.image.bytes,
              mime: result.image.mime,
              clipStatus: result.clipStatus,
              deduped: result.deduped,
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text" as const, text: `Image store failed: ${message}` },
            ],
            isError: true,
          };
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_image_recall"))
    server.registerTool(
      "memos_image_recall",
      {
        title: "Resolve Image",
        annotations: TOOL_ANNOTATIONS.memos_image_recall,
        description:
          "Resolve an image reference (the `[img:...]` token a context pack " +
          "carries, or a memory node id) back to its bytes. Returns the " +
          "blob as base64 plus its MIME type so a vision-capable host can " +
          "actually see the image. The bytes are NEVER inlined into a " +
          "context pack — call this when you need them.",
        inputSchema: z.object({
          ref: z
            .string()
            .describe("Image ref (`img_<sha256[0:12]>`) or a node id."),
        }),
        outputSchema: z.object({
          ref: z.string(),
          mime: z.string(),
          bytes: z.number(),
          data: z.string(),
        }),
      },
      async ({ ref }) => {
        const resolved = await memos.imageMemory(ref);
        if (!resolved) {
          return {
            content: [
              { type: "text" as const, text: `Image not found: ${ref}` },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `${resolved.ref} — ${resolved.mime}, ${resolved.buffer.length} bytes`,
            },
          ],
          structuredContent: {
            ref: resolved.ref,
            mime: resolved.mime,
            bytes: resolved.buffer.length,
            data: resolved.buffer.toString("base64"),
          },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_image_search"))
    server.registerTool(
      "memos_image_search",
      {
        title: "Search Images",
        annotations: TOOL_ANNOTATIONS.memos_image_search,
        description:
          "Search stored images by text query. The caption leg (keyword + " +
          "semantic) always runs; the CLIP pixel leg runs only when the " +
          "instance was constructed with vision.clip.enabled, and is what " +
          "finds an image whose caption shares no vocabulary with the " +
          "query. Returns refs — resolve them with memos_image_recall.",
        inputSchema: z.object({
          query: z.string().describe("What to look for."),
          limit: z.number().optional().describe("Maximum result count."),
          namespace: z.string().optional().describe("Namespace filter."),
          kind: z
            .enum([
              "photo",
              "screenshot",
              "chart",
              "diagram",
              "memo",
              "meme",
              "other",
            ])
            .optional()
            .describe("Restrict to one image kind."),
        }),
        outputSchema: z.object({
          results: z.array(
            z.object({
              id: z.string(),
              ref: z.string(),
              kind: z.string(),
              width: z.number(),
              height: z.number(),
              caption: z.string(),
              score: z.number(),
            }),
          ),
        }),
      },
      async ({ query, limit, namespace, kind }) => {
        const hits = await memos.searchImages(query, {
          limit: limit ?? 10,
          ...(namespace !== undefined ? { namespace } : {}),
          ...(kind !== undefined ? { kind } : {}),
        });
        const results = hits.map((hit) => ({
          id: hit.node.id,
          ref: hit.image.ref,
          kind: hit.image.kind,
          width: hit.image.width,
          height: hit.image.height,
          caption: hit.image.caption,
          score: Number(hit.score.toFixed(4)),
        }));
        const text =
          results.length === 0
            ? "No matching images found."
            : `${results.length} image(s):\n` +
              results
                .map(
                  (r) => `• ${r.ref} [${r.kind}] (${r.score}) — ${r.caption}`,
                )
                .join("\n");
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { results },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_explain"))
    server.registerTool(
      "memos_explain",
      {
        title: "Explain Recall",
        annotations: TOOL_ANNOTATIONS.memos_explain,
        description:
          "Explain why memories were (or were not) recalled for a query. " +
          "Returns per-leg score signals, lifecycle status, supersede chain, " +
          "outcome utility, and the relevance-gate verdict. Pass memoryId to " +
          "diagnose one memory that should have matched but did not.",
        inputSchema: z.object({
          query: z.string().describe("Query to explain."),
          memoryId: z
            .string()
            .optional()
            .describe("Focus on one memory id and report eligibility checks."),
          limit: z
            .number()
            .optional()
            .describe("Candidates to return (1-100)."),
          namespace: z.string().optional().describe("Namespace filter."),
          pool: z
            .enum(["event", "note", "procedure", "visual"])
            .optional()
            .describe("Pool filter."),
        }),
        outputSchema: z.object({ explanation: z.unknown() }),
      },
      async ({ query, memoryId, limit, namespace, pool }) => {
        const explanation = await memos.explain({
          query,
          ...(memoryId !== undefined ? { memoryId } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
          ...(pool !== undefined ? { pool } : {}),
        });
        const gate = explanation.gate;
        const gateText = !gate.enabled
          ? "gate off"
          : gate.abstained
            ? "gate would ABSTAIN"
            : gate.trimmed
              ? `gate would trim ${gate.dropped}`
              : "gate keeps all";
        const lines = explanation.candidates.map(
          (candidate) =>
            `#${candidate.rank} ${candidate.id} score=${candidate.score.toFixed(
              3,
            )} [${candidate.status}/${candidate.pool}] ${candidate.summary}`,
        );
        const focusText = explanation.focus
          ? `\nFocus ${explanation.focus.id}: ${
              explanation.focus.retrieved ? "retrieved" : "NOT retrieved"
            }.\n${explanation.focus.reasons.map((r) => `  - ${r}`).join("\n")}`
          : "";
        const text = `${lines.length} candidate(s), ${gateText}${focusText}\n\n${JSON.stringify(
          explanation,
          null,
          2,
        )}`;
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { explanation },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_feedback"))
    server.registerTool(
      "memos_feedback",
      {
        title: "Record Recall Outcome",
        annotations: TOOL_ANNOTATIONS.memos_feedback,
        description:
          "Close the loop: report which recalled memories the agent actually " +
          "used and whether the task succeeded. Successful uses promote those " +
          "memories in future ranking; failed uses demote them. Call this after " +
          "acting on search/context results.",
        inputSchema: z.object({
          query: z.string().describe("The query whose results were used."),
          used: z
            .array(z.string())
            .describe("Memory ids the agent actually used (may be empty)."),
          outcome: z.enum(["success", "partial", "failure"]),
          weight: z
            .number()
            .optional()
            .describe("Importance weight (0.01-100, default 1)."),
          note: z.string().optional().describe("Optional free-form note."),
        }),
        outputSchema: z.object({ feedback: z.unknown() }),
      },
      async ({ query, used, outcome, weight, note }) => {
        const feedback = await memos.recordRecallFeedback({
          query,
          used,
          outcome,
          ...(weight !== undefined ? { weight } : {}),
          ...(note !== undefined ? { note } : {}),
        });
        const text =
          `Recorded ${feedback.outcome} outcome for ${feedback.recorded} ` +
          `memor${feedback.recorded === 1 ? "y" : "ies"} (batch ${feedback.batchId}).` +
          (feedback.unknown.length > 0
            ? ` Unknown ids ignored: ${feedback.unknown.join(", ")}.`
            : "");
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { feedback },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_health"))
    server.registerTool(
      "memos_health",
      {
        title: "Memory Health",
        annotations: TOOL_ANNOTATIONS.memos_health,
        description:
          "Hygiene and usefulness report: contradiction pressure, expired " +
          "rows, low-confidence share, quarantine count, and outcome-conditioned " +
          "recall rate, with actionable findings and a heuristic grade.",
        inputSchema: z.object({}),
        outputSchema: z.object({ health: z.unknown() }),
      },
      async () => {
        const health = await memos.health();
        const lines = health.findings.map(
          (finding) =>
            `[${finding.severity}] ${finding.title} - ${finding.detail}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Health ${health.score}/100 (grade ${health.grade})\n${lines.join(
                "\n",
              )}\n\n${JSON.stringify(health, null, 2)}`,
            },
          ],
          structuredContent: { health },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_overview"))
    server.registerTool(
      "memos_overview",
      {
        title: "Memory Overview",
        annotations: TOOL_ANNOTATIONS.memos_overview,
        description:
          "What this store knows, without listing memories: namespaces, " +
          "types, top tags, provenance, freshness, trust, and graph size. " +
          "Call once at session start to decide whether to search.",
        inputSchema: z.object({
          namespace: z
            .string()
            .optional()
            .describe("Restrict counts to one namespace."),
        }),
        outputSchema: z.object({ overview: z.unknown() }),
      },
      async ({ namespace }) => {
        const overview = await memos.overview(
          namespace !== undefined ? { namespace } : {},
        );
        const topics = overview.tags
          .slice(0, 8)
          .map((tag) => `${tag.tag} (${tag.count})`)
          .join(", ");
        const text =
          `${overview.active} active / ${overview.total} total memories · ` +
          `${overview.namespaces.length} namespace(s) · ` +
          `${overview.edges} edges · ` +
          `${overview.freshness.last7d} updated in 7d\n` +
          (topics ? `Top tags: ${topics}\n` : "") +
          `Types: ${overview.types
            .map((row) => `${row.type} ${row.count}`)
            .join(", ")}\n\n` +
          JSON.stringify(overview, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { overview },
        };
      },
    );

  if (enabledTools === null || enabledTools.has("memos_handoff"))
    server.registerTool(
      "memos_handoff",
      {
        title: "Cross-Harness Handoff",
        annotations: TOOL_ANNOTATIONS.memos_handoff,
        description:
          "Build a compact, citable handoff brief for another harness, model, " +
          "or session: durable profile, token-budgeted context, lessons, " +
          "reminders, memory health, and harness attribution. Read-only.",
        inputSchema: z.object({
          task: z
            .string()
            .min(1)
            .describe("Task the next agent should continue."),
          tokenBudget: z.number().int().positive().optional(),
          namespace: z.string().optional(),
          scope: scopeInputSchema.optional(),
          lessons: z.number().int().min(0).optional(),
          includeReminders: z.boolean().optional(),
          fromHarness: z.string().optional(),
          toHarness: z.string().optional(),
          format: z.enum(["markdown", "json"]).optional(),
        }),
        outputSchema: z.object({ brief: z.unknown() }),
      },
      async (input) => {
        try {
          const brief = await memos.handoff({
            task: input.task,
            ...(input.tokenBudget !== undefined
              ? { tokenBudget: input.tokenBudget }
              : {}),
            ...(input.namespace ? { namespace: input.namespace } : {}),
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.lessons !== undefined ? { lessons: input.lessons } : {}),
            ...(input.includeReminders !== undefined
              ? { includeReminders: input.includeReminders }
              : {}),
            ...(input.fromHarness ? { fromHarness: input.fromHarness } : {}),
            ...(input.toHarness ? { toHarness: input.toHarness } : {}),
            format: input.format ?? "json",
          });
          const text =
            typeof brief === "string" ? brief : JSON.stringify(brief, null, 2);
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { brief },
          };
        } catch (error) {
          return toolErrorResult("memos_handoff", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_audit"))
    server.registerTool(
      "memos_audit",
      {
        title: "Memory Audit",
        annotations: TOOL_ANNOTATIONS.memos_audit,
        description:
          "Tamper-chain verification, provenance/source inventory, quarantine " +
          "register, deletion certificates, semantic-search health, and " +
          "recommendations. Read-only.",
        inputSchema: z.object({
          expectTip: z.string().optional(),
          limit: z.number().int().positive().optional(),
        }),
        outputSchema: z.object({ audit: z.unknown() }),
      },
      async (input) => {
        try {
          const audit = await memos.auditReport({
            ...(input.expectTip ? { expectTip: input.expectTip } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(audit, null, 2) },
            ],
            structuredContent: { audit },
          };
        } catch (error) {
          return toolErrorResult("memos_audit", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_eval"))
    server.registerTool(
      "memos_eval",
      {
        title: "Memory Retrieval Eval",
        annotations: TOOL_ANNOTATIONS.memos_eval,
        description:
          "Evaluate retrieval on this store. Without cases, samples recent " +
          "memories and checks self-recall (index health). With cases, runs a " +
          "labelled {query, relevantIds} corpus and reports Hit@K, MRR, latency, " +
          "and token cost.",
        inputSchema: z.object({
          k: z.number().int().positive().optional(),
          limit: z.number().int().positive().optional(),
          fromSessions: z.boolean().optional(),
          namespace: z.string().optional(),
          cases: z
            .array(
              z.object({
                query: z.string().min(1),
                relevantIds: z.array(z.string()).min(1),
              }),
            )
            .optional(),
        }),
        outputSchema: z.object({ eval: z.unknown() }),
      },
      async (input) => {
        try {
          const cases =
            input.cases && input.cases.length > 0
              ? input.cases
              : await buildSelfEvalCases(memos, {
                  ...(input.limit !== undefined ? { limit: input.limit } : {}),
                  ...(input.fromSessions !== undefined
                    ? { fromSessions: input.fromSessions }
                    : {}),
                  ...(input.namespace ? { namespace: input.namespace } : {}),
                });
          if (cases.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "No memories to evaluate. Store a few facts first (`memos demo` works).",
                },
              ],
              structuredContent: { eval: null },
            };
          }
          const report = await runRetrievalEval(memos, cases, {
            ...(input.k !== undefined ? { k: input.k } : {}),
            mode: input.cases?.length ? "corpus" : "self",
            ...(input.namespace ? { namespace: input.namespace } : {}),
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(report, null, 2),
              },
            ],
            structuredContent: { eval: report },
          };
        } catch (error) {
          return toolErrorResult("memos_eval", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_promote"))
    server.registerTool(
      "memos_promote",
      {
        title: "Promote Successful Recalls",
        annotations: TOOL_ANNOTATIONS.memos_promote,
        description:
          "Review repeated successful recall patterns as procedure candidates. " +
          "Dry-run by default; set apply=true to write the lessons. Existing " +
          "duplicates are skipped.",
        inputSchema: z.object({
          apply: z.boolean().optional(),
          minSuccesses: z.number().int().positive().optional(),
          maxFailureRatio: z.number().min(0).max(1).optional(),
          limit: z.number().int().positive().optional(),
          namespace: z.string().optional(),
        }),
        outputSchema: z.object({ promotion: z.unknown() }),
      },
      async (input) => {
        try {
          const promotion = await memos.promoteProcedures({
            ...(input.apply !== undefined ? { apply: input.apply } : {}),
            ...(input.minSuccesses !== undefined
              ? { minSuccesses: input.minSuccesses }
              : {}),
            ...(input.maxFailureRatio !== undefined
              ? { maxFailureRatio: input.maxFailureRatio }
              : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.namespace ? { namespace: input.namespace } : {}),
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(promotion, null, 2),
              },
            ],
            structuredContent: { promotion },
          };
        } catch (error) {
          return toolErrorResult("memos_promote", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_trigger"))
    server.registerTool(
      "memos_trigger",
      {
        title: "Trigger Procedures",
        annotations: TOOL_ANNOTATIONS.memos_trigger,
        description:
          "Call before acting: takes the task and entities it touches and " +
          "returns relevant procedural lessons with a reason for each match. " +
          "Read-only. Follow with memos_feedback or a lesson outcome.",
        inputSchema: z.object({
          task: z.string().min(1).describe("What the agent is about to do."),
          entities: z
            .array(z.string())
            .optional()
            .describe("Files, tools, services, or people involved."),
          namespace: z.string().optional(),
          limit: z.number().int().min(1).max(20).optional(),
        }),
        outputSchema: z.object({ trigger: z.unknown() }),
      },
      async (input) => {
        try {
          const trigger = await memos.trigger({
            task: input.task,
            ...(input.entities !== undefined
              ? { entities: input.entities }
              : {}),
            ...(input.namespace !== undefined
              ? { namespace: input.namespace }
              : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
          });
          const text =
            trigger.matches.length === 0
              ? `No procedural lessons matched "${trigger.task}".`
              : trigger.matches
                  .map(
                    (match, index) =>
                      `${index + 1}. ${match.lesson}\n   why: ${match.reason}`,
                  )
                  .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `${text}\n\n${JSON.stringify(trigger, null, 2)}`,
              },
            ],
            structuredContent: { trigger },
          };
        } catch (error) {
          return toolErrorResult("memos_trigger", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_brief"))
    server.registerTool(
      "memos_brief",
      {
        title: "Subject Brief",
        annotations: TOOL_ANNOTATIONS.memos_brief,
        description:
          "Maintained open/closed brief for one person, project, or topic. " +
          "Inject only the open items; closed items are kept for audit. " +
          "Recomputed on read, so it cannot drift from memory.",
        inputSchema: z.object({
          subject: z.string().min(1),
          namespace: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          includeClosed: z.boolean().optional(),
        }),
        outputSchema: z.object({ brief: z.unknown() }),
      },
      async (input) => {
        try {
          const brief = await memos.brief({
            subject: input.subject,
            ...(input.namespace !== undefined
              ? { namespace: input.namespace }
              : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
            ...(input.includeClosed !== undefined
              ? { includeClosed: input.includeClosed }
              : {}),
          });
          const text =
            `Brief: ${brief.subject}\n\nOpen (${brief.open.length}):\n` +
            brief.open.map((item) => `- ${item.content}`).join("\n") +
            (brief.closed.length > 0
              ? `\n\nClosed (${brief.closed.length}):\n` +
                brief.closed.map((item) => `- ${item.content}`).join("\n")
              : "");
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { brief },
          };
        } catch (error) {
          return toolErrorResult("memos_brief", error);
        }
      },
    );

  if (enabledTools === null || enabledTools.has("memos_page"))
    server.registerTool(
      "memos_page",
      {
        title: "Knowledge Pages",
        annotations: TOOL_ANNOTATIONS.memos_page,
        description:
          "Named, living knowledge pages: save a query plus pinned memories, " +
          "then get a freshly rendered page with citations on every read. " +
          "Actions: list, get, save, delete.",
        inputSchema: z.object({
          action: z.enum(["list", "get", "save", "delete"]),
          name: z.string().optional(),
          title: z.string().optional(),
          query: z.string().optional(),
          pinnedIds: z.array(z.string()).optional(),
          maxItems: z.number().int().min(1).max(100).optional(),
          namespace: z.string().optional(),
        }),
        outputSchema: z.object({ result: z.unknown() }),
      },
      async (input) => {
        try {
          switch (input.action) {
            case "list": {
              const pages = await memos.listPages();
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      pages.length === 0
                        ? "No knowledge pages saved."
                        : pages
                            .map(
                              (page) =>
                                `${page.name}: ${page.title} (${page.query})`,
                            )
                            .join("\n"),
                  },
                ],
                structuredContent: { result: pages },
              };
            }
            case "save": {
              if (!input.name || !input.query) {
                throw new Error("save requires name and query.");
              }
              const page = await memos.savePage({
                name: input.name,
                query: input.query,
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.pinnedIds !== undefined
                  ? { pinnedIds: input.pinnedIds }
                  : {}),
                ...(input.maxItems !== undefined
                  ? { maxItems: input.maxItems }
                  : {}),
                ...(input.namespace !== undefined
                  ? { namespace: input.namespace }
                  : {}),
              });
              return {
                content: [
                  { type: "text" as const, text: `Saved page ${page.name}.` },
                ],
                structuredContent: { result: page },
              };
            }
            case "delete": {
              if (!input.name) throw new Error("delete requires name.");
              const deleted = await memos.deletePage(input.name);
              return {
                content: [
                  {
                    type: "text" as const,
                    text: deleted
                      ? `Deleted page ${input.name}.`
                      : `Page not found: ${input.name}.`,
                  },
                ],
                structuredContent: { result: { name: input.name, deleted } },
              };
            }
            default: {
              if (!input.name) throw new Error("get requires name.");
              const page = await memos.readPage(input.name);
              return {
                content: [{ type: "text" as const, text: page.markdown }],
                structuredContent: { result: page },
              };
            }
          }
        } catch (error) {
          return toolErrorResult("memos_page", error);
        }
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
        "memos_search_temporal. Images: memos_image_add stores one with a " +
        "caption (be specific — the caption is what text search matches), " +
        "memos_image_search finds them, memos_image_recall resolves an " +
        "[img:...] ref to bytes. All data stays on this machine.",
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
  const memos = createMemOsForMcp(config);
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
// Streamable HTTP transport
// ---------------------------------------------------------------------------

/** Options for {@link startMcpHttpServer}. */
export interface McpHttpServerOptions {
  /** TCP port. `0` picks a free port (useful in tests). Default `8788`. */
  port?: number;
  /**
   * Interface to bind. Defaults to `127.0.0.1`, i.e. loopback only.
   *
   * MemOS holds private conversation memory, so the listener is never
   * network-reachable unless a caller passes a host explicitly. Passing
   * `0.0.0.0` is an intentional act with its own consequences (auth,
   * firewalling); this module does not provide authentication.
   */
  host?: string;
  /** URL path that serves MCP. Default `/mcp`. */
  path?: string;
}

/** A running Streamable-HTTP MCP server. */
export interface McpHttpServerHandle {
  port: number;
  host: string;
  /** Absolute endpoint URL, e.g. `http://127.0.0.1:8788/mcp`. */
  url: string;
  /** Stop listening and release the MemOS instance. Idempotent. */
  close(): Promise<void>;
}

/** Largest request body accepted, mirroring the SDK's default POST cap. */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function createMemOsForMcp(config: MemOSConfig): MemOS {
  return new MemOS({
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
}

/** Convert a Node request into a Web `Request` for the SDK handler. */
async function toWebRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let body: Buffer | undefined;
  if (hasBody) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        throw new Error(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
      }
      chunks.push(buf);
    }
    body = Buffer.concat(chunks);
  }

  return new Request(url, {
    method,
    headers,
    ...(body && body.length > 0 ? { body } : {}),
  });
}

/** Stream a Web `Response` back to the Node response without buffering. */
async function writeWebResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // MCP does not set cookies, so a flat copy is correct here.
    if (key.toLowerCase() === "set-cookie") return;
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Write, then wait for the socket to drain so a slow client cannot
      // make an SSE stream buffer without bound in memory.
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

/**
 * Serve MemOS over **Streamable HTTP** instead of stdio.
 *
 * Why this exists: a stdio-only server cannot be reached over the network,
 * so hosted clients, multi-session harnesses, and MCP registry probes cannot
 * exercise it at all. The protocol framing is identical — only the transport
 * differs — because both go through `createMcpServer`.
 *
 * The listener binds loopback by default. There is **no authentication**
 * here: if you bind a routable host, put it behind a reverse proxy that
 * authenticates, because every tool on this server reads and writes your
 * memory.
 *
 * @returns A handle with the bound address and an idempotent `close()`.
 */
export async function startMcpHttpServer(
  config: MemOSConfig = {},
  options: McpHttpServerOptions = {},
): Promise<McpHttpServerHandle> {
  const path = options.path ?? "/mcp";
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;

  const memos = createMemOsForMcp(config);
  await memos.init();

  const handler = createMcpHandler(() => createMcpServer(memos));

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const authority = req.headers.host ?? `${host}:${port}`;
        const url = new URL(req.url ?? path, `http://${authority}`);
        if (url.pathname !== path) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end(`Not found. MCP is served at ${path}.`);
          return;
        }
        const response = await handler.fetch(await toWebRequest(req, url));
        await writeWebResponse(response, res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        }
        res.end(`MCP request failed: ${message}`);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : port;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await handler.close();
    await memos.close();
  };

  return {
    port: boundPort,
    host,
    url: `http://${host}:${boundPort}${path}`,
    close,
  };
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
        pool: z.string().optional(),
        context: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        scope: z.record(z.string(), z.string()).optional(),
        provenance: z.string().optional(),
        filter_retain: z.boolean().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ node: memoryNodeSchema, links: z.array(memoryEdgeSchema) }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_ingest",
    annotations: TOOL_ANNOTATIONS.memos_ingest,
    description:
      "Ingest a file or folder (Markdown, text, HTML, PDF) into memory. " +
      "Incremental and idempotent.",
    inputSchema: z.toJSONSchema(
      z.object({
        path: z.string(),
        namespace: z.string().optional(),
        chunk_chars: z.number().optional(),
        extensions: z.array(z.string()).optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        added: z.number(),
        updated: z.number(),
        unchanged: z.number(),
        removed: z.number(),
        skipped: z.number(),
        errors: z.number(),
        chunks: z.number(),
      }),
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
    name: "memos_profile",
    annotations: TOOL_ANNOTATIONS.memos_profile,
    description:
      "One-call user profile: durable facts (static) plus recent activity " +
      "(dynamic) — inject at session start so the agent knows who it is " +
      "talking to before the first turn.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string().optional(),
        max_static: z.number().optional(),
        max_dynamic: z.number().optional(),
        recent_days: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        static: z.array(memoryNodeSchema),
        dynamic: z.array(memoryNodeSchema),
        generatedAt: z.number(),
        cached: z.boolean(),
        totalStatic: z.number(),
        totalDynamic: z.number(),
      }),
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
    name: "memos_forget_source",
    annotations: TOOL_ANNOTATIONS.memos_forget_source,
    description:
      "Delete every memory from one source, with proof-of-forgetting certificates.",
    inputSchema: z.toJSONSchema(
      z.object({
        source: z.string(),
        field: z.string().optional(),
        prefix: z.boolean().optional(),
        namespace: z.string().optional(),
        dryRun: z.boolean().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ result: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_deletion_status",
    annotations: TOOL_ANNOTATIONS.memos_deletion_status,
    description:
      "Check whether a memory is present, deleted (certificate), or unknown.",
    inputSchema: z.toJSONSchema(z.object({ id: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(z.object({ status: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_review",
    annotations: TOOL_ANNOTATIONS.memos_review,
    description:
      "List, approve, or reject inferred memories waiting for review.",
    inputSchema: z.toJSONSchema(
      z.object({
        action: z.enum(["list", "approve", "reject"]),
        id: z.string().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ result: z.unknown() })) as Record<
      string,
      unknown
    >,
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
  {
    name: "memos_image_add",
    annotations: TOOL_ANNOTATIONS.memos_image_add,
    description:
      "Store an image as a durable memory. The image is written to a " +
      "content-addressed blob next to the database and a caption becomes " +
      "the memory's text. Requires vision: { enabled: true }.",
    inputSchema: z.toJSONSchema(
      z.object({
        path: z.string().optional(),
        url: z.string().optional(),
        data: z.string().optional(),
        mime: z.string().optional(),
        caption: z.string().optional(),
        kind: z
          .enum([
            "photo",
            "screenshot",
            "chart",
            "diagram",
            "memo",
            "meme",
            "other",
          ])
          .optional(),
        tags: z.array(z.string()).optional(),
        namespace: z.string().optional(),
        conversationId: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        node: z.unknown(),
        ref: z.string(),
        kind: z.string(),
        width: z.number(),
        height: z.number(),
        bytes: z.number(),
        mime: z.string(),
        clipStatus: z.string(),
        deduped: z.boolean(),
      }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_image_recall",
    annotations: TOOL_ANNOTATIONS.memos_image_recall,
    description:
      "Resolve an [img:...] ref (or a node id) back to its bytes, as " +
      "base64 plus MIME type.",
    inputSchema: z.toJSONSchema(z.object({ ref: z.string() })) as Record<
      string,
      unknown
    >,
    outputSchema: z.toJSONSchema(
      z.object({
        ref: z.string(),
        mime: z.string(),
        bytes: z.number(),
        data: z.string(),
      }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_image_search",
    annotations: TOOL_ANNOTATIONS.memos_image_search,
    description:
      "Search stored images by text query. Caption leg always; CLIP " +
      "pixel leg only when vision.clip.enabled.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        limit: z.number().optional(),
        namespace: z.string().optional(),
        kind: z
          .enum([
            "photo",
            "screenshot",
            "chart",
            "diagram",
            "memo",
            "meme",
            "other",
          ])
          .optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({
        results: z.array(
          z.object({
            id: z.string(),
            ref: z.string(),
            kind: z.string(),
            width: z.number(),
            height: z.number(),
            caption: z.string(),
            score: z.number(),
          }),
        ),
      }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_explain",
    annotations: TOOL_ANNOTATIONS.memos_explain,
    description:
      "Explain why memories were (or were not) recalled for a query: " +
      "per-leg scores, lifecycle status, supersede chain, outcome utility, " +
      "and the relevance-gate verdict.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        memoryId: z.string().optional(),
        limit: z.number().optional(),
        namespace: z.string().optional(),
        pool: z.enum(["event", "note", "procedure", "visual"]).optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ explanation: z.unknown() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_feedback",
    annotations: TOOL_ANNOTATIONS.memos_feedback,
    description:
      "Record which recalled memories the agent actually used and whether " +
      "the task succeeded, so future ranking can learn from outcomes.",
    inputSchema: z.toJSONSchema(
      z.object({
        query: z.string(),
        used: z.array(z.string()),
        outcome: z.enum(["success", "partial", "failure"]),
        weight: z.number().optional(),
        note: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ feedback: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_health",
    annotations: TOOL_ANNOTATIONS.memos_health,
    description:
      "Hygiene and usefulness report with actionable findings and a " +
      "heuristic grade.",
    inputSchema: z.toJSONSchema(z.object({})) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ health: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_overview",
    annotations: TOOL_ANNOTATIONS.memos_overview,
    description:
      "What this store knows: namespaces, types, top tags, provenance, " +
      "freshness, trust, and graph size. Read-only session-start index.",
    inputSchema: z.toJSONSchema(
      z.object({ namespace: z.string().optional() }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ overview: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_handoff",
    annotations: TOOL_ANNOTATIONS.memos_handoff,
    description:
      "Compact, citable handoff brief for another harness or session.",
    inputSchema: z.toJSONSchema(
      z.object({
        task: z.string(),
        tokenBudget: z.number().optional(),
        namespace: z.string().optional(),
        scope: z.unknown().optional(),
        lessons: z.number().optional(),
        includeReminders: z.boolean().optional(),
        fromHarness: z.string().optional(),
        toHarness: z.string().optional(),
        format: z.enum(["markdown", "json"]).optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ brief: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_audit",
    annotations: TOOL_ANNOTATIONS.memos_audit,
    description:
      "Tamper chain, provenance, quarantine, deletion certificates, health.",
    inputSchema: z.toJSONSchema(
      z.object({
        expectTip: z.string().optional(),
        limit: z.number().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ audit: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_eval",
    annotations: TOOL_ANNOTATIONS.memos_eval,
    description:
      "Retrieval eval: self-recall or a labelled query corpus, with Hit@K and token cost.",
    inputSchema: z.toJSONSchema(
      z.object({
        k: z.number().optional(),
        limit: z.number().optional(),
        fromSessions: z.boolean().optional(),
        namespace: z.string().optional(),
        cases: z
          .array(
            z.object({
              query: z.string(),
              relevantIds: z.array(z.string()),
            }),
          )
          .optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ eval: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_promote",
    annotations: TOOL_ANNOTATIONS.memos_promote,
    description:
      "Review repeated successful recalls as procedures; apply=true writes lessons.",
    inputSchema: z.toJSONSchema(
      z.object({
        apply: z.boolean().optional(),
        minSuccesses: z.number().optional(),
        maxFailureRatio: z.number().optional(),
        limit: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(
      z.object({ promotion: z.unknown() }),
    ) as Record<string, unknown>,
  },
  {
    name: "memos_trigger",
    annotations: TOOL_ANNOTATIONS.memos_trigger,
    description:
      "Before acting, recall relevant procedural lessons for a task and its entities.",
    inputSchema: z.toJSONSchema(
      z.object({
        task: z.string(),
        entities: z.array(z.string()).optional(),
        namespace: z.string().optional(),
        limit: z.number().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ trigger: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_brief",
    annotations: TOOL_ANNOTATIONS.memos_brief,
    description:
      "Open/closed brief for a person, project, or topic; recomputed on read.",
    inputSchema: z.toJSONSchema(
      z.object({
        subject: z.string(),
        namespace: z.string().optional(),
        limit: z.number().optional(),
        includeClosed: z.boolean().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ brief: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
  {
    name: "memos_page",
    annotations: TOOL_ANNOTATIONS.memos_page,
    description:
      "Save or read a living knowledge page (query + pinned memories, re-rendered).",
    inputSchema: z.toJSONSchema(
      z.object({
        action: z.enum(["list", "get", "save", "delete"]),
        name: z.string().optional(),
        title: z.string().optional(),
        query: z.string().optional(),
        pinnedIds: z.array(z.string()).optional(),
        maxItems: z.number().optional(),
        namespace: z.string().optional(),
      }),
    ) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(z.object({ result: z.unknown() })) as Record<
      string,
      unknown
    >,
  },
];

/**
 * Return static metadata about the MCP tools exposed by MemOS.
 * Useful for programmatic consumers and tests that need tool definitions
 * without spinning up a live server connection.
 *
 * Kept in the SAME ORDER as the live `registerTools` registrations —
 * the annotations test asserts the two surfaces match exactly, so a
 * reorder here must be mirrored there.
 */
export function getMcpTools(): readonly McpToolInfo[] {
  const enabled = resolveMcpToolSet();
  if (enabled === null) return TOOL_METADATA;
  return TOOL_METADATA.filter((tool) => enabled.has(tool.name));
}
