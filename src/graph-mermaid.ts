/**
 * Render a memory graph snapshot as a Mermaid flowchart.
 *
 * Shared by the CLI (`memos graph --mermaid`) and the MCP server
 * (`memos://graph` resource) so both emit identical, GitHub-renderable
 * diagrams. Node labels are sanitized for Mermaid's `["..."]` syntax and
 * ids are rewritten to guaranteed-valid, collision-free identifiers.
 *
 * @module @mem-os/graph-mermaid
 */

import type { GraphSnapshot } from "./types.js";

export function graphToMermaid(graph: GraphSnapshot): string {
  const mermaidIds = new Map<string, string>();
  const lines: string[] = ["graph TD"];

  graph.nodes.forEach((node, i) => {
    const safe = `m${i}_${node.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8)}`;
    mermaidIds.set(node.id, safe);
    const label = `${node.type}: ${node.content.slice(0, 60)}`
      .replace(/"/g, "'")
      .replace(/[[\]{}()<>]/g, "");
    lines.push(`  ${safe}["${label}"]`);
  });

  for (const edge of graph.edges) {
    const source = mermaidIds.get(edge.sourceId);
    const target = mermaidIds.get(edge.targetId);
    if (!source || !target) continue;
    const relation = edge.relation.replace(/[^\w-]/g, "_") || "related";
    lines.push(`  ${source} -->|${relation}| ${target}`);
  }

  return lines.join("\n");
}
