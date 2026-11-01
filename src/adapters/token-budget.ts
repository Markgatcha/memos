/**
 * Shared token-budget plumbing for the framework adapters.
 *
 * The adapters used to select memories purely by COUNT
 * (`maxContextMemories`, default 5) and hand the model either raw
 * `node.content` or `JSON.stringify(memories, null, 2)`. That bypasses
 * every optimization in the context-pack path — TOON, fidelity, dedup,
 * debloating, and above all the token budget — on what is the most
 * common integration route in the SDK.
 *
 * This module gives all three framework adapters one implementation of
 * "assemble memories under a token budget", so they cannot drift apart:
 *
 *   1. `MemOS.contextPack({ tokenBudget })` ranks, de-dupes and trims
 *      the candidate set by COST rather than count.
 *   2. The trimmed pack is serialized deterministically in the requested
 *      format (minified JSON with a fixed key order, verbose TOON, or
 *      compact TOON).
 *   3. The serialized payload is re-trimmed against the same budget.
 *      `contextPack` accounts each item with a flat
 *      `content + summary + 4` estimate, which undercounts the serialized
 *      framing — so a pack that "fits" can still render over budget. The
 *      re-trim closes that gap and makes the guarantee exact:
 *      `estimateTokens(text) <= tokenBudget` whenever at least one item
 *      fits, in every format.
 *
 * Leaving `tokenBudget` unset keeps every adapter on its historical
 * byte-identical path (including the `maxContextMemories: 5` default);
 * nothing here is consulted unless a budget is configured.
 *
 * @module @memos/adapters/token-budget
 */

import type { MemOS } from "../index.js";
import type { ContextPack, ContextPackItem } from "../index.js";
import {
  estimateTokens,
  packToToon,
  packToToonCompact,
} from "../context-pack.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Wire format for a budgeted memory payload. */
export type AdapterPackFormat = "json" | "toon" | "toon-compact";

/**
 * The two options every framework adapter accepts to opt into budgeted
 * memory assembly. Both are unset by default, which keeps the adapters'
 * legacy count-based, raw-content output byte-identical.
 */
export interface AdapterTokenBudgetOptions {
  /**
   * Token budget for assembled memory context. When set, memory assembly
   * routes through `MemOS.contextPack({ tokenBudget })` — ranking,
   * dedup and TOON/fidelity included — and the rendered payload is
   * guaranteed to cost at most this many estimated tokens. When unset,
   * the adapter keeps its historical count-based selection.
   */
  tokenBudget?: number;
  /**
   * Wire format used when `tokenBudget` is set.
   *
   * - `"json"` (default): minified JSON with a fixed key order — a
   *   drop-in replacement for the old `JSON.stringify(memories, null, 2)`.
   * - `"toon"`: verbose pipe-delimited TOON.
   * - `"toon-compact"`: ultra-compact pipe-delimited TOON.
   *
   * Ignored when `tokenBudget` is unset.
   */
  packFormat?: AdapterPackFormat;
}

/** Overrides for {@link buildBudgetedPack}. */
export interface BudgetedPackRequest {
  /** Query text to assemble memory for. */
  query: string;
  /** Namespace to search. Defaults to `"default"`. */
  namespace?: string;
  /** Token budget (must be > 0). */
  tokenBudget: number;
  /** Hard cap on items, mirroring `maxContextMemories`. */
  limit: number;
  /** Wire format. Defaults to `"json"`. */
  format?: AdapterPackFormat;
  /** Returned as `text` when the budget fits nothing at all. */
  emptyText: string;
}

