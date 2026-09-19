// `memos browse` — interactive terminal browser for the local memory store.
//
// A dependency-free pager built entirely on existing MemOS APIs
// (getGraph / search / retrieve / forget) so it stays in sync with the SDK:
// browse everything, full-text search, inspect a memory's details, and
// forget entries without leaving the terminal.
//
// Console output is the entire UI here, so no-console is disabled file-wide.
/* eslint-disable no-console */

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { MemOS } from "./memory.js";
import type { MemoryNode } from "./types.js";

const PAGE_SIZE = 10;

function row(node: MemoryNode, index: number): string {
  const content =
    node.content.length > 56 ? `${node.content.slice(0, 53)}...` : node.content;
  return `  ${(index + 1).toString().padStart(3)}  [${node.type}] ${node.id.slice(0, 8)} — ${content}`;
}

async function currentList(memos: MemOS, query: string): Promise<MemoryNode[]> {
  if (query) {
    const scored = await memos.search(query);
    return scored.map((s) => s.node);
  }
  const graph = await memos.getGraph();
  return graph.nodes;
}

function printPage(
  nodes: MemoryNode[],
  page: number,
  pages: number,
  query: string,
): void {
  console.log("\x1B[2J\x1B[H"); // clear screen, move cursor home
  const title = query ? `search: "${query}"` : "all memories";
  console.log(`MemOS browse — ${title} (${nodes.length})`);
  console.log("");
  if (nodes.length === 0) {
    console.log("  (nothing to show)");
  }
  for (
    let i = page * PAGE_SIZE;
    i < Math.min((page + 1) * PAGE_SIZE, nodes.length);
    i++
  ) {
    console.log(row(nodes[i], i));
  }
  console.log("");
  console.log(
    `  page ${page + 1}/${pages} · <n> detail · n next · p prev · s <query> search · s clears · f <n> forget · q quit`,
  );
}

export async function runBrowse(memos: MemOS): Promise<void> {
  const rl = readline.createInterface({ input, output });
  let query = "";
  let page = 0;

  try {
    while (true) {
      let nodes: MemoryNode[] = [];
      try {
        nodes = await currentList(memos, query);
      } catch (error) {
        console.log(
          `  search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const pages = Math.max(1, Math.ceil(nodes.length / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      printPage(nodes, page, pages, query);

      const answer = (await rl.question("browse> ")).trim();
      if (!answer) continue;

      if (answer === "q" || answer === "quit" || answer === "exit") {
        break;
      }

      if (answer === "n" || answer === "next") {
        page = Math.min(page + 1, pages - 1);
        continue;
      }

      if (answer === "p" || answer === "prev") {
        page = Math.max(page - 1, 0);
        continue;
      }

      if (answer === "s") {
        query = "";
        page = 0;
        continue;
      }

      if (answer.startsWith("s ")) {
        query = answer.slice(2).trim();
        page = 0;
        continue;
      }

      if (answer.startsWith("f ")) {
        const index = Number.parseInt(answer.slice(2), 10);
        const node = Number.isInteger(index) ? nodes[index - 1] : undefined;
        if (!node) {
          console.log("  no such row — pick a number from the list");
          continue;
        }
        const confirmed = (
          await rl.question(
            `  forget ${node.id.slice(0, 8)} "${node.content.slice(0, 40)}"? (y/N) `,
          )
        )
          .trim()
          .toLowerCase();
        if (confirmed === "y" || confirmed === "yes") {
          await memos.forget(node.id);
          console.log("  forgotten.");
        } else {
          console.log("  kept.");
        }
        continue;
      }

      const index = Number.parseInt(answer, 10);
      if (Number.isInteger(index)) {
        const node = nodes[index - 1];
        if (!node) {
          console.log("  no such row");
          continue;
        }
        const full = (await memos.retrieve(node.id)) ?? node;
        console.log("\x1B[2J\x1B[H");
        console.log(`id         ${full.id}`);
        console.log(`type       ${full.type}`);
        console.log(
          `created    ${"createdAt" in full ? String(full.createdAt) : "—"}`,
        );
        const tags =
          "tags" in full && Array.isArray(full.tags)
            ? full.tags.join(", ")
            : "";
        if (tags) console.log(`tags       ${tags}`);
        console.log("");
        console.log(full.content);
        console.log("");
        await rl.question("  (enter to go back) ");
        continue;
      }

      console.log("  ? — try a row number, n, p, s <query>, f <n>, or q");
    }
  } finally {
    rl.close();
  }
}
