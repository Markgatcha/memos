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
  "demo",
  "store",
  "ingest",
  "retrieve",
  "search",
  "profile",
  "handoff",
  "forget",
  "summarize",
  "graph",
  "browse",
  "image",
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
  "promote",
  "cite",
  "quarantine",
  "harness",
  "history",
  "revert",
  "reminders",
  "remind",
  "digest",
  "consolidate",
  "dream",
  "encrypt",
  "decrypt",
  "stats",
  "health",
  "audit",
  "eval",
  "explain",
  "feedback",
  "compact",
  "doctor",
  "connect",
  "reindex-embeddings",
  "extract-facts",
  "session-hook",
  "dashboard",
  "sync",
  "log",
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
  demo: `memos demo [--json]

Stores three sample memories in a temporary database, searches for them,
closes the process, reopens the same file, and proves the memories survived.
The temporary database is deleted afterwards. Use it to check the install
without touching your real store.`,
  store: `memos store "<content>" [--type <type>] [--ttl <seconds>]
  [--pool <pool>] [--context <ctx>] [--scope user:alice[,agent:coder][,run:r1]]
  [--tags a,b] [--json]

Store a new memory. Example:
  memos store "User prefers dark mode" --type preference`,
  ingest: `memos ingest <file-or-folder> [--watch] [--namespace documents]
  [--ext .md,.txt,.pdf] [--chunk-chars 1200]

Ingest documents into memory. Markdown, text, HTML and PDF are supported.
Re-running is incremental: unchanged files are skipped, edited files replace
their old chunks, deleted files remove theirs.

  memos ingest ./notes
  memos ingest ./notes --watch
  memos ingest ./papers --ext .pdf --namespace research`,
  retrieve: `memos retrieve <id> [--json]

Retrieve a single memory by its ID.`,
  search: `memos search "<query>" [--limit <n>] [--pool event|note|procedure]
  [--scope user:alice[,...]] [--harness <name|all>] [--json]

Search memories by text (full-text + semantic when embeddings are on).
Example:
  memos search "dark mode" --limit 5`,
  profile: `memos profile [--query <text>] [--max-static <n>] [--max-dynamic <n>]
  [--recent-days <n>] [--scope user:alice[,...]] [--json]

One-call user profile: STATIC (durable facts — preferences, entities,
facts, best-first by trust) plus DYNAMIC (recent activity inside the
recency window, newest first). This is the block to inject at session
start so the agent knows who it is talking to.
Example:
  memos profile --scope user:alice --recent-days 3`,
  handoff: `memos handoff "<task>" [--to <harness>] [--from <harness>]
  [--token-budget <n>] [--lessons <n>] [--namespace <ns>]
  [--scope user:alice[,...]] [--no-reminders] [--json]

Build a compact "continue here" brief for another harness, model, or
session: durable profile, token-budgeted relevant memories with [mem:hex]
citations, procedural lessons, reminders, memory health, and harness
attribution. Read-only. Default output is Markdown.
Example:
  memos handoff "finish the auth refactor" --to codex --token-budget 1200`,
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
  image: `memos image add <path|url> [--caption <text>] [--kind <kind>] [--tags a,b]
memos image list [--limit <n>]
memos image search <query> [--limit <n>]
memos image show <ref|id> [--out <path>]
memos image purge

Image memories. Requires --vision (caption track only) or
--vision-clip (also matches image pixels with CLIP). Both can be set
permanently in .memos.json under "vision".

add     Store an image. The caption becomes the memory's text, so
        keyword and semantic search find it like any other memory.
        --kind sets the taxonomy (photo|screenshot|chart|diagram|
        memo|meme|other); --tags adds filter tags.
list    List stored images, newest first.
search  Find images by query — caption leg always, CLIP pixel leg
        when --vision-clip is on.
show    Resolve an [img:...] ref (or a node id) back to its bytes.
        --out writes them to a file.
purge   Delete blobs no live node references any more.`,
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
  promote: `memos promote [--apply] [--min-successes <n>] [--max-failure-ratio <r>]
  [--limit <n>] [--namespace <ns>] [--json]

Review repeated successful recall patterns (from 'memos feedback') as
procedure candidates. Dry-run by default; --apply writes the lessons.
Nothing is promoted from a single success, and high-failure patterns are
excluded.`,
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
  dream: `memos dream [--dry-run] [--namespace <ns>] [--json]
  [--schedule hourly|daily|weekly]

Consolidation with a report: merged duplicates, superseded memories,
archived rows, cluster notes, and contradiction findings. --schedule keeps
the process running and repeats the pass on that cadence (ctrl+c to stop);
use cron or Task Scheduler for a background run.`,
  encrypt: `memos encrypt --db <path> --key <key>

Encrypt the database in place (requires better-sqlite3-multiple-ciphers).
The key can also come from the MEMOS_KEY environment variable. The
previous plaintext file is kept as a backup.`,
  decrypt: `memos decrypt --db <path> --key <key>

Remove encryption in place. The previous encrypted file is kept as a backup.`,
  stats: `memos stats [--json]

Token-savings telemetry for this process (packs built, tokens injected
vs naive baseline).`,
  health: `memos health [--json]

Hygiene and usefulness report: contradiction pressure, expired rows,
low-confidence share, quarantine count, and outcome-conditioned recall
rate, with actionable findings and a heuristic grade.`,
  audit: `memos audit [--expect-tip <hash>] [--limit <n>] [--json]

Assemble the full audit artifact: hash-chain verification, provenance/source
inventory, quarantine register, deletion certificates, semantic-search
health, and recommendations. --expect-tip checks an externally recorded tip
so truncation is detectable. Exits 1 when the chain fails.`,
  eval: `memos eval [--limit <n>] [--k <n>] [--from-sessions]
  [--corpus <path>] [--namespace <ns>] [--json]

Evaluate retrieval on YOUR store. Default self mode samples recent memories,
uses a fragment of each as the query, and reports Hit@K, MRR, latency, and
token cost. --corpus runs a JSON array (or {cases:[...]}) of
{query, relevantIds}. This is an index-health check, not a public benchmark.`,
  explain: `memos explain "<query>" [--id <memoryId>] [--limit <n>]
  [--namespace <ns>] [--pool <event|note|procedure|visual>] [--json]

Explain a ranking: per-leg score signals, lifecycle status, supersede
chain, outcome utility, and the relevance-gate verdict. Pass --id to
diagnose one memory that should have matched but did not.`,
  feedback: `memos feedback --query "<query>" --used <id[,id]> --outcome success|partial|failure
  [--weight <n>] [--note <text>] [--json]

Record which recalled memories the agent actually used and whether the
task succeeded. Future ranking is promoted/demoted from this evidence.`,
  compact: `memos compact [--stats] [--namespace <ns>] [--limit <n>] [--dry-run]

Fidelity backfill: generate missing L1/L2 levels for stored memories.
--stats shows average tokens per level.`,
  doctor: `memos doctor [--json]

Health-check the store, embedding config, and endpoints. Prints findings
with pointers to the Troubleshooting Playbook.`,
  connect: `memos connect <target> [--write] [--json]

Register the MemOS MCP server with a coding harness: claude-code, cursor,
windsurf, cline, opencode, codex, gemini, hermes, kilo, pi, openclaw, zed,
goose, or generic. --write saves the config where the harness uses a
dedicated file; YAML/merged configs are printed for you to paste.`,
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
move it to another machine yourself (cloud drive, USB, scp), and import
it there.

  memos sync export --output <file> [--passphrase <passphrase> | --passphrase-file <path>]
  memos sync import --input <file> [--strategy skip-existing|last-write-wins]
  memos sync status --input <file>

