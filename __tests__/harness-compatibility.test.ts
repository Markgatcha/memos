/**
 * Validates `docs/harness-compatibility.md`.
 *
 * Every harness section on that page ships a registration snippet for the
 * `mem-os` MCP server. This test parses each snippet, checks the entry lands
 * under the key path that harness actually documents, and asserts it runs the
 * pinned `@mem-os/sdk@1.6.26` server with the `mcp` subcommand. It also fails
 * if the page ever documents an unpinned SDK version, skips one of the ten
 * most-used harnesses, or stops marking the session hooks as Claude Code-only.
 *
 * The snippets are schema-checked here; installing into a live harness is
 * explicitly out of scope (see the page's Limitations section).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The working tree checks out CRLF on Windows; normalise so headings, fences and
// line-by-line assertions behave the same everywhere.
const doc = readFileSync(
  resolve(here, "../docs/harness-compatibility.md"),
  "utf8",
).replace(/\r\n/g, "\n");

/** Ten most-used coding harnesses (trailing ~30 days, opt-in data). */
const TOP_TEN = [
  "Hermes Agent",
  "Claude Code",
  "Kilo Code",
  "Cline",
  "omp (Oh My Pi)",
  "pi",
  "Codex",
  "OpenClaw",
  "ZCode",
  "Cursor",
];

/** Extra harnesses the page also documents. */
const EXTRAS = [
  "Claude Desktop",
  "VS Code",
  "Zed",
  "Windsurf",
  "OpenCode",
  "Gemini CLI",
];

/** Key path each harness stores its MCP server map under. */
const SERVER_KEY_PATH: Record<string, readonly string[]> = {
  "Hermes Agent": ["mcpServers"],
  "Claude Code": ["mcpServers"],
  "Kilo Code": ["mcp"],
  Cline: ["mcpServers"],
  "omp (Oh My Pi)": ["mcpServers"],
  pi: ["mcpServers"],
  OpenClaw: ["mcp", "servers"],
  ZCode: ["mcp", "servers"],
  Cursor: ["mcpServers"],
  "Claude Desktop": ["mcpServers"],
  "VS Code": ["servers"],
  Zed: ["context_servers"],
  Windsurf: ["mcpServers"],
  OpenCode: ["mcp"],
  "Gemini CLI": ["mcpServers"],
};

const ALL_HARNESSES = [...TOP_TEN, ...EXTRAS];

/** Harnesses whose snippet is a TOML table instead of a JSON server map. */
const TOML_HARNESSES = ["Codex"];

/** Harnesses with a JSON snippet, i.e. everything the JSON checks cover. */
const JSON_HARNESSES = ALL_HARNESSES.filter(
  (heading) => !TOML_HARNESSES.includes(heading),
);

/** The doc's section body for a `### <heading>` block. */
function section(heading: string): string {
  const start = doc.indexOf(`### ${heading}\n`);
  if (start === -1)
    throw new Error(
      `docs/harness-compatibility.md has no '### ${heading}' section`,
    );

  const nextHeading = doc.indexOf("\n### ", start + 1);
  const nextSection = doc.indexOf("\n## ", start + 1);
  const end = nextHeading === -1 ? nextSection : nextHeading;
  return doc.slice(start, end === -1 ? undefined : end);
}

/** The first fenced block of a given language inside `text`. */
function fence(text: string, lang: "json" | "jsonc" | "toml"): string {
  const match = new RegExp("```" + lang + "\\n([\\s\\S]*?)```").exec(text);
  if (!match) throw new Error(`no \`\`\`${lang} snippet found`);
  return match[1]!;
}

function atPath(root: unknown, keyPath: readonly string[]): unknown {
  return keyPath.reduce<unknown>(
    (value, key) =>
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined,
    root,
  );
}

/** The `mem-os` entry from a harness section's JSON snippet. */
function memosEntry(heading: string): Record<string, unknown> {
  const keyPath = SERVER_KEY_PATH[heading]!;
  const raw = fence(
    section(heading),
    heading === "Kilo Code" ? "jsonc" : "json",
  );
  const servers = atPath(JSON.parse(raw), keyPath) as
    Record<string, unknown> | undefined;

  if (!servers)
    throw new Error(`${heading}: no server map at ${keyPath.join(".")}`);
  const entry = servers["mem-os"] as Record<string, unknown> | undefined;
  if (!entry)
    throw new Error(
      `${heading}: no 'mem-os' server under ${keyPath.join(".")}`,
    );
  return entry;
}

