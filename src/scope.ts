/**
 * Multi-scope memory — hierarchical namespace composition.
 *
 * Scopes are the promoted, first-class interface over raw namespaces.
 * A scope is a set of typed keys (`user` / `agent` / `run`) composed —
 * in that fixed order — into the underlying namespace string:
 *
 *   { user: "alice", agent: "coder", run: "r1" }
 *     → "u:alice/a:coder/r:r1"
 *
 * Because scopes map onto namespace strings, retrieval can be
 * hierarchical: querying with `{ user: "alice" }` (prefix match)
 * surfaces every memory stored under any of Alice's agents and runs,
 * while `{ user: "alice", run: "r1" }` narrows to one run. Exact
 * matching is available via `scopeMatch: "exact"`.
 *
 * @module @mem-os/scope
 */

import type { MemoryScope } from "./types.js";

const SCOPE_PREFIX: Array<{ key: keyof MemoryScope; tag: string }> = [
  { key: "user", tag: "u" },
  { key: "agent", tag: "a" },
  { key: "run", tag: "r" },
];

/** Compose a scope object into its canonical namespace string. */
export function composeScope(scope: MemoryScope): string {
  const parts: string[] = [];
  for (const { key, tag } of SCOPE_PREFIX) {
    const value = scope[key];
    if (value && String(value).trim()) {
      parts.push(`${tag}:${String(value).trim()}`);
    }
  }
  if (parts.length === 0) {
    throw new Error(
      "Empty scope — provide at least one of user, agent, or run.",
    );
  }
  return parts.join("/");
}

/**
 * Parse a CLI-scope string into a MemoryScope. Accepts both tag and long
 * forms, comma- or slash-separated:
 *   "user:alice,agent:coder" · "u:alice/a:coder/r:r1"
 */
export function parseScopeArg(value: string): MemoryScope {
  const scope: MemoryScope = {};
  const longNames: Record<string, keyof MemoryScope> = {
    u: "user",
    user: "user",
    a: "agent",
    agent: "agent",
    r: "run",
    run: "run",
  };
  for (const part of value.split(/[,/]/)) {
    const [rawKey, ...rest] = part.split(":");
    const rawValue = rest.join(":").trim();
    const key = rawKey.trim().toLowerCase();
    if (!rawValue) continue;
    const mapped = longNames[key];
    if (!mapped) {
      throw new Error(
        `Unknown scope key '${rawKey}'. Use user/agent/run (or u/a/r).`,
      );
    }
    scope[mapped] = rawValue;
  }
  return scope;
}

/** Escape LIKE wildcards so user values can't widen a prefix match. */
export function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
