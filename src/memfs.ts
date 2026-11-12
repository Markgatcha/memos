/**
 * MemFS: a stable, human-browsable filesystem view of memory.
 *
 * The existing `export()` writes flat `<id>.md` files and is one-way; the
 * Markdown importer re-stores every file as a new memory. MemFS is the
 * bidirectional counterpart: a deterministic nested tree plus a manifest of
 * content hashes, so a sync can tell "memory changed" from "file changed"
 * instead of guessing.
 *
 * This module is storage-free. Filesystem I/O and manifest handling live
 * here; `memory.ts` owns the store/update/forget calls.
 *
 * @module @mem-os/sdk/memfs
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { MemoryNode, MemoryType } from "./types.js";

/** Manifest filename written at the root of a MemFS tree. */
export const MEMFS_MANIFEST_FILENAME = ".memfs-manifest.json";

/** One tracked memory file. */
export interface MemFSFileEntry {
  id: string;
  /** Relative path using POSIX separators. */
  path: string;
  /** SHA-256 of the file text at the last sync. */
  hash: string;
  /** Memory `updatedAt` at the last sync, used to detect memory-side edits. */
  memoryUpdatedAt: number;
}

/** On-disk manifest for one MemFS root. */
export interface MemFSManifest {
  version: 1;
  syncedAt: number;
  files: Record<string, MemFSFileEntry>;
}

/** Conflict policy when both the file and the memory changed since last sync. */
export type MemFSConflictPolicy = "memory" | "file" | "skip";

/** Options for a MemFS sync. */
export interface MemFSSyncOptions {
  /** Only export memories in this namespace. */
  namespace?: string;
  /** Delete memories whose files were removed. Default false. */
  prune?: boolean;
  /**
   * Which side wins when both changed since the last sync.
   * Default `"memory"` (the store is the source of truth) and the edited
   * file is kept as a `.conflict-<timestamp>.md` backup.
   */
  conflict?: MemFSConflictPolicy;
}

/** Counts returned by export/sync. */
export interface MemFSSyncStats {
  /** Files written from memory. */
  written: number;
  /** Memories updated from edited files. */
  updated: number;
  /** Memories created from new files. */
  created: number;
  /** Memories deleted because their file was removed and `prune` was set. */
  deleted: number;
  /** Files that matched the manifest and needed no work. */
  skipped: number;
  /** File-vs-memory conflicts detected. */
  conflicts: number;
  /** Relative paths of conflicting files. */
  conflictPaths: string[];
  /** Non-fatal per-file errors. */
  errors: string[];
}

/** A read-only summary of what a sync would do. */
export interface MemFSStatus {
  tracked: number;
  files: number;
  pendingWrites: number;
  pendingCreates: number;
  pendingUpdates: number;
  pendingDeletes: number;
  conflicts: number;
}

/** Empty stats object. */
export function emptyMemFSSyncStats(): MemFSSyncStats {
  return {
    written: 0,
    updated: 0,
    created: 0,
    deleted: 0,
    skipped: 0,
    conflicts: 0,
    conflictPaths: [],
    errors: [],
  };
}

const MEMORY_TYPES: ReadonlySet<string> = new Set<MemoryType>([
  "fact",
  "preference",
  "context",
  "relationship",
  "entity",
  "custom",
]);

/** Coerce a frontmatter `type` into a MemoryType. */
export function coerceMemoryType(value: string | null | undefined): MemoryType {
  const normalized = (value ?? "").trim().toLowerCase();
  return MEMORY_TYPES.has(normalized) ? (normalized as MemoryType) : "fact";
}

