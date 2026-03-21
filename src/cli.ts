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
 *   memos serve           # Start the HTTP server
 *
 * @module @memos/cli
 */

import { MemOS } from "./memory";
import { resolve } from "path";

const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
  console.log(`
MemOS — Universal memory layer for AI agents.

Usage:
  memos <command> [options]

Commands:
  store <content>     Store a new memory
  retrieve <id>       Retrieve a memory by ID
  search <query>      Search memories by text
  forget <id>         Delete a memory by ID
  summarize           Summarize all memories
  graph               Print the full memory graph
  link <src> <dst>    Link two memories
  count               Show memory count
  serve               Start the HTTP server
  help                Show this help message

Options:
  --db <path>         Database path (default: ~/.memos/memos.db)
  --type <type>       Memory type (store command)
  --limit <n>         Result limit (search command)
  --json              Output as JSON

Examples:
  memos store "User prefers dark mode" --type preference
  memos search "dark mode" --limit 5
  memos store "Project uses TypeScript" --type fact --json
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
        const result = await memos.store(
          content,
          type ? { type: type as any } : {},
        );
        if (jsonFlag) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Stored memory: ${result.node.id}`);
          console.log(`  Summary: ${result.node.summary}`);
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
        const results = await memos.search({ query, limit });
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

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    await memos.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
