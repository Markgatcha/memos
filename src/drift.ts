/**
 * Source drift detection.
 *
 * A memory written from a file keeps `metadata.sourcePath` and
 * `metadata.sourceHash` (see `ingest.ts`). If the file changes later, the
 * stored claim silently becomes stale — the classic "the docs moved, the
 * agent didn't" failure.
 *
 * This module hashes the current file and compares it with the recorded
 * hash. It is local-only: HTTP(S) sources are reported as unsupported
 * rather than fetched, because a memory layer should not make surprise
 * network calls.
 *
 * @module @mem-os/sdk/drift
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryNode } from "./types.js";

/** Outcome of checking one source. */
export type DriftStatus =
  "unchanged" | "drifted" | "missing" | "unreadable" | "unsupported";

/** One source and every memory derived from it. */
export interface DriftFinding {
  source: string;
  status: DriftStatus;
  memoryIds: string[];
  expectedHash?: string;
  actualHash?: string;
  error?: string;
}

/** Aggregate drift scan result. */
export interface DriftReport {
  checkedAt: number;
  /** Memories that carry a source reference. */
  scanned: number;
  /** Distinct sources checked. */
  sources: number;
  unchanged: number;
  drifted: number;
  missing: number;
  unreadable: number;
  unsupported: number;
  findings: DriftFinding[];
}

/** Empty report with zeroed counters. */
export function emptyDriftReport(checkedAt = Date.now()): DriftReport {
  return {
    checkedAt,
    scanned: 0,
    sources: 0,
    unchanged: 0,
    drifted: 0,
    missing: 0,
    unreadable: 0,
    unsupported: 0,
    findings: [],
  };
}

/**
 * Hash file bytes exactly the way `ingest.ts` does: SHA-256, first 32 hex
 * characters. Keeping the two in sync is what makes the comparison valid.
 */
export function hashSourceBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** Extract a source reference from memory metadata. */
export function sourceOf(node: MemoryNode): string | null {
  const metadata = node.metadata ?? {};
  const path = metadata.sourcePath;
  if (typeof path === "string" && path.trim().length > 0) return path.trim();
  const url = metadata.url;
  if (typeof url === "string" && url.trim().length > 0) return url.trim();
  const source = metadata.source;
  if (typeof source === "string" && source.trim().length > 0) {
    return source.trim();
  }
  return null;
}

/** True when the source is a local path or `file://` URL. */
export function isLocalSource(source: string): boolean {
  if (source.startsWith("file://")) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return false;
  return true;
}

/** Resolve a source reference to a filesystem path. */
export function resolveSourcePath(source: string, root: string): string {
  if (source.startsWith("file://")) return fileURLToPath(source);
  return isAbsolute(source) ? source : join(root, source);
}

/** Hash recorded on the node, if any. */
export function expectedSourceHash(node: MemoryNode): string | null {
  const value = node.metadata?.sourceHash;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Count one finding into a report. */
export function addDriftFinding(
  report: DriftReport,
  finding: DriftFinding,
): void {
  report.sources += 1;
  report.findings.push(finding);
  switch (finding.status) {
    case "unchanged":
      report.unchanged += 1;
      break;
    case "drifted":
      report.drifted += 1;
      break;
    case "missing":
      report.missing += 1;
      break;
    case "unreadable":
      report.unreadable += 1;
      break;
    case "unsupported":
      report.unsupported += 1;
      break;
  }
}

/**
 * Check one source. Exported for callers that manage their own batching.
 */
export async function checkSource(
  source: string,
  nodes: MemoryNode[],
  root: string,
): Promise<DriftFinding> {
  const memoryIds = nodes.map((node) => node.id);
  if (!isLocalSource(source)) {
    return {
      source,
      status: "unsupported",
      memoryIds,
      error: "remote sources are not fetched",
    };
  }

  const expected =
    nodes
      .map(expectedSourceHash)
      .find((hash): hash is string => hash !== null) ?? undefined;

  let bytes: Buffer;
  try {
    bytes = await readFile(resolveSourcePath(source, root));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      source,
      status: code === "ENOENT" ? "missing" : "unreadable",
      memoryIds,
      expectedHash: expected,
      error: code ?? String(error),
    };
  }

  const actual = hashSourceBytes(bytes);
  if (!expected) {
    return {
      source,
      status: "unsupported",
      memoryIds,
      actualHash: actual,
      error: "no sourceHash recorded on the memory",
    };
  }

  return {
    source,
    status: expected === actual ? "unchanged" : "drifted",
    memoryIds,
    expectedHash: expected,
    actualHash: actual,
  };
}

/** Render a report as text for the CLI. */
export function formatDriftReport(
  report: DriftReport,
  opts: { all?: boolean } = {},
): string {
  const lines: string[] = [
    `Drift scan: ${report.sources} source(s), ${report.scanned} memory(s)`,
    `  unchanged ${report.unchanged}  drifted ${report.drifted}  missing ${report.missing}  unreadable ${report.unreadable}  unsupported ${report.unsupported}`,
  ];
  const interesting = report.findings.filter(
    (finding) => opts.all || finding.status !== "unchanged",
  );
  for (const finding of interesting) {
    const detail =
      finding.status === "drifted"
        ? ` (${finding.expectedHash} -> ${finding.actualHash})`
        : finding.error
          ? ` (${finding.error})`
          : "";
    lines.push(
      `  [${finding.status}] ${finding.source}${detail} - ${finding.memoryIds.length} memory(s)`,
    );
  }
  return lines.join("\n");
}
