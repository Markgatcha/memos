/**
 * Shell completion for the `memos` CLI.
 *
 * `memos completion <bash|zsh|fish>` prints a completion script to stdout.
 * The scripts are generated from the canonical command list in
 * `./cli-help.js` plus the per-command flag table below, so they can never
 * drift out of sync with the CLI itself.
 *
 * Install:
 *   # bash
 *   memos completion bash >> ~/.bashrc
 *   # zsh (needs a dir on your $fpath, e.g. ~/.zfunc)
 *   memos completion zsh > ~/.zfunc/_memos
 *   # fish
 *   memos completion fish > ~/.config/fish/completions/memos.fish
 *
 * @module @memos/cli-completion
 */

import { CLI_COMMANDS } from "./cli-help.js";

export type CompletionShell = "bash" | "zsh" | "fish";

export const COMPLETION_SHELLS: readonly CompletionShell[] = [
  "bash",
  "zsh",
  "fish",
];

/** Short descriptions shown by zsh/fish alongside each command. */
const COMMAND_DESCS: Record<string, string> = {
  init: "Interactive setup wizard",
  store: "Store a new memory",
  retrieve: "Retrieve a memory by ID",
  search: "Search memories by text",
  forget: "Delete a memory by ID",
  summarize: "Summarize all memories",
  graph: "Print the memory graph",
  browse: "Interactive terminal browser",
  link: "Link two memories",
  count: "Show memory count",
  tag: "Add tags to a memory",
  untag: "Remove tags from a memory",
  list: "List memories by tag",
  export: "Export memories to file",
  backup: "Back up the database",
  restore: "Restore from a backup",
  "import-external": "Import a ChatGPT/Claude memory export",
  import: "Import a chat export",
  learn: "Capture a procedural lesson",
  lesson: "Record a lesson outcome",
  lessons: "List procedural lessons",
  cite: "Trace a citation token to its memory",
  quarantine: "Review the quarantine queue",
  harness: "Cross-harness memory tools",
  history: "Version timeline for one memory",
  revert: "Revert a memory to a previous version",
  reminders: "List scheduled reminders",
  remind: "Store a reminder",
  digest: "Run consolidation now",
  consolidate: "Offline maintenance pass",
  encrypt: "Encrypt the database in place",
  decrypt: "Remove database encryption",
  stats: "Token-savings telemetry",
  compact: "Fidelity backfill for stored memories",
  doctor: "Health-check the store and config",
  connect: "Register the MCP server with a harness",
  "reindex-embeddings": "Re-embed all memories",
  mcp: "Start the MCP stdio server",
  trio: "Show or launch the AI Trio",
  completion: "Print shell completion script",
  help: "Show help",
};

/** Flags beyond the global ones, per command. */
const COMMAND_FLAGS: Record<string, string[]> = {
  init: ["--yes"],
  store: ["--type", "--ttl", "--pool", "--context", "--scope", "--tags"],
  retrieve: [],
  search: ["--limit", "--pool", "--scope", "--harness"],
  forget: [],
  summarize: [],
  graph: ["--mermaid"],
  browse: [],
  link: [],
  count: [],
  tag: [],
  untag: [],
  list: ["--tag"],
  export: ["--format", "--output", "--tag"],
  backup: ["--output"],
  restore: [],
  "import-external": ["--source", "--dry-run", "--max-items", "--namespace"],
  import: [
    "--from",
    "--file",
    "--dir",
    "--synthesize",
    "--dry-run",
    "--max-items",
    "--namespace",
  ],
  learn: ["--context", "--tags"],
  lesson: ["--outcome"],
  lessons: ["--namespace", "--limit"],
  cite: [],
  quarantine: ["--limit"],
  harness: ["--from", "--dry-run"],
  history: [],
  revert: ["--last", "--id", "--about", "--dry-run", "--reason", "--actor"],
  reminders: ["--due", "--namespace"],
  remind: [],
  digest: [],
  consolidate: [
    "--dry-run",
    "--no-summarize",
    "--no-decay",
    "--decay-half-life",
    "--min-retention",
    "--older-than",
    "--namespace",
    "--watch",
    "--interval-min",
  ],
  encrypt: ["--key"],
  decrypt: ["--key"],
  stats: [],
  compact: ["--stats", "--namespace", "--limit", "--dry-run"],
  doctor: [],
  connect: ["--write"],
  "reindex-embeddings": ["--purge-stale"],
  mcp: [],
  trio: ["--up"],
  completion: [],
  help: [],
};

