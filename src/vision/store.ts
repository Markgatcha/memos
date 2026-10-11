/**
 * Content-addressed blob store for image memories.
 *
 * Image bytes never go into SQLite. A 400 KB JPEG dragged through the
 * WAL, the encrypted-sync channel, and the tamper-log hash chain would
 * cost far more than the bytes are worth — all three are tuned for small
 * text rows. Instead the DB stores a reference (`img_<sha256[0:12]>`)
 * and the file lives in a sibling directory next to the database.
 *
 * Content addressing gives three properties for free:
 * - **Dedupe:** identical bytes stored twice cost one file. The write
 *   path hashes before creating a node, so a repeated image produces a
 *   single blob and (in the same namespace) a single node.
 * - **Integrity:** the ref is derived from the digest, so a truncated
 *   or corrupted file is detectable by re-hashing.
 * - **Portability:** the root is derived from the database path, so a
 *   store moves as a unit.
 *
 * Dependency-free by design — MemOS carries only three runtime deps and
 * prizes that, so image dimensions are read straight from the PNG IHDR
 * and JPEG SOFn headers rather than pulling in an image library. WebP
 * and GIF report `0x0` dimensions rather than failing: the dimensions
 * are used for prompt context, not for correctness.
 *
 * @module @memos/vision/store
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ImageInput, ImageKind } from "../types.js";

/** Prefix for every content-addressed image reference. */
const REF_PREFIX = "img_";

/** Number of hex digest characters used in a ref (12 = 48 bits). */
const REF_HASH_LENGTH = 12;

/**
 * Accepted image MIME types. An unknown type is rejected at the write
 * path (fail-closed: no node is created) rather than stored with a
 * guess — a mislabeled blob is worse than a rejected write.
 */
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Magic-number signatures for the accepted formats. */
const MIME_SIGNATURES: Array<{
  mime: string;
  bytes: number[];
  offset?: number;
}> = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    mime: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  // JPEG: FF D8 FF
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  // GIF: "GIF87a" / "GIF89a"
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: "RIFF" .... "WEBP"
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** File extension per accepted MIME type. */
const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Thrown when image bytes are rejected before anything is persisted.
 * Fail-closed: the caller must not write a node when this is thrown.
 */