/** Make one path segment safe on Windows and POSIX. */
export function sanitizeMemFSSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Deterministic tree path for a memory: namespace/YYYY/MM/slug-id.md. */
export function memfsRelativePath(node: MemoryNode): string {
  const namespace =
    sanitizeMemFSSegment(node.namespace || "default") || "default";
  const created = new Date(
    Number.isFinite(node.createdAt) ? node.createdAt : Date.now(),
  );
  const year = String(created.getUTCFullYear());
  const month = String(created.getUTCMonth() + 1).padStart(2, "0");
  const slugSource = node.summary?.trim() || node.content.trim().slice(0, 60);
  const slug = sanitizeMemFSSegment(slugSource) || "memory";
  return `${namespace}/${year}/${month}/${slug}-${node.id}.md`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** Render one memory as Markdown with YAML frontmatter. */
export function serializeMemFSNode(node: MemoryNode): string {
  const lines: string[] = ["---"];
  lines.push(`id: ${node.id}`);
  lines.push(`namespace: ${quote(node.namespace || "default")}`);
  lines.push(`type: ${node.type}`);
  lines.push(`tags: [${node.tags.map(quote).join(", ")}]`);
  lines.push(`created: ${new Date(node.createdAt).toISOString()}`);
  lines.push(`updated: ${new Date(node.updatedAt).toISOString()}`);
  if (typeof node.importance === "number") {
    lines.push(`importance: ${node.importance}`);
  }
  if (typeof node.trustScore === "number") {
    lines.push(`trust: ${node.trustScore}`);
  }
  if (node.provenance) lines.push(`provenance: ${node.provenance}`);
  if (node.source) lines.push(`source: ${quote(node.source)}`);
  if (node.harness) lines.push(`harness: ${quote(node.harness)}`);
  if (node.expiresAt !== null && node.expiresAt !== undefined) {
    lines.push(`expires: ${new Date(node.expiresAt * 1000).toISOString()}`);
  }
  if (node.validFrom !== null && node.validFrom !== undefined) {
    lines.push(`valid_from: ${new Date(node.validFrom).toISOString()}`);
  }
  if (node.validTo !== null && node.validTo !== undefined) {
    lines.push(`valid_to: ${new Date(node.validTo).toISOString()}`);
  }
  lines.push("---", "", node.content.trim(), "");
  return lines.join("\n");
}

/** Parsed MemFS file. */
export interface ParsedMemFSFile {
  id: string | null;
  namespace: string | null;
  type: string | null;
  tags: string[];
  created: string | null;
  updated: string | null;
  content: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Split a frontmatter tag list on commas that are not inside quotes, so
 * tags containing commas survive a round-trip.
 */
function splitTagList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoteChar: string | null = null;
  for (const char of value) {
    if (quoteChar) {
      current += char;
      if (char === quoteChar) quoteChar = null;
    } else if (char === '"' || char === "'") {
      current += char;
      quoteChar = char;
    } else if (char === ",") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out.map(unquote).filter((tag) => tag.length > 0);
}

/** Parse frontmatter and body from a MemFS file. */
export function parseMemFSFile(text: string): ParsedMemFSFile {
  const lines = text.split(/\r?\n/);
  const out: ParsedMemFSFile = {
    id: null,
    namespace: null,
    type: null,
    tags: [],
    created: null,
    updated: null,
    content: "",
  };
  if (lines[0]?.trim() !== "---") {
    out.content = text.trim();
    return out;
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    out.content = text.trim();
    return out;
  }

  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case "id":
        out.id = unquote(value) || null;
        break;
      case "namespace":
        out.namespace = unquote(value) || null;
        break;
      case "type":
        out.type = unquote(value) || null;
        break;
      case "tags": {
        const match = value.match(/^\[(.*)\]$/);
        if (match) {
          out.tags = splitTagList(match[1]);
        }
        break;
      }
      case "created":
        out.created = unquote(value) || null;
        break;
      case "updated":
        out.updated = unquote(value) || null;
        break;
      default:
        break;
    }
  }

  out.content = lines
    .slice(end + 1)
    .join("\n")
    .trim();
  return out;
}

/** SHA-256 of file text, used for change detection. */
export function hashMemFSContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function manifestPath(root: string): string {
  return join(root, MEMFS_MANIFEST_FILENAME);
}

/** Read a manifest, returning an empty one when missing or malformed. */
export function readMemFSManifest(root: string): MemFSManifest {
  const path = manifestPath(root);
  if (!existsSync(path)) {
    return { version: 1, syncedAt: 0, files: {} };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<MemFSManifest>;
    if (
      parsed.version !== 1 ||
      typeof parsed.files !== "object" ||
      parsed.files === null
    ) {
      return { version: 1, syncedAt: 0, files: {} };
    }
    return {
      version: 1,
      syncedAt: typeof parsed.syncedAt === "number" ? parsed.syncedAt : 0,
      files: parsed.files as Record<string, MemFSFileEntry>,
    };
  } catch {
    return { version: 1, syncedAt: 0, files: {} };
  }
}

/** Atomically write the manifest. */
export function writeMemFSManifest(
  root: string,
  manifest: MemFSManifest,
): void {
  mkdirSync(root, { recursive: true });
  const path = manifestPath(root);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** True for conflict backups written by a "memory wins" resolution. */
export function isMemFSConflictBackup(relativePath: string): boolean {
  return /\.conflict-\d+\.md$/i.test(relativePath);
}

function walk(root: string, prefix: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(root, relative, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(relative);
    }
  }
}

/** List every `.md` file under `root` as POSIX-separated relative paths. */
export function listMemFSFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  walk(root, "", out);
  return out.filter((relative) => !isMemFSConflictBackup(relative)).sort();
}

/** Filesystem path for a POSIX-relative MemFS path. */
export function memfsAbsolutePath(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

/** Write a file, creating parent directories. */
export function writeMemFSFile(
  root: string,
  relative: string,
  text: string,
): void {
  const abs = memfsAbsolutePath(root, relative);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

/** Convert a native path to the manifest's POSIX form. */
export function toMemFSPath(nativePath: string): string {
  return nativePath.split(sep).join("/");
}
