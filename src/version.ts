/**
 * Runtime package version resolution.
 *
 * The published version is read from `package.json` at runtime instead of
 * being hardcoded, so the MCP `serverInfo.version` and the CLI backup
 * manifest always report the real release. This file lives one level below
 * the package root both in source (`src/version.ts`) and in the build output
 * (`dist/version.js`), so `../package.json` resolves to the package root in
 * either layout.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let cached: string | undefined;

/**
 * Return the `@mem-os/sdk` package version, read from `package.json`.
 * Falls back to `"0.0.0"` if the manifest cannot be resolved (e.g. an
 * unusual bundler or test sandbox), so callers never throw.
 */
export function getSdkVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkg = require("../package.json") as { version?: unknown };
    cached =
      typeof pkg.version === "string" && pkg.version.length > 0
        ? pkg.version
        : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
