// CI guard: the Claude Code plugin manifests must carry the same version as
// the published npm package so `/plugin install memos@memos-marketplace` and
// `npm install @mem-os/sdk` never drift apart. Run via `npm run check:plugin`.
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const plugin = JSON.parse(await readFile("plugin/.claude-plugin/plugin.json", "utf8"));
const marketplace = JSON.parse(await readFile(".claude-plugin/marketplace.json", "utf8"));

const errors = [];
if (plugin.version !== pkg.version) {
  errors.push(`plugin/.claude-plugin/plugin.json version ${plugin.version} != package.json version ${pkg.version}`);
}
const listing = marketplace.plugins?.find((p) => p.name === "memos");
if (!listing) {
  errors.push(".claude-plugin/marketplace.json does not list the 'memos' plugin");
} else if (listing.version !== pkg.version) {
  errors.push(`.claude-plugin/marketplace.json version ${listing.version} != package.json version ${pkg.version}`);
}

if (errors.length > 0) {
  console.error("Plugin version drift detected:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error(`\nFix: set both plugin manifests to ${pkg.version} (or bump package.json to match).`);
  process.exit(1);
}

console.log(`plugin version OK (${plugin.version})`);
