#!/usr/bin/env node

/**
 * MemOS CLI — command-line interface for the MemOS memory layer.
 *
 * Usage:
 *   memos store "User prefers dark mode" --type preference
 *   memos search "dark mode"
 *   memos retrieve <id>
 *   memos forget <id>
 *   memos summarize
 *   memos graph
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
import { getSdkVersion } from "./version.js";
import { resolve, dirname, join } from "path";
import {
  existsSync,
  copyFileSync,
  statSync,
  writeFileSync,
  readFileSync,
} from "fs";

const args = process.argv.slice(2);
const command = args[0];

/**
 * Filter out flags and their values from an argument list.
 * Flags that take a value: --db, --type, --ttl, --limit, --format, --output
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

function printHelp(): void {
  console.log(`
MemOS — Universal memory layer for AI agents.

Usage:
  memos <command> [options]

Commands:
  store <content>         Store a new memory
  retrieve <id>           Retrieve a memory by ID
  search <query>          Search memories by text
  forget <id>             Delete a memory by ID
  summarize               Summarize all memories
  graph                   Print the full memory graph
  link <src> <dst>        Link two memories
  count                   Show memory count
  tag <id> <tag> [...]    Add tags to a memory
  untag <id> <tag> [...]  Remove tags from a memory
  list --tag <tag>        List memories by tag
  export                  Export memories to file
  backup                  Backup the database
  restore <path>          Restore from a backup
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
  const dbPath = dbFlagIdx !== -1 ? args[dbFlagIdx + 1] : undefined;
  const jsonFlag = args.includes("--json");

  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer({ dbPath });
    return;
  }

  const memos = new MemOS({ dbPath });
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
        const result = await memos.store(content, opts as any);
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
        const results = await memos.search({ query, limit, tags: searchTags });
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
        if (jsonFlag) {
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
          format: format as any,
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

        const children: any[] = [];
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
