/**
 * Auditable memory reports.
 *
 * MemOS already has the primitives a compliance reviewer asks for: a
 * hash-chained tamper log, provenance tiers, quarantine, point-in-time
 * history, deletion certificates, and semantic-search health. This module
 * assembles them into one reviewable artifact instead of leaving the user to
 * run five commands and join the output by hand.
 */

import type {
  EmbeddingHealth,
  MemoryHealth,
  MemoryNode,
  TamperLogEntry,
} from "./types.js";
import type { TamperVerifyResult } from "./tamper-log.js";
import {
  createDeletionCertificate,
  type DeletionCertificate,
} from "./proof-of-forgetting.js";
import { redactSecrets } from "./redact.js";

export interface AuditOptions {
  /** Optional externally recorded tamper-log tip to prove no truncation. */
  expectTip?: string;
  /** Max quarantine/deletion rows to include. Default 100. */
  limit?: number;
}

export interface AuditReport {
  schema: "memos.audit.v1";
  generatedAt: number;
  /** True when the tamper chain verifies and no critical issue was found. */
  ok: boolean;
  tamper: TamperVerifyResult & {
    /** True when `expectTip` was supplied and matched. */
    externallyAnchored: boolean;
  };
  counts: {
    totalNodes: number;
    activeNodes: number;
    historicalNodes: number;
    quarantinedNodes: number;
    byProvenance: Record<string, number>;
    bySource: Record<string, number>;
    byHarness: Record<string, number>;
  };
  quarantine: Array<{
    id: string;
    preview: string;
    reason: string | null;
    quarantinedAt: number | null;
    provenance: string;
    trustScore: number;
  }>;
  deletions: DeletionCertificate[];
  contradictions: { unresolved: number | null };
  embeddingHealth: EmbeddingHealth;
  recommendations: string[];
}

export interface BuildAuditInput {
  generatedAt?: number;
  nodes: MemoryNode[];
  tamper: TamperVerifyResult;
  tamperLog: TamperLogEntry[];
  quarantine: MemoryNode[];
  health: MemoryHealth;
  expectTip?: string;
  limit?: number;
}

export function buildAuditReport(input: BuildAuditInput): AuditReport {
  const limit = Math.max(1, input.limit ?? 100);
  const now = input.generatedAt ?? Date.now();
  const nodes = input.nodes;
  const historical = nodes.filter(
    (node) => node.validTo !== null && node.validTo <= now,
  ).length;
  const active = nodes.filter(
    (node) =>
      !node.quarantined && !(node.validTo !== null && node.validTo <= now),
  ).length;

  const byProvenance: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byHarness: Record<string, number> = {};
  for (const node of nodes) {
    byProvenance[node.provenance] = (byProvenance[node.provenance] ?? 0) + 1;
    bySource[node.source] = (bySource[node.source] ?? 0) + 1;
    const harness = node.harness ?? "unknown";
    byHarness[String(harness)] = (byHarness[String(harness)] ?? 0) + 1;
  }

  const deletions = input.tamperLog
    .filter((entry) => entry.op === "forget")
    .slice(-limit)
    .map((entry) => createDeletionCertificate(entry))
    .filter((cert): cert is DeletionCertificate => cert !== null);

  const externallyAnchored =
    input.expectTip !== undefined && input.expectTip === input.tamper.tipHash;

  const recommendations: string[] = [];
  if (!input.tamper.supported) {
    recommendations.push(
      "This storage adapter does not expose the tamper-evident log, so the audit cannot verify the mutation chain.",
    );
  }
  if (!input.tamper.ok) {
    recommendations.push(
      "The tamper chain did not verify. Preserve the database and investigate the reported entries before writing more memories.",
    );
  }
  if (input.expectTip && !externallyAnchored) {
    recommendations.push(
      "The externally recorded tip does not match the current log tip. The log may have been truncated or a different checkpoint was supplied.",
    );
  }
  if (input.health.metrics.unresolvedContradictions) {
    recommendations.push(
      `${input.health.metrics.unresolvedContradictions} contradiction pair(s) are unresolved; supersede or revert the outdated version.`,
    );
  }
  if (input.quarantine.length > 0) {
    recommendations.push(
      `${input.quarantine.length} memory(s) are quarantined. Review with \`memos quarantine list\` and release only after verifying the source.`,
    );
  }
  if (input.health.embeddingHealth.status === "degraded") {
    recommendations.push(
      input.health.embeddingHealth.fix ?? "Semantic search is degraded.",
    );
  }
  if (!input.expectTip) {
    recommendations.push(
      "Record the current tip hash outside this machine (`memos audit --json | jq -r .tamper.tipHash`) to make future truncation detectable.",
    );
  }

  return {
    schema: "memos.audit.v1",
    generatedAt: now,
    ok: input.tamper.supported && input.tamper.ok,
    tamper: { ...input.tamper, externallyAnchored },
    counts: {
      totalNodes: nodes.length,
      activeNodes: active,
      historicalNodes: historical,
      quarantinedNodes: input.quarantine.length,
      byProvenance,
      bySource,
      byHarness,
    },
    quarantine: input.quarantine.slice(0, limit).map((node) => ({
      id: node.id,
      preview: redactSecrets(node.content).slice(0, 160),
      reason: node.quarantineReason,
      quarantinedAt: node.quarantinedAt,
      provenance: node.provenance,
      trustScore: node.trustScore,
    })),
    deletions,
    contradictions: {
      unresolved: input.health.metrics.unresolvedContradictions,
    },
    embeddingHealth: input.health.embeddingHealth,
    recommendations,
  };
}

