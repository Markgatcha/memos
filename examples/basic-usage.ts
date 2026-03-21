/**
 * Example: Using MemOS with a simple chat loop.
 *
 * Run: npx ts-node examples/basic-usage.ts
 *   or: node --loader ts-node/esm examples/basic-usage.ts
 */

import { MemOS } from "../src/index";

async function main() {
  const memos = new MemOS({ dbPath: "./example.db" });
  await memos.init();

  console.log("--- Storing memories ---\n");

  const m1 = await memos.store("User prefers dark mode in all applications", {
    type: "preference",
  });
  console.log(`Stored: ${m1.node.id.slice(0, 8)} — ${m1.node.summary}`);

  const m2 = await memos.store("Project uses TypeScript and React with Vite", {
    type: "fact",
  });
  console.log(`Stored: ${m2.node.id.slice(0, 8)} — ${m2.node.summary}`);

  const m3 = await memos.store("User lives in Berlin, UTC+1 timezone", {
    type: "context",
  });
  console.log(`Stored: ${m3.node.id.slice(0, 8)} — ${m3.node.summary}`);

  const m4 = await memos.store("Dark mode reduces eye strain during night work", {
    type: "fact",
  });
  console.log(`Stored: ${m4.node.id.slice(0, 8)} — ${m4.node.summary}`);

  // Auto-links
  if (m1.links.length > 0) {
    console.log(`\nAuto-linked ${m1.links.length} related memories`);
  }

  console.log("\n--- Searching ---\n");

  const results = await memos.search("dark mode");
  for (const r of results) {
    console.log(`  [${r.node.type}] ${r.node.content} (score: ${r.score.toFixed(3)})`);
  }

  console.log("\n--- Graph ---\n");

  const graph = await memos.getGraph();
  console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges`);

  for (const edge of graph.edges) {
    const src = graph.nodes.find((n) => n.id === edge.sourceId);
    const tgt = graph.nodes.find((n) => n.id === edge.targetId);
    console.log(
      `  ${src?.content.slice(0, 30)} --[${edge.relation}]--> ${tgt?.content.slice(0, 30)}`
    );
  }

  console.log("\n--- Summary ---\n");
  const summary = await memos.summarize();
  console.log(summary);

  // Cleanup
  await memos.close();
  console.log("\nDone.");
}

main().catch(console.error);
