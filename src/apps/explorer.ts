/**
 * MCP Apps memory explorer — an interactive graph UI served as a `ui://`
 * resource (MCP Apps, ratified Jan 2026).
 *
 * The explorer renders the MemOS entity/memory graph as a self-contained,
 * CSP-locked HTML payload: no external network fetches, no CDN scripts —
 * the SVG renderer, pan/zoom, and filters are all hand-rolled in the
 * payload. The bitemporal "as-of" scrubber re-queries the graph at any past
 * timestamp through the host: each scrub position sends a structured `read`
 * request over the `postMessage` bridge, the host performs a server-side
 * `resources/read` at that timestamp (the existing as-of read path), and the
 * app swaps in the returned snapshot. Nodes are colored by provenance
 * tier, edges labeled by relation type.
 *
 * Consent model (the important part): the app itself is UNPRIVILEGED. It
 * cannot touch the database. Mutating actions (forget, link, release from
 * quarantine) are expressed as structured *intents* posted to the host via
 * `postMessage`; the host translates each intent into a normal MCP
 * `tools/call` (see {@link intentToToolCall}) so the HOST's consent UI
 * applies exactly as if the agent had called the tool itself. Read-path
 * interactions (pan/zoom/filter/scrub) need no consent.
 *
 * Where the host has no MCP Apps support the same resource serves a
 * text/markdown fallback (mermaid diagram + summary) instead of the HTML
 * app — see {@link resolveExplorerMode}.
 *
 * Everything here is deterministic and LLM-free.
 *
 * @module @mem-os/apps-explorer
 */

import { z } from "zod";

import { UriTemplate, type Variables } from "@modelcontextprotocol/server";

import { citationToken } from "../citations.js";
import { graphToMermaid } from "../graph-mermaid.js";
import { PROVENANCE_TIER_ORDER } from "../provenance.js";
import type {
  GraphSnapshot,
  MemoryEdge,
  MemoryNode,
  ProvenanceTier,
} from "../types.js";

// ---------------------------------------------------------------------------
// Identity & caps
// ---------------------------------------------------------------------------

/** Canonical resource URI for the explorer app. */
export const EXPLORER_APP_URI = "ui://memos/explorer";

/**
 * URI template registered on the MCP server. Query variables:
 * - `asOf`      — unix ms; render the graph as of a past timestamp
 *                 (bitemporal time-travel) instead of live.
 * - `mode`      — `app` forces the HTML app, `text` forces the markdown
 *                 fallback. Unset: auto-detect from the host signal,
 *                 defaulting to the safe `text` fallback.
 * - `nodeLimit` — override the node cap (clamped to 1..1000).
 * - `edgeLimit` — override the edge cap (clamped to 1..2000).
 */
export const EXPLORER_URI_TEMPLATE =
  "ui://memos/explorer{?asOf,mode,nodeLimit,edgeLimit}";

/**
 * URI template for the explorer resource with correct optional-query
 * matching.
 *
 * The SDK's built-in `UriTemplate.match()` compiles `{?a,b,...}` into a
 * regex that requires *every* variable to be present, in declaration order —
 * so `ui://memos/explorer?mode=app` would never match
 * `ui://memos/explorer{?asOf,mode,nodeLimit,edgeLimit}`. This subclass keeps
 * the standard template string (so `resources/templates/list` advertises the
 * documented template) but overrides matching: the path must be exactly
 * `ui://memos/explorer`, and any subset of the documented query parameters
 * may be present, in any order. Unknown query parameters are ignored.
 */
export class ExplorerUriTemplate extends UriTemplate {
  constructor() {
    super(EXPLORER_URI_TEMPLATE);
  }

  override match(uri: string): Variables | null {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== "ui:" ||
      parsed.host !== "memos" ||
      parsed.pathname !== "/explorer"
    ) {
      return null;
    }
    const variables: Variables = {};
    for (const name of this.variableNames) {
      const value = parsed.searchParams.get(name);
      if (value !== null) variables[name] = value;
    }
    return variables;
  }
}

/** Default cap on nodes embedded in one payload (keeps it small). */
export const EXPLORER_NODE_CAP = 150;
/** Default cap on edges embedded in one payload. */
export const EXPLORER_EDGE_CAP = 400;
/** Hard ceiling for client-overridden caps. */
export const EXPLORER_NODE_CAP_MAX = 1000;
export const EXPLORER_EDGE_CAP_MAX = 2000;
/** Characters of node content embedded per node. */
export const EXPLORER_CONTENT_CHARS = 280;

/**
 * postMessage protocol identifier. The app posts
 * `{ protocol: "memos-explorer/1", kind: "intent", intent, params, requestId }`
 * to `window.parent`; hosts translate intents via {@link intentToToolCall}
 * and reply with `{ protocol: "memos-explorer/1", kind: "intent-result", ... }`.
 *
 * Read-path time travel uses a second message pair so scrubbing the as-of
 * slider re-queries the server instead of filtering the embedded snapshot
 * client-side: the app posts
 * `{ protocol: "memos-explorer/1", kind: "read", requestId, asOf: number|null }`
 * (`asOf: null` = live graph) and the host performs an MCP `resources/read`
 * of `ui://memos/explorer?mode=app` (plus `&asOf=<ms>` when set) and replies
 * with `{ protocol: "memos-explorer/1", kind: "snapshot", requestId, ok, html?, error? }`
 * where `html` is the raw resource text — the app extracts the new snapshot
 * from its `<script id="memos-snapshot">` tag and re-renders. Reads need no
 * consent. If the host never answers (no bridge support) the app falls back
 * to filtering its embedded snapshot locally.
 */
export const EXPLORER_PROTOCOL = "memos-explorer/1";

/** Node fill color per provenance tier (highest trust → greenest). */
export const PROVENANCE_TIER_COLORS: Record<ProvenanceTier, string> = {
  "user-verified": "#2f9e44",
  user: "#1971c2",
  "tool-output": "#e67700",
  chat: "#7048e8",
  imported: "#868e96",
};

