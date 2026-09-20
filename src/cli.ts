#!/usr/bin/env node

/**
 * MemOS CLI — command-line interface for the MemOS memory layer.
 *
 * Usage:
 *   memos store "User prefers dark mode" --type preference
 *   memos search "dark mode"
 *   memos history <id>
 *   memos retrieve <id>
 *   memos forget <id>
 *   memos revert --last | --id <id> | --about <topic> | "<revert request>" [--dry-run]
 *   memos summarize
 *   memos graph [--mermaid]
 *   memos browse
 *   memos link <src> <dst>
 *   memos count
 *   memos tag <id> <tag1> [tag2...]
 *   memos untag <id> <tag1> [tag2...]
 *   memos list --tag <tag>
 *   memos export [--format json|markdown|obsidian] [--output <dir>] [--tag <tag>]
 *   memos backup [--output <path>]
 *   memos restore <path>
 *   memos mcp
 *   memos serve
 *
 * @module @memos/cli
 */

import { MemOS } from "./memory.js";
import { graphToMermaid } from "./graph-mermaid.js";
import { parseScopeArg } from "./scope.js";
import { parseRevertCliArgs } from "./revert.js";
import type { MemoryPool } from "./types.js";
import type { CreateMemoryInput, ExportFormat } from "./types.js";
import type { ChildProcess } from "node:child_process";
import type { SQLiteStorage } from "./storage/sqlite.js";
import { getSdkVersion } from "./version.js";
import type { EmbeddingConfig, EmbeddingProviderKind } from "./types.js";
import { resolve, dirname, join } from "path";
import * as os from "os";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "fs";

const args = process.argv.slice(2);
const command = args[0];

/**
 * Filter out flags and their values from an argument list.
 * Flags that take a value: --db, --type, --ttl, --limit, --format, --output,
 * --id, --about, --reason, --actor, --namespace
 * Boolean flags: --json
 */
function nonFlagArgs(args: string[], startIndex: number): string[] {
  const flagsWithValue = new Set([
    "--db",
    "--type",
    "--ttl",
    "--limit",
    "--format",
    "--output",
    "--id",
    "--about",
    "--reason",
    "--actor",
    "--namespace",
  ]);
  const result: string[] = [];
  let skipNext = false;
  for (let i = startIndex; i < args.length; i++) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (args[i] === "--json") continue;
    if (flagsWithValue.has(args[i])) {
      skipNext = true;
      continue;
    }
    if (args[i].startsWith("--")) continue;
    result.push(args[i]);
  }
  return result;
}

/**
 * Build an `EmbeddingConfig` from MEMOS_EMBEDDING_* environment variables.
 * Returns null when MEMOS_EMBEDDING_PROVIDER is unset so callers fall
 * through to the config file / SDK default.
 */
function cliEmbeddingsConfig(): EmbeddingConfig | null {
  const provider = process.env.MEMOS_EMBEDDING_PROVIDER;
  if (!provider) return null;
  const dimensions = process.env.MEMOS_EMBEDDING_DIMENSIONS;
  return {
    provider: provider as EmbeddingProviderKind,
    model: process.env.MEMOS_EMBEDDING_MODEL,
    baseUrl: process.env.MEMOS_EMBEDDING_BASE_URL,
    apiKey: process.env.MEMOS_EMBEDDING_API_KEY,
    dimensions: dimensions ? parseInt(dimensions, 10) : undefined,
    queryPrefix: process.env.MEMOS_EMBEDDING_QUERY_PREFIX,
    documentPrefix: process.env.MEMOS_EMBEDDING_DOCUMENT_PREFIX,
  };
}

// ---------------------------------------------------------------------------
// ~/.memos/config.json — written by `memos init`, read by every command.
// ---------------------------------------------------------------------------

/** Shape of the JSON written by `memos init` to ~/.memos/config.json. */
interface MemosFileConfig {
  version: 1;
  dbPath?: string;
  embeddings?: {
    enabled?: boolean;
    provider?: EmbeddingProviderKind;
    model?: string;
    baseUrl?: string;
    dimensions?: number;
    queryPrefix?: string;
    documentPrefix?: string;
  };
}

function configFilePath(): string {
  return join(os.homedir(), ".memos", "config.json");
}

