import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

describe("plugin hook manifests", () => {
  test("hooks.json has exactly one UserPromptSubmit key", () => {
    const raw = read("plugin/hooks/hooks.json");
    // JSON.parse keeps the last duplicate, so count the raw text too. This is
    // the exact regression that silently disabled per-prompt recall.
    expect(raw.match(/"UserPromptSubmit"\s*:/g) ?? []).toHaveLength(1);
    const hooks = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(hooks)).toContain("UserPromptSubmit");
  });

  test("both prompt-time hooks are registered", () => {
    const hooks = JSON.parse(read("plugin/hooks/hooks.json")) as {
      UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }>;
    };
    const commands = hooks.UserPromptSubmit.flatMap((entry) =>
      entry.hooks.map((hook) => hook.command),
    );
    expect(commands.join(" ")).toContain("user-prompt-submit.mjs");
    expect(commands.join(" ")).toContain("auto-capture.mjs");
  });

  test("plugin, marketplace, and MCP pins agree with package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { version: string };
    const plugin = JSON.parse(read("plugin/plugin.json")) as {
      version: string;
    };
    const claudePlugin = JSON.parse(
      read("plugin/.claude-plugin/plugin.json"),
    ) as { version: string };
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: Array<{ name: string; version: string }>;
    };
    const mcp = JSON.parse(read("plugin/mcp.json")) as {
      mcpServers: { memos: { args: string[] } };
    };
    expect(plugin.version).toBe(pkg.version);
    expect(claudePlugin.version).toBe(pkg.version);
    expect(
      marketplace.plugins.find((entry) => entry.name === "memos")?.version,
    ).toBe(pkg.version);
    expect(mcp.mcpServers.memos.args).toContain(`@mem-os/sdk@${pkg.version}`);
  });
});