export class ImageRejectedError extends Error {
  constructor(
    message: string,
    readonly kind: "mime" | "size" | "empty",
  ) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

/** What a stored image looks like once written. */
export interface StoredImage {
  /** Content-addressed key, `img_<sha256[0:12]>`. */
  ref: string;
  /** Absolute path of the blob file. */
  path: string;
  /** Full hex digest of the bytes. */
  sha256: string;
  /** Detected pixel width, or 0 when the header could not be parsed. */
  width: number;
  /** Detected pixel height, or 0 when the header could not be parsed. */
  height: number;
  /** Size of the stored blob in bytes. */
  bytes: number;
  /** Sniffed MIME type. */
  mime: string;
}

/** Derive the blob-store root from a database path (`<dbDir>/memos-images`). */
export function blobRoot(dbPath: string): string {
  // The DB path's directory is the anchor so a store moves as a unit.
  const lastSlash = Math.max(dbPath.lastIndexOf("/"), dbPath.lastIndexOf("\\"));
  const dir = lastSlash >= 0 ? dbPath.slice(0, lastSlash) : ".";
  return join(dir, "memos-images");
}

/** Build the content-addressed ref for a digest. */
export function refFor(sha256: string): string {
  return REF_PREFIX + sha256.slice(0, REF_HASH_LENGTH);
}

/**
 * Detect the MIME type from magic bytes rather than trusting the
 * caller's declared type — a `.png` name on JPEG bytes would otherwise
 * be stored and later mis-decoded by a vision model.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  for (const sig of MIME_SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (bytes.length < offset + sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (bytes[offset + i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    // WebP needs the trailing "WEBP" fourcc at offset 8 to disambiguate
    // from other RIFF containers.
    if (sig.mime === "image/webp") {
      if (bytes.length < 12) return null;
      const fourcc = [bytes[8], bytes[9], bytes[10], bytes[11]]
        .map((b) => String.fromCharCode(b))
        .join("");
      if (fourcc !== "WEBP") return null;
    }
    return sig.mime;
  }
  return null;
}

/**
 * Read pixel dimensions from the container header.
 *
 * PNG: bytes 16-19 (big-endian width), 20-23 (height) after the 8-byte
 * signature and the 4-byte length + 4-byte "IHDR" chunk type.
 * JPEG: walk the marker segments to the first SOFn; width/height are
 * big-endian 16-bit fields at a fixed offset within that frame header.
 * Anything else returns `0x0` — dimensions are prompt context, not
 * correctness, and a failed parse must never fail a write.
 */
export function readDimensions(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } {
  try {
    if (mime === "image/png") {
      if (bytes.length < 24) return { width: 0, height: 0 };
      const width =
        (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height =
        (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      return { width: width >>> 0, height: height >>> 0 };
    }
    if (mime === "image/jpeg") {
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return { width: 0, height: 0 };
      }
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        // SOF0..SOF15 except DHT (C4), JPGA (C8) and DAC (CC).
        const isSof =
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc;
        if (isSof) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          return { width, height };
        }
        // Standalone markers carry no length field.
        if (
          marker === 0xd8 ||
          marker === 0xd9 ||
          (marker >= 0xd0 && marker <= 0xd7)
        ) {
          offset += 2;
          continue;
        }
        const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (segmentLength < 2) break;
        offset += 2 + segmentLength;
      }
      return { width: 0, height: 0 };
    }
  } catch {
    // A malformed header must never fail a write — dimensions default
    // to 0x0 and the caller records them as unknown.
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

/**
 * Write image bytes to the blob store, content-addressed.
 *
 * Idempotent: writing the same bytes twice rewrites the same file with
 * the same content, so a repeated call is a no-op on disk and returns
 * an identical `StoredImage`. Callers still dedupe at the NODE level
 * (same digest in the same namespace → one node) in `memory.ts`.
 *
 * @throws {@link ImageRejectedError} when the bytes are empty, an
 * unrecognised format, or above `maxBytes`.
 */
export function writeImage(
  bytes: Buffer | Uint8Array,
  declaredMime: string | undefined,
  root: string,
  maxBytes: number,
): StoredImage {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length === 0) {
    throw new ImageRejectedError("image bytes are empty", "empty");
  }
  if (buf.length > maxBytes) {
    throw new ImageRejectedError(
      `image is ${buf.length} bytes, above the ${maxBytes}-byte limit`,
      "size",
    );
  }
  // Sniffed type wins over the declared one — a wrong declared type is
  // the more dangerous error (a vision model would mis-decode the blob).
  const sniffed = sniffMime(new Uint8Array(buf));
  const mime = sniffed ?? declaredMime ?? null;
  if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
    throw new ImageRejectedError(
      `unsupported image format (detected ${
        sniffed ?? "none"
      }, declared ${declaredMime ?? "none"})`,
      "mime",
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const ref = refFor(sha256);
  const extension = MIME_EXTENSION[mime] ?? "bin";
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const path = join(root, `${ref}.${extension}`);
  // Write only when absent: content-addressed means the file is already
  // correct, so a rewrite is wasted I/O (and a needless mtime bump).
  if (!existsSync(path)) writeFileSync(path, buf);
  const { width, height } = readDimensions(new Uint8Array(buf), mime);
  return { ref, path, sha256, width, height, bytes: buf.length, mime };
}

/** Read a blob back by ref. Returns null when it is missing. */
export function readImage(ref: string, root: string): Buffer | null {
  const resolved = resolveRef(ref, root);
  if (!resolved) return null;
  try {
    return readFileSync(resolved);
  } catch {
    return null;
  }
}

/**
 * Resolve a ref to an on-disk path, tolerating any of the accepted
 * extensions (the format is recorded in the metadata, but the store
 * stays addressable by ref alone so a pack consumer holding only
 * `[img:…]` can still resolve it).
 */
export function resolveRef(ref: string, root: string): string | null {
  if (!/^img_[a-f0-9]{4,64}$/.test(ref)) return null;
  for (const ext of Object.values(MIME_EXTENSION)) {
    const candidate = join(root, `${ref}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Delete a blob by ref. Returns true when a file was removed. */
export function deleteRef(ref: string, root: string): boolean {
  const resolved = resolveRef(ref, root);
  if (!resolved) return false;
  try {
    unlinkSync(resolved);
    return true;
  } catch {
    return false;
  }
}

/**
 * Coarse classification from MIME type only.
 *
 * Deliberately NOT content analysis: `photo` vs `screenshot` cannot be
 * told apart from a header, and guessing would put a wrong label in
 * every image node. `chart`/`diagram`/`memo` are caller-declared via
 * `addImageMemory({ kind })`; the sniffed value is the safe default.
 */
export function kindFromMime(mime: string): ImageKind {
  // Every accepted raster format is a photo by default — the caller
  // overrides with the real kind when it knows one.
  if (ALLOWED_MIME_TYPES.has(mime)) return "photo";
  return "other";
}

/**
 * Delete blobs that no live node references anymore.
 *
 * Called explicitly (never on a background timer) because eviction
 * (`forgetByDecay`, `archive`) deletes nodes, and a blob whose node is
 * gone is unreachable garbage. Returns how many files were removed so
 * maintenance commands can report it.
 */
export function purgeOrphanImages(
  root: string,
  liveRefs: ReadonlySet<string>,
): number {
  if (!existsSync(root)) return 0;
  let purged = 0;
  for (const entry of readdirSync(root)) {
    const ref = entry.replace(/\.[a-z0-9]+$/i, "");
    if (!ref.startsWith(REF_PREFIX)) continue;
    if (liveRefs.has(ref)) continue;
    if (deleteRef(ref, root)) purged += 1;
  }
  return purged;
}

/** Size of a stored blob in bytes, or null when missing. */
export function imageSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * Normalize every accepted {@link ImageInput} shape into raw bytes plus
 * a declared MIME type.
 *
 * Resolution order matters: a `data:` URL is checked BEFORE a path
 * (both are strings), and base64-with-explicit-mime is checked before
 * the fetch path (both can be objects). Bytes pass through untouched —
 * the caller's `writeImage` sniffs the true format from the header
 * anyway, so a wrong declared MIME can never mislabel the blob.
 *
 * `file:` and `http(s):` URLs are fetched; everything else that looks
 * like a URL but isn't fetchable throws rather than being guessed at.
 */
export async function normalizeImageInput(
  input: ImageInput,
): Promise<{ bytes: Buffer; mime: string | undefined }> {
  // Raw bytes — the fastest and most common programmatic path.
  if (Buffer.isBuffer(input)) {
    return { bytes: input, mime: undefined };
  }
  if (input instanceof Uint8Array) {
    return { bytes: Buffer.from(input), mime: undefined };
  }

  // Explicit base64 + mime.
  if (typeof input === "object" && input !== null && "data" in input) {
    return { bytes: Buffer.from(input.data, "base64"), mime: input.mime };
  }

  // URL fetch.
  if (typeof input === "object" && input !== null && "url" in input) {
    return fetchImageUrl(input.url);
  }

  if (typeof input !== "string") {
    throw new ImageRejectedError(
      "image input must be a path, bytes, { data, mime }, or { url }",
      "empty",
    );
  }

  // A data: URL is a string too — check the prefix before treating the
  // value as a filesystem path.
  if (input.startsWith("data:")) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(input);
    if (!match) {
      throw new ImageRejectedError("malformed data: URL", "mime");
    }
    const mime = match[1] ?? undefined;
    const payload = match[3] ?? "";
    const bytes = match[2]
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { bytes, mime };
  }

  // Filesystem path.
  return { bytes: await readFile(input), mime: undefined };
}

/** Fetch an image from an http(s)/file URL into bytes. */
async function fetchImageUrl(
  url: string,
): Promise<{ bytes: Buffer; mime: string | undefined }> {
  if (url.startsWith("file:")) {
    // A file: URL is a local path — read it directly rather than
    // routing a local file through the network stack.
    const { readFile } = await import("node:fs/promises");
    return { bytes: await readFile(fileURLToPath(url)), mime: undefined };
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ImageRejectedError(
      `unsupported image URL scheme: ${url.slice(0, 32)}`,
      "mime",
    );
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new ImageRejectedError(
      `fetching image failed with HTTP ${response.status}`,
      "empty",
    );
  }
  const mime = response.headers.get("content-type") ?? undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mime };
}
