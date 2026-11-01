/**
 * Generate the reference docs that must not drift: CLI commands, MCP tools,
 * and HTTP routes.
 *
 * Usage: npx tsx scripts/gen-docs-reference.ts
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLI_COMMANDS, getCommandHelp } from "../src/cli-help.js";
import { getMcpTools, MCP_CORE_TOOL_NAMES } from "../src/mcp.js";

process.env.MEMOS_MCP_TOOLS = "all";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "docs/reference");
mkdirSync(outDir, { recursive: true });

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const cliSections = CLI_COMMANDS.map((command) => {
  const help = getCommandHelp(command);
  if (!help) {
    return `### \`memos ${command}\`\n\nNo dedicated help text. Run \`memos ${command} --help\`.\n`;
  }
  const lines = help.split("\n");
  const usageIndex = lines.findIndex((line) =>
    line.trim().startsWith("memos "),
  );
  const index =
    usageIndex >= 0 ? usageIndex : lines.findIndex((line) => line.trim());
  const usage = index >= 0 ? lines[index]!.trim() : `memos ${command}`;
  const description = lines
    .slice(index + 1)
    .join("\n")
    .trim();
  return [
    `### \`memos ${command}\``,
    "",
    "```text",
    usage,
    "```",
    "",
    description || "No description.",
    "",
  ].join("\n");
});

writeFileSync(
  resolve(outDir, "cli.md"),
  [
    "# CLI reference",
    "",
    "Generated from `src/cli-help.ts` by `npm run docs:reference`. Every",
    "command in the dispatch table is listed; if it is not here, it is not a",
    "command.",
    "",
    ...cliSections,
  ].join("\n"),
  "utf8",
);

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

const tools = getMcpTools();
const core = new Set<string>(MCP_CORE_TOOL_NAMES);
const rows = tools.map((tool) => {
  const annotations = Object.entries(tool.annotations ?? {})
    .filter(([, value]) => value === true)
    .map(([key]) => key.replace(/Hint$/, ""))
    .join(", ");
  return `| \`${tool.name}\` | ${core.has(tool.name) ? "yes" : "—"} | ${escapeCell(tool.description)} | ${annotations || "—"} |`;
});

const details = tools.map((tool) => {
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  const required = new Set(schema?.required ?? []);
  const params = Object.entries(schema?.properties ?? {}).map(
    ([name, value]) =>
      `- \`${name}\`${required.has(name) ? " (required)" : ""}: ${value.description ?? value.type ?? "value"}`,
  );
  return [
    `### \`${tool.name}\``,
    "",
    tool.description,
    "",
    params.length > 0 ? params.join("\n") : "No parameters.",
    "",
  ].join("\n");
});

writeFileSync(
  resolve(outDir, "mcp-tools.md"),
  [
    "# MCP tools",
    "",
    "Generated from `src/mcp.ts` by `npm run docs:reference`. The default",
    "profile exposes the core set; `MEMOS_MCP_TOOLS=all` exposes every tool",
    "listed here.",
    "",
    "| Tool | Core | What it does | Hints |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    ...details,
  ].join("\n"),
  "utf8",
);

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function python(): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  if (process.platform === "win32") {
    return resolve(root, ".venv", "Scripts", "python.exe");
  }
  return resolve(root, ".venv", "bin", "python");
}

const openapi = JSON.parse(
  execFileSync(
    python(),
    [
      "-c",
      "from memos.server.main import app; import json; print(json.dumps(app.openapi()))",
    ],
    { cwd: root, encoding: "utf8" },
  ),
) as {
  info: { title: string; version: string };
  paths: Record<
    string,
    Record<
      string,
      {
        summary?: string;
        description?: string;
        parameters?: Array<{ name: string; required?: boolean }>;
        requestBody?: {
          content?: {
            "application/json"?: {
              schema?: {
                required?: string[];
                properties?: Record<string, unknown>;
              };
            };
          };
        };
      }
    >
  >;
};

const routeRows: string[] = [];
const routeDetails: string[] = [];
for (const [path, methods] of Object.entries(openapi.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const body =
      operation.requestBody?.content?.["application/json"]?.schema?.properties;
    routeRows.push(
      `| \`${method.toUpperCase()} ${path}\` | ${escapeCell(operation.summary ?? "")} |`,
    );
    const params = [
      ...(operation.parameters ?? []).map(
        (parameter) =>
          `- \`${parameter.name}\`${parameter.required ? " (required)" : ""} (query)`,
      ),
      ...Object.keys(body ?? {}).map((name) => `- \`${name}\` (body)`),
    ];
    routeDetails.push(
      [
        `### \`${method.toUpperCase()} ${path}\``,
        "",
        operation.summary ?? "",
        "",
        operation.description ?? "",
        "",
        params.length > 0 ? params.join("\n") : "No parameters.",
        "",
      ].join("\n"),
    );
  }
}

writeFileSync(
  resolve(outDir, "http-api.md"),
  [
    "# HTTP API reference",
    "",
    `Generated from the FastAPI OpenAPI document (${openapi.info.title} ${openapi.info.version}).`,
    "The server mounts every route under `/api/mem`.",
    "",
    "| Route | What it does |",
    "| --- | --- |",
    ...routeRows.sort(),
    "",
    ...routeDetails,
  ].join("\n"),
  "utf8",
);

console.log(
  `docs:reference wrote ${CLI_COMMANDS.length} CLI commands, ${tools.length} MCP tools, ${routeRows.length} HTTP routes`,
);