/** The `[mcp_servers.<name>]` tables of a TOML snippet (Codex). */
function tomlTables(text: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = {};
      tables[header[1]!] = current;
      continue;
    }

    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment || current === undefined)
      throw new Error(`Unparseable TOML line: ${rawLine}`);
    current[assignment[1]!] = JSON.parse(assignment[2]!);
  }

  return tables;
}

/** `[command, ...args]` for an entry that may use a command array (OpenCode/Kilo). */
function argvOf(entry: Record<string, unknown>): unknown[] {
  const command = entry.command;
  return Array.isArray(command)
    ? command
    : [command, ...((entry.args as unknown[]) ?? [])];
}

describe("docs/harness-compatibility.md", () => {
  it("documents a config shape for the ten most-used harnesses", () => {
    for (const heading of TOP_TEN) {
      const documented =
        SERVER_KEY_PATH[heading] ??
        (TOML_HARNESSES.includes(heading) ? "toml" : undefined);
      expect(documented).toBeDefined();
    }
  });

  it.each(JSON_HARNESSES)(
    "%s registers mem-os under its documented key path",
    (heading) => {
      const argv = argvOf(memosEntry(heading));

      expect(argv).toContain("npx");
      expect(argv).toContain("-y");
      expect(argv).toContain("@mem-os/sdk@1.6.26");
      expect(argv).toContain("mcp");
    },
  );

  it("uses each harness's documented entry shape", () => {
    // VS Code wants an explicit stdio type; OpenCode and Kilo Code use a
    // single local command array with an enabled flag.
    expect(memosEntry("VS Code").type).toBe("stdio");
    for (const heading of ["OpenCode", "Kilo Code"]) {
      const entry = memosEntry(heading);
      expect(entry.type).toBe("local");
      expect(entry.command).toEqual(expect.any(Array));
      expect(entry.enabled).toBe(true);
    }
    // Zed's context_servers entries are flat command/args objects.
    expect(Array.isArray(memosEntry("Zed").args)).toBe(true);
  });

  it("registers Codex through a TOML table", () => {
    const entry = tomlTables(fence(section("Codex"), "toml"))[
      "mcp_servers.mem-os"
    ];

    expect(entry).toBeDefined();
    expect(entry!.command).toBe("npx");
    expect(entry!.args).toEqual(["-y", "@mem-os/sdk@1.6.26", "mcp"]);
  });

  it("keeps ${PLUGIN_DATA} to the Hermes entry", () => {
    expect(JSON.stringify(memosEntry("Hermes Agent"))).toContain(
      "${PLUGIN_DATA}",
    );

    for (const heading of ALL_HARNESSES.filter(
      (name) => name !== "Hermes Agent",
    )) {
      expect(section(heading)).not.toContain("${PLUGIN_DATA}");
    }
  });

  it("pins the SDK in every command on the page", () => {
    expect(doc).toContain("@mem-os/sdk@1.6.26");

    // Prose may name the package, but any *command* must carry the exact
    // version: a bare `@mem-os/sdk` argument floats to the next release.
    // (Multi-line snippets are covered by the per-harness argv assertions.)
    for (const line of doc.split("\n")) {
      if (!line.includes("npx") || !line.includes("@mem-os/sdk")) continue;
      expect(line).toContain("@mem-os/sdk@1.6.26");
    }
  });

  it("marks the session hooks as Claude Code-only", () => {
    expect(doc.replace(/\s+/g, " ")).toContain("Claude Code-only");
  });

  it("parses every fenced snippet on the page", () => {
    const fences = [...doc.matchAll(/```(jsonc?|toml)\n([\s\S]*?)```/g)];

    expect(fences.length).toBeGreaterThanOrEqual(ALL_HARNESSES.length);
    for (const [, lang, body] of fences) {
      if (lang === "toml") {
        expect(() => tomlTables(body!)).not.toThrow();
      } else {
        expect(() => JSON.parse(body!)).not.toThrow();
      }
    }
  });
});
