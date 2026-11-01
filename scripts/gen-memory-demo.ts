/**
 * Record a real MemOS trace for the website playground.
 *
 * The playground ships these results verbatim for preset queries (recorded
 * from the actual SDK) and only falls back to a clearly-labelled lexical
 * model for arbitrary queries typed in the browser.
 *
 * Usage: npx tsx scripts/gen-memory-demo.ts
 */

import { writeFileSync } from "node:fs";
import { MemOS } from "../src/memory.js";
import { estimateTokens } from "../src/context-pack.js";

const memories: Array<{
  content: string;
  type: "fact" | "preference" | "context" | "relationship" | "entity";
  tags: string[];
  source: "user_input" | "agent_inferred" | "tool_output" | "external_data";
  trust: number;
}> = [
  {
    content:
      "User prefers the Solarized Dark theme in VS Code and the terminal.",
    type: "preference",
    tags: ["editor", "theme", "ui"],
    source: "user_input",
    trust: 0.95,
  },
  {
    content: "The team deploys on Fridays at 14:00 UTC, never after 16:00.",
    type: "fact",
    tags: ["deploy", "team", "process"],
    source: "user_input",
    trust: 0.9,
  },
  {
    content:
      "Deploys run through GitHub Actions and require a green CI run plus one approval.",
    type: "context",
    tags: ["deploy", "ci", "github"],
    source: "tool_output",
    trust: 0.82,
  },
  {
    content:
      "Rollback is `kubectl rollout undo deployment/api` in the production cluster.",
    type: "fact",
    tags: ["deploy", "rollback", "kubernetes"],
    source: "external_data",
    trust: 0.78,
  },
  {
    content: "The platform team owns the API gateway and the deploy pipeline.",
    type: "relationship",
    tags: ["team", "platform", "ownership"],
    source: "user_input",
    trust: 0.88,
  },
  {
    content:
      "Priya leads the platform team and reviews production changes on Thursdays.",
    type: "entity",
    tags: ["team", "platform", "people"],
    source: "user_input",
    trust: 0.86,
  },
  {
    content:
      "Project Atlas uses pnpm workspaces and a single SQLite file per service.",
    type: "fact",
    tags: ["atlas", "tooling", "sqlite"],
    source: "user_input",
    trust: 0.92,
  },
  {
    content: "User is allergic to shellfish and avoids oyster sauce.",
    type: "preference",
    tags: ["food", "allergy", "health"],
    source: "user_input",
    trust: 1,
  },
  {
    content: "The staging database is reset every Monday at 03:00 UTC.",
    type: "fact",
    tags: ["staging", "database", "schedule"],
    source: "agent_inferred",
    trust: 0.66,
  },
  {
    content:
      "Incident 2026-10-14: the API gateway ran out of file descriptors after a config reload.",
    type: "context",
    tags: ["incident", "gateway", "postmortem"],
    source: "external_data",
    trust: 0.74,
  },
  {
    content:
      "User prefers concise answers with code first and explanation second.",
    type: "preference",
    tags: ["communication", "style"],
    source: "user_input",
    trust: 0.93,
  },
  {
    content:
      "The design review happens on Wednesdays and needs a Figma link in the agenda.",
    type: "context",
    tags: ["design", "meeting", "process"],
    source: "user_input",
    trust: 0.8,
  },
];

const queries = [
  "What theme does the user prefer?",
  "How do we deploy and roll back?",
  "Who owns the platform and gateway?",
];

async function main(): Promise<void> {
  const memos = new MemOS({ dbPath: ":memory:" });
  await memos.init();
  try {
    const stored = [];
    for (const entry of memories) {
      const { node } = await memos.store(entry.content, {
        type: entry.type,
        tags: entry.tags,
        source: entry.source,
      });
      await memos.setTrust(node.id, entry.trust);
      stored.push({
        id: node.id,
        content: node.content,
        type: node.type,
        tags: node.tags,
        source: node.source,
        trustScore: entry.trust,
      });
    }

    const recordedQueries = [];
    for (const query of queries) {
      const hits = await memos.search({ query, limit: 5 });
      const pack = await memos.contextPack({
        query,
        tokenBudget: 600,
        format: "json",
        includeSummary: true,
      });
      recordedQueries.push({
        query,
        results: hits.map((hit) => ({
          id: hit.node.id,
          score: Math.round(hit.score * 1000) / 1000,
        })),
        pack:
          typeof pack === "string"
            ? pack
            : {
                items: pack.items.map((item) => ({
                  id: item.id,
                  content: item.content,
                  citation: item.citation ?? `[mem:${item.id.slice(0, 8)}]`,
                  tokens: estimateTokens(item.content),
                })),
                totalTokens: estimateTokens(JSON.stringify(pack)),
                tokensSaved: pack.tokensSaved,
                markdown: [
                  "## Memory context",
                  "",
                  ...pack.items.map(
                    (item) =>
                      `- ${item.content} ${item.citation ?? `[mem:${item.id.slice(0, 8)}]`}`,
                  ),
                ].join("\n"),
              },
      });
    }

    const out = {
      generatedAt: new Date().toISOString(),
      engine: "MemOS 1.6.27 · default local embeddings",
      note: "Preset query results and packs were recorded from the real SDK. Arbitrary queries typed in the browser use a local lexical scorer, not the SDK.",
      memories: stored,
      queries: recordedQueries,
    };
    writeFileSync(
      "website/data/memory-demo.json",
      `${JSON.stringify(out, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `wrote website/data/memory-demo.json (${stored.length} memories, ${recordedQueries.length} recorded queries)`,
    );
  } finally {
    await memos.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
