/**
 * Document ingestion: turn a file or a folder into memories.
 *
 * Supports Markdown/text/CSV/JSON/HTML natively and PDF through `unpdf`
 * (pure JavaScript, no native build). Ingestion is incremental: a file whose
 * bytes have not changed is skipped, a changed file replaces its old chunks,
 * and a deleted file removes them.
 */

import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import type { MemOS } from "./memory.js";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".log",
  ".rst",
  ".json",
  ".jsonl",
  ".csv",
  ".tsv",
  ".yaml",
  ".yml",
]);

const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const PDF_EXTENSIONS = new Set([".pdf"]);

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  ".memos",
]);

export interface IngestOptions {
  /** Target namespace. Default `documents`. */
  namespace?: string;
  /** Extra tags applied to every chunk. */
  tags?: string[];
  /** Max characters per chunk. Default 1200. */
  chunkChars?: number;
  /** Characters repeated between adjacent chunks. Default 150. */
  overlapChars?: number;
  /** Skip files larger than this. Default 20 MB. */
  maxFileBytes?: number;
  /** Restrict to these extensions (with dot). Default: all supported. */
  extensions?: string[];
  /** Progress callback, useful for CLIs. */
  onProgress?: (event: IngestProgress) => void;
}

export interface IngestProgress {
  path: string;
  status: "added" | "updated" | "unchanged" | "removed" | "skipped" | "error";
  chunks?: number;
  error?: string;
}

export interface IngestResult {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  errors: number;
  chunks: number;
}

const EMPTY_RESULT = (): IngestResult => ({
  added: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  skipped: 0,
  errors: 0,
  chunks: 0,
});

export function isSupportedFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return (
    TEXT_EXTENSIONS.has(ext) ||
    HTML_EXTENSIONS.has(ext) ||
    PDF_EXTENSIONS.has(ext)
  );
}

/** Strip HTML to readable text without a DOM dependency. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi,
      "\n\n",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split text on paragraph boundaries, then cap each chunk and carry a small
 * overlap so a sentence split across chunks is still recoverable.
 */
export function chunkText(
  text: string,
  maxChars = 1200,
  overlapChars = 150,
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const body = current.trim();
    if (!body) return;
    chunks.push(body);
    current =
      overlapChars > 0 && body.length > overlapChars
        ? body.slice(-overlapChars).replace(/^\s+/, "")
        : "";
  };

  for (const paragraph of paragraphs) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if (current && current.length + piece.length + 2 > maxChars) flush();
    if (piece.length <= maxChars) {
      current = current ? `${current}\n\n${piece}` : piece;
      continue;
    }
    // A single huge paragraph: hard-split on sentence-ish boundaries.
    const sentences = piece.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        for (let i = 0; i < sentence.length; i += maxChars) {
          const slice = sentence.slice(i, i + maxChars);
          if (current && current.length + slice.length > maxChars) flush();
          current = current ? `${current} ${slice}` : slice;
          if (current.length >= maxChars) flush();
        }
        continue;
      }
      if (current && current.length + sentence.length + 1 > maxChars) flush();
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  flush();
  return chunks;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  try {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer), {
      mergePages: true,
    });
    const text = Array.isArray(result.text)
      ? result.text.join("\n")
      : result.text;
    return String(text ?? "");
  } catch (error) {
    throw new Error(
      `PDF extraction failed (${error instanceof Error ? error.message : String(error)}). ` +
        "Install the optional `unpdf` package to read PDFs.",
    );
  }
}

export async function extractFileText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  const buffer = await readFile(path);
  if (PDF_EXTENSIONS.has(ext)) return extractPdf(buffer);
  const raw = buffer.toString("utf8");
  if (HTML_EXTENSIONS.has(ext)) return htmlToText(raw);
  return raw;
}

interface FileEntry {
  absolute: string;
  relative: string;
  size: number;
}

async function collectFiles(
  root: string,
  options: IngestOptions,
): Promise<FileEntry[]> {
  const allowed = options.extensions
    ? new Set(options.extensions.map((ext) => ext.toLowerCase()))
    : null;
  const entries: FileEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    let items;
    try {
      items = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".") && item.isDirectory()) continue;
      const absolute = resolve(directory, item.name);
      if (item.isDirectory()) {
        if (SKIP_DIRECTORIES.has(item.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!item.isFile()) continue;
      const ext = extname(item.name).toLowerCase();
      if (allowed ? !allowed.has(ext) : !isSupportedFile(item.name)) continue;
      const info = await stat(absolute);
      if (info.size > (options.maxFileBytes ?? 20 * 1024 * 1024)) continue;
      entries.push({
        absolute,
        relative: relative(root, absolute).replace(/\\/g, "/"),
        size: info.size,
      });
    }
  };
  await walk(root);
  return entries;
}

function documentTag(relativePath: string): string {
  const hash = createHash("sha256")
    .update(relativePath)
    .digest("hex")
    .slice(0, 16);
  return `doc:${hash}`;
}

async function removeChunks(memos: MemOS, tag: string, namespace: string) {
  const nodes = await memos.listByTag(tag);
  let removed = 0;
  for (const node of nodes) {
    if (node.namespace !== namespace) continue;
    if (await memos.forget(node.id)) removed += 1;
  }
  return removed;
}