/** Flags accepted by (almost) every command. */
const GLOBAL_FLAGS = ["--db", "--json", "--help"];

/** Fixed value sets for flags/positionals that take an enum. */
const FLAG_VALUES: Record<string, string[]> = {
  "--from": ["chatgpt", "claude", "slack"],
  "--source": ["auto", "chatgpt", "claude", "generic"],
  "--format": ["json", "markdown", "obsidian"],
  "--pool": ["event", "note", "procedure"],
  "--outcome": ["success", "failure"],
};

/** Positional value sets: `command -> values` for the first positional. */
const POSITIONAL_VALUES: Record<string, string[]> = {
  completion: [...COMPLETION_SHELLS],
  quarantine: ["list", "release"],
  harness: ["list", "merge"],
  connect: [
    "claude-code",
    "cursor",
    "windsurf",
    "cline",
    "opencode",
    "codex",
    "gemini",
    "generic",
  ],
};

function commandsExcludingHelp(): string[] {
  return CLI_COMMANDS.filter((c) => c !== "help" && c !== "completion");
}

function allFlagsFor(cmd: string): string[] {
  const extra = COMMAND_FLAGS[cmd] ?? [];
  return [...GLOBAL_FLAGS, ...extra];
}

function shList(items: readonly string[]): string {
  return items.join(" ");
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function bashScript(): string {
  const cmds = shList(commandsExcludingHelp());
  const lines: string[] = [
    "# memos bash completion — generated by `memos completion bash`",
    "# Install: memos completion bash >> ~/.bashrc",
    "_memos() {",
    "    local cur prev cmds flags",
    "    COMPREPLY=()",
    '    cur="${COMP_WORDS[COMP_CWORD]}"',
    '    prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `    cmds="${cmds}"`,
    "",
    "    # enum-valued flags: complete the value",
    '    case "$prev" in',
  ];
  for (const [flag, values] of Object.entries(FLAG_VALUES)) {
    lines.push(
      `        ${flag}) COMPREPLY=( $(compgen -W "${shList(values)}" -- "$cur") ); return 0 ;;`,
    );
  }
  lines.push(
    "    esac",
    "",
    "    # first positional: the command itself",
    "    if [[ $COMP_CWORD -eq 1 ]]; then",
    '        COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )',
    "        return 0",
    "    fi",
    "",
    "    # `memos completion <shell>`",
    '    if [[ "${COMP_WORDS[1]}" == "completion" && $COMP_CWORD -eq 2 ]]; then',
    `        COMPREPLY=( $(compgen -W "${shList(COMPLETION_SHELLS)}" -- "$cur") )`,
    "        return 0",
    "    fi",
    "",
    "    # positional enums (quarantine list|release, ...)",
    '    case "${COMP_WORDS[1]}" in',
  );
  for (const [cmd, values] of Object.entries(POSITIONAL_VALUES)) {
    if (cmd === "completion") continue; // handled above
    lines.push(
      `        ${cmd}) if [[ "$cur" != -* ]]; then COMPREPLY=( $(compgen -W "${shList(values)}" -- "$cur") ); return 0; fi ;;`,
    );
  }
  lines.push(
    "    esac",
    "",
    "    # flags for the active command",
    '    flags="--db --json --help"',
    '    case "${COMP_WORDS[1]}" in',
  );
  for (const cmd of commandsExcludingHelp()) {
    const extra = COMMAND_FLAGS[cmd] ?? [];
    if (extra.length > 0) {
      lines.push(`        ${cmd}) flags="$flags ${shList(extra)}" ;;`);
    }
  }
  lines.push(
    "    esac",
    '    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )',
    "    return 0",
    "}",
    "complete -F _memos memos",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// zsh
// ---------------------------------------------------------------------------

/**
 * Escape a string for embedding in a single-quoted shell string.
 * Both zsh and fish treat backslash as literal inside single quotes, so
 * `\'` does NOT escape — the portable idiom is '\'' (end quote, escaped
 * quote, reopen quote). CodeQL js/incomplete-sanitization flags the
 * backslash form.
 */
export function shSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

function zshEscape(s: string): string {
  return shSingleQuoteEscape(s);
}

function zshScript(): string {
  const lines: string[] = [
    "#compdef memos",
    "# memos zsh completion — generated by `memos completion zsh`",
    "# Install: memos completion zsh > ~/.zfunc/_memos  (with ~/.zfunc on $fpath)",
    "",
    "_memos() {",
    "    local context state line",
    "    typeset -A opt_args",
    "",
    "    _arguments -C \\",
    "        '1:command:->command' \\",
    "        '*::options:->options'",
    "",
    "    case $state in",
    "        command)",
    "            local -a commands",
    "            commands=(",
  ];
  for (const cmd of commandsExcludingHelp()) {
    const desc = COMMAND_DESCS[cmd] ?? "";
    lines.push(`                '${zshEscape(cmd)}:${zshEscape(desc)}'`);
  }
  lines.push(
    "            )",
    "            _describe -t commands 'memos command' commands",
    "            ;;",
    "        options)",
    "            case $line[1] in",
  );
  for (const cmd of commandsExcludingHelp()) {
    const flags = allFlagsFor(cmd);
    const argLines = flags.map((f) => {
      const values = FLAG_VALUES[f];
      // `_arguments` spec: '--flag[desc]: :values'
      const spec = values
        ? `'${f}[${f}]:${f.replace(/^--/, "")}:(${shList(values)})'`
        : `'${f}[${f}]'`;
      return `                    ${spec} \\`;
    });
    const positional = POSITIONAL_VALUES[cmd];
    if (positional && cmd !== "completion") {
      argLines.push(`                    '1: :(${shList(positional)})' \\`);
    }
    if (cmd === "completion") {
      argLines.push(
        `                    '1:shell:(${shList(COMPLETION_SHELLS)})' \\`,
      );
    }
    // strip trailing backslash from last line
    const last = argLines.pop()!;
    argLines.push(last.replace(/ \\$/, ""));
    lines.push(`                ${cmd})`);
    lines.push("                    _arguments \\");
    lines.push(...argLines);
    lines.push("                    ;;");
  }
  lines.push(
    "            esac",
    "            ;;",
    "    esac",
    "}",
    "",
    '_memos "$@"',
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// fish
// ---------------------------------------------------------------------------

function fishScript(): string {
  const lines: string[] = [
    "# memos fish completion — generated by `memos completion fish`",
    "# Install: memos completion fish > ~/.config/fish/completions/memos.fish",
    "",
  ];
  // subcommands
  for (const cmd of commandsExcludingHelp()) {
    const desc = shSingleQuoteEscape(COMMAND_DESCS[cmd] ?? "");
    lines.push(
      `complete -c memos -f -n '__fish_use_subcommand' -a '${cmd}' -d '${desc}'`,
    );
  }
  lines.push("");
  // per-command flags
  for (const cmd of commandsExcludingHelp()) {
    const cond = `__fish_seen_subcommand_from ${cmd}`;
    for (const flag of allFlagsFor(cmd)) {
      const name = flag.replace(/^--/, "");
      const values = FLAG_VALUES[flag];
      if (values) {
        lines.push(
          `complete -c memos -f -n '${cond}' -l '${name}' -x -a '${shList(values)}' -d '${flag} value'`,
        );
      } else {
        lines.push(
          `complete -c memos -f -n '${cond}' -l '${name}' -d '${flag}'`,
        );
      }
    }
    const positional = POSITIONAL_VALUES[cmd];
    if (positional) {
      lines.push(
        `complete -c memos -f -n '${cond}' -a '${shList(positional)}'`,
      );
    }
  }
  // `memos completion <shell>`
  lines.push(
    `complete -c memos -f -n '__fish_seen_subcommand_from completion' -a '${shList(COMPLETION_SHELLS)}'`,
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

/** Generate the completion script for a shell, or null for unknown shells. */
export function getCompletionScript(shell: string): string | null {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    default:
      return null;
  }
}