export function renderAuditMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const status = !report.tamper.supported
    ? "UNSUPPORTED"
    : report.ok
      ? "OK"
      : "FAILED";
  lines.push(`# MemOS audit — ${status}`);
  lines.push("");
  lines.push(`Generated: ${new Date(report.generatedAt).toISOString()}`);
  lines.push(
    `Tamper chain: ${report.tamper.entriesChecked} entries checked, ` +
      `${report.tamper.issues.length} issue(s), tip ${report.tamper.tipHash ?? "none"}`,
  );
  lines.push(
    `External anchor: ${report.tamper.externallyAnchored ? "verified" : "not supplied"}`,
  );
  lines.push("");
  lines.push("## Store");
  lines.push(
    `- ${report.counts.totalNodes} nodes: ${report.counts.activeNodes} active, ` +
      `${report.counts.historicalNodes} historical, ${report.counts.quarantinedNodes} quarantined`,
  );
  lines.push(`- provenance: ${formatCounts(report.counts.byProvenance)}`);
  lines.push(`- source: ${formatCounts(report.counts.bySource)}`);
  lines.push(`- harness: ${formatCounts(report.counts.byHarness)}`);
  lines.push(
    `- semantic search: ${report.embeddingHealth.status} — ${report.embeddingHealth.message}`,
  );
  lines.push(
    `- unresolved contradictions: ${report.contradictions.unresolved ?? "unknown"}`,
  );
  lines.push("");

  if (report.tamper.issues.length > 0) {
    lines.push("## Tamper issues");
    for (const issue of report.tamper.issues.slice(0, 20)) {
      lines.push(`- ${issue.kind}: ${issue.detail}`);
    }
    lines.push("");
  }

  if (report.quarantine.length > 0) {
    lines.push("## Quarantine");
    for (const row of report.quarantine) {
      lines.push(
        `- ${row.id.slice(0, 8)} (${row.provenance}, trust ${row.trustScore.toFixed(2)}): ${row.preview}`,
      );
      if (row.reason) lines.push(`  reason: ${row.reason}`);
    }
    lines.push("");
  }

  if (report.deletions.length > 0) {
    lines.push("## Deletion certificates");
    for (const cert of report.deletions.slice(-20)) {
      lines.push(
        `- ${cert.nodeId.slice(0, 8)} at ${new Date(cert.deletedAt).toISOString()} ` +
          `(seq ${cert.tamperSeq}, hash ${cert.contentHash.slice(0, 12)}…)`,
      );
    }
    lines.push("");
  }

  if (report.recommendations.length > 0) {
    lines.push("## Recommendations");
    for (const recommendation of report.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  return lines.join("\n").trim();
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key}=${value}`).join(", ");
}