/** Edge stroke color per relation type. */
export const EDGE_RELATION_COLORS: Record<string, string> = {
  relates_to: "#adb5bd",
  supports: "#2f9e44",
  contradicts: "#e03131",
  derived_from: "#1971c2",
  part_of: "#7048e8",
  temporal_precedes: "#e67700",
  custom: "#868e96",
};

/** Intents the app may emit (all go through host consent). */
export const SUPPORTED_INTENTS = [
  "forget",
  "link",
  "release-quarantine",
] as const;
export type ExplorerIntentName = (typeof SUPPORTED_INTENTS)[number];

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Compact, JSON-safe node projection embedded in the app payload. */
export interface ExplorerNode {
  id: string;
  content: string;
  contentTruncated: boolean;
  type: string;
  importance: number;
  trustScore: number;
  /** Provenance tier string; "unknown" when the row predates the column. */
  provenance: string;
  quarantined: boolean;
  quarantineReason: string | null;
  validFrom: number | null;
  validTo: number | null;
  createdAt: number;
  /** Citable `[mem:hex]` token for this memory. */
  citation: string;
}

/** Compact, JSON-safe edge projection embedded in the app payload. */
export interface ExplorerEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
  validFrom: number | null;
  validTo: number | null;
}

/** Everything the app needs, in one JSON blob. */
export interface ExplorerSnapshot {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  /** Pre-cap totals, so the UI can say "showing 150 of 1,204". */
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
  /** When the snapshot was generated (unix ms). */
  generatedAt: number;
  /** As-of timestamp when rendered for a past moment, else null (live). */
  asOf: number | null;
}

export interface SnapshotOptions {
  nodeCap?: number;
  edgeCap?: number;
  /** Pre-filter to this bitemporal timestamp (unix ms). */
  asOf?: number;
}

function clampCap(value: number | undefined, def: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return def;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function projectNode(node: MemoryNode): ExplorerNode {
  const content =
    node.content.length > EXPLORER_CONTENT_CHARS
      ? node.content.slice(0, EXPLORER_CONTENT_CHARS) + "…"
      : node.content;
  return {
    id: node.id,
    content,
    contentTruncated: node.content.length > EXPLORER_CONTENT_CHARS,
    type: node.type,
    importance: node.importance,
    trustScore: node.trustScore,
    provenance: node.provenance ?? "unknown",
    quarantined: node.quarantined ?? false,
    quarantineReason: node.quarantineReason ?? null,
    validFrom: node.validFrom ?? null,
    validTo: node.validTo ?? null,
    createdAt: node.createdAt,
    citation: citationToken(node.id),
  };
}

function projectEdge(edge: MemoryEdge): ExplorerEdge {
  return {
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    relation: edge.relation,
    weight: edge.weight,
    validFrom: edge.validFrom ?? null,
    validTo: edge.validTo ?? null,
  };
}

/**
 * Build the capped, JSON-safe snapshot the app embeds. Nodes are taken in
 * importance order (most important first); edges are kept only when both
 * endpoints survived the node cap, in weight order. Pass `asOf` to
 * pre-filter to a bitemporal timestamp (same predicates as the server
 * as-of read path).
 */
export function buildExplorerSnapshot(
  graph: GraphSnapshot,
  opts: SnapshotOptions = {},
): ExplorerSnapshot {
  const nodeCap = clampCap(
    opts.nodeCap,
    EXPLORER_NODE_CAP,
    EXPLORER_NODE_CAP_MAX,
  );
  const edgeCap = clampCap(
    opts.edgeCap,
    EXPLORER_EDGE_CAP,
    EXPLORER_EDGE_CAP_MAX,
  );

  let nodes = graph.nodes;
  let edges = graph.edges;
  if (opts.asOf !== undefined) {
    nodes = nodes.filter((n) => isNodeValidAt(n, opts.asOf as number));
    edges = edges.filter((e) => isEdgeValidAt(e, opts.asOf as number));
  }

  const totalNodes = nodes.length;
  const totalEdges = edges.length;

  const kept = [...nodes]
    .sort((a, b) => b.importance - a.importance || (a.id < b.id ? -1 : 1))
    .slice(0, nodeCap);
  const keptIds = new Set(kept.map((n) => n.id));
  const keptEdges = edges
    .filter((e) => keptIds.has(e.sourceId) && keptIds.has(e.targetId))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, edgeCap);

  return {
    nodes: kept.map(projectNode),
    edges: keptEdges.map(projectEdge),
    totalNodes,
    totalEdges,
    truncated: totalNodes > kept.length || totalEdges > keptEdges.length,
    generatedAt: Date.now(),
    asOf: opts.asOf ?? null,
  };
}

// ---------------------------------------------------------------------------
// Bitemporal as-of predicates (mirror the server read path exactly)
// ---------------------------------------------------------------------------

/**
 * Node as-of predicate — identical to the SQLite as-of read path
 * (`valid_from <= t AND (valid_to IS NULL OR valid_to >= t)`).
 */
export function isNodeValidAt(
  node:
    | Pick<MemoryNode, "validFrom" | "validTo">
    | Pick<ExplorerNode, "validFrom" | "validTo">,
  atTime: number,
): boolean {
  const from = node.validFrom ?? null;
  const to = node.validTo ?? null;
  return (from === null || from <= atTime) && (to === null || to >= atTime);
}

/**
 * Edge as-of predicate — identical to the SQLite edge as-of read path,
 * which uses strict `valid_to > t` (see `queryEdges({ validAt })`): an
 * edge closed in the same millisecond as the query is already historical.
 */
export function isEdgeValidAt(
  edge:
    | Pick<MemoryEdge, "validFrom" | "validTo">
    | Pick<ExplorerEdge, "validFrom" | "validTo">,
  atTime: number,
): boolean {
  const from = edge.validFrom ?? null;
  const to = edge.validTo ?? null;
  return (from === null || from <= atTime) && (to === null || to > atTime);
}