async function ingestOne(
  memos: MemOS,
  entry: FileEntry,
  options: IngestOptions,
  result: IngestResult,
): Promise<void> {
  const namespace = options.namespace ?? "documents";
  const tag = documentTag(entry.relative);
  try {
    const buffer = await readFile(entry.absolute);
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 32);
    const existing = (await memos.listByTag(tag)).filter(
      (node) => node.namespace === namespace,
    );
    if (existing.length > 0 && existing[0].metadata?.sourceHash === hash) {
      result.unchanged += 1;
      options.onProgress?.({ path: entry.relative, status: "unchanged" });
      return;
    }
    const text = await extractFileText(entry.absolute);
    const chunks = chunkText(
      text,
      options.chunkChars ?? 1200,
      options.overlapChars ?? 150,
    );
    if (chunks.length === 0) {
      result.skipped += 1;
      options.onProgress?.({ path: entry.relative, status: "skipped" });
      return;
    }
    const hadPrevious = existing.length > 0;
    if (hadPrevious) await removeChunks(memos, tag, namespace);
    for (let index = 0; index < chunks.length; index += 1) {
      await memos.store(chunks[index], {
        namespace,
        type: "fact",
        tags: [tag, "ingested", ...(options.tags ?? [])],
        metadata: {
          sourcePath: entry.relative,
          sourceHash: hash,
          chunkIndex: index,
          chunkCount: chunks.length,
          bytes: entry.size,
          ingestedAt: Date.now(),
        },
      });
    }
    result.chunks += chunks.length;
    if (hadPrevious) {
      result.updated += 1;
      options.onProgress?.({
        path: entry.relative,
        status: "updated",
        chunks: chunks.length,
      });
    } else {
      result.added += 1;
      options.onProgress?.({
        path: entry.relative,
        status: "added",
        chunks: chunks.length,
      });
    }
  } catch (error) {
    result.errors += 1;
    options.onProgress?.({
      path: entry.relative,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Remove chunks whose source file no longer exists on disk. */
async function sweepDeleted(
  memos: MemOS,
  root: string,
  options: IngestOptions,
  result: IngestResult,
): Promise<void> {
  const namespace = options.namespace ?? "documents";
  const nodes = (await memos.listByTag("ingested")).filter(
    (node) => node.namespace === namespace,
  );
  const known = new Map<string, string[]>();
  for (const node of nodes) {
    const source = String(node.metadata?.sourcePath ?? "");
    if (!source) continue;
    const bucket = known.get(source) ?? [];
    bucket.push(node.id);
    known.set(source, bucket);
  }
  for (const [source, ids] of known) {
    const absolute = resolve(root, source);
    let exists = true;
    try {
      await stat(absolute);
    } catch {
      exists = false;
    }
    if (!exists) {
      for (const id of ids) await memos.forget(id);
      result.removed += 1;
      options.onProgress?.({ path: source, status: "removed" });
    }
  }
}

export async function ingestPath(
  memos: MemOS,
  target: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const result = EMPTY_RESULT();
  const absolute = resolve(target);
  const info = await stat(absolute);
  if (info.isFile()) {
    const root = resolve(absolute, "..");
    await ingestOne(
      memos,
      {
        absolute,
        relative: relative(root, absolute).replace(/\\/g, "/"),
        size: info.size,
      },
      options,
      result,
    );
    return result;
  }
  const files = await collectFiles(absolute, options);
  for (const file of files) {
    await ingestOne(memos, file, options, result);
  }
  await sweepDeleted(memos, absolute, options, result);
  return result;
}

export interface WatchHandle {
  close: () => void;
}

/**
 * Ingest a folder, then keep it in sync. Changes are debounced per path so an
 * editor writing a file does not trigger several ingests.
 */
export async function watchPath(
  memos: MemOS,
  target: string,
  options: IngestOptions = {},
): Promise<WatchHandle> {
  const absolute = resolve(target);
  await ingestPath(memos, absolute, options);
  const pending = new Map<string, NodeJS.Timeout>();
  const watcher: FSWatcher = watch(
    absolute,
    { recursive: true },
    (event, file) => {
      if (!file) return;
      const path = String(file).replace(/\\/g, "/");
      if (!isSupportedFile(path)) return;
      const existing = pending.get(path);
      if (existing) clearTimeout(existing);
      pending.set(
        path,
        setTimeout(() => {
          pending.delete(path);
          void (async () => {
            const full = resolve(absolute, path);
            try {
              const info = await stat(full);
              if (info.isFile()) {
                await ingestOne(
                  memos,
                  { absolute: full, relative: path, size: info.size },
                  options,
                  EMPTY_RESULT(),
                );
              }
            } catch {
              // Deleted: let the sweep handle it on the next change.
              const result = EMPTY_RESULT();
              await sweepDeleted(memos, absolute, options, result);
            }
          })();
        }, 300),
      );
    },
  );
  return {
    close: () => {
      for (const timer of pending.values()) clearTimeout(timer);
      watcher.close();
    },
  };
}
