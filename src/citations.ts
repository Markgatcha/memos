/**
 * Memory-grounded citations.
 *
 * Every memory injected into a context pack can carry a citable token
 * like `[mem:a3f9]`: short enough to quote in an agent's answer, stable
 * enough to trace back to the full source memory. `resolveCitation`
 * (on `MemOS`) turns a token back into the memory — its text,
 * timestamps, source, and tags — and `memos cite <id>` exposes the same
 * lookup on the CLI.
 *
 * Token scheme: `mem:` + the first 4 hex chars of the node id (dashes
 * stripped, lowercase). Four chars keeps citations cheap in the prompt;
 * when two pack items would collide, the pack renderer lengthens the
 * colliding tokens until they are unique *within the pack* (git-style).
 * Globally, `resolveCitation` prefix-matches the token against stored
 * ids and reports `ambiguous` with the candidate list instead of
 * guessing when a short token matches more than one memory.
 *
 * @module @mem-os/citations
 */

import type { MemoryNode } from "./types.js";

/** Minimum/maximum hex length accepted in a citation token. */
export const CITATION_MIN_HEX = 4;
export const CITATION_MAX_HEX = 32;

/**
 * The citable short id for a memory: first 4 hex chars of the node id
 * (dashes stripped, lowercase). Non-hex ids fall back to the first 4
 * characters as-is.
 */
export function shortCitationId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]+$/.test(hex)) return hex.slice(0, CITATION_MIN_HEX);
  return id.slice(0, CITATION_MIN_HEX);
}

/** Render the citation token for a memory id, e.g. `[mem:a3f9]`. */
export function citationToken(id: string): string {
  return `[mem:${shortCitationId(id)}]`;
}

/** Render a citation token with an explicit hex body (pack renderer). */
export function citationTokenForHex(hex: string): string {
  return `[mem:${hex.toLowerCase()}]`;
}

/**
 * Normalize user input to a hex prefix: accepts `[mem:a3f9]`, bare
 * `a3f9`, a full dashed uuid, or a dashless id. Returns null when the
 * input carries no usable hex.
 */
export function parseCitationToken(input: string): string | null {
  let text = input.trim();
  const wrapped = /^\[mem:([0-9a-fA-F]+)\]$/.exec(text);
  if (wrapped) text = wrapped[1]!;
  const hex = text.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  if (hex.length < 2 || hex.length > CITATION_MAX_HEX) return null;
  return hex;
}

/** Outcome of tracing a citation token back to its source memory. */
export type CitationResolution =
  | { status: "resolved"; token: string; memory: MemoryNode }
  | { status: "not_found"; token: string }
  | {
      status: "ambiguous";
      token: string;
      candidates: MemoryNode[];
    };

/**
 * Assign citation tokens to pack items, unique within the pack.
 * Tokens start at 4 hex chars and lengthen (git-style) only for items
 * that would otherwise collide.
 */
export function assignCitationTokens(ids: string[]): Map<string, string> {
  const normalized = ids.map((id) => id.replace(/-/g, "").toLowerCase());
  let length = CITATION_MIN_HEX;
  for (;;) {
    const seen = new Map<string, number>();
    for (const n of normalized) {
      const key = n.slice(0, length);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const unique = [...seen.values()].every((c) => c === 1);
    if (unique || length >= CITATION_MAX_HEX) break;
    length += 1;
  }
  const tokens = new Map<string, string>();
  ids.forEach((id, i) => {
    tokens.set(id, citationTokenForHex(normalized[i]!.slice(0, length)));
  });
  return tokens;
}

/**
 * Render a citation resolution exactly as the `memos cite` CLI prints
 * it (shared so tests assert on the real output bytes).
 */
export function formatCitationResolution(
  resolution: CitationResolution,
  asJson: boolean = false,
): string {
  if (asJson) {
    return JSON.stringify(
      resolution.status === "resolved"
        ? {
            status: resolution.status,
            token: resolution.token,
            memory: resolution.memory,
          }
        : resolution.status === "ambiguous"
          ? {
              status: resolution.status,
              token: resolution.token,
              candidates: resolution.candidates.map((c) => ({
                id: c.id,
                token: citationToken(c.id),
                content: c.content,
              })),
            }
          : { status: resolution.status, token: resolution.token },
      null,
      2,
    );
  }
  if (resolution.status === "not_found") {
    return `No memory found for citation ${resolution.token}.`;
  }
  if (resolution.status === "ambiguous") {
    const lines = [
      `Citation ${resolution.token} is ambiguous — ${resolution.candidates.length} memories share the prefix:`,
    ];
    for (const c of resolution.candidates) {
      lines.push(`  ${citationToken(c.id)}  ${c.id}`);
      lines.push(`    ${oneLine(c.content, 120)}`);
    }
    lines.push(`Use a longer token (more hex chars) to disambiguate.`);
    return lines.join("\n");
  }
  const m = resolution.memory;
  const lines = [
    `${resolution.token} → ${m.id}`,
    ``,
    m.content,
    ``,
    `Type: ${m.type}  Source: ${m.source}  Trust: ${m.trustScore}`,
    `Tags: ${m.tags.length > 0 ? m.tags.join(", ") : "(none)"}`,
    `Created: ${new Date(m.createdAt).toISOString()}`,
    `Updated: ${new Date(m.updatedAt).toISOString()}`,
    `Namespace: ${m.namespace}`,
  ];
  return lines.join("\n");
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