/**
 * The as-of scrubber's filter: re-evaluate a snapshot at a past timestamp.
 * This is the graceful-degradation path for the time slider — the same
 * predicates the server uses, applied client-side to the embedded
 * snapshot — used only when the host does not implement the `read` bridge
 * (see {@link EXPLORER_PROTOCOL}). With a supporting host, every scrub
 * position re-queries the server via `resources/read?asOf=` instead.
 */
export function filterSnapshotAsOf(
  snapshot: ExplorerSnapshot,
  atTime: number,
): ExplorerSnapshot {
  const nodes = snapshot.nodes.filter((n) => isNodeValidAt(n, atTime));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = snapshot.edges.filter(
    (e) =>
      ids.has(e.sourceId) && ids.has(e.targetId) && isEdgeValidAt(e, atTime),
  );
  return { ...snapshot, nodes, edges, asOf: atTime };
}

// ---------------------------------------------------------------------------
// Graceful degradation: app vs. text fallback
// ---------------------------------------------------------------------------

export type ExplorerMode = "app" | "text";

/**
 * `_meta` keys probed for an explicit host MCP Apps signal, in priority
 * order. `memos.uiApps` is the documented MemOS convention; the others
 * are tolerated aliases.
 */
const APPS_SIGNAL_KEYS = [
  "memos.uiApps",
  "io.modelcontextprotocol/ui",
  "ui",
] as const;

/**
 * Probe a `resources/read` request `_meta` for host MCP Apps support.
 * Returns true/false on an explicit signal, null when the host says
 * nothing (the common case for older clients).
 */
export function probeHostAppsSupport(meta: unknown): boolean | null {
  if (meta === null || meta === undefined || typeof meta !== "object") {
    return null;
  }
  const record = meta as Record<string, unknown>;
  for (const key of APPS_SIGNAL_KEYS) {
    const value = record[key];
    if (value === true) return true;
    if (value === false) return false;
  }
  return null;
}

export interface ResolveModeOptions {
  /** Raw `mode` URI-template variable (`app` | `text`), if given. */
  modeParam?: string | null;
  /** The `resources/read` request `_meta` (host signal probe). */
  meta?: unknown;
}

/**
 * Decide whether to serve the HTML app or the markdown fallback.
 *
 * 1. An explicit `?mode=app|text` always wins.
 * 2. Otherwise an explicit host Apps signal in `_meta` wins.
 * 3. Otherwise fail closed to the `text` fallback: a host that cannot
 *    render the app must never receive a raw HTML blob it would dump as
 *    markup into the conversation.
 */
export function resolveExplorerMode(opts: ResolveModeOptions): ExplorerMode {
  const param = (opts.modeParam ?? "").trim().toLowerCase();
  if (param === "app") return "app";
  if (param === "text" || param === "markdown") return "text";
  return probeHostAppsSupport(opts.meta) === true ? "app" : "text";
}

// ---------------------------------------------------------------------------
// Consent bridge: UI intents → MCP tool calls
// ---------------------------------------------------------------------------

const intentPayloadSchemas: Record<ExplorerIntentName, z.ZodTypeAny> = {
  forget: z.object({ id: z.string().min(1) }),
  link: z.object({
    sourceId: z.string().min(1),
    targetId: z.string().min(1),
    relation: z.enum([
      "relates_to",
      "contradicts",
      "supports",
      "derived_from",
      "part_of",
      "temporal_precedes",
      "custom",
    ]),
    weight: z.number().min(0).max(1).optional(),
  }),
  "release-quarantine": z.object({ id: z.string().min(1) }),
};

export interface IntentToolCall {
  /** MCP tool name — the host calls this via the standard tools/call path. */
  tool: string;
  args: Record<string, unknown>;
}

export type IntentTranslation =
  | { ok: true; intent: ExplorerIntentName; call: IntentToolCall }
  | { ok: false; error: string };

/**
 * Translate a UI intent (posted by the app via `postMessage`) into the MCP
 * tool call the host must issue. Pure and zod-validated: unknown intents
 * and malformed params are rejected here, before any host consent UI.
 *
 * The host — never this module, never the app — performs the actual
 * `tools/call`, so the host's consent model applies to every mutation.
 * The app itself has no credentials and no database access.
 */
export function intentToToolCall(raw: unknown): IntentTranslation {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ok: false, error: "intent must be an object" };
  }
  const { intent, params } = raw as { intent?: unknown; params?: unknown };
  if (
    typeof intent !== "string" ||
    !(SUPPORTED_INTENTS as readonly string[]).includes(intent)
  ) {
    return {
      ok: false,
      error: `unknown intent ${JSON.stringify(intent)}; supported: ${SUPPORTED_INTENTS.join(", ")}`,
    };
  }
  const name = intent as ExplorerIntentName;
  const parsed = intentPayloadSchemas[name].safeParse(params ?? {});
  if (!parsed.success) {
    return { ok: false, error: `invalid params for intent "${name}"` };
  }
  const p = parsed.data as Record<string, unknown>;
  switch (name) {
    case "forget":
      return {
        ok: true,
        intent: name,
        call: { tool: "memos_forget", args: { id: p.id } },
      };
    case "link":
      return {
        ok: true,
        intent: name,
        call: {
          tool: "memos_link",
          args: {
            sourceId: p.sourceId,
            targetId: p.targetId,
            relation: p.relation,
            ...(p.weight !== undefined ? { weight: p.weight } : {}),
          },
        },
      };
    case "release-quarantine":
      return {
        ok: true,
        intent: name,
        call: { tool: "memos_quarantine_release", args: { id: p.id } },
      };
  }
}

// ---------------------------------------------------------------------------
// Text/markdown fallback (hosts without MCP Apps support)
// ---------------------------------------------------------------------------

export interface FallbackOptions {
  asOf?: number | null;
}

/**
 * Build the graceful-degradation payload: the mermaid diagram (reusing
 * `graphToMermaid`, the same renderer as `memos://graph`) plus a summary.
 * Served when {@link resolveExplorerMode} picks `"text"`.
 */
