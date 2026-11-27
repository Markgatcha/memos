/**
 * `memos connect` - register the MemOS MCP server with an agentic harness.
 *
 * Every target here is a plain stdio MCP launch command plus the config
 * shape one harness expects. Targets that merge into a larger settings file
 * deliberately have no `configPath`: replacing a user's editor or agent
 * settings wholesale would destroy unrelated configuration, so those print
 * the block for the user to paste instead.
 *
 * @module @memos/connect
 */

import * as os from "node:os";
import { join } from "node:path";
import { openCodeV2PluginSource, openCodeV1PluginSource } from "./session-hooks.js";

/** Launch command for the MemOS MCP stdio server. */
export const MCP_COMMAND = ["npx", "-y", "@mem-os/sdk", "mcp"];

/** Server name used inside each harness's config. */
export const MCP_SERVER_NAME = "memos";

/** An additional file to write next to the main config (e.g. a plugin). */
export interface ConnectExtraFile {
  /** Path, relative to the current working directory, to write. */
  path: string;
  /** File contents. */
  contents: string;
}

/** One harness the `connect` command knows how to configure. */
export interface ConnectTarget {
  /** Human-readable setup instructions (always printed). */
  instructions: string;
  /** Config file to write with --write, when applicable. */
  configPath?: string;
  /** File contents for --write. */
  fileContents?: string;
  /** Extra files to write alongside the config (e.g. a session hook plugin). */
  extraFiles?: ConnectExtraFile[];
}

/** Options that shape the generated config entry. */
export interface ConnectOptions {
  /** Override the SQLite path (travels as MEMOS_DB_PATH). */
  dbPath?: string;
  /**
   * Tool names for the `generic` target's summary line. Injected by the
   * caller from `getMcpTools()` so the count can never go stale.
   */
  toolNames?: string[];
  /**
   * Also write the OpenCode session-hook plugin (V1 or V2, matching the
   * target) next to the config. Only meaningful for OpenCode targets.
   */
  withSessionHook?: boolean;
}

/**
 * Every target `memos connect` accepts, in the order they are listed in
 * help and completions. Aliases are resolved inside `connectTarget()`.
 */
export const CONNECT_TARGETS = [
  "claude-code",
  "cursor",
  "windsurf",
  "cline",
  "opencode",
  "opencode-v1",
  "opencode-v2",
  "codex",
  "gemini",
  "hermes",
  "dsh",
  "kilo",
  "pi",
  "openclaw",
  "zed",
  "goose",
  "generic",
] as const;

/** Targets that only print a block because they merge into a larger file. */
export const PRINT_ONLY_TARGETS = [
  "cline",
  "hermes",
  "dsh",
  "openclaw",
  "zed",
  "goose",
] as const;

/**
 * Build the MCP server entry, forwarding embedding configuration when it is
 * present in the environment so a custom embedder survives the hop into the
 * harness's config file.
 */