/** Result of {@link buildBudgetedPack}. */
export interface BudgetedPackResult {
  /** Deterministic serialized payload, within `tokenBudget`. */
  text: string;
  /** The ranked, budget-trimmed items behind `text`. */
  items: ContextPackItem[];
  /** Estimated token cost of `text`. */
  tokens: number;
  /** The budget that was applied. */
  tokenBudget: number;
  /** Number of items dropped by the post-serialization re-trim. */
  trimmedForFraming: number;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize one pack item to minified JSON with a FIXED key order.
 *
 * `JSON.stringify` walks insertion order, so the object literal below is
 * the wire contract: reordering these fields would change the bytes for
 * every consumer with a cached prompt prefix. Compact (no indentation)
 * and free of the per-item `\n  ` the legacy pretty-printer paid for.
 */
function itemToJson(item: ContextPackItem): string {
  return (
    `{"id":${JSON.stringify(item.id)}` +
    `,"content":${JSON.stringify(item.content)}` +
    `,"summary":${JSON.stringify(item.summary)}` +
    `,"score":${item.score}` +
    `,"tags":${JSON.stringify(item.tags)}` +
    `,"trust":${JSON.stringify(item.trust)}` +
    `,"source":${JSON.stringify(item.source)}` +
    `,"updatedAt":${JSON.stringify(item.updatedAt)}}`
  );
}

/** Serialize a set of pack items in the requested wire format. */
function serializePack(
  pack: ContextPack,
  items: ContextPackItem[],
  format: AdapterPackFormat,
): string {
  if (format === "toon") return packToToon({ ...pack, items });
  if (format === "toon-compact") {
    return packToToonCompact({ ...pack, items });
  }
  return `[${items.map(itemToJson).join(",")}]`;
}

// ---------------------------------------------------------------------------
// Budget assembly
// ---------------------------------------------------------------------------

/**
 * Assemble memory context under a token budget and render it
 * deterministically.
 *
 * Never throws on an empty or irrelevant store: `text` falls back to
 * `emptyText` so callers keep a single well-defined empty payload.
 */
export async function buildBudgetedPack(
  memos: MemOS,
  request: BudgetedPackRequest,
): Promise<BudgetedPackResult> {
  const format = request.format ?? "json";
  const budget = Math.max(1, Math.floor(request.tokenBudget));

  const pack = (await memos.contextPack({
    query: request.query,
    namespace: request.namespace ?? "default",
    tokenBudget: budget,
    // `maxContextMemories` stays a hard cap on item count even when a
    // budget is set, so configuring both behaves as expected.
    limit: Math.max(1, Math.floor(request.limit)),
  })) as ContextPack;

  const items = pack.items ?? [];
  if (items.length === 0) {
    return {
      text: request.emptyText,
      items: [],
      tokens: estimateTokens(request.emptyText),
      tokenBudget: budget,
      trimmedForFraming: 0,
    };
  }

  // Re-trim against the serialized form. Items are already in rank order
  // and `buildContextPack` admitted them best-first, so walking from the
  // end and dropping until the payload fits is deterministic and only
  // ever removes the weakest contributors.
  const kept = items.slice();
  const initialText = serializePack(pack, kept, format);
  let text = initialText;
  let tokens = estimateTokens(text);
  let trimmedForFraming = 0;
  while (tokens > budget && kept.length > 1) {
    kept.pop();
    trimmedForFraming += 1;
    text = serializePack(pack, kept, format);
    tokens = estimateTokens(text);
  }

  // A single item that cannot fit on its own is still returned: dropping
  // the only relevant memory would lose the answer entirely, and the
  // budget is an allocation hint rather than a hard output truncation.
  // `tokens` therefore reports the real cost, over budget, so callers
  // can see it.
  return { text, items: kept, tokens, tokenBudget: budget, trimmedForFraming };
}

/**
 * Project a budgeted pack item onto the common adapter entry shape.
 *
 * Adapters with richer entry shapes (OpenAI/Anthropic carry `type` and
 * `trustScore`) extend this with their own projection; the pack schema
 * deliberately does not duplicate node fields that cost tokens to carry.
 */
export function packItemToEntry(item: ContextPackItem): {
  id: string;
  content: string;
  summary: string;
  score: number;
  tags: string[];
} {
  return {
    id: item.id,
    content: item.content,
    // `buildContextPack` elides a summary that restates its own content;
    // the entry shape has no `null`, so an elided summary renders empty.
    summary: item.summary ?? "",
    score: item.score,
    tags: [...item.tags],
  };
}