export function buildExplorerFallbackMarkdown(
  snapshot: ExplorerSnapshot,
  opts: FallbackOptions = {},
): string {
  // Reuse the canonical mermaid renderer over the (capped) snapshot.
  const graph: GraphSnapshot = {
    nodes: snapshot.nodes.map(
      (n) =>
        ({
          id: n.id,
          content: n.content,
          type: n.type,
        }) as MemoryNode,
    ),
    edges: snapshot.edges.map(
      (e) =>
        ({
          id: e.id,
          sourceId: e.sourceId,
          targetId: e.targetId,
          relation: e.relation,
        }) as MemoryEdge,
    ),
  };
  const mermaid = graphToMermaid(graph);

  const asOf = opts.asOf ?? snapshot.asOf;
  const lines: string[] = [
    "# MemOS memory explorer — text fallback",
    "",
    "> Your host does not support MCP Apps interactive UIs, so this is a",
    "> static snapshot. Open `" +
      EXPLORER_APP_URI +
      "?mode=app` in an MCP Apps host",
    "> (Claude, ChatGPT, Goose, or VS Code) for the interactive graph with",
    "> the bitemporal time-travel scrubber.",
    "",
    asOf !== null && asOf !== undefined
      ? `*As of ${new Date(asOf).toISOString()} (bitemporal time-travel view)*`
      : "*Live view (current memory state)*",
    "",
    `Showing ${snapshot.nodes.length} of ${snapshot.totalNodes} memories and ` +
      `${snapshot.edges.length} of ${snapshot.totalEdges} relations` +
      (snapshot.truncated
        ? ` (capped at ${EXPLORER_NODE_CAP} nodes / ${EXPLORER_EDGE_CAP} edges — see docs/mcp-apps-explorer.md)`
        : "") +
      ".",
    "",
    "## Graph (Mermaid)",
    "",
    "```mermaid",
    mermaid,
    "```",
    "",
    "## Memories (by importance)",
    "",
  ];
  const top = [...snapshot.nodes]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 25);
  for (const n of top) {
    const flags = [
      n.provenance,
      `trust ${n.trustScore.toFixed(2)}`,
      n.quarantined ? "QUARANTINED" : null,
      n.validTo !== null ? "superseded" : null,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`- [${n.type}] ${n.content} _(${flags})_ ${n.citation}`);
  }
  if (snapshot.nodes.length > top.length) {
    lines.push("", `_…and ${snapshot.nodes.length - top.length} more._`);
  }
  lines.push(
    "",
    "## Node color key (interactive app)",
    "",
    ...PROVENANCE_TIER_ORDER.map(
      (t) => `- ${PROVENANCE_TIER_COLORS[t]} — \`${t}\``,
    ),
    "- red dashed outline — quarantined (pending review)",
    "",
    "Mutating actions from the interactive app (forget, link, release from",
    "quarantine) always go through the host's MCP tool-call consent flow —",
    "the app itself cannot write to memory.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HTML app
// ---------------------------------------------------------------------------

export interface HtmlOptions {
  asOf?: number | null;
}

/** Minimal HTML/XML escaping for interpolated strings. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escape a JSON payload for embedding in <script type="application/json">. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Build the single-file HTML app payload.
 *
 * Security properties (asserted by tests):
 * - `<meta http-equiv="Content-Security-Policy">` locks the document down:
 *   no network, no plugins, inline scripts/styles only.
 * - No external URLs anywhere in the payload (no CDNs, fonts, images).
 * - An HTML comment states the host-side requirement:
 *   `<iframe sandbox="allow-scripts">` (no `allow-same-origin`).
 * - The app is unprivileged: the only outbound channel is `postMessage`
 *   intents to the host; there is no database access from this layer.
 */
export function buildExplorerHtml(
  snapshot: ExplorerSnapshot,
  opts: HtmlOptions = {},
): string {
  const snapJson = embedJson(snapshot);
  const tierColorsJson = embedJson(PROVENANCE_TIER_COLORS);
  const relColorsJson = embedJson(EDGE_RELATION_COLORS);
  const tierOrderJson = embedJson([...PROVENANCE_TIER_ORDER, "unknown"]);
  const asOf = opts.asOf ?? snapshot.asOf;
  const title =
    asOf !== null && asOf !== undefined
      ? "MemOS memory explorer — as of " + new Date(asOf).toISOString()
      : "MemOS memory explorer";

  // NOTE: client JS below deliberately avoids template literals and ${}
  // so it can live inside this TypeScript template literal unescaped.
  return (
    "<!DOCTYPE html>\n" +
    "<!-- MemOS memory explorer (MCP App, " +
    EXPLORER_PROTOCOL +
    ").\n" +
    '     HOST REQUIREMENT: render inside <iframe sandbox="allow-scripts">.\n' +
    "     Do NOT add allow-same-origin or allow-top-navigation: the app must\n" +
    "     stay opaque to the host origin. Mutating actions are intents posted\n" +
    "     via postMessage; the host turns them into MCP tool calls under its\n" +
    "     own consent UI. This payload makes zero network requests. -->\n" +
    '<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'\">\n" +
    "<title>" +
    escapeHtml(title) +
    "</title>\n" +
    "<style>\n" +
    ":root{color-scheme:dark}\n" +
    "body{margin:0;font:13px/1.45 system-ui,-apple-system,sans-serif;background:#14171c;color:#e7eaef}\n" +
    "header{display:flex;align-items:center;gap:12px;padding:8px 12px;background:#1c2128;border-bottom:1px solid #2d333b;flex-wrap:wrap}\n" +
    "header h1{font-size:14px;margin:0;font-weight:600}\n" +
    ".badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#0d419d;color:#fff}\n" +
    ".badge.past{background:#9c6d00}\n" +
    "#toolbar{display:flex;gap:10px;align-items:center;padding:8px 12px;background:#1c2128;border-bottom:1px solid #2d333b;flex-wrap:wrap}\n" +
    "#toolbar input[type=text]{background:#0d1117;border:1px solid #2d333b;color:#e7eaef;border-radius:6px;padding:5px 8px;min-width:180px}\n" +
    "#toolbar select{background:#0d1117;border:1px solid #2d333b;color:#e7eaef;border-radius:6px;padding:5px}\n" +
    ".tiers{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}\n" +
    ".tiers label{display:flex;gap:4px;align-items:center;cursor:pointer}\n" +
    ".dot{display:inline-block;width:10px;height:10px;border-radius:50%}\n" +
    "#main{display:flex;height:calc(100vh - 148px);min-height:320px}\n" +
    "#canvaswrap{flex:1;position:relative;min-width:0}\n" +
    "#graph{width:100%;height:100%;display:block;cursor:grab;touch-action:none}\n" +
    "#graph:active{cursor:grabbing}\n" +
    "#scrub{position:absolute;left:12px;right:12px;bottom:10px;display:flex;gap:8px;align-items:center;background:rgba(28,33,40,.92);border:1px solid #2d333b;border-radius:8px;padding:6px 10px}\n" +
    "#scrub input[type=range]{flex:1;accent-color:#1f6feb}\n" +
    "#scrub button{background:#1f6feb;border:0;color:#fff;border-radius:6px;padding:4px 10px;cursor:pointer}\n" +
    "#tlabel{font-size:11px;color:#9aa4b2;white-space:nowrap;min-width:210px}\n" +
    "#panel{width:300px;border-left:1px solid #2d333b;background:#161b22;padding:12px;overflow-y:auto}\n" +
    "#panel h2{font-size:13px;margin:0 0 8px}\n" +
    "#panel .meta{font-size:12px;color:#9aa4b2;margin:4px 0}\n" +
    "#panel .content{font-size:12px;background:#0d1117;border:1px solid #2d333b;border-radius:6px;padding:8px;margin:8px 0;white-space:pre-wrap;word-break:break-word}\n" +
    "#panel button.action{display:block;width:100%;margin:6px 0;padding:7px;border-radius:6px;border:1px solid #2d333b;background:#21262d;color:#e7eaef;cursor:pointer}\n" +
    "#panel button.action:hover{background:#2d333b}\n" +
    "#panel button.action.danger{border-color:#7a2e2e}\n" +
    "#panel button.action:disabled{opacity:.45;cursor:not-allowed}\n" +
    "#panel details{font-size:11px;color:#9aa4b2;margin-top:8px}\n" +
    "#panel pre{background:#0d1117;padding:8px;border-radius:6px;overflow-x:auto;font-size:11px}\n" +
    "#panel label.f{display:block;font-size:11px;color:#9aa4b2;margin:8px 0 2px}\n" +
    "#panel select,#panel input[type=text],#panel input[type=number]{width:100%;background:#0d1117;border:1px solid #2d333b;color:#e7eaef;border-radius:6px;padding:5px;box-sizing:border-box}\n" +
    "#legend{font-size:11px;color:#9aa4b2}\n" +
    "#legend .row{display:flex;gap:6px;align-items:center;margin:2px 0}\n" +
    "#toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);background:#1c2128;border:1px solid #2d333b;border-radius:8px;padding:8px 14px;font-size:12px;max-width:80%;display:none;z-index:10}\n" +
    ".hint{font-size:11px;color:#9aa4b2}\n" +
    "</style>\n</head>\n<body>\n" +
    "<header>\n<h1>MemOS memory explorer</h1>\n" +
    '<span class="badge" id="modebadge">live</span>\n' +
    '<span class="hint" id="counts"></span>\n' +
    '<span class="hint">nodes = provenance tier &middot; edge labels = relation &middot; drag to pan, wheel to zoom</span>\n' +
    "</header>\n" +
    '<div id="toolbar">\n' +
    '<input type="text" id="q" placeholder="filter text\u2026" aria-label="filter text">\n' +
    '<select id="typef" aria-label="filter type"><option value="all">all types</option></select>\n' +
    '<div class="tiers" id="tierf"></div>\n' +
    "</div>\n" +
    '<div id="main">\n<div id="canvaswrap">\n' +
    '<svg id="graph" role="img" aria-label="memory graph"></svg>\n' +
    '<div id="scrub">\n<button id="livebtn" title="jump back to the live graph">Live</button>\n' +
    '<input type="range" id="time" aria-label="as-of time scrubber">\n' +
    '<span id="tlabel"></span>\n</div>\n</div>\n' +
    '<aside id="panel">\n<h2>Details</h2>\n' +
    '<div id="pbody"><p class="hint">Select a node to inspect it. Mutating actions ask the host for approval first.</p></div>\n' +
    '<h2 style="margin-top:16px">Legend</h2>\n<div id="legend"></div>\n' +
    "</aside>\n</div>\n" +
    '<div id="toast" role="status"></div>\n' +
    '<script type="application/json" id="memos-snapshot">' +
    snapJson +
    "</script>\n" +
    "<script>\n" +
    '"use strict";\n' +
    'var SNAP=JSON.parse(document.getElementById("memos-snapshot").textContent);\n' +
    "var PROTOCOL=" +
    JSON.stringify(EXPLORER_PROTOCOL) +
    ";\n" +
    "var TIER_COLORS=" +
    tierColorsJson +
    ";\n" +
    "var REL_COLORS=" +
    relColorsJson +
    ";\n" +
    "var TIER_ORDER=" +
    tierOrderJson +
    ";\n" +
    'var state={t:SNAP.asOf!==null?SNAP.asOf:SNAP.generatedAt,live:SNAP.asOf===null,q:"",tiers:{},type:"all",sel:null,tx:0,ty:0,k:1};\n' +
    "TIER_ORDER.forEach(function(t){state.tiers[t]=true;});\n" +
    "var $=function(id){return document.getElementById(id);};\n" +
    'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}\n' +
    'function toast(m){var t=$("toast");t.textContent=m;t.style.display="block";clearTimeout(t._h);t._h=setTimeout(function(){t.style.display="none";},4200);}\n' +
    // as-of predicates (mirror the server read path)
    "function validNode(n,t){return (n.validFrom===null||n.validFrom<=t)&&(n.validTo===null||n.validTo>=t);}\n" +
    "function validEdge(e,t){return (e.validFrom===null||e.validFrom<=t)&&(e.validTo===null||e.validTo>t);}\n" +
    // deterministic ring layout, computed once so nodes hold still while scrubbing
    "function computeLayout(){\n" +
    "var adj={};SNAP.nodes.forEach(function(n){adj[n.id]=[];});\n" +
    "SNAP.edges.forEach(function(e){if(adj[e.sourceId]&&adj[e.targetId]){adj[e.sourceId].push(e.targetId);adj[e.targetId].push(e.sourceId);}});\n" +
    "var order=SNAP.nodes.slice().sort(function(a,b){return b.importance-a.importance;});\n" +
    "var depth={},q=[],maxD=0,i;\n" +
    "if(order.length){q.push(order[0].id);depth[order[0].id]=0;}\n" +
    "while(q.length){var id=q.shift(),d=depth[id];var nbs=adj[id]||[];for(i=0;i<nbs.length;i++){var nb=nbs[i];if(depth[nb]===undefined){depth[nb]=d+1;if(d+1>maxD)maxD=d+1;q.push(nb);}}}\n" +
    "var rings={};SNAP.nodes.forEach(function(n){var dd=depth[n.id];if(dd===undefined)dd=maxD+1;if(!rings[dd])rings[dd]=[];rings[dd].push(n.id);});\n" +
    "var pos={};Object.keys(rings).forEach(function(dk){var dd=+dk,ring=rings[dk];if(dd===0){pos[ring[0]]={x:0,y:0};return;}var R=150*dd;for(var j=0;j<ring.length;j++){var a=(2*Math.PI*j/ring.length)+(dd*0.37);pos[ring[j]]={x:Math.round(R*Math.cos(a)),y:Math.round(R*Math.sin(a))};}});\n" +
    "return pos;}\n" +
    "var POS=computeLayout();\n" +
    // keep positions for nodes the app has already seen so the graph does not
    // jump when a re-queried snapshot arrives; brand-new nodes go on an outer ring
    "function ensureLayout(){var maxR=0,seen={},fresh=[],i;\n" +
    "Object.keys(POS).forEach(function(id){seen[id]=1;var p=POS[id];var r=Math.sqrt(p.x*p.x+p.y*p.y);if(r>maxR)maxR=r;});\n" +
    "SNAP.nodes.forEach(function(n){if(!seen[n.id])fresh.push(n);});\n" +
    "for(i=0;i<fresh.length;i++){var a=2*Math.PI*i/Math.max(1,fresh.length);var R=maxR+150;POS[fresh[i].id]={x:Math.round(R*Math.cos(a)),y:Math.round(R*Math.sin(a))};}}\n" +
    "function currentView(){\n" +
    "var t=state.t;\n" +
    "var nodes=SNAP.nodes.filter(function(n){\n" +
    "if(!validNode(n,t))return false;\n" +
    'if(state.q){var hay=(n.content+" "+n.type+" "+n.id).toLowerCase();if(hay.indexOf(state.q)<0)return false;}\n' +
    "if(!state.tiers[n.provenance])return false;\n" +
    'if(state.type!=="all"&&n.type!==state.type)return false;\n' +
    "return true;});\n" +
    "var ids={};nodes.forEach(function(n){ids[n.id]=1;});\n" +
    "var edges=SNAP.edges.filter(function(e){return ids[e.sourceId]&&ids[e.targetId]&&validEdge(e,t);});\n" +
    "return {nodes:nodes,edges:edges};}\n" +
    // render
    'function nodeColor(n){return TIER_COLORS[n.provenance]||"#adb5bd";}\n' +
    'function relColor(r){return REL_COLORS[r]||"#868e96";}\n' +
    'function shortId(id){return id.replace(/-/g,"").slice(0,8);}\n' +
    "function render(){\n" +
    "var v=currentView(),svg=$('graph'),s='';\n" +
    "var i,e,n,a,b,mx,my,lx,ly;\n" +
    "for(i=0;i<v.edges.length;i++){e=v.edges[i];a=POS[e.sourceId];b=POS[e.targetId];if(!a||!b)continue;\n" +
    "mx=(a.x+b.x)/2;my=(a.y+b.y)/2;\n" +
    "s+='<line x1=\"'+a.x+'\" y1=\"'+a.y+'\" x2=\"'+b.x+'\" y2=\"'+b.y+'\" stroke=\"'+relColor(e.relation)+'\" stroke-width=\"'+(0.8+e.weight*1.6).toFixed(1)+'\" opacity=\"0.75\"/>';\n" +
    's+=\'<text x="\'+mx+\'" y="\'+(my-4)+\'" font-size="9" fill="#9aa4b2" text-anchor="middle">\'+esc(e.relation)+\'</text>\';}\n' +
    "for(i=0;i<v.nodes.length;i++){n=v.nodes[i];var p=POS[n.id];if(!p)continue;var r=13+Math.min(8,n.importance*8);\n" +
    'var dash=n.quarantined?\' stroke-dasharray="5,3"\':"";\n' +
    'var stroke=n.quarantined?"#e03131":(n.validTo!==null?"#868e96":"#0d1117");\n' +
    "var sw=n.quarantined?2.5:1.5;\n" +
    "var op=(n.validTo!==null&&state.live)?0.55:1;\n" +
    "s+='<g class=\"node\" data-id=\"'+esc(n.id)+'\" opacity=\"'+op+'\"><title>'+esc(n.type+\": \"+n.content)+'</title>';\n" +
    "s+='<circle cx=\"'+p.x+'\" cy=\"'+p.y+'\" r=\"'+r.toFixed(1)+'\" fill=\"'+nodeColor(n)+'\" stroke=\"'+stroke+'\" stroke-width=\"'+sw+'\"'+dash+'/>';\n" +
    // (keep building: label)
    "s+='<text x=\"'+p.x+'\" y=\"'+(p.y+r+12)+'\" font-size=\"9\" fill=\"#c9d1d9\" text-anchor=\"middle\">'+esc(n.type)+' · '+esc(shortId(n.id))+'</text></g>';}\n" +
    "svg.innerHTML='<g id=\"vp\" transform=\"translate('+state.tx+' '+state.ty+') scale('+state.k+')\">'+s+'</g>';\n" +
    'var c=$("counts");c.textContent=v.nodes.length+" of "+SNAP.totalNodes+" memories \u00b7 "+v.edges.length+" of "+SNAP.totalEdges+" relations"+(SNAP.truncated?" (capped)":"");\n' +
    'var live=state.live;$("modebadge").textContent=live?"live":"as-of";$("modebadge").className="badge"+(live?"":" past");\n' +
    'var lab=$("tlabel");lab.textContent=new Date(state.t).toLocaleString()+(live?" (live)":" (time travel)");\n' +
    "}\n" +
    // pan & zoom
    'var svg=$("graph"),drag=null;\n' +
    'svg.addEventListener("pointerdown",function(ev){drag={x:ev.clientX,y:ev.clientY,tx:state.tx,ty:state.ty};svg.setPointerCapture(ev.pointerId);});\n' +
    'svg.addEventListener("pointermove",function(ev){if(!drag)return;state.tx=drag.tx+(ev.clientX-drag.x);state.ty=drag.ty+(ev.clientY-drag.y);var vp=$("vp");if(vp)vp.setAttribute("transform","translate("+state.tx+" "+state.ty+") scale("+state.k+")");});\n' +
    'svg.addEventListener("pointerup",function(){drag=null;});\n' +
    'svg.addEventListener("wheel",function(ev){ev.preventDefault();var f=ev.deltaY<0?1.15:1/1.15;state.k=Math.min(6,Math.max(0.2,state.k*f));var vp=$("vp");if(vp)vp.setAttribute("transform","translate("+state.tx+" "+state.ty+") scale("+state.k+")");},{passive:false});\n' +
    'svg.addEventListener("click",function(ev){var g=ev.target.closest?ev.target.closest("g.node"):null;if(!g)return;selectNode(g.getAttribute("data-id"));});\n' +
    // selection + panel
    "function findNode(id){for(var i=0;i<SNAP.nodes.length;i++)if(SNAP.nodes[i].id===id)return SNAP.nodes[i];return null;}\n" +
    "function selectNode(id){state.sel=id;renderPanel();}\n" +
    'function fmtT(t){return t===null?"\u2014":new Date(t).toLocaleString();}\n' +
    "function renderPanel(){\n" +
    'var body=$("pbody"),n=state.sel?findNode(state.sel):null;\n' +
    "if(!n){body.innerHTML='<p class=\"hint\">Select a node to inspect it. Mutating actions ask the host for approval first.</p>';return;}\n" +
    "var h='';\n" +
    "h+='<div class=\"meta\"><span class=\"dot\" style=\"background:'+nodeColor(n)+'\"></span> <b>'+esc(n.type)+'</b> · '+esc(n.provenance)+'</div>';\n" +
    'h+=\'<div class="content" id="pc"></div>\';\n' +
    "h+='<div class=\"meta\">trust '+n.trustScore.toFixed(2)+' · importance '+n.importance.toFixed(2)+'</div>';\n" +
    "h+='<div class=\"meta\">citation <code>'+esc(n.citation)+'</code></div>';\n" +
    "h+='<div class=\"meta\">valid: '+esc(fmtT(n.validFrom))+' → '+esc(fmtT(n.validTo))+'</div>';\n" +
    'if(n.quarantined)h+=\'<div class="meta" style="color:#ff8787">quarantined: \'+esc(n.quarantineReason||"unspecified")+\'</div>\';\n' +
    'h+=\'<button class="action danger" id="a-forget">Forget this memory</button>\';\n' +
    'if(n.quarantined)h+=\'<button class="action" id="a-release">Release from quarantine</button>\';\n' +
    // link form
    'h+=\'<label class="f">Link to memory</label><select id="link-target"></select>\';\n' +
    'h+=\'<label class="f">Relation</label><select id="link-rel">\'+\n' +
    "Object.keys(REL_COLORS).map(function(r){return '<option value=\"'+r+'\">'+r+'</option>';}).join(\"\")+'</select>';\n" +
    'h+=\'<button class="action" id="a-link">Create link</button>\';\n' +
    'h+=\'<details><summary>Equivalent MCP tool call (what the host will run)</summary><pre id="toolpreview"></pre><button class="action" id="a-copy">Copy tool call JSON</button></details>\';\n' +
    "h+='<p class=\"hint\">Actions are sent to the host as intents and need your approval there. Nothing is written directly.</p>';\n" +
    "body.innerHTML=h;\n" +
    '$("pc").textContent=n.content;\n' +
    // target options
    'var ts=$("link-target");SNAP.nodes.forEach(function(m){if(m.id===n.id)return;var o=document.createElement("option");o.value=m.id;o.textContent=m.type+" \u00b7 "+shortId(m.id);ts.appendChild(o);});\n' +
    'var preview=$("toolpreview");\n' +
    'function showPreview(intent,params){var tc=toolCallFor(intent,params);preview.textContent=tc?JSON.stringify(tc,null,2):"unsupported intent";}\n' +
    'showPreview("forget",{id:n.id});\n' +
    '$("a-forget").addEventListener("click",function(){var p={id:n.id};showPreview("forget",p);sendIntent("forget",p);});\n' +
    'var rel=$("a-release");if(rel)rel.addEventListener("click",function(){var p={id:n.id};showPreview("release-quarantine",p);sendIntent("release-quarantine",p);});\n' +
    '$("a-link").addEventListener("click",function(){var p={sourceId:n.id,targetId:ts.value,relation:$("link-rel").value,weight:0.5};showPreview("link",p);sendIntent("link",p);});\n' +
    '$("a-copy").addEventListener("click",function(){var t=preview.textContent;if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){toast("Copied tool call JSON");},function(){toast("Copy failed");});}else{toast("Clipboard unavailable");}});\n' +
    "}\n" +
    // intent bridge
    "function toolCallFor(intent,params){\n" +
    'if(intent==="forget")return {tool:"memos_forget",args:{id:params.id}};\n' +
    'if(intent==="link")return {tool:"memos_link",args:{sourceId:params.sourceId,targetId:params.targetId,relation:params.relation,weight:params.weight}};\n' +
    'if(intent==="release-quarantine")return {tool:"memos_quarantine_release",args:{id:params.id}};\n' +
    "return null;}\n" +
    "var seq=0,pending={};\n" +
    "function sendIntent(intent,params){\n" +
    'var id="req-"+(++seq)+"-"+Date.now();\n' +
    'var msg={protocol:PROTOCOL,kind:"intent",intent:intent,params:params,requestId:id};\n' +
    "pending[id]=intent;\n" +
    'try{window.parent.postMessage(msg,"*");}catch(e){toast("postMessage failed");return;}\n' +
    'toast("Sent \'"+intent+"\' to the host \u2014 approve it there to apply.");\n' +
    "}\n" +
    'window.addEventListener("message",function(ev){\n' +
    "var d=ev.data;if(!d||d.protocol!==PROTOCOL)return;\n" +
    'if(d.kind==="snapshot"){onSnapshot(d);return;}\n' +
    'if(d.kind!=="intent-result")return;\n' +
    'var what=pending[d.requestId]||"intent";delete pending[d.requestId];\n' +
    'toast(d.ok?("Host applied \'"+what+"\'. Refresh the resource to see it."):("Host did not apply \'"+what+"\': "+(d.error||"declined")));\n' +
    "});\n" +
    // toolbar wiring
    'var qi=$("q");qi.addEventListener("input",function(){state.q=qi.value.trim().toLowerCase();render();});\n' +
    'var tf=$("typef");var types={};SNAP.nodes.forEach(function(n){types[n.type]=1;});\n' +
    'Object.keys(types).sort().forEach(function(t){var o=document.createElement("option");o.value=t;o.textContent=t;tf.appendChild(o);});\n' +
    'tf.addEventListener("change",function(){state.type=tf.value;render();});\n' +
    'var tierf=$("tierf");TIER_ORDER.forEach(function(t){\n' +
    'var lab=document.createElement("label");var cb=document.createElement("input");cb.type="checkbox";cb.checked=true;\n' +
    'cb.addEventListener("change",function(){state.tiers[t]=cb.checked;render();});\n' +
    'var dot=document.createElement("span");dot.className="dot";dot.style.background=TIER_COLORS[t]||"#adb5bd";\n' +
    "lab.appendChild(cb);lab.appendChild(dot);lab.appendChild(document.createTextNode(t));tierf.appendChild(lab);});\n" +
    // legend
    'var lg=$("legend");TIER_ORDER.forEach(function(t){var d=document.createElement("div");d.className="row";var s=document.createElement("span");s.className="dot";s.style.background=TIER_COLORS[t]||"#adb5bd";d.appendChild(s);d.appendChild(document.createTextNode(t));lg.appendChild(d);});\n' +
    'var qd=document.createElement("div");qd.className="row";qd.innerHTML=\'<span class="dot" style="background:transparent;border:2px dashed #e03131"></span>\';qd.appendChild(document.createTextNode("quarantined"));lg.appendChild(qd);\n' +
    // scrubber: every position re-queries the server through the host bridge
    // (read-only, no consent needed). When the host does not implement the
    // bridge, scrubbing degrades to filtering the embedded snapshot locally.
    'var tr=$("time");\n' +
    "function scrubBounds(){var tmin=SNAP.generatedAt;SNAP.nodes.forEach(function(n){if(n.createdAt<tmin)tmin=n.createdAt;});tr.min=tmin;tr.max=Math.max(SNAP.generatedAt,state.t);tr.step=60000;}\n" +
    "scrubBounds();tr.value=state.t;\n" +
    "var bridge={mode:0,wait:0,timer:0,debounce:0};\n" +
    'function extractSnapshot(html){try{var doc=new DOMParser().parseFromString(html,"text/html");var el=doc.getElementById("memos-snapshot");return el?JSON.parse(el.textContent):null;}catch(e){return null;}}\n' +
    "function applySnapshot(snap){SNAP=snap;state.t=snap.asOf!==null?snap.asOf:snap.generatedAt;state.live=snap.asOf===null;ensureLayout();scrubBounds();tr.value=state.t;render();}\n" +
    "function fallbackScrub(t){state.t=t;state.live=t>=SNAP.generatedAt;tr.value=state.t;render();}\n" +
    "function fallbackLive(){state.t=SNAP.generatedAt;state.live=true;tr.value=state.t;render();}\n" +
    "function onSnapshot(d){if(d.requestId!==bridge.wait)return;bridge.wait=0;clearTimeout(bridge.timer);\n" +
    "if(d.ok&&d.html){var snap=extractSnapshot(d.html);if(snap){bridge.mode=1;applySnapshot(snap);return;}}\n" +
    'bridge.mode=2;toast("Host could not re-read the graph; scrubbing locally.");if(bridge.wantLive)fallbackLive();else fallbackScrub(bridge.wantT);}\n' +
    "function requestSnapshot(t,live){\n" +
    "var go=function(){if(live)fallbackLive();else fallbackScrub(t);};\n" +
    "if(bridge.mode===2){go();return;}\n" +
    'var id="read-"+(++seq)+"-"+Date.now();bridge.wait=id;bridge.wantT=t;bridge.wantLive=live;\n' +
    'try{window.parent.postMessage({protocol:PROTOCOL,kind:"read",requestId:id,asOf:live?null:t},"*");}\n' +
    "catch(e){bridge.mode=2;go();return;}\n" +
    "clearTimeout(bridge.timer);\n" +
    "bridge.timer=setTimeout(function(){if(bridge.wait===id){bridge.mode=2;bridge.wait=0;go();} },2000);\n" +
    "}\n" +
    'tr.addEventListener("input",function(){var t=+tr.value;clearTimeout(bridge.debounce);bridge.debounce=setTimeout(function(){requestSnapshot(t,false);},300);});\n' +
    '$("livebtn").addEventListener("click",function(){requestSnapshot(0,true);});\n' +
    "render();\n" +
    "</script>\n</body>\n</html>"
  );
}