function mcpServerEntry(dbPath?: string): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (process.env.MEMOS_EMBEDDING_PROVIDER)
    env.MEMOS_EMBEDDING_PROVIDER = process.env.MEMOS_EMBEDDING_PROVIDER;
  if (process.env.MEMOS_EMBEDDING_MODEL)
    env.MEMOS_EMBEDDING_MODEL = process.env.MEMOS_EMBEDDING_MODEL;
  if (process.env.MEMOS_EMBEDDING_BASE_URL)
    env.MEMOS_EMBEDDING_BASE_URL = process.env.MEMOS_EMBEDDING_BASE_URL;
  if (process.env.MEMOS_EMBEDDING_DIMENSIONS)
    env.MEMOS_EMBEDDING_DIMENSIONS = process.env.MEMOS_EMBEDDING_DIMENSIONS;
  if (process.env.MEMOS_EMBEDDING_QUERY_PREFIX)
    env.MEMOS_EMBEDDING_QUERY_PREFIX = process.env.MEMOS_EMBEDDING_QUERY_PREFIX;
  if (process.env.MEMOS_EMBEDDING_DOCUMENT_PREFIX)
    env.MEMOS_EMBEDDING_DOCUMENT_PREFIX =
      process.env.MEMOS_EMBEDDING_DOCUMENT_PREFIX;
  if (dbPath) env.MEMOS_DB_PATH = dbPath;
  return {
    command: MCP_COMMAND[0],
    args: MCP_COMMAND.slice(1),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

/**
 * YAML-quote a scalar for a Cordis patch file. JSON string escaping is a
 * subset of YAML's double-quoted style, so this is safe for Windows paths
 * containing backslashes.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/**
 * Build the DeepSeek Harness (`dsh`) Cordis patch row.
 *
 * dsh has no `mcp.json`. MCP servers are rows for the
 * `@deepseek-ai/dsh-mcp-client` plugin inside a Cordis patch file, and the
 * documented shape is a top-level `- insert:` list. See
 * https://deepseekdocs.com/en/docs/features/mcp
 */
function dshPatchYaml(dbPath?: string): string {
  const lines = [
    "# Managed by `memos connect dsh`. Merge this row into your patch file -",
    "# dsh warns that overwriting cordis.patch.yml can drop unrelated user",
    "# patches, so this file is printed rather than written.",
    "- insert:",
    "    - id: memos",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: memos",
    "        transport: stdio",
    `        command: ${yamlScalar(MCP_COMMAND[0])}`,
    `        args: [${MCP_COMMAND.slice(1)
      .map((a) => yamlScalar(a))
      .join(", ")}]`,
  ];
  // Forward the same environment the other targets forward: a custom
  // embedder is otherwise silently dropped for dsh users.
  const source = mcpServerEntry(dbPath);
  const env = (source as any).env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    lines.push("        env:");
    for (const [k, v] of Object.entries(env)) {
      lines.push(`          ${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build the OpenCode MCP entry. OpenCode uses `type: "local"` with the
 * command as an array, and `environment` (not `env`) for variables.
 */
function opencodeEntry(dbPath?: string): Record<string, unknown> {
  const env: Record<string, string> = {};
  const source = mcpServerEntry(dbPath);
  const env2 = (source as any).env;
  if (env2) for (const k of Object.keys(env2)) env[k] = String(env2[k]);
  return {
    type: "local",
    command: MCP_COMMAND,
    ...(Object.keys(env).length > 0 ? { environment: env } : {}),
    enabled: true,
  };
}

function homeDir(): string {
  return os.homedir();
}

/**
 * Resolve a `memos connect` target into instructions, and - where the
 * harness uses a dedicated file - the contents to write.
 *
 * Returns `null` for an unknown target, after printing the supported list
 * to stderr.
 */
export function connectTarget(
  target: string,
  opts: ConnectOptions = {},
): ConnectTarget | null {
  const entry = mcpServerEntry(opts.dbPath);
  const entryEnv = (entry as { env?: Record<string, string> }).env;
  const jsonEntry = JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: entry } },
    null,
    2,
  );

  switch (target) {
    case "claude-code":
    case "claude":
    case "claudecode": {
      const args = MCP_COMMAND.map((a) => `"${a}"`).join(" ");
      return {
        instructions: [
          "Claude Code - pick ONE:",
          "",
          "  # User scope (available in every project):",
          `  claude mcp add ${MCP_SERVER_NAME} -s user -- ${MCP_COMMAND.join(" ")}`,
          "",
          "  # Project scope (checked into the repo for the whole team):",
          "  memos connect claude-code --write",
          "  # -> writes ./.mcp.json:",
          jsonEntry,
          "",
          `  Or run inside Claude Code: /plugin marketplace add Markgatcha/memos`,
          `  then /plugin install ${MCP_SERVER_NAME}@memos-marketplace (bundles this MCP`,
          `  server + /memos, /recall commands + a memory skill).`,
          "",
          `  Manual one-liner equivalent: claude mcp add ${MCP_SERVER_NAME} -s user -- ${args}`,
          "",
          "  # Session hook (auto-extract facts at session end):",
          "  # Add to .claude/settings.json:",
          "  {",
          '    "hooks": {',
          '      "SessionEnd": [{ "hooks": [{ "type": "command", "command": "memos session-hook" }] }]',
          "    }",
          "  }",
        ].join("\n"),
        configPath: ".mcp.json",
        fileContents: jsonEntry + "\n",
      };
    }
    case "cursor": {
      return {
        instructions: [
          "Cursor - MCP config at ~/.cursor/mcp.json:",
          jsonEntry,
          "",
          "Or: memos connect cursor --write  (writes the file; --force overwrites).",
          "Restart Cursor, then enable the memos server in MCP settings.",
        ].join("\n"),
        configPath: join(homeDir(), ".cursor", "mcp.json"),
        fileContents: jsonEntry + "\n",
      };
    }
    case "windsurf": {
      return {
        instructions: [
          "Windsurf - MCP config at ~/.codeium/windsurf/mcp_config.json:",
          jsonEntry,
          "",
          "Or: memos connect windsurf --write",
        ].join("\n"),
        configPath: join(homeDir(), ".codeium", "windsurf", "mcp_config.json"),
        fileContents: jsonEntry + "\n",
      };
    }
    case "cline": {
      return {
        instructions: [
          "Cline (VS Code) - MCP settings file:",
          "  Windows: %APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json",
          "  macOS:   ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
          "",
          "Merge this into the mcpServers object:",
          jsonEntry,
        ].join("\n"),
      };
    }
    case "opencode":
    case "opencode-v2":
    case "opencode2": {
      // OpenCode 2.0 nests servers under `mcp.servers` and renamed the
      // top-level `plugin` array to `plugins`. The 1.x shape
      // (`mcp.<name>`, no `servers` level) is rejected by the V2 schema.
      const v2Obj: Record<string, unknown> = {
        mcp: {
          servers: { [MCP_SERVER_NAME]: opencodeEntry(opts.dbPath) },
        },
      };
      const pluginPath = join(".opencode", "plugins", "memos-session-hook", "index.ts");
      const pluginSource = openCodeV2PluginSource();
      const withHook = opts.withSessionHook === true;
      if (withHook) v2Obj.plugins = ["./plugins/memos-session-hook"];
      const v2 = JSON.stringify(v2Obj, null, 2);
      return {
        instructions: [
          "OpenCode 2.x - add to opencode.json (project) or",
          "~/.config/opencode/opencode.json (global):",
          v2,
          "",
          `Or: memos connect opencode${withHook ? " --with-session-hook" : ""} --write  (writes ./opencode.json).`,
          "",
          "V2 nests servers under `mcp.servers`; the 1.x `mcp.<name>` shape is",
          "rejected by the V2 schema. On OpenCode 1.x use:",
          "  memos connect opencode-v1",
          "",
          "For the session hook (auto-extract facts when an agent turn",
          "completes), add --with-session-hook.",
        ].join("\n"),
        configPath: "opencode.json",
        fileContents: v2 + "\n",
        ...(withHook
          ? { extraFiles: [{ path: pluginPath, contents: pluginSource }] }
          : {}),
      };
    }
    case "opencode-v1":
    case "opencode1": {
      const v1Obj: Record<string, unknown> = {
        mcp: { [MCP_SERVER_NAME]: opencodeEntry(opts.dbPath) },
      };
      const pluginPath = join(".opencode", "plugins", "memos-session-hook.ts");
      const pluginSource = openCodeV1PluginSource();
      const withHook = opts.withSessionHook === true;
      if (withHook) v1Obj.plugin = ["./plugins/memos-session-hook.ts"];
      const v1 = JSON.stringify(v1Obj, null, 2);
      return {
        instructions: [
          "OpenCode 1.x - add to opencode.json (project) or",
          "~/.config/opencode/opencode.json (global):",
          v1,
          "",
          `Or: memos connect opencode-v1${withHook ? " --with-session-hook" : ""} --write  (writes ./opencode.json).`,
          "",
          "1.x uses `mcp.<name>` with no `servers` level. On OpenCode 2.x use:",
          "  memos connect opencode   (writes the mcp.servers shape)",
          "",
          "For the session hook (auto-extract facts when a session is",
          "deleted), add --with-session-hook.",
        ].join("\n"),
        configPath: "opencode.json",
        fileContents: v1 + "\n",
        ...(withHook
          ? { extraFiles: [{ path: pluginPath, contents: pluginSource }] }
          : {}),
      };
    }
    case "codex": {
      const toml = `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "${MCP_COMMAND[0]}"\nargs = [${MCP_COMMAND.slice(
        1,
      )
        .map((a) => `"${a}"`)
        .join(", ")}]\n`;
      return {
        instructions: [
          "Codex CLI - add to ~/.codex/config.toml:",
          toml,
          "Or: memos connect codex --write  (appends to the file).",
        ].join("\n"),
        configPath: join(homeDir(), ".codex", "config.toml"),
        fileContents: toml,
      };
    }
    case "gemini": {
      return {
        instructions: [
          "Gemini CLI - MCP config at ~/.gemini/settings.json:",
          jsonEntry,
          "",
          "Or: memos connect gemini --write",
        ].join("\n"),
        configPath: join(homeDir(), ".gemini", "settings.json"),
        fileContents: jsonEntry + "\n",
      };
    }
    case "hermes": {
      const env = entryEnv
        ? `    env:\n${Object.entries(entryEnv)
            .map(([k, v]) => `      ${k}: "${v}"`)
            .join("\n")}\n`
        : "";
      return {
        instructions: [
          "Hermes Agent (Nous Research) - add to ~/.hermes/config.yaml:",
          "mcp_servers:",
          `  ${MCP_SERVER_NAME}:`,
          '    command: "npx"',
          '    args: ["-y", "@mem-os/sdk", "mcp"]',
          env.trimEnd(),
          "    protocol: auto",
          "    trust: full",
          "",
          "MCP ships with the standard Hermes install. Restart the agent,",
          "then verify with /mcp or `hermes mcp list`.",
          "",
          "Portable package route: Hermes also installs Agent Plugins 1.0.0",
          "packages. This repo's root plugin.json + mcp.json already match that",
          "format: `hermes plugins install Markgatcha/memos --no-enable`,",
          `then enable \`${MCP_SERVER_NAME}\` in ~/.hermes/config.yaml.`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "dsh":
    case "deepseek":
    case "deepseek-harness": {
      const dshHome = process.env.DSH_HOME ?? join(homeDir(), ".dsh");
      const patch = dshPatchYaml(opts.dbPath);
      const dedicatedPath = join(dshHome, "memos.patch.yml");
      return {
        instructions: [
          "DeepSeek Harness (dsh) - dsh has no mcp.json.",
          "",
          "MCP servers are rows for the @deepseek-ai/dsh-mcp-client plugin",
          "inside a Cordis patch file. Merge the row below into ONE of:",
          "",
          `  ${join(dshHome, "cordis.patch.yml")}                 # every profile`,
          `  ${join(dshHome, "profiles", "<name>", "cordis.patch.yml")}   # one profile`,
          "",
          patch,
          "",
          "Do not replace an existing patch file: dsh warns it may already",
          "contain unrelated user patches. Merge this row in by hand.",
          "",
          "One-off test without touching your patch file:",
          "  dsh web --patch <file>       # applies the patch for a single run",
          "",
          "Then restart dsh and verify:",
          "  dsh web --dump-config | grep -A3 mcp",
          "",
          "`memos connect dsh --write` saves the row above to",
          `  ${dedicatedPath}`,
          "which is safe to create (it is new, not your cordis.patch.yml). You",
          "still need to either `dsh web --patch <that file>` for a one-off run,",
          "or merge the row into cordis.patch.yml for a permanent install.",
          "",
          "dsh namespaces bridged tools as mcp__memos__<tool>. Only tools",
          "bridge - resources and prompts have no dsh consumer.",
        ].join("\n"),
        configPath: dedicatedPath,
        fileContents: patch + "\n",
      };
    }
    case "kilo":
    case "kilo-code":
    case "kilocode": {
      const kiloEntry = {
        type: "local",
        command: MCP_COMMAND,
        ...(entryEnv ? { environment: entryEnv } : {}),
        enabled: true,
      };
      const contents = JSON.stringify(
        { mcp: { [MCP_SERVER_NAME]: kiloEntry } },
        null,
        2,
      );
      return {
        instructions: [
          "Kilo Code - add to kilo.json (project) or ~/.config/kilo/kilo.json:",
          contents,
          "",
          "Or: memos connect kilo --write  (writes ./kilo.json)",
          "Kilo uses `mcp` (not mcpServers), a command array, and",
          "`environment` for env vars. Open Settings -> MCP Servers to verify.",
        ].join("\n"),
        configPath: "kilo.json",
        fileContents: contents + "\n",
      };
    }
    case "pi": {
      return {
        instructions: [
          "Pi - add to ~/.pi/agent/mcp.json (global) or .pi/mcp.json (project):",
          jsonEntry,
          "",
          "Or: memos connect pi --write",
          "Pi reads mcpServers entries with command/args/env. Type `mcp` under",
          "`pi config` to confirm the built-in MCP extension is enabled.",
        ].join("\n"),
        configPath: join(homeDir(), ".pi", "agent", "mcp.json"),
        fileContents: jsonEntry + "\n",
      };
    }
    case "openclaw": {
      const openclawEntry = {
        mcp: {
          servers: {
            [MCP_SERVER_NAME]: {
              command: MCP_COMMAND[0],
              args: MCP_COMMAND.slice(1),
              ...(entryEnv ? { env: entryEnv } : {}),
              enabled: true,
            },
          },
        },
      };
      return {
        instructions: [
          "OpenClaw - merge into ~/.openclaw/openclaw.json:",
          JSON.stringify(openclawEntry, null, 2),
          "",
          "MCP servers live under mcp.servers. Keep credentials in the",
          "environment, not in the JSON. Verify with:",
          `  openclaw mcp doctor ${MCP_SERVER_NAME} --probe`,
          "",
          "OpenClaw also loads Agent Plugins 1.0.0 bundles (plugin.json +",
          "mcp.json), which this repo root already provides.",
        ].join("\n"),
      };
    }
    case "zed": {
      const zedConfig = {
        context_servers: {
          [MCP_SERVER_NAME]: {
            source: "custom",
            command: MCP_COMMAND[0],
            args: MCP_COMMAND.slice(1),
            ...(entryEnv ? { env: entryEnv } : {}),
          },
        },
      };
      return {
        instructions: [
          "Zed - merge into ~/.config/zed/settings.json:",
          JSON.stringify(zedConfig, null, 2),
          "",
          "Zed calls MCP servers `context_servers` and keeps them in the same",
          "settings file as the editor. Open Settings -> AI -> MCP Servers and",
          "watch for a green status dot.",
        ].join("\n"),
      };
    }
    case "goose": {
      return {
        instructions: [
          "goose - add to ~/.config/goose/config.yaml:",
          "extensions:",
          `  ${MCP_SERVER_NAME}:`,
          "    type: stdio",
          '    cmd: "npx"',
          '    args: ["-y", "@mem-os/sdk", "mcp"]',
          "    enabled: true",
          "    timeout: 300",
          "",
          "Restart goose and check `goose configure` -> Extensions.",
        ].join("\n"),
      };
    }
    case "generic":
    case "any":
    case "mcp": {
      const short = (opts.toolNames ?? []).map((n) => n.replace(/^memos_/, ""));
      return {
        instructions: [
          "Any MCP-capable harness - the MemOS server is a plain stdio MCP",
          `server. Launch command: ${MCP_COMMAND.join(" ")}`,
          "",
          "MCP config shape (mcpServers object):",
          jsonEntry,
          "",
          "The server speaks MCP 2026-07-28 (server/discover + _meta, with a legacy-2025 initialize fallback) and",
          `exposes ${short.length} tools: ${short.join("/")}.`,
          "All data stays in local SQLite.",
          "",
          "Streamable HTTP (for hosted clients, or several harnesses at once):",
          "  memos mcp --http --port=8788",
          "  endpoint: http://localhost:8788/mcp",
          "It binds loopback by default and has no authentication - put it",
          "behind an authenticating proxy before exposing it beyond localhost.",
        ].join("\n"),
      };
    }
    default:
      console.error(
        `Unknown target. Supported: ${CONNECT_TARGETS.join(", ")}.`,
      );
      return null;
  }
}