/**
 * Shared CLI help data: the canonical command list, did-you-mean suggestions,
 * and per-command usage text for `memos <command> --help`.
 *
 * Kept in its own module (no process.argv reads) so it can be unit-tested.
 *
 * @module @memos/cli-help
 */

/** Every command the CLI actually implements (mirrors the dispatch in cli.ts). */
export const CLI_COMMANDS: readonly string[] = [
  "init",
  "store",
  "retrieve",
  "search",
  "forget",
  "summarize",
  "graph",
  "browse",
  "link",
  "count",
  "tag",
  "untag",
  "list",
  "export",
  "backup",
  "restore",
  "import-external",
  "import",
  "learn",
  "lesson",
  "lessons",
  "cite",
  "quarantine",
  "harness",
  "history",
  "revert",
  "reminders",
  "remind",
  "digest",
  "consolidate",
  "encrypt",
  "decrypt",
  "stats",
  "compact",
  "doctor",
  "connect",
  "reindex-embeddings",
  "extract-facts",
  "session-hook",
  "dashboard",
  "sync",
  "beta",
  "update",
  "mcp",
  "trio",
  "completion",
  "help",
];

/** Classic Levenshtein edit distance (small inputs; clarity over speed). */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/**
 * Suggest the most likely intended command for a typo'd input.
 * Returns null when nothing is close enough to be helpful.
 */
export function suggestCommand(input: string): string | null {
  if (!input) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cmd of CLI_COMMANDS) {
    if (cmd === "help") continue;
    const dist = levenshtein(input.toLowerCase(), cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }
  if (best === null) return null;
  // Accept only genuinely close matches: small absolute distance for short
  // words, or within ~40% of the input length for longer ones.
  const threshold = Math.max(2, Math.floor(input.length * 0.4));
  return bestDist <= threshold ? best : null;
}

/** One-paragraph usage for each command, shown by `memos <command> --help`. */
const COMMAND_HELP: Record<string, string> = {
  init: `memos init [--yes]

Interactive setup wizard: picks the database path and embedding provider,
runs a store → search → forget smoke test, and saves ~/.memos/config.json.
--yes accepts all defaults (for scripts; also auto-detected when stdin is
not a TTY). Environment variables (MEMOS_DB_PATH, MEMOS_EMBEDDING_*)
always override the saved config.`,
  store: `memos store "<content>" [--type <type>] [--ttl <seconds>]
  [--pool <pool>] [--context <ctx>] [--scope user:alice[,agent:coder][,run:r1]]
  [--tags a,b] [--json]

Store a new memory. Example:
  memos store "User prefers dark mode" --type preference`,
  retrieve: `memos retrieve <id> [--json]

Retrieve a single memory by its ID.`,
  search: `memos search "<query>" [--limit <n>] [--pool event|note|procedure]
  [--scope user:alice[,...]] [--harness <name|all>] [--json]

Search memories by text (full-text + semantic when embeddings are on).
Example:
  memos search "dark mode" --limit 5`,
  forget: `memos forget <id> [--json]

Delete a memory by ID. The deletion is recorded in the bitemporal ledger,
so it can be audited (see: memos history <id>).`,
  summarize: `memos summarize [--json]

Print a summary of all stored memories.`,
  graph: `memos graph [--mermaid] [--json]

Print the full memory graph. --mermaid emits a GitHub-renderable
Mermaid diagram (memos graph --mermaid > graph.mmd).`,
  browse: `memos browse

Interactive terminal browser: search, inspect, and forget memories.`,
  link: `memos link <src-id> <dst-id> [--json]

Create an explicit link between two memories.`,
  count: `memos count [--json]

Show the number of stored memories.`,
  tag: `memos tag <id> <tag> [tag...] [--json]

Add one or more tags to a memory.`,
  untag: `memos untag <id> <tag> [tag...] [--json]

Remove one or more tags from a memory.`,
  list: `memos list --tag <tag> [--json]

List memories carrying a tag.`,
  export: `memos export [--format json|markdown|obsidian] [--output <path>]
  [--tag <tag>]

Export memories to a file. Example:
  memos export --format markdown --output ./my-export`,
  backup: `memos backup [--output <path>]

Back up the database file (default: ./memos-backup-<timestamp>.db).`,
  restore: `memos restore <path>

Restore the database from a backup file.`,
  "import-external": `memos import-external <file> [--source auto|chatgpt|claude|generic]
  [--dry-run] [--max-items <n>] [--namespace <ns>]

Import a ChatGPT/Claude memory export file.`,
  import: `memos import --from chatgpt|claude|slack (--file <path> | --dir <path>)
  [--synthesize] [--dry-run] [--max-items <n>] [--namespace <ns>]

Import a chat export. --dry-run previews without writing.`,
  learn: `memos learn "<lesson>" [--context <ctx>] [--tags a,b] [--json]

Capture a procedural lesson — behavioral guidance, not a fact.`,
  lesson: `memos lesson <id> --outcome success|failure [--json]

Record a lesson outcome: reinforces or demotes the lesson's score.`,
  lessons: `memos lessons [--namespace <ns>] [--limit <n>] [--json]

List procedural lessons.`,
  cite: `memos cite <id> [--json]

Trace a [mem:xxxx] citation token back to its full source memory.`,
  quarantine: `memos quarantine <list|release> [--limit <n>] [--json]

Review the write-gate quarantine queue: list flagged memories, or release
one back into recall.`,
  harness: `memos harness <list|merge> [--from <db-path>] [--dry-run] [--json]

Cross-harness memory: per-harness memory counts (list), or merge another
harness's DB file into this one (merge).`,
  history: `memos history <id> [--json]

Version timeline for one memory: supersedes / superseded-by / derived notes.`,
  revert: `memos revert (--last | --id <id> | --about <topic> | "<natural language>")
  [--dry-run] [--reason <r>] [--actor <a>] [--json]

Revert a memory to its previous version. Natural language works too:
  memos revert "forget the last thing I told you"`,
  reminders: `memos reminders [--due] [--namespace <ns>] [--json]

List scheduled event reminders, earliest first. --due shows only reminders
due as of now.`,
  remind: `memos remind "<text>" at <when> [--json]

Store a reminder firing at <when>. Example:
  memos remind "call mom" at tomorrow 9am`,
  digest: `memos digest [--json]

Run consolidation now and print a summary.`,
  consolidate: `memos consolidate [--dry-run] [--no-summarize] [--no-decay]
  [--decay-half-life <days>] [--min-retention <score>] [--older-than <days>]
  [--namespace <ns>] [--watch] [--interval-min <n>]

Offline maintenance pass: merge duplicates, archive stale memories,
supersede decayed ones (kept as history), distill cluster summary notes.`,
  encrypt: `memos encrypt --db <path> --key <key>

Encrypt the database in place (requires better-sqlite3-multiple-ciphers).
The key can also come from the MEMOS_KEY environment variable. The
previous plaintext file is kept as a backup.`,
  decrypt: `memos decrypt --db <path> --key <key>

Remove encryption in place. The previous encrypted file is kept as a backup.`,
  stats: `memos stats [--json]

Token-savings telemetry for this process (packs built, tokens injected
vs naive baseline).`,
  compact: `memos compact [--stats] [--namespace <ns>] [--limit <n>] [--dry-run]

Fidelity backfill: generate missing L1/L2 levels for stored memories.
--stats shows average tokens per level.`,
  doctor: `memos doctor [--json]

Health-check the store, embedding config, and endpoints. Prints findings
with pointers to the Troubleshooting Playbook.`,
  connect: `memos connect <target> [--write] [--json]

Register the MemOS MCP server with a coding harness: claude-code, cursor,
windsurf, cline, opencode, codex, gemini, or generic. --write saves the
config to the harness.`,
  "reindex-embeddings": `memos reindex-embeddings [--purge-stale]

Re-embed all memories with the configured provider. --purge-stale deletes
vectors produced by other models first.`,
  "extract-facts": `memos extract-facts --transcript <path> [--namespace <ns>]
  [--min-confidence <n>] [--dry-run] [--json]

Extract durable facts from a session transcript (Claude Code JSONL or
plain text) and store them. Uses the same extractFacts() path as the
session hook. --dry-run shows what would be stored without writing.`,
  "session-hook": `memos session-hook [--transcript <path>] [--opencode-session <id>] [--namespace <ns>] [--json]

Session-end hook entrypoint for Claude Code / OpenCode. Claude Code
passes hook JSON (with transcript_path) on stdin; the OpenCode plugin
passes --opencode-session <id> and memos loads the session from
OpenCode's data dir. Extracts durable facts from the transcript and
stores them. Fail-open: never breaks session teardown. Set
MEMOS_SKIP_SESSION_HOOK=1 to opt out.`,
  dashboard: `memos dashboard [--port <n>] [--no-open]

Start a local web dashboard for browsing, searching, and visualizing
the memory graph. Opens the browser automatically unless --no-open.
The server binds to 127.0.0.1 only.`,
  sync: `memos sync <export|import|status> [options]

Encrypted cross-machine sync. Export memories to an encrypted bundle,
move it to another machine, and import it there.

  memos sync export --output <file> [--key <passphrase> | --key-file <path>]
  memos sync import --input <file> [--strategy skip-existing|last-write-wins]
  memos sync status --input <file>

The bundle is encrypted with AES-256-GCM. The key can be a passphrase
(PBKDF2-derived) or a 32-byte key file. MEMOS_SYNC_KEY env var also works.
Local-first: import never deletes, only adds or updates.`,
  beta: `memos beta [enable|disable|status]

Opt in or out of the beta channel. With beta enabled, memos checks (at most
every 6 hours, cached) whether a newer fully-successful main commit exists —
CI, Prebuilds, and CodeQL all green — and prompts you to update. Default: off.`,
  update: `memos update [--check] [--yes]

Check for the newest fully-successful main commit (CI, Prebuilds, and CodeQL
all green) and install it from source. Beta users are prompted automatically;
this command works for anyone.

  memos update --check   just report what's available, don't install
  memos update --yes     install without asking (for scripts)

Installing builds from source with pnpm (PATH or corepack) into
$MEMOS_HOME/beta/<sha> and repoints $MEMOS_HOME/bin/memos at it.`,
  mcp: `memos mcp [--db <path>]

Start the MemOS MCP stdio server (for MCP clients to connect to).`,
  trio: `memos trio [--up]

Show (or with --up, launch) the full AI Trio: MemOS + LLM-Guardian +
Universal-MCP-Toolkit.`,
  completion: `memos completion <bash|zsh|fish>

Print a shell completion script to stdout. Install it, e.g.:
  memos completion bash >> ~/.bashrc
  memos completion zsh > ~/.zfunc/_memos      # with ~/.zfunc on $fpath
  memos completion fish > ~/.config/fish/completions/memos.fish`,
  help: `memos help

Show the full command list. For one command: memos <command> --help`,
};

/** Usage text for one command, or null for unknown commands. */
export function getCommandHelp(command: string): string | null {
  const body = COMMAND_HELP[command];
  if (!body) return null;
  return `\nMemOS — ${command}\n\n${body}\n`;
}
