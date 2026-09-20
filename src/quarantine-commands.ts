/**
 * Testable CLI command logic for the quarantine review queue.
 *
 * The CLI dispatches `memos quarantine list|release` through these
 * helpers so the output format is asserted in unit tests rather than
 * through awkward subprocess runs.
 */

import type { MemOS } from "./memory.js";
import type { MemoryNode } from "./types.js";

/**
 * Render the quarantine review queue. JSON mode emits the raw nodes;
 * human mode prints one line per memory: `[mem:hex]`-style short id,
 * quarantine reason, and the first ~120 chars of content.
 */
export function formatQuarantineList(
  nodes: MemoryNode[],
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(nodes, null, 2);
  }
  if (nodes.length === 0) {
    return "Quarantine queue is empty.";
  }
  return nodes
    .map((n) => {
      const preview =
        n.content.length > 120 ? `${n.content.slice(0, 117)}...` : n.content;
      const reason = n.quarantineReason ?? "unspecified";
      return `[${n.id.slice(0, 8)}] (${n.provenance}) reason=${reason}: ${preview}`;
    })
    .join("\n");
}

/**
 * Release a memory from quarantine and render the result. JSON mode
 * emits the updated node; human mode confirms the release while
 * reminding the operator that the memory keeps its low-trust marking
 * for agent consumption.
 */
export async function releaseQuarantined(
  memos: MemOS,
  id: string,
  json: boolean,
): Promise<string> {
  const node = await memos.releaseFromQuarantine(id);
  if (json) {
    return JSON.stringify(node, null, 2);
  }
  return (
    `Released ${id.slice(0, 8)} from quarantine.` +
    " It is recallable again; agent tools still see it as untrusted until a reviewer promotes its provenance tier."
  );
}