AES-256-GCM: every record field (id, content, type, tags, timestamps…)
is encrypted; bundle metadata is authenticated. The key can be a
passphrase (PBKDF2-derived, prompted interactively on a TTY when not
given), a 32-byte key file, or MEMOS_SYNC_KEY. Import preserves
original IDs and timestamps; content-identical records are never
duplicated. Local-first: import only adds, or replaces the conflicting
record under last-write-wins.`,
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
  log: `memos log <verify|show|checkpoint> [options]

Tamper-evident mutation log. Every memory mutation (store, import,
update, forget) appends a hash-chained entry; verify recomputes the
chain and cross-checks each node's current content against its latest
log entry.

  memos log verify [--expect <hash>]   Verify the chain; exit 1 on tampering.
  memos log show [--limit N]           Print the N most recent entries.
  memos log checkpoint                 Print the tip hash to anchor externally.

The log detects edited/deleted/reordered rows and nodes changed
directly in the DB — but a full-chain rewrite by someone with raw DB
write access is only provable against an external checkpoint: write
the checkpoint hash down somewhere the DB writer can't reach (paper,
another machine, a signed commit), then verify with --expect later.`,
  help: `memos help

Show the full command list. For one command: memos <command> --help`,
};

/** Usage text for one command, or null for unknown commands. */
export function getCommandHelp(command: string): string | null {
  const body = COMMAND_HELP[command];
  if (!body) return null;
  return `\nMemOS — ${command}\n\n${body}\n`;
}
