/**
 * Memory-as-code: optional project-level configuration from a
 * `.memos.json` file, resolved by walking up from the working directory
 * (like AGENTS.md) so monorepo subdirectories inherit the root policy.
 *
 * The file commits memory POLICY to version control — scope defaults,
 * consolidation knobs, embedding routing, the NAME of the env var that
 * holds the encryption key (never the key itself):
 *
 * ```json
 * {
 *   "scope": { "user": "alice", "agent": "coder" },
 *   "consolidation": { "minRetentionScore": 0.2, "decayHalfLifeDays": 60 },
 *   "embeddings": { "provider": "openai-compatible", "model": "LFM2.5-Embedding-350M-BF16", "baseUrl": "http://127.0.0.1:8080/v1" },
 *   "privacy": { "cipherKeyEnv": "MEMOS_KEY" }
 * }
 * ```
 *
 * @module @mem-os/project-config
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface MemosProjectConfig {
  scope?: {
    user?: string;
    agent?: string;
  };
  consolidation?: {
    minRetentionScore?: number;
    decayHalfLifeDays?: number;
    olderThanDays?: number;
  };
  embeddings?: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  /**
   * Image memory. `enabled` turns on the caption track (images are
   * stored with a searchable caption); `clip.enabled` additionally
   * turns on the CLIP pixel track. Overridable per-invocation with
   * `--vision` / `--vision-clip` or MEMOS_VISION / MEMOS_VISION_CLIP.
   */
  vision?: {
    enabled?: boolean;
    clip?: { enabled?: boolean };
    storeRoot?: string;
    maxImageBytes?: number;
  };
  privacy?: {
    /** Environment variable that holds the encryption key. */
    cipherKeyEnv?: string;
  };
}

export const PROJECT_CONFIG_FILE = ".memos.json";

/**
 * Find and parse the nearest `.memos.json`, walking up from `dir` to the
 * filesystem root. Returns null when no file exists. Throws with the file
 * path when the file exists but is malformed.
 */
export function loadProjectConfig(
  dir: string = process.cwd(),
): MemosProjectConfig | null {
  let current = resolve(dir);
  for (;;) {
    const candidate = resolve(current, PROJECT_CONFIG_FILE);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(
          readFileSync(candidate, "utf8"),
        ) as MemosProjectConfig;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("config must be a JSON object");
        }
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Malformed ${PROJECT_CONFIG_FILE} at ${candidate}: ${message}`,
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The env var name that holds the encryption key, per project config.
 * Default: MEMOS_KEY.
 */
export function cipherKeyEnvName(config: MemosProjectConfig | null): string {
  return config?.privacy?.cipherKeyEnv || "MEMOS_KEY";
}