/** Read ~/.memos/config.json. Returns null when the file is missing or invalid. */
function loadFileConfig(): MemosFileConfig | null {
  try {
    const raw = readFileSync(configFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as MemosFileConfig;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the config file, creating ~/.memos when needed. */
function saveFileConfig(config: MemosFileConfig): void {
  mkdirSync(dirname(configFilePath()), { recursive: true });
  writeFileSync(configFilePath(), JSON.stringify(config, null, 2) + "\n");
}

/**
 * Embedding config for the CLI: MEMOS_EMBEDDING_* wins, then the config
 * file, then nothing (SDK default — embeddings on, fastembed provider).
 */
function resolveCliEmbeddingsConfig(): EmbeddingConfig | null {
  const fromEnv = cliEmbeddingsConfig();
  if (fromEnv) return fromEnv;
  const file = loadFileConfig();
  const e = file?.embeddings;
  if (!e || Object.keys(e).length === 0) return null;
  return {
    ...(e.enabled !== undefined ? { enabled: e.enabled } : {}),
    ...(e.provider ? { provider: e.provider } : {}),
    ...(e.model ? { model: e.model } : {}),
    ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
    ...(e.dimensions ? { dimensions: e.dimensions } : {}),
    ...(e.queryPrefix ? { queryPrefix: e.queryPrefix } : {}),
    ...(e.documentPrefix ? { documentPrefix: e.documentPrefix } : {}),
  };
}

/** Database path: --db wins, then the config file, then the SDK default. */
function resolveDbPath(cliDbPath: string | undefined): string | undefined {
  if (cliDbPath) return cliDbPath;
  return loadFileConfig()?.dbPath;
}

// ---------------------------------------------------------------------------
// `memos init` — interactive onboarding wizard.
// ---------------------------------------------------------------------------

type InitProviderChoice = "fastembed" | "openai-compatible" | "ollama" | "off";

/** Prompt for a line of input; returns the default when the user hits enter. */
async function promptText(
  rl: { question: (q: string) => Promise<string> },
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await rl.question(`${label} [${defaultValue}]: `)).trim();
  return answer === "" ? defaultValue : answer;
}

/** Numbered-choice prompt. Returns the chosen key, or the default on empty. */
async function promptChoice<T extends string>(
  rl: { question: (q: string) => Promise<string> },
  label: string,
  options: Array<{ key: T; label: string; hint?: string }>,
  defaultKey: T,
): Promise<T> {
  console.log(label);
  options.forEach((o, i) => {
    const marker = o.key === defaultKey ? " (default)" : "";
    console.log(
      `  ${i + 1}) ${o.label}${o.hint ? ` — ${o.hint}` : ""}${marker}`,
    );
  });
  for (;;) {
    const answer = (
      await rl.question(
        `Choice [${options.findIndex((o) => o.key === defaultKey) + 1}]: `,
      )
    ).trim();
    if (answer === "") return defaultKey;
    const n = parseInt(answer, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
      return options[n - 1].key;
    }
    console.log(
      `Enter a number 1–${options.length}, or press enter for the default.`,
    );
  }
}

/**
 * `memos init` — walk the user through database path + embedding provider,
 * smoke-test the setup (store → semantic search → forget a probe memory),
 * and save ~/.memos/config.json. `memos init --yes` accepts all defaults
 * without prompting (for scripts).
 */
async function runInitWizard(cliArgs: string[]): Promise<void> {
  const nonInteractive = cliArgs.includes("--yes") || cliArgs.includes("-y");
  const { createInterface } = await import("node:readline/promises");
  const rl = nonInteractive
    ? null
    : createInterface({ input: process.stdin, output: process.stdout });

  try {
    const existing = loadFileConfig();
    if (existing && !nonInteractive) {
      console.log(`Existing config found at ${configFilePath()}.`);
      const again = await promptChoice(
        rl!,
        "Re-run the wizard and overwrite it?",
        [
          { key: "yes", label: "Yes, overwrite" },
          { key: "no", label: "No, keep existing" },
        ],
        "no",
      );
      if (again === "no") {
        console.log("Keeping existing config. Nothing changed.");
        return;
      }
    }

    const defaultDb = join(os.homedir(), ".memos", "memos.db");
    const dbPath = nonInteractive
      ? (existing?.dbPath ?? defaultDb)
      : await promptText(rl!, "Database path", existing?.dbPath ?? defaultDb);

    const providerChoice: InitProviderChoice = nonInteractive
      ? ((existing?.embeddings?.provider as InitProviderChoice) ?? "fastembed")
      : await promptChoice<InitProviderChoice>(
          rl!,
          "Embedding provider (semantic search):",
          [
            {
              key: "fastembed",
              label: "Local (fastembed)",
              hint: "free, on-device; needs `npm i @huggingface/transformers` for real vectors",
            },
            {
              key: "openai-compatible",
              label: "OpenAI-compatible server",
              hint: "e.g. scripts/embed-server.py on a GPU box",
            },
            {
              key: "ollama",
              label: "Ollama",
              hint: "local models via Ollama",
            },
            {
              key: "off",
              label: "Off",
              hint: "keyword-only search, no embeddings",
            },
          ],
          "fastembed",
        );

    const embeddings: NonNullable<MemosFileConfig["embeddings"]> = {};
    if (providerChoice === "off") {
      embeddings.enabled = false;
    } else {
      embeddings.enabled = true;
      embeddings.provider = providerChoice;
      if (providerChoice === "openai-compatible") {
        embeddings.baseUrl = nonInteractive
          ? (existing?.embeddings?.baseUrl ?? "http://localhost:8000")
          : await promptText(
              rl!,
              "Embedding server base URL",
              existing?.embeddings?.baseUrl ?? "http://localhost:8000",
            );
        embeddings.model = nonInteractive
          ? (existing?.embeddings?.model ?? "BAAI/bge-small-en-v1.5")
          : await promptText(
              rl!,
              "Embedding model",
              existing?.embeddings?.model ?? "BAAI/bge-small-en-v1.5",
            );
        const dimsDefault = String(existing?.embeddings?.dimensions ?? 384);
        const dimsAnswer = nonInteractive
          ? dimsDefault
          : await promptText(rl!, "Embedding dimensions", dimsDefault);
        const dims = parseInt(dimsAnswer, 10);
        if (!Number.isNaN(dims) && dims > 0) embeddings.dimensions = dims;
        console.log(
          "Note: if the server needs an API key, set MEMOS_EMBEDDING_API_KEY — keys are never written to the config file.",
        );
      } else if (providerChoice === "ollama") {
        embeddings.baseUrl = nonInteractive
          ? (existing?.embeddings?.baseUrl ?? "http://localhost:11434")
          : await promptText(
              rl!,
              "Ollama base URL",
              existing?.embeddings?.baseUrl ?? "http://localhost:11434",
            );
        embeddings.model = nonInteractive
          ? (existing?.embeddings?.model ?? "nomic-embed-text")
          : await promptText(
              rl!,
              "Ollama embedding model",
              existing?.embeddings?.model ?? "nomic-embed-text",
            );
      } else {
        console.log(
          "Note: real local vectors need `npm install @huggingface/transformers`; " +
            "without it MemOS falls back to a deterministic local hash and warns loudly.",
        );
      }
    }

    // Smoke test: open the store with this exact config, round-trip a probe.
    console.log("\nSmoke-testing the setup…");
    const memos = new MemOS({
      dbPath,
      ...(Object.keys(embeddings).length > 0 ? { embeddings } : {}),
    });
    try {
      await memos.init();
      const probe = `memos init smoke test ${Date.now()}`;
      const { node } = await memos.store(probe);
      const info = memos.getEmbeddingRuntimeInfo();
      if (info) {
        if (info.fallbackActive) {
          console.log(
            `  embeddings: ${info.resolvedProvider} (fallback — ${info.fallbackReason})`,
          );
        } else {
          console.log(
            `  embeddings: ${info.resolvedProvider} (${info.resolvedModel}, ${info.observedDimensions ?? info.requestedDimensions}d)`,
          );
        }
      } else {
        console.log("  embeddings: disabled (keyword search only)");
      }
      const hits = await memos.search({
        query: "memos init smoke test",
        limit: 3,
      });
      const found = hits.some((h) => h.node.id === node.id);
      console.log(
        `  store → search round-trip: ${found ? "ok" : "PROBE NOT FOUND"}`,
      );
      await memos.forget(node.id);
      if (!found) {
        console.error("Smoke test failed: probe memory was not retrievable.");
        process.exit(1);
      }
      console.log("  probe memory cleaned up.");
    } finally {
      await memos.close();
    }

    const config: MemosFileConfig = { version: 1, dbPath };
    if (Object.keys(embeddings).length > 0) config.embeddings = embeddings;
    saveFileConfig(config);
    console.log(`\nSaved ${configFilePath()}.`);
    console.log(
      "Every memos command (including `memos mcp`) now uses these settings.",
    );
    console.log(
      "Precedence: --db and MEMOS_EMBEDDING_* env vars still override the file.",
    );
  } finally {
    rl?.close();
  }
}

// ---------------------------------------------------------------------------
// `memos connect` — register the MemOS MCP server with agentic harnesses.
// ---------------------------------------------------------------------------

interface ConnectTarget {
  /** Human-readable setup instructions (always printed). */
  instructions: string;
  /** Config file to write with --write, when applicable. */
  configPath?: string;
  /** File contents for --write. */
  fileContents?: string;
}

const MCP_COMMAND = ["npx", "-y", "@mem-os/sdk", "mcp"];

function mcpServerEntry(dbPath?: string): Record<string, unknown> {
  const env: Record<string, string> = {};
  if (dbPath) env.MEMOS_DB_PATH = dbPath;
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
  return {
    command: MCP_COMMAND[0],
    args: MCP_COMMAND.slice(1),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function connectTarget(
  target: string,
  opts: { dbPath?: string; toolNames?: string[] },
): ConnectTarget | null {
  const entry = mcpServerEntry(opts.dbPath);
  const jsonEntry = JSON.stringify({ mcpServers: { memos: entry } }, null, 2);
  switch (target) {
    case "claude-code":
    case "claude":
    case "claudecode": {
      const args = MCP_COMMAND.map((a) => `"${a}"`).join(" ");
      return {
        instructions: [
          "Claude Code — pick ONE:",
          "",
          "  # User scope (available in every project):",
          `  claude mcp add memos -s user -- ${MCP_COMMAND.join(" ")}`,
          "",
          "  # Project scope (checked into the repo for the whole team):",
          "  memos connect claude-code --write",
          "  # → writes ./.mcp.json:",
          jsonEntry,
          "",
          `  Or run inside Claude Code: /plugin marketplace add Markgatcha/memos`,
          `  then /plugin install memos@memos-marketplace (bundles this MCP`,
          `  server + /memos, /recall commands + a memory skill).`,
          "",
          `  Manual one-liner equivalent: claude mcp add memos -s user -- ${args}`,
        ].join("\n"),
        configPath: ".mcp.json",
        fileContents: jsonEntry + "\n",
      };
    }
    case "cursor": {
      return {
        instructions: [
          "Cursor — MCP config at ~/.cursor/mcp.json:",
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
          "Windsurf — MCP config at ~/.codeium/windsurf/mcp_config.json:",
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
          "Cline (VS Code) — MCP settings file:",
          "  Windows: %APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json",
          "  macOS:   ~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
          "",
          "Merge this into the mcpServers object:",
          jsonEntry,
        ].join("\n"),
      };
    }
    case "opencode": {
      return {
        instructions: [
          "OpenCode — add to opencode.json (project) or ~/.config/opencode/opencode.json:",
          JSON.stringify(
            {
              mcp: {
                memos: { type: "local", command: MCP_COMMAND },
              },
            },
            null,
            2,
          ),
          "",
          "Or: memos connect opencode --write  (writes ./opencode.json).",
        ].join("\n"),
        configPath: "opencode.json",
        fileContents:
          JSON.stringify(
            { mcp: { memos: { type: "local", command: MCP_COMMAND } } },
            null,
            2,
          ) + "\n",
      };
    }
    case "codex": {
      const toml = `[mcp_servers.memos]\ncommand = "${MCP_COMMAND[0]}"\nargs = [${MCP_COMMAND.slice(
        1,
      )
        .map((a) => `"${a}"`)
        .join(", ")}]\n`;
      return {
        instructions: [
          "Codex CLI — add to ~/.codex/config.toml:",
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
          "Gemini CLI — MCP config at ~/.gemini/settings.json:",
          jsonEntry,
          "",
          "Or: memos connect gemini --write",
        ].join("\n"),
        configPath: join(homeDir(), ".gemini", "settings.json"),
        fileContents: jsonEntry + "\n",
      };
    }
    case "generic":
    case "any":
    case "mcp": {
      // Tool list is injected by the caller from getMcpTools() so the
      // count and names can never go stale.
      const short = (opts.toolNames ?? []).map((n) => n.replace(/^memos_/, ""));
      return {
        instructions: [
          "Any MCP-capable harness — the MemOS server is a plain stdio MCP",
          `server. Launch command: ${MCP_COMMAND.join(" ")}`,
          "",
          "MCP config shape (mcpServers object):",
          jsonEntry,
          "",
          "The server speaks MCP 2026-07-28 with a legacy-2025 fallback and",
          `exposes ${short.length} tools: ${short.join("/")}.`,
          "All data stays in local SQLite.",
        ].join("\n"),
      };
    }
    default:
      console.error(
        "Unknown target. Supported: claude-code, cursor, windsurf, cline, " +
          "opencode, codex, gemini, generic.",
      );
      return null;
  }
}

function homeDir(): string {
  return os.homedir();
}

function existsSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function writeFileSafe(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function printHelp(): void {
  console.log(`
MemOS — Universal memory layer for AI agents.

Usage:
  memos <command> [options]

Commands:
  init                  Interactive setup wizard: database path, embedding
                          provider, smoke test — saves ~/.memos/config.json
                          (--yes accepts all defaults)
  store <content>         Store a new memory (--pool, --context,
                          --scope user:alice[,agent:coder][,run:r1])
  retrieve <id>           Retrieve a memory by ID
  search <query>          Search memories by text (--pool event|note|procedure,
                          --scope user:alice[,...]) (--pool event|note|procedure)
  forget <id>             Delete a memory by ID
  summarize               Summarize all memories
  graph                   Print the full memory graph (--mermaid for a
                          GitHub-renderable Mermaid diagram)
  browse                  Interactive terminal browser (search, inspect,
                          forget memories)
  link <src> <dst>        Link two memories
  count                   Show memory count
  tag <id> <tag> [...]    Add tags to a memory
  untag <id> <tag> [...]  Remove tags from a memory
  list --tag <tag>        List memories by tag
  export                  Export memories to file
  backup                  Backup the database
  restore <path>          Restore from a backup
  import-external <file>  Import a ChatGPT/Claude memory export
                          (--source auto|chatgpt|claude|generic, --dry-run,
                          --max-items <n>, --namespace <ns>)
  import                  Import a chat export: --from chatgpt|claude|slack
                          (--file <path> | --dir <path>, --synthesize,
                          --dry-run, --max-items <n>, --namespace <ns>)
  learn "<lesson>"        Capture a procedural lesson — behavioral guidance,
                          not a fact (--context <ctx>, --tags a,b)
  lesson <id>             Record lesson outcome: --outcome success|failure
                          (reinforces or demotes the lesson score)
  lessons                 List procedural lessons (--namespace <ns>,
                          --limit <n>)
  cite <id>               Trace a [mem:xxxx] citation token back to its
                          full source memory
  quarantine <list|release>
                          Review the write-gate quarantine queue: list
                          flagged memories, release one back into recall
                          (--limit <n>, --json)
  history <id>            Version timeline for one memory: supersedes,
                          superseded by, derived notes
  revert                  Revert a memory to its previous version
                          (--last | --id <id> | --about <topic> |
                          "<natural language>"; --dry-run, --reason <r>,
                          --actor <a>)
  digest                  Run consolidation now and print a summary
  consolidate             Offline maintenance pass: merge duplicates, archive
                          stale memories, supersede decayed ones (kept as
                          history), distill cluster summary notes
                          (--dry-run, --no-summarize, --no-decay,
                          --decay-half-life <days>, --min-retention <score>,
                          --older-than <days>, --namespace <ns>, --watch,
                          --interval-min <n>)
  encrypt                 Encrypt the database in place (--key <key> or
                          MEMOS_KEY; requires better-sqlite3-multiple-ciphers)
  decrypt                 Remove encryption in place (--key <key>)
  stats                   Token-savings telemetry for this process
                          (packs built, tokens injected vs naive baseline)
  doctor                  Health-check the store, embedding config and endpoints
  consolidate             Offline maintenance pass: merge duplicates, archive
                          stale memories, supersede decayed ones (kept as
                          history), distill cluster summary notes
                          (--dry-run, --no-summarize, --no-decay,
                          --decay-half-life <days>, --min-retention <score>,
                          --older-than <days>, --namespace <ns>)
  connect <target>        Register the MemOS MCP server with a coding harness
                          (claude-code, cursor, windsurf, cline, opencode,
                          codex, gemini, generic) — --write saves the config
  reindex-embeddings      Re-embed all memories with the configured provider
                          (--purge-stale deletes vectors from other models first)
  mcp                     Start the MemOS MCP stdio server
  serve                   Start the HTTP server
  trio [--up]             Show (or launch) the full AI Trio: MemOS + LLM-Guardian + Universal-MCP-Toolkit
  help                    Show this help message

Options:
  --db <path>             Database path (default: ~/.memos/memos.db)
  --type <type>           Memory type (store command)
  --ttl <seconds>         TTL in seconds (store command)
  --limit <n>             Result limit (search command)
  --format <fmt>          Export format: json, markdown, obsidian
  --output <path>         Output path (export/backup)
  --tag <tag>             Tag filter (export/list)
  --json                  Output as JSON

Examples:
  memos store "User prefers dark mode" --type preference
  memos store "Temp note" --ttl 3600
  memos search "dark mode" --limit 5
  memos graph --mermaid > graph.mmd
  memos browse
  memos tag <id> work important
  memos list --tag work
  memos export --format markdown --output ./my-export
  memos backup --output ./backup.db
  memos restore ./backup.db
  memos mcp --db ~/.memos/memos.db
`);
}

async function main(): Promise<void> {
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp();
    process.exit(0);
  }

  const dbFlagIdx = args.indexOf("--db");
  const cliDbPath = dbFlagIdx !== -1 ? args[dbFlagIdx + 1] : undefined;
  // --db wins, then ~/.memos/config.json (written by `memos init`), then the
  // SDK default (~/.memos/memos.db).
  const dbPath = resolveDbPath(cliDbPath);
  const jsonFlag = args.includes("--json");
  // Encryption key for at-rest-encrypted databases: --key or MEMOS_KEY.
  // encrypt/decrypt are excluded — they perform the conversion itself and
  // must open the source at its CURRENT (pre/post conversion) state.
  const keyFlagIdx = args.indexOf("--key");
  const cipherKey =
    command === "encrypt" || command === "decrypt"
      ? undefined
      : keyFlagIdx !== -1
        ? args[keyFlagIdx + 1]
        : process.env.MEMOS_KEY;

  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    const embeddings = resolveCliEmbeddingsConfig();
    await runMcpServer({
      dbPath,
      ...(embeddings ? { embeddings: { ...embeddings, enabled: true } } : {}),
    });
    return;
  }

  // Encrypt/decrypt operate on the raw database file and must run BEFORE
  // the store is opened (Windows refuses to rename an open file).
  if (command === "encrypt" || command === "decrypt") {
    const keyIdx = args.indexOf("--key");
    const key = keyIdx !== -1 ? args[keyIdx + 1] : process.env.MEMOS_KEY;
    if (!key) {
      console.error(
        "Error: --key <key> (or the MEMOS_KEY environment variable) is required.",
      );
      process.exit(1);
    }
    if (!dbPath) {
      console.error("Error: --db <path> is required.");
      process.exit(1);
    }
    const { encryptDatabase, decryptDatabase } =
      await import("./storage/sqlite.js");
    const backup =
      command === "encrypt"
        ? await encryptDatabase(dbPath, key)
        : await decryptDatabase(dbPath, key);
    if (jsonFlag) {
      console.log(JSON.stringify({ command, dbPath, backup }, null, 2));
    } else {
      console.log(
        `${command === "encrypt" ? "Encrypted" : "Decrypted"}: ${dbPath}`,
      );
      console.log(`  previous file kept as ${backup}`);
      console.log(
        command === "encrypt"
          ? "  From now on provide the key: --key, MEMOS_KEY, or cipherKey config."
          : "  The database is now plaintext.",
      );
    }
    return;
  }

  // Embedding config via environment (same variables the Python server
  // and benchmark scripts accept). Without MEMOS_EMBEDDING_PROVIDER the
  // SDK default applies: embeddings enabled with the local fastembed
  // provider (real ONNX embeddings when @huggingface/transformers is
  // installed, loud local-hash fallback otherwise).
  const embeddingsConfig = cliEmbeddingsConfig();
  const memos = new MemOS({
    dbPath,
    ...(cipherKey ? { cipherKey } : {}),
    ...(embeddingsConfig
      ? { embeddings: { ...embeddingsConfig, enabled: true } }
      : {}),
  });
  await memos.init();

  try {
    switch (command) {
      case "store": {
        const content = args[1];
        if (!content) {
          console.error(
            "Error: content is required.\n  Usage: memos store <content>",
          );
          process.exit(1);
        }
        const typeIdx = args.indexOf("--type");
        const type = typeIdx !== -1 ? args[typeIdx + 1] : undefined;
        const ttlIdx = args.indexOf("--ttl");
        const ttl = ttlIdx !== -1 ? parseInt(args[ttlIdx + 1], 10) : undefined;
        const tagIdx = args.indexOf("--tag");
        let tags: string[] | undefined;
        if (tagIdx !== -1) {
          tags = [];
          for (let i = tagIdx + 1; i < args.length; i++) {
            if (args[i].startsWith("--")) break;
            tags.push(args[i]);
          }
          if (tags.length === 0) tags = undefined;
        }
        const opts: Record<string, unknown> = {};
        if (type) opts.type = type;
        if (ttl) opts.ttl = ttl;
        if (tags && tags.length > 0) opts.tags = tags;
        const poolIdx = args.indexOf("--pool");
        const pool = poolIdx !== -1 ? args[poolIdx + 1] : undefined;
        if (pool === "event" || pool === "note" || pool === "procedure") {
          opts.pool = pool;
        }
        const contextIdx = args.indexOf("--context");
        const context = contextIdx !== -1 ? args[contextIdx + 1] : undefined;
        if (context) opts.context = context;
        const scopeIdx = args.indexOf("--scope");
        if (scopeIdx !== -1 && args[scopeIdx + 1]) {
          opts.scope = parseScopeArg(args[scopeIdx + 1]);
        }
        const result = await memos.store(
          content,
          opts as unknown as Omit<CreateMemoryInput, "content">,
        );
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Stored memory: ${result.node.id}`);
          console.log(`  Summary: ${result.node.summary}`);
          if (result.node.expiresAt) {
            const expDate = new Date(
              result.node.expiresAt * 1000,
            ).toISOString();
            console.log(`  Expires: ${expDate}`);
          }
          if (result.node.tags.length > 0) {
            console.log(`  Tags: ${result.node.tags.join(", ")}`);
          }
          if (result.links.length > 0) {
            console.log(
              `  Auto-linked to ${result.links.length} existing memories`,
            );
          }
        }
        break;
      }

      case "retrieve": {
        const id = args[1];
        if (!id) {
          console.error("Error: ID is required.\n  Usage: memos retrieve <id>");
          process.exit(1);
        }
        const node = await memos.retrieve(id);
        if (!node) {
          console.error(`Memory not found: ${id}`);
          process.exit(1);
        }
        if (jsonFlag) {
          console.log(JSON.stringify(node, null, 2));
        } else {
          console.log(`[${node.type}] ${node.content}`);
          console.log(`  ID: ${node.id}`);
          console.log(`  Importance: ${node.importance}`);
          console.log(`  Access count: ${node.accessCount}`);
          console.log(`  Created: ${new Date(node.createdAt).toISOString()}`);
          if (node.tags.length > 0) {
            console.log(`  Tags: ${node.tags.join(", ")}`);
          }
          if (node.expiresAt) {
            console.log(
              `  Expires: ${new Date(node.expiresAt * 1000).toISOString()}`,
            );
          }
        }
        break;
      }

      case "search": {
        const query = args[1];
        if (!query) {
          console.error(
            "Error: query is required.\n  Usage: memos search <query>",
          );
          process.exit(1);
        }
        const limitIdx = args.indexOf("--limit");
        const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 10;
        const poolIdx = args.indexOf("--pool");
        const poolArg = poolIdx !== -1 ? args[poolIdx + 1] : undefined;
        const pool = poolArg
          ? (poolArg.split(",").map((p) => p.trim()) as MemoryPool[])
          : undefined;
        const scopeIdx = args.indexOf("--scope");
        const scopeArg = scopeIdx !== -1 ? args[scopeIdx + 1] : undefined;
        const scope = scopeArg ? parseScopeArg(scopeArg) : undefined;
        const tagIdx = args.indexOf("--tag");
        let searchTags: string[] | undefined;
        if (tagIdx !== -1) {
          searchTags = [];
          for (let i = tagIdx + 1; i < args.length; i++) {
            if (args[i].startsWith("--")) break;
            searchTags.push(args[i]);
          }
          if (searchTags.length === 0) searchTags = undefined;
        }
        const results = await memos.search({
          query,
          limit,
          tags: searchTags,
          ...(pool ? { pool } : {}),
          ...(scope && Object.keys(scope).length > 0 ? { scope } : {}),
        });
        if (jsonFlag) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log("No memories found.");
          } else {
            console.log(`Found ${results.length} memories:\n`);
            for (const r of results) {
              console.log(`  [${r.node.type}] ${r.node.content}`);
              console.log(`    ID: ${r.node.id}  Score: ${r.score.toFixed(3)}`);
              if (r.node.tags.length > 0) {
                console.log(`    Tags: ${r.node.tags.join(", ")}`);
              }
            }
          }
        }
        break;
      }

      case "forget": {
        const id = args[1];
        if (!id) {
          console.error("Error: ID is required.\n  Usage: memos forget <id>");
          process.exit(1);
        }
        const deleted = await memos.forget(id);
        if (jsonFlag) {
          console.log(JSON.stringify({ deleted, id }));
        } else {
          console.log(
            deleted ? `Forgot memory: ${id}` : `Memory not found: ${id}`,
          );
        }
        break;
      }

      case "summarize": {
        const summary = await memos.summarize();
        if (jsonFlag) {
          console.log(JSON.stringify({ summary }));
        } else {
          console.log(summary);
        }
        break;
      }

      case "graph": {
        const graph = await memos.getGraph();
        if (args.includes("--mermaid")) {
          console.log(graphToMermaid(graph));
        } else if (jsonFlag) {
          console.log(JSON.stringify(graph, null, 2));
        } else {
          console.log(
            `Memory Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges\n`,
          );
          for (const node of graph.nodes) {
            console.log(
              `  [${node.type}] ${node.id.slice(0, 8)} — ${node.content.slice(0, 60)}`,
            );
          }
          if (graph.edges.length > 0) {
            console.log("\nEdges:");
            for (const edge of graph.edges) {
              console.log(
                `  ${edge.sourceId.slice(0, 8)} --[${edge.relation}]--> ${edge.targetId.slice(0, 8)}`,
              );
            }
          }
        }
        break;
      }

      case "browse": {
        const { runBrowse } = await import("./cli-browse.js");
        await runBrowse(memos);
        break;
      }

      case "import-external": {
        const file = args[1];
        if (!file) {
          console.error(
            "Error: export file is required.\n  Usage: memos import-external <file> [--source auto|chatgpt|claude|generic] [--dry-run]",
          );
          process.exit(1);
        }
        const sourceIdx = args.indexOf("--source");
        const importSource =
          sourceIdx !== -1
            ? (args[sourceIdx + 1] as "auto" | "chatgpt" | "claude" | "generic")
            : "auto";
        const maxItemsIdx = args.indexOf("--max-items");
        const maxItems =
          maxItemsIdx !== -1 ? parseInt(args[maxItemsIdx + 1], 10) : undefined;
        const nsIdx = args.indexOf("--namespace");
        const namespace = nsIdx !== -1 ? args[nsIdx + 1] : undefined;
        const result = await memos.importExternal({
          file,
          ...(importSource ? { source: importSource } : {}),
          ...(maxItems !== undefined && !Number.isNaN(maxItems)
            ? { maxItems }
            : {}),
          ...(namespace ? { namespace } : {}),
          dryRun: args.includes("--dry-run"),
        });
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `Import from ${result.detected} export ${result.dryRun ? "(dry run)" : "complete"}: ${result.imported} imported, ${result.skipped} skipped of ${result.total} item(s)`,
          );
        }
        break;
      }

      case "import": {
        const fromIdx = args.indexOf("--from");
        const from = fromIdx !== -1 ? args[fromIdx + 1] : undefined;
        if (from !== "chatgpt" && from !== "claude" && from !== "slack") {
          console.error(
            "Error: --from is required.\\n  Usage: memos import --from chatgpt|claude|slack (--file <path> | --dir <path>) [--synthesize] [--dry-run] [--max-items <n>] [--namespace <ns>] [--tags a,b]",
          );
          process.exit(1);
        }
        const fileIdx = args.indexOf("--file");
        const file = fileIdx !== -1 ? args[fileIdx + 1] : undefined;
        const dirIdx = args.indexOf("--dir");
        const dir = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
        if (!file && !dir) {
          console.error(
            "Error: --file or --dir is required.\\n  Usage: memos import --from chatgpt|claude|slack (--file <path> | --dir <path>)",
          );
          process.exit(1);
        }
        if (from === "slack" && !dir) {
          console.error(
            "Error: Slack imports require --dir (the export folder with channels.json).",
          );
          process.exit(1);
        }
        const maxItemsIdx = args.indexOf("--max-items");
        const maxItems =
          maxItemsIdx !== -1 ? parseInt(args[maxItemsIdx + 1], 10) : undefined;
        const nsIdx = args.indexOf("--namespace");
        const namespace = nsIdx !== -1 ? args[nsIdx + 1] : undefined;
        const tagsIdx = args.indexOf("--tags");
        const importTags =
          tagsIdx !== -1
            ? args[tagsIdx + 1]
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
            : undefined;
        const result = await memos.importExternal({
          source: from,
          ...(file ? { file } : {}),
          ...(dir ? { dir } : {}),
          ...(maxItems !== undefined && !Number.isNaN(maxItems)
            ? { maxItems }
            : {}),
          ...(namespace ? { namespace } : {}),
          ...(importTags ? { tags: importTags } : {}),
          dryRun: args.includes("--dry-run"),
          synthesize: args.includes("--synthesize"),
        });
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `Import from ${result.detected} export${result.dryRun ? " (dry run)" : ""}: ${result.imported} imported, ${result.skipped} skipped of ${result.total} item(s)`,
          );
          const s = result.synthesized;
          if (s.decisions + s.preferences + s.milestones > 0) {
            console.log(
              `Synthesized: ${s.decisions} decision(s), ${s.preferences} preference(s), ${s.milestones} milestone(s)`,
            );
          }
        }
        break;
      }

      case "learn": {
        const lesson = args[1];
        if (!lesson) {
          console.error(
            'Error: lesson text is required.\\n  Usage: memos learn "<lesson>" [--context <ctx>] [--tags a,b] [--namespace <ns>]',
          );
          process.exit(1);
        }
        const contextIdx = args.indexOf("--context");
        const context = contextIdx !== -1 ? args[contextIdx + 1] : undefined;
        const tagsIdx = args.indexOf("--tags");
        const tags =
          tagsIdx !== -1
            ? args[tagsIdx + 1]
                .split(",")
                .map((t) => t.trim())
                .filter((t) => t.length > 0)
            : undefined;
        const nsIdx = args.indexOf("--namespace");
        const namespace = nsIdx !== -1 ? args[nsIdx + 1] : undefined;
        const saved = await memos.memorizeProcedural(lesson, {
          ...(context ? { context } : {}),
          ...(tags ? { tags } : {}),
          ...(namespace ? { namespace } : {}),
        });
        if (jsonFlag) {
          console.log(JSON.stringify(saved, null, 2));
        } else {
          console.log(
            `Learned [${saved.id.slice(0, 8)}] (score ${saved.score.toFixed(2)}): ${saved.lesson}`,
          );
        }
        break;
      }

      case "lesson": {
        const id = args[1];
        const outcomeIdx = args.indexOf("--outcome");
        const outcome = outcomeIdx !== -1 ? args[outcomeIdx + 1] : undefined;
        if (!id || (outcome !== "success" && outcome !== "failure")) {
          console.error(
            "Error: lesson ID and --outcome are required.\\n  Usage: memos lesson <id> --outcome success|failure",
          );
          process.exit(1);
        }
        try {
          const updated = await memos.recordLessonOutcome(id, outcome);
          if (jsonFlag) {
            console.log(JSON.stringify(updated, null, 2));
          } else {
            console.log(
              `Lesson [${updated.id.slice(0, 8)}] ${outcome}: score ${updated.score.toFixed(2)} (${updated.successCount} success, ${updated.failureCount} failure, ${updated.useCount} uses)`,
            );
          }
        } catch (err) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
        break;
      }

      case "lessons": {
        const nsIdx = args.indexOf("--namespace");
        const namespace = nsIdx !== -1 ? args[nsIdx + 1] : undefined;
        const limitIdx = args.indexOf("--limit");
        const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 20;
        const lessons = await memos.listProceduralLessons({
          ...(namespace ? { namespace } : {}),
        });
        const shown = Number.isNaN(limit) ? lessons : lessons.slice(0, limit);
        if (jsonFlag) {
          console.log(JSON.stringify(shown, null, 2));
        } else if (shown.length === 0) {
          console.log(
            'No procedural lessons yet. Teach one: memos learn "..."',
          );
        } else {
          console.log(`Procedural lessons (${shown.length}):\\n`);
          for (const l of shown) {
            console.log(
              `  [${l.id.slice(0, 8)}] score ${l.score.toFixed(2)} · ${l.useCount} uses (${l.successCount}✓/${l.failureCount}✗)`,
            );
            console.log(`    ${l.lesson}`);
            if (l.context) console.log(`    when: ${l.context}`);
          }
        }
        break;
      }

      case "cite": {
        const id = args[1];
        if (!id) {
          console.error(
            "Error: citation ID is required.\\n  Usage: memos cite <id>  (accepts [mem:a3f9], a3f9, or a full ID)",
          );
          process.exit(1);
        }
        const resolution = await memos.resolveCitation(id);
        console.log(memos.formatCitation(resolution, jsonFlag));
        if (resolution.status === "not_found") process.exit(1);
        break;
      }

      case "quarantine": {
        const { formatQuarantineList, releaseQuarantined } =
          await import("./quarantine-commands.js");
        const sub = args[1];
        if (sub === "list") {
          const limitIdx = args.indexOf("--limit");
          const limit =
            limitIdx !== -1 ? parseInt(args[limitIdx + 1]!, 10) : undefined;
          const nodes = await memos.listQuarantined(
            limit !== undefined && !Number.isNaN(limit) ? { limit } : {},
          );
          console.log(formatQuarantineList(nodes, jsonFlag));
          break;
        }
        if (sub === "release") {
          const id = args[2];
          if (!id) {
            console.error(
              "Error: memory ID is required.\n  Usage: memos quarantine release <id>",
            );
            process.exit(1);
          }
          try {
            console.log(await releaseQuarantined(memos, id, jsonFlag));
          } catch (err) {
            console.error(`Error: ${(err as Error).message}`);
            process.exit(1);
          }
          break;
        }
        console.error(
          "Error: subcommand is required.\n  Usage: memos quarantine <list|release>  (list [--limit <n>] [--json], release <id> [--json])",
        );
        process.exit(1);
      }

      case "stats": {
        const usage = memos.usageStats();
        if (jsonFlag) {
          console.log(JSON.stringify(usage, null, 2));
        } else {
          console.log("Context-pack token telemetry (this process):");
          console.log(`  packs built:   ${usage.packsBuilt}`);
          console.log(`  tokens injected: ${usage.packTokens}`);
          console.log(
            `  naive baseline:  ${usage.naiveBaselineTokens} (raw node JSON, same candidates)`,
          );
          console.log(
            `  saved:           ${usage.savedTokens} tok (${usage.savedPct}%)`,
          );
        }
        break;
      }

      case "consolidate": {
        const dryRun = args.includes("--dry-run");
        const summarize = !args.includes("--no-summarize");
        const decay = !args.includes("--no-decay");
        const nsIdx = args.indexOf("--namespace");
        const namespace = nsIdx !== -1 ? args[nsIdx + 1] : undefined;
        const halfLifeIdx = args.indexOf("--decay-half-life");
        const decayHalfLifeDays =
          halfLifeIdx !== -1 ? Number(args[halfLifeIdx + 1]) : undefined;
        const minRetentionIdx = args.indexOf("--min-retention");
        const minRetentionScore =
          minRetentionIdx !== -1
            ? Number(args[minRetentionIdx + 1])
            : undefined;
        const olderThanIdx = args.indexOf("--older-than");
        const olderThanDays =
          olderThanIdx !== -1 ? Number(args[olderThanIdx + 1]) : undefined;

        // Watch mode: self-maintaining memory. Runs the full consolidation
        // immediately, then every interval until interrupted. Each cycle
        // prints a one-line digest.
        if (args.includes("--watch")) {
          const intervalIdx = args.indexOf("--interval-min");
          const intervalMin = Math.max(
            1,
            intervalIdx !== -1 ? parseInt(args[intervalIdx + 1], 10) || 30 : 30,
          );
          const consolidateOpts = {
            ...(namespace ? { namespace } : {}),
            dryRun,
            summarize,
            decay,
            ...(decayHalfLifeDays !== undefined &&
            !Number.isNaN(decayHalfLifeDays)
              ? { decayHalfLifeDays }
              : {}),
            ...(minRetentionScore !== undefined &&
            !Number.isNaN(minRetentionScore)
              ? { minRetentionScore }
              : {}),
            ...(olderThanDays !== undefined && !Number.isNaN(olderThanDays)
              ? { olderThanDays }
              : {}),
          };
          console.log(
            `consolidation watch: every ${intervalMin} min — ctrl+c to stop`,
          );
          for (;;) {
            const started = Date.now();
            try {
              const result = await memos.consolidate(consolidateOpts);
              const usage = memos.usageStats();
              console.log(
                `[${new Date().toISOString()}] merged ${result.merges.length} · archived ${result.moves.length} · decayed ${result.decayed.length} · notes ${result.clusters.length} · ${usage.packTokens} tok injected (${usage.savedPct}% saved) — ${Date.now() - started} ms`,
              );
            } catch (error) {
              console.error(
                "consolidation cycle failed:",
                error instanceof Error ? error.message : String(error),
              );
            }
            await new Promise((resolve) =>
              setTimeout(resolve, intervalMin * 60_000),
            );
          }
        }

        const result = await memos.consolidate({
          ...(namespace ? { namespace } : {}),
          dryRun,
          summarize,
          decay,
          ...(decayHalfLifeDays !== undefined &&
          !Number.isNaN(decayHalfLifeDays)
            ? { decayHalfLifeDays }
            : {}),
          ...(minRetentionScore !== undefined &&
          !Number.isNaN(minRetentionScore)
            ? { minRetentionScore }
            : {}),
          ...(olderThanDays !== undefined && !Number.isNaN(olderThanDays)
            ? { olderThanDays }
            : {}),
        });

        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `Consolidation ${dryRun ? "(dry run — nothing changed)" : "complete"} in ${result.durationMs} ms`,
          );
          console.log(
            `  merged:   ${result.merges.length} duplicate cluster(s)`,
          );
          console.log(`  archived: ${result.moves.length} memory(ies)`);
          console.log(
            `  decayed:  ${result.decayed.length} superseded (kept as history — queryable via searchTemporal)`,
          );
          console.log(
            `  notes:    ${result.clusters.length} cluster summary(ies)`,
          );
          for (const cluster of result.clusters) {
            if (cluster.summaryId) {
              console.log(
                `    - ${cluster.summaryId.slice(0, 8)}: ${cluster.summary.slice(0, 72)}`,
              );
            }
          }
        }
        break;
      }

      case "digest": {
        const result = await memos.consolidate({
          summarize: !args.includes("--no-summarize"),
        });
        const usage = memos.usageStats();
        if (jsonFlag) {
          console.log(JSON.stringify({ result, usage }, null, 2));
        } else {
          console.log("Memory digest:");
          console.log(
            `  learned/merged:  ${result.merges.length} duplicate cluster(s) merged`,
          );
          console.log(`  superseded:      ${result.decayed.length} decayed`);
          console.log(`  archived:        ${result.moves.length} moved aside`);
          console.log(
            `  new notes:       ${result.clusters.length} cluster summary(ies)`,
          );
          console.log(
            `  context packs:   ${usage.packsBuilt} built · ${usage.savedPct}% tokens saved vs raw JSON`,
          );
        }
        break;
      }

      case "history": {
        const id = args[1];
        if (!id) {
          console.error(
            "Error: memory ID is required.\n  Usage: memos history <id>",
          );
          process.exit(1);
        }
        const timeline = await memos.history(id);
        if (jsonFlag) {
          console.log(JSON.stringify(timeline, null, 2));
          break;
        }
        const node = timeline.node;
        const validity =
          node.validFrom || node.validTo
            ? `${node.validFrom ? new Date(node.validFrom).toISOString().slice(0, 10) : "…"} → ${node.validTo ? new Date(node.validTo).toISOString().slice(0, 10) : "present"}`
            : "always";
        console.log(`Memory ${node.id}`);
        console.log(
          `  type: ${node.type} · trust: ${node.trustScore.toFixed(2)} · valid: ${validity}`,
        );
        console.log(`  ${node.content}`);
        if (timeline.supersedes.length > 0) {
          console.log(`\nSupersedes (older versions):`);
          for (const version of timeline.supersedes) {
            console.log(
              `  ← [${version.node.createdAt ? new Date(version.node.createdAt).toISOString().slice(0, 10) : "?"}] ${version.node.id.slice(0, 8)} — ${version.node.content.slice(0, 60)}`,
            );
          }
        }
        if (timeline.supersededBy.length > 0) {
          console.log(`\nSuperseded by (newer versions):`);
          for (const version of timeline.supersededBy) {
            console.log(
              `  → [${new Date(version.node.createdAt).toISOString().slice(0, 10)}] ${version.node.id.slice(0, 8)} — ${version.node.content.slice(0, 60)}`,
            );
          }
        }
        if (timeline.derivedNotes.length > 0) {
          console.log(`\nDerived notes: ${timeline.derivedNotes.length}`);
          for (const note of timeline.derivedNotes) {
            console.log(
              `  ¶ ${note.id.slice(0, 8)} — ${note.content.slice(0, 60)}`,
            );
          }
        }
        if (
          timeline.supersedes.length === 0 &&
          timeline.supersededBy.length === 0
        ) {
          console.log(
            "\nNo related versions found (this is the only version).",
          );
        }
        break;
      }

      case "revert": {
        const parsed = parseRevertCliArgs(args.slice(1));
        if (parsed.error) {
          console.error(`Error: ${parsed.error}`);
          process.exit(1);
        }
        try {
          const result = await memos.revert(parsed.scope, {
            dryRun: parsed.dryRun,
            ...(parsed.reason ? { reason: parsed.reason } : {}),
            ...(parsed.actor ? { actor: parsed.actor } : {}),
            ...(parsed.namespace ? { namespace: parsed.namespace } : {}),
          });
          if (jsonFlag) {
            console.log(JSON.stringify(result, null, 2));
          } else if (result.dryRun) {
            console.log("Dry run — nothing was changed.");
            console.log(
              `  Would revert:  ${result.target.id.slice(0, 8)} — ${result.target.content.slice(0, 80)}`,
            );
            console.log(
              `  Would restore: ${result.predecessor.id.slice(0, 8)} — ${result.predecessor.content.slice(0, 80)}`,
            );
            if (result.alternatives.length > 0) {
              console.log("  Other candidates (not chosen):");
              for (const alt of result.alternatives) {
                console.log(
                  `    ${alt.node.id.slice(0, 8)} — ${alt.node.content.slice(0, 60)}`,
                );
              }
            }
          } else {
            console.log(
              `Reverted ${result.target.id.slice(0, 8)} — restored predecessor ${result.predecessor.id.slice(0, 8)}.`,
            );
            console.log(
              `  Now believed: ${result.predecessor.content.slice(0, 100)}`,
            );
            console.log(`  Audit event: ${result.auditId}`);
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
        break;
      }

      case "link": {
        const sourceId = args[1];
        const targetId = args[2];
        if (!sourceId || !targetId) {
          console.error(
            "Error: source and target IDs are required.\n  Usage: memos link <source-id> <target-id>",
          );
          process.exit(1);
        }
        const edge = await memos.link(sourceId, targetId);
        if (jsonFlag) {
          console.log(JSON.stringify(edge, null, 2));
        } else {
          console.log(
            `Linked: ${sourceId.slice(0, 8)} --[${edge.relation}]--> ${targetId.slice(0, 8)}`,
          );
        }
        break;
      }

      case "count": {
        if (jsonFlag) {
          console.log(JSON.stringify({ count: memos.count }));
        } else {
          console.log(`${memos.count} memories stored.`);
        }
        break;
      }

      case "tag": {
        const id = args[1];
        const tags = nonFlagArgs(args, 2);
        if (!id || tags.length === 0) {
          console.error(
            "Error: ID and at least one tag are required.\n  Usage: memos tag <id> <tag1> [tag2...]",
          );
          process.exit(1);
        }
        await memos.tag(id, tags);
        if (jsonFlag) {
          console.log(JSON.stringify({ id, tags, tagged: true }));
        } else {
          console.log(`Tagged ${id.slice(0, 8)} with: ${tags.join(", ")}`);
        }
        break;
      }

      case "untag": {
        const id = args[1];
        const tags = nonFlagArgs(args, 2);
        if (!id || tags.length === 0) {
          console.error(
            "Error: ID and at least one tag are required.\n  Usage: memos untag <id> <tag1> [tag2...]",
          );
          process.exit(1);
        }
        await memos.untag(id, tags);
        if (jsonFlag) {
          console.log(JSON.stringify({ id, tags, untagged: true }));
        } else {
          console.log(
            `Removed tags from ${id.slice(0, 8)}: ${tags.join(", ")}`,
          );
        }
        break;
      }

      case "list": {
        const tagIdx = args.indexOf("--tag");
        if (tagIdx === -1 || !args[tagIdx + 1]) {
          console.error(
            "Error: --tag is required.\n  Usage: memos list --tag <tag>",
          );
          process.exit(1);
        }
        const tag = args[tagIdx + 1];
        const nodes = await memos.listByTag(tag);
        if (jsonFlag) {
          console.log(JSON.stringify(nodes, null, 2));
        } else {
          if (nodes.length === 0) {
            console.log(`No memories with tag: ${tag}`);
          } else {
            console.log(`Found ${nodes.length} memories with tag "${tag}":\n`);
            for (const node of nodes) {
              console.log(
                `  [${node.type}] ${node.id.slice(0, 8)} — ${node.content.slice(0, 60)}`,
              );
            }
          }
        }
        break;
      }

      case "export": {
        const formatIdx = args.indexOf("--format");
        const format = formatIdx !== -1 ? args[formatIdx + 1] : "json";
        const outputIdx = args.indexOf("--output");
        const output = outputIdx !== -1 ? args[outputIdx + 1] : undefined;
        const tagIdx = args.indexOf("--tag");
        const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;

        if (!["json", "markdown", "obsidian"].includes(format)) {
          console.error(
            `Error: Invalid format: ${format}. Use json, markdown, or obsidian.`,
          );
          process.exit(1);
        }

        const result = await memos.export({
          format: format as ExportFormat,
          output,
          tag,
        });
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (format === "json") {
            // Write to file
            const outPath = output ?? "./memos-export/memories.json";
            const dir = dirname(outPath);
            if (!existsSync(dir)) {
              const fs = await import("fs");
              fs.mkdirSync(dir, { recursive: true });
            }
            writeFileSync(outPath, result.data);
            console.log(`Exported ${result.count} memories to ${outPath}`);
          } else {
            console.log(`Exported ${result.count} memories to ${result.data}/`);
          }
        }
        break;
      }

      case "backup": {
        const outputIdx = args.indexOf("--output");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const defaultPath = `./memos-backup-${timestamp}.db`;
        const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : defaultPath;

        const resolvedDb = resolve(
          dbPath ??
            (await import("path")).join(
              process.env.HOME || process.env.USERPROFILE || ".",
              ".memos/memos.db",
            ),
        );
        const resolvedOut = resolve(outputPath);

        if (!existsSync(resolvedDb)) {
          console.error(`Error: Database not found at ${resolvedDb}`);
          process.exit(1);
        }

        // Close before copying
        await memos.close();

        copyFileSync(resolvedDb, resolvedOut);

        // Get stats for manifest
        const dbStat = statSync(resolvedDb);
        // Re-open to get counts
        const tmpMemos = new MemOS({ dbPath: resolvedDb });
        await tmpMemos.init();
        const graph = await tmpMemos.getGraph();
        await tmpMemos.close();

        const manifest = {
          timestamp: new Date().toISOString(),
          version: getSdkVersion(),
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          dbSizeBytes: dbStat.size,
        };

        const manifestPath = `${resolvedOut}.manifest.json`;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        if (jsonFlag) {
          console.log(
            JSON.stringify({ backup: resolvedOut, manifest }, null, 2),
          );
        } else {
          console.log(`Backup created: ${resolvedOut}`);
          console.log(
            `  Nodes: ${manifest.nodeCount}, Edges: ${manifest.edgeCount}`,
          );
          console.log(
            `  DB size: ${(manifest.dbSizeBytes / 1024).toFixed(1)} KB`,
          );
          console.log(`  Manifest: ${manifestPath}`);
        }
        break;
      }

      case "restore": {
        const path = args[1];
        if (!path) {
          console.error(
            "Error: backup path is required.\n  Usage: memos restore <path>",
          );
          process.exit(1);
        }

        const resolvedBackup = resolve(path);
        const manifestPath = `${resolvedBackup}.manifest.json`;

        if (!existsSync(resolvedBackup)) {
          console.error(`Error: Backup file not found: ${resolvedBackup}`);
          process.exit(1);
        }

        // Validate manifest
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          if (jsonFlag) {
            console.log(JSON.stringify({ manifest }, null, 2));
          } else {
            console.log(`Backup manifest:`);
            console.log(`  Timestamp: ${manifest.timestamp}`);
            console.log(`  Version: ${manifest.version}`);
            console.log(
              `  Nodes: ${manifest.nodeCount}, Edges: ${manifest.edgeCount}`,
            );
          }
        }

        // Stop sweep, close DB
        await memos.close();

        const resolvedDb = resolve(
          dbPath ??
            (await import("path")).join(
              process.env.HOME || process.env.USERPROFILE || ".",
              ".memos/memos.db",
            ),
        );
        const dbDir = dirname(resolvedDb);
        if (!existsSync(dbDir)) {
          const fs = await import("fs");
          fs.mkdirSync(dbDir, { recursive: true });
        }

        copyFileSync(resolvedBackup, resolvedDb);

        // Re-open and report
        const restored = new MemOS({ dbPath: resolvedDb });
        await restored.init();
        const graph = await restored.getGraph();
        await restored.close();

        if (!jsonFlag) {
          console.log(`\nRestored from: ${resolvedBackup}`);
          console.log(
            `  Nodes: ${graph.nodes.length}, Edges: ${graph.edges.length}`,
          );
        }
        break;
      }

      case "doctor": {
        const jsonOut = jsonFlag;
        const report: Record<string, unknown> = {};
        const problems: string[] = [];
        const suggestions: string[] = [];

        // 1. Store health.
        const diag = await memos.diagnostics();
        report.store = {
          totalMemories: diag.totalNodes,
          totalEdges: diag.totalEdges,
          nodesWithEmbeddings: diag.nodesWithEmbeddings,
          dbSizeBytes: diag.dbSizeBytes ?? null,
        };
        if (jsonOut) {
          // detailed JSON path prints below
        } else {
          console.log(
            `Store: ${diag.totalNodes} memories, ${diag.totalEdges} edges, ` +
              `${diag.nodesWithEmbeddings} with embeddings.`,
          );
        }

        // 2. Embedding coverage — partial coverage silently weakens the
        //    semantic leg.
        if (diag.totalNodes > 0 && diag.nodesWithEmbeddings < diag.totalNodes) {
          problems.push(
            `Only ${diag.nodesWithEmbeddings}/${diag.totalNodes} memories have embeddings.`,
          );
          suggestions.push(
            "Run `memos reindex-embeddings` to backfill missing vectors.",
          );
        }

        // 3. Embedding model mix — mixed models mean the semantic leg is
        //    comparing against a subset only.
        const storage = (memos as unknown as { storage: SQLiteStorage })
          .storage;
        if (storage.getEmbeddingModelCounts) {
          const counts: Array<{ model: string; count: number }> =
            (await storage.getEmbeddingModelCounts?.()) ?? [];
          report.embeddingModels = counts;
          if (counts.length > 1) {
            problems.push(
              `Embeddings from ${counts.length} different models: ` +
                counts
                  .map(
                    (c: { model: string; count: number }) =>
                      `${c.model}×${c.count}`,
                  )
                  .join(", ") +
                " — vectors from different models are never compared.",
            );
            suggestions.push(
              "Run `memos reindex-embeddings --purge-stale` after switching models.",
            );
          }
          if (!jsonOut) {
            console.log(
              "Embedding models: " +
                (counts.length
                  ? counts
                      .map(
                        (c: { model: string; count: number }) =>
                          `${c.model} (${c.count})`,
                      )
                      .join(", ")
                  : "none stored"),
            );
          }
        }

        // 4. Provider probe — embed one query and report what actually loaded.
        const embeddings = cliEmbeddingsConfig();
        if (embeddings?.provider && embeddings.baseUrl) {
          const started = Date.now();
          try {
            const probe = await fetch(
              `${embeddings.baseUrl.replace(/\/+$/, "")}/models`,
              { signal: AbortSignal.timeout(4_000) },
            );
            report.embeddingEndpoint = {
              url: embeddings.baseUrl,
              reachable: probe.ok,
              ms: Date.now() - started,
            };
            if (!jsonOut) {
              console.log(
                `Embedding endpoint ${embeddings.baseUrl}: reachable (${probe.status}) in ${Date.now() - started}ms.`,
              );
            }
          } catch (err) {
            problems.push(
              `Embedding endpoint ${embeddings.baseUrl} unreachable: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
            suggestions.push(
              "Start llama-server (--embedding) or unset MEMOS_EMBEDDING_* to fall back to the hash embedder.",
            );
          }
        } else {
          // Default path (no MEMOS_EMBEDDING_*): the SDK resolves its
          // default provider during the semantic probe below; the
          // runtime-info report after step 5 shows what actually loaded.
        }

        // 5. Semantic probe — does a search actually come back?
        const t0 = Date.now();
        const probeResults = await memos.search({
          query: "doctor connectivity probe",
          limit: 1,
        });
        report.semanticProbe = {
          ok: true,
          ms: Date.now() - t0,
          hits: probeResults.length,
        };
        if (!jsonOut) {
          console.log(
            `Semantic search probe: ok (${Date.now() - t0}ms, ${probeResults.length} candidate).`,
          );
        }

        // 5b. Provider runtime info — the semantic probe above forced the
        // provider to resolve, so fallbackActive is accurate here.
        if (!(embeddings?.provider && embeddings.baseUrl)) {
          const info = memos.getEmbeddingRuntimeInfo();
          report.embeddingProvider = info;
          if (!jsonOut) {
            if (!info) {
              console.log(
                "Embeddings disabled — semantic search falls back to keyword scoring.",
              );
            } else if (info.fallbackActive) {
              problems.push(
                `Embedding fallback active: ${info.fallbackReason}.`,
              );
              suggestions.push(
                "Install @huggingface/transformers for real local embeddings: npm install @huggingface/transformers",
              );
              console.log(
                `Embedding provider: ${info.resolvedProvider} (fallback — ${info.fallbackReason}).`,
              );
            } else {
              console.log(
                `Embedding provider: ${info.resolvedProvider} (${info.resolvedModel}, ${info.requestedDimensions}d).`,
              );
            }
          }
        }

        // 6. Rerank endpoint probe (when configured).
        const rerankUrl = process.env.MEMOS_RERANK_URL;
        if (rerankUrl) {
          try {
            const started = Date.now();
            await fetch(`${rerankUrl.replace(/\/+$/, "")}/health`, {
              signal: AbortSignal.timeout(4_000),
            });
            report.rerank = {
              url: rerankUrl,
              reachable: true,
              ms: Date.now() - started,
            };
            if (!jsonOut) {
              console.log(`Rerank endpoint ${rerankUrl}: reachable.`);
            }
          } catch {
            problems.push(
              `Rerank endpoint ${rerankUrl} unreachable — reranking will silently fall back.`,
            );
          }
        }

        report.problems = problems;
        report.suggestions = suggestions;
        if (jsonOut) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          if (problems.length === 0) {
            console.log("Doctor: no problems found.");
          } else {
            console.log(`Doctor: ${problems.length} problem(s):`);
            for (const problem of problems) console.log(`  - ${problem}`);
            for (const suggestion of suggestions)
              console.log(`  → ${suggestion}`);
          }
        }
        break;
      }

      case "reindex-embeddings": {
        const purgeStale = args.includes("--purge-stale");
        try {
          const result = await memos.reindexEmbeddings({ purgeStale });
          if (jsonFlag) {
            console.log(JSON.stringify(result));
          } else {
            console.log(
              `Re-embedded ${result.reembedded} memories with "${result.model}"` +
                `${result.purged ? `, purged ${result.purged} stale vectors` : ""}` +
                `${result.failed ? `, ${result.failed} FAILED` : ""}.`,
            );
          }
        } catch (err) {
          console.error(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
        break;
      }

      case "init": {
        await runInitWizard(args);
        break;
      }

      case "connect": {
        const target = (args[1] ?? "").toLowerCase();
        const write = args.includes("--write");
        const force = args.includes("--force");
        const { getMcpTools } = await import("./mcp.js");
        const result = connectTarget(target, {
          dbPath,
          toolNames: getMcpTools().map((t) => t.name),
        });
        if (!result) break;
        if (!write) {
          console.log(result.instructions);
          console.log(
            "\nRe-run with --write to write the config file directly " +
              "(add --force to overwrite an existing file).",
          );
          break;
        }
        if (!result.configPath) {
          console.log(result.instructions);
          break;
        }
        if (existsSyncSafe(result.configPath) && !force) {
          console.error(
            `Error: ${result.configPath} already exists. Re-run with --force to overwrite.`,
          );
          process.exit(1);
        }
        try {
          writeFileSafe(result.configPath, result.fileContents ?? "");
          console.log(`Wrote ${result.configPath}.`);
          console.log(
            "Restart the harness so it picks up the new MCP server. " +
              "All data stays in the local SQLite store.",
          );
        } catch (err) {
          console.error(
            `Error writing ${result.configPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }
        break;
      }

      case "trio": {
        // Boot the full AI Trio: MemOS (this process, memory) + LLM-Guardian
        // (optimization) + Universal-MCP-Toolkit (tools). With `--up` the
        // command locates the sibling repos and spawns Guardian + UMT from
        // their entrypoints; without it, it prints the compose plan.
        const up = args.includes("--up");
        const flagIdx = (name: string) =>
          args.indexOf(name) !== -1 ? args[args.indexOf(name) + 1] : undefined;
        const home = process.env.HOME || process.env.USERPROFILE || ".";
        const candidates = [
          flagIdx("--guardian"),
          flagIdx("--umt"),
          join(home, "llm-guardian"),
          join(home, "universal-mcp-toolkit"),
          resolve(process.cwd(), "..", "llm-guardian"),
          resolve(process.cwd(), "..", "universal-mcp-toolkit"),
        ].filter(Boolean) as string[];
        const findRepo = (name: string) =>
          candidates.find(
            (c) => existsSync(join(c, "package.json")) && c.includes(name),
          );
        const guardian = findRepo("llm-guardian");
        const umt = findRepo("universal-mcp-toolkit");

        if (!jsonFlag) {
          console.log("AI Trio — compose plan:");
          console.log(
            `  [memory]     memos   (this process)  db=${dbPath ?? join(home, ".memos/memos.db")}`,
          );
          console.log(
            `  [optimize]   llm-guardian  ${guardian ? `→ ${guardian}` : "(not found; pass --guardian <path>)"}`,
          );
          console.log(
            `  [tools]      universal-mcp-toolkit  ${umt ? `→ ${umt}` : "(not found; pass --umt <path>)"}`,
          );
        }

        if (!up) {
          if (!jsonFlag)
            console.log(
              "\nRun with --up to launch Guardian + UMT alongside this MemOS instance.",
            );
          break;
        }

        const children: ChildProcess[] = [];
        const spawn = async (
          cmd: string,
          cwd: string,
          env: Record<string, string>,
        ) => {
          const { spawn: _spawn } = await import("child_process");
          const child = _spawn(cmd, ["run", "start"], {
            cwd,
            env: { ...process.env, ...env },
            stdio: "inherit" as const,
            shell: true,
          });
          child.on("error", (err: Error) => {
            console.error(`Failed to launch ${cmd} in ${cwd}: ${err.message}`);
          });
          children.push(child);
          return child;
        };

        // Guardian must run under Node (not Bun) when MemOS memory is enabled,
        // because MemOS uses better-sqlite3 — a native Node module Bun cannot
        // load. If the user has not set MemOS env vars (standalone Guardian),
        // Bun is fine and faster to start.
        const memosEnabled =
          !!process.env.MEMOS_NAMESPACE ||
          !!process.env.MEMOS_STORAGE_PATH ||
          !!dbPath;
        if (guardian) {
          const guardianEnv: Record<string, string> = {};
          if (memosEnabled) {
            guardianEnv.MEMOS_NAMESPACE =
              process.env.MEMOS_NAMESPACE || "default";
            guardianEnv.MEMOS_STORAGE_PATH =
              process.env.MEMOS_STORAGE_PATH ||
              dbPath ||
              join(home, ".memos/memos.db");
          }
          await spawn(memosEnabled ? "node" : "bun", guardian, guardianEnv);
          if (!jsonFlag)
            console.log(
              `  → llm-guardian via ${memosEnabled ? "node" : "bun"}${memosEnabled ? " (MemOS memory enabled)" : ""}`,
            );
        } else if (!jsonFlag) {
          console.warn(
            "  ⚠ skipping llm-guardian: not found. Pass --guardian <path> or clone it next to memos.",
          );
        }

        if (umt) {
          await spawn("npx", umt, {});
        } else if (!jsonFlag) {
          console.warn(
            "  ⚠ skipping universal-mcp-toolkit: not found. Pass --umt <path> or clone it next to memos.",
          );
        }

        if (!guardian && !umt) {
          console.error(
            "Error: no sibling repos located. Clone llm-guardian and/or universal-mcp-toolkit next to memos, or pass --guardian / --umt.",
          );
          process.exit(1);
        }

        if (!jsonFlag && (guardian || umt))
          console.log(
            "\nAI Trio is starting. MemOS is live (this process); Guardian + UMT launching above.",
          );

        const shutdown = () => {
          for (const c of children) c.kill();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        // Keep the parent alive while children run.
        await new Promise(() => {});
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    // Only close if we haven't already (backup/restore handle their own close)
    if (command !== "backup" && command !== "restore") {
      await memos.close();
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
