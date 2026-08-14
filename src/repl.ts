/**
 * `memos repl` — interactive read-eval-print loop.
 *
 * Drop into a shell against a live MemOS instance:
 *
 *   $ memos repl
 *   memos> store "User prefers dark mode"
 *   Stored memory: 1ea66691-…
 *   memos> search dark mode
 *   Found 1 memories:
 *     [preference] User prefers dark mode
 *   memos> flush-embeddings
 *   Flushed embedding queue. Pending: 0, running: 0.
 *   memos> graph
 *   Memory Graph: 1 nodes, 0 edges
 *   memos> exit
 *
 * Why this exists: a CLI tool that doesn't ship a REPL gets played
 * with once and forgotten. A REPL keeps the developer in the loop
 * for an order of magnitude longer. It also doubles as a smoke
 * test — `echo "store x; search x; exit" | memos repl` is a
 * useful CI sanity check.
 *
 * The dispatch function is exported separately from the readline
 * loop so the test suite can exercise it without driving a real
 * TTY. See `__tests__/repl.test.ts`.
 *
 * @module @memos/repl
 */

import { createInterface } from "node:readline";
import type { MemOS } from "./memory.js";
import type { ContextPack } from "./context-pack.js";

/**
 * ReplHandlers — owns the printable output stream and the exit
 * predicate. Tests construct this directly; `runRepl` builds one
 * for a real readline interface.
 */
export interface ReplHandlers {
  /** Dispatch one line of input. The result lands in `out`. */
  dispatch(line: string, out: string[]): Promise<void>;
  /** True for `exit` / `quit` / `q` — caller should break the loop. */
  shouldExit(line: string): boolean;
}

const BANNER =
  "MemOS interactive shell. Type `help` for commands, `exit` to quit.";

/**
 * Construct a ReplHandlers for a given MemOS instance.
 *
 * The handlers are pure with respect to `memos` — they only read
 * from the instance and write to the `out` array. That makes
 * them safe to construct in tests and to swap out for a real
 * readline interface at runtime.
 */
export function createReplHandlers(memos: MemOS): ReplHandlers {
  return {
    async dispatch(line, out) {
      const trimmed = line.trim();
      if (!trimmed) return;

      const [command, ...rest] = trimmed.split(/\s+/);
      const args = rest.join(" ");

      switch (command) {
        case "help":
        case "?":
          out.push("Available commands:");
          for (const name of REPL_COMMANDS) {
            out.push(`  ${name}`);
          }
          out.push("");
          out.push("Usage: each command takes a single line of arguments.");
          out.push('Quoted strings stay together: store "hello world".');
          break;

        case "store": {
          const content = unquote(args);
          if (!content) {
            out.push("Usage: store <content>");
            break;
          }
          const { node } = await memos.store(content);
          out.push(`Stored memory: ${node.id}`);
          break;
        }

        case "retrieve": {
          const id = args.trim();
          if (!id) {
            out.push("Usage: retrieve <id>");
            break;
          }
          const node = await memos.retrieve(id);
          if (!node) {
            out.push(`Memory not found: ${id}`);
            break;
          }
          out.push(`[${node.type}] ${node.content}`);
          out.push(`  ID: ${node.id}`);
          out.push(`  Importance: ${node.importance}`);
          out.push(`  Access count: ${node.accessCount}`);
          break;
        }

        case "search": {
          if (!args.trim()) {
            out.push("Usage: search <query>");
            break;
          }
          const results = await memos.search({ query: args, limit: 10 });
          if (results.length === 0) {
            out.push("No memories found.");
            break;
          }
          out.push(`Found ${results.length} memories:`);
          for (const r of results) {
            out.push(`  [${r.node.type}] ${r.node.content}`);
            out.push(`    ID: ${r.node.id}  Score: ${r.score.toFixed(3)}`);
          }
          break;
        }

        case "semantic": {
          if (!args.trim()) {
            out.push("Usage: semantic <query>");
            break;
          }
          const results = await memos.semanticSearch(args, 10);
          if (results.length === 0) {
            out.push("No memories found.");
            break;
          }
          out.push(`Found ${results.length} memories:`);
          for (const r of results) {
            out.push(`  [${r.node.type}] ${r.node.content}`);
            out.push(`    ID: ${r.node.id}  Score: ${r.score.toFixed(3)}`);
          }
          break;
        }

        case "forget": {
          const id = args.trim();
          if (!id) {
            out.push("Usage: forget <id>");
            break;
          }
          const deleted = await memos.forget(id);
          out.push(
            deleted ? `Forgot memory: ${id}` : `Memory not found: ${id}`,
          );
          break;
        }

        case "summarize": {
          out.push(await memos.summarize());
          break;
        }

        case "graph": {
          const g = await memos.getGraph();
          out.push(
            `Memory Graph: ${g.nodes.length} nodes, ${g.edges.length} edges`,
          );
          if (g.nodes.length > 0) {
            for (const n of g.nodes.slice(0, 20)) {
              out.push(
                `  [${n.type}] ${n.id.slice(0, 8)} — ${n.content.slice(0, 60)}`,
              );
            }
            if (g.nodes.length > 20) {
              out.push(`  ... ${g.nodes.length - 20} more`);
            }
          }
          break;
        }

        case "count": {
          out.push(`${memos.count} memories stored.`);
          break;
        }

        case "context-pack": {
          if (!args.trim()) {
            out.push("Usage: context-pack <query> [budget=N]");
            break;
          }
          const budgetMatch = args.match(/budget=(\d+)/);
          const query = args.replace(/budget=\d+/, "").trim();
          const tokenBudget = budgetMatch ? parseInt(budgetMatch[1], 10) : 1200;
          const pack = (await memos.contextPack({
            query,
            tokenBudget,
            format: "json",
          })) as any as ContextPack;
          out.push(
            `Context pack for "${query}" (${pack.items.length} items, ${pack.tokenBudget} token budget):`,
          );
          for (const item of pack.items) {
            out.push(
              `  [${item.score.toFixed(3)}] ${item.content.slice(0, 80)}`,
            );
          }
          break;
        }

        case "flush-embeddings": {
          await memos.flushEmbeddings();
          const status = memos.embeddingStatus();
          out.push(
            `Flushed embedding queue. Pending: ${status.pending}, running: ${status.running}.`,
          );
          break;
        }

        case "embedding-status": {
          const status = memos.embeddingStatus();
          out.push(
            `Embedding queue: ${status.pending} pending, ${status.running} running, ${status.total} nodes tracked.`,
          );
          break;
        }

        case "tag": {
          const parts = args.split(/\s+/);
          const id = parts[0];
          const tags = parts.slice(1);
          if (!id || tags.length === 0) {
            out.push("Usage: tag <id> <tag1> [tag2...]");
            break;
          }
          await memos.tag(id, tags);
          out.push(`Tagged ${id.slice(0, 8)} with: ${tags.join(", ")}`);
          break;
        }

        case "untag": {
          const parts = args.split(/\s+/);
          const id = parts[0];
          const tags = parts.slice(1);
          if (!id || tags.length === 0) {
            out.push("Usage: untag <id> <tag1> [tag2...]");
            break;
          }
          await memos.untag(id, tags);
          out.push(`Removed tags from ${id.slice(0, 8)}: ${tags.join(", ")}`);
          break;
        }

        case "link": {
          const parts = args.split(/\s+/);
          if (parts.length < 2) {
            out.push("Usage: link <source-id> <target-id>");
            break;
          }
          const edge = await memos.link(parts[0], parts[1]);
          out.push(
            `Linked: ${parts[0].slice(0, 8)} --[${edge.relation}]--> ${parts[1].slice(0, 8)}`,
          );
          break;
        }

        case "exit":
        case "quit":
          out.push("Bye.");
          break;

        default:
          out.push(`Unknown command: ${command}. Type \`help\` for the list.`);
      }
    },
    shouldExit(line) {
      const t = line.trim().toLowerCase();
      return t === "exit" || t === "quit" || t === "q";
    },
  };
}

/** Commands the help screen advertises. Kept in sync with the dispatcher. */
const REPL_COMMANDS = [
  "store <content>",
  "retrieve <id>",
  "search <query>",
  "semantic <query>",
  "forget <id>",
  "summarize",
  "graph",
  "count",
  "context-pack <query> [budget=N]",
  "flush-embeddings",
  "embedding-status",
  "tag <id> <tag1> [tag2...]",
  "untag <id> <tag1> [tag2...]",
  "link <source-id> <target-id>",
  "exit",
];

/**
 * Strip a single layer of matched quotes from a string. Lets users
 * type `store "hello world"` without the quotes landing in the
 * stored content.
 */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Run the interactive REPL. Connects the dispatcher to a readline
 * interface on stdin/stdout and exits when the user types one of
 * the exit commands.
 */
export async function runRepl(memos: MemOS): Promise<void> {
  const handlers = createReplHandlers(memos);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  // eslint-disable-next-line no-console
  console.log(BANNER);

  for await (const line of rl) {
    if (handlers.shouldExit(line)) break;
    const out: string[] = [];
    try {
      await handlers.dispatch(line, out);
    } catch (err) {
      out.push(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const chunk of out) {
      // eslint-disable-next-line no-console
      console.log(`memos> ${chunk}`);
    }
  }

  rl.close();
  await memos.close();
}
