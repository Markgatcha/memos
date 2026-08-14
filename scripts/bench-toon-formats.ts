/**
 * Before/after benchmark: compare JSON, verbose TOON, and compact TOON
 * token savings on realistic memory search results.
 *
 * Mirrors Mem0's Claude Code experiment: measures the actual token
 * footprint of memory injected into context across all three formats,
 * so we can see how much our compact TOON format saves vs the
 * already-53%-reduced verbose TOON.
 *
 * Usage:
 *   npx tsx scripts/bench-toon-formats.ts
 */

import { MemOS } from "../src/memory";
import { estimateTokens } from "../src/context-pack";
import type { ScoredMemory } from "../src/types";

// ---------------------------------------------------------------------------
// Real-world memory fixtures (mimics what an agent would store)
// ---------------------------------------------------------------------------

const fixtures: {
  content: string;
  type: string;
  tags: string[];
  source: string;
  trustScore: number;
}[] = [
  {
    content:
      "User prefers dark mode in their code editor and terminal. Uses VS Code with the One Dark Pro theme. Also sets GitHub to dark mode.",
    type: "preference",
    tags: ["ui", "editor", "theme"],
    source: "user_input",
    trustScore: 0.9,
  },
  {
    content:
      "User works at Google as a Senior Software Engineer on the Cloud Spanner team. They've been there since 2020 after switching from academia.",
    type: "fact",
    tags: ["work", "employment"],
    source: "user_input",
    trustScore: 1.0,
  },
  {
    content:
      "Coffee preference: User drinks pour-over coffee in the morning, specifically using a Hario V60 with Ethiopian single-origin beans, medium-fine grind, 22g for a 350ml cup. Water temperature 93°C, 3-minute total brew time.",
    type: "preference",
    tags: ["lifestyle", "coffee"],
    source: "user_input",
    trustScore: 1.0,
  },
  {
    content:
      "Python project for building AI agents. Uses pydantic for type safety, FastAPI for the HTTP layer, and pytest for testing. Dependencies are managed with pnpm workspaces in a monorepo structure.",
    type: "context",
    tags: ["work", "python", "tech-stack"],
    source: "user_input",
    trustScore: 0.95,
  },
  {
    content:
      "Meeting scheduled for Tuesday at 2 PM PST with Dr. Sarah Chen from Stanford to discuss the Q3 research collaboration. Agenda includes model evaluation methodology and dataset sharing protocols.",
    type: "context",
    tags: ["work", "meeting"],
    source: "user_input",
    trustScore: 0.85,
  },
  {
    content:
      "User's partner Alex is a product manager at Notion. They met at a TypeScript meetup in 2021. Alex prefers oat milk in their coffee and is allergic to shellfish.",
    type: "relationship",
    tags: ["personal", "partner"],
    source: "user_input",
    trustScore: 0.9,
  },
  {
    content:
      "Exercise routine: User runs 5K every morning before work, follows a vegetarian diet with occasional pescatarian options, and does yoga twice a week. Takes vitamin D3 supplements daily.",
    type: "preference",
    tags: ["health", "lifestyle"],
    source: "user_input",
    trustScore: 0.8,
  },
  {
    content:
      "Favorite podcasts: The Rest Is History (history), Hardcore History (deep-dive history), and Software Engineering Daily (tech). Listens during commute and weekend runs.",
    type: "preference",
    tags: ["media", "podcasts"],
    source: "user_input",
    trustScore: 0.7,
  },
  {
    content:
      "Current project: Building a universal memory layer for AI agents called MemOS. It's a TypeScript/Node.js library that provides graph-based persistent memory using SQLite. The repo is at github.com/Markgatcha/memos.",
    type: "fact",
    tags: ["work", "project", "memos"],
    source: "agent_inferred",
    trustScore: 0.7,
  },
  {
    content:
      "Travel plans: User is visiting Tokyo from August 15-22, 2026. Has a reservation at the Park Hyatt Hotel in Shinjuku. Wants to try ramen at Ichiran and visit the teamLab Borderless museum.",
    type: "context",
    tags: ["travel", "personal"],
    source: "user_input",
    trustScore: 0.95,
  },
  {
    content:
      "Book recommendation from last month: The Programming Machine by Dilip Sarwate. User said it was helpful for understanding compiler design and finite state machines. Added to their reading list.",
    type: "fact",
    tags: ["books", "recommendations"],
    source: "agent_inferred",
    trustScore: 0.6,
  },
  {
    content:
      "Financial reminder: User's credit card payment is due on the 5th of each month. Minimum payment is $250, but they typically pay the full balance. Card is with Chase Sapphire Reserve.",
    type: "context",
    tags: ["finance", "reminder"],
    source: "user_input",
    trustScore: 0.9,
  },
  {
    content:
      "Vehicle: User owns a 2022 Tesla Model 3 Long Range in red. Has Full Self-Driving capability. Charging is usually done at home (level 2 charger) but they use Superchargers for long trips.",
    type: "fact",
    tags: ["personal", "vehicle"],
    source: "user_input",
    trustScore: 0.95,
  },
  {
    content:
      "Family: Two younger siblings — Maya (born 2005, studying engineering at MIT) and Ben (born 2008, in high school). Parents live in Portland, OR. Family dog is a corgi named Pixel.",
    type: "relationship",
    tags: ["family", "personal"],
    source: "user_input",
    trustScore: 0.85,
  },
  {
    content:
      "Health note from conversation: User mentioned occasional migraines, especially around weather changes. Takes sumatriptan as needed. Prefers non-pharmaceutical approaches first — stays hydrated and uses a blue light filter.",
    type: "context",
    tags: ["health", "medical"],
    source: "user_input",
    trustScore: 0.9,
  },
  {
    content:
      "VS Code extensions the user has installed: Python (ms-python.python), ESLint (dbaeumer.vscode-eslint), Prettier (esbenp.prettier-vscode), GitLens (eamodio.gitlens), and Error Lens (usernamehw.errorlens). Workspace has specific settings for indent size 2 and format on save.",
    type: "preference",
    tags: ["tech", "editor", "extensions"],
    source: "user_input",
    trustScore: 0.85,
  },
  {
    content:
      "User is learning Japanese using WaniKani (currently level 22) and Anki for vocabulary flashcards. They study for 30 minutes daily and have a trip to Japan planned for August 2026 to take the JLPT N3 exam.",
    type: "context",
    tags: ["language", "learning", "japanese"],
    source: "user_input",
    trustScore: 0.8,
  },
  {
    content:
      "Hardware setup: Custom-built Windows 11 desktop with AMD Ryzen 7 7800X3D, 32GB DDR5-5600, RTX 4070, 2TB NVMe SSD. Secondary 27-inch 1440p monitor for multitasking. Mechanical keyboard (Brown switches).",
    type: "context",
    tags: ["hardware", "setup"],
    source: "user_input",
    trustScore: 0.9,
  },
  {
    content:
      "Music recommendation: User enjoyed the album 'Bruton' by Black Country, New Road. They prefer complex, emotionally intense indie rock with orchestral elements. Also likes Swans, Godspeed You! Black Emperor, and Low.",
    type: "preference",
    tags: ["music", "recommendations"],
    source: "user_input",
    trustScore: 0.75,
  },
  {
    content:
      "Online accounts security: User uses 1Password for password management, has 2FA enabled on all critical accounts (GitHub, Google, banking), and uses a YubiKey 5 NFC for hardware security keys. Last password audit was in June 2026.",
    type: "fact",
    tags: ["security", "privacy"],
    source: "user_input",
    trustScore: 0.95,
  },
];

// ---------------------------------------------------------------------------
// Synthetic search results (mimic what search() returns)
// ---------------------------------------------------------------------------

function makeScoredResults(items: typeof fixtures): ScoredMemory[] {
  return items.map((item, i) => ({
    node: {
      id: `mem_${Buffer.from(item.content.slice(0, 8)).toString("hex")}`,
      content: item.content,
      summary: item.content.slice(0, 80) + "...",
      type: item.type as any,
      metadata: {},
      importance: 0.7,
      createdAt: Date.now() - 86400000 * (i + 1),
      updatedAt: Date.now() - 86400000 * i,
      accessCount: 5 + i,
      lastAccessed: Date.now() - 3600000 * i,
      tags: item.tags,
      expiresAt: null,
      namespace: "demo",
      validFrom: null,
      validTo: null,
      source: item.source as any,
      trustScore: item.trustScore,
    },
    score: 0.95 - i * 0.03,
    scores: { keyword: 0.8, semantic: 0.9, hybrid: 0.85 },
  }));
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

async function run() {
  const results = makeScoredResults(fixtures);
  const query = "user preferences and work context";
  const tokenBudget = 8000;

  console.log("=== TOON Format Comparison Benchmark ===\n");
  console.log(`Fixtures: ${fixtures.length} memory entries`);
  console.log(`Query: "${query}"`);
  console.log(`Token budget: ${tokenBudget}\n`);

  // JSON (full object serialization)
  const jsonStr = JSON.stringify(results);
  const jsonTokens = estimateTokens(jsonStr);

  // Verbose TOON (current format)
  const { searchResultsToToon } = await import("../src/context-pack");
  const verboseToon = searchResultsToToon(results);
  const verboseToonTokens = estimateTokens(verboseToon);

  // Compact TOON (new format)
  const { searchResultsToToonCompact } = await import("../src/context-pack");
  const compactToon = searchResultsToToonCompact(results);
  const compactToonTokens = estimateTokens(compactToon);

  // Also test context pack formats
  const { buildContextPack, serializeContextPack } =
    await import("../src/context-pack");

  // Build a pack from these results
  const pack = buildContextPack({
    query,
    namespace: "demo",
    tokenBudget,
    items: results,
    includeSummary: true,
  });

  // Pack as JSON
  const packJson = JSON.stringify(pack);
  const packJsonTokens = estimateTokens(packJson);

  // Pack as verbose TOON
  const packToon = serializeContextPack(pack, "toon");
  const packToonTokens = estimateTokens(packToon as string);

  // Pack as compact TOON
  const packToonCompact = serializeContextPack(pack, "toon-compact");
  const packToonCompactTokens = estimateTokens(packToonCompact as string);

  console.log(
    "┌──────────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│                        SEARCH RESULTS                           │",
  );
  console.log(
    "├──────────────────────────────────────────────────────────────────┤",
  );
  console.log("│ JSON (full objects)              │");
  console.log(`│   Chars: ${jsonStr.length}`);
  console.log(`│   Tokens: ${jsonTokens}`);
  console.log(
    "├──────────────────────────────────────────────────────────────────┤",
  );
  console.log("│ Verbose TOON (current)           │");
  console.log(`│   Chars: ${verboseToon.length}`);
  console.log(`│   Tokens: ${verboseToonTokens}`);
  console.log(
    `│   Savings vs JSON: ${((1 - verboseToonTokens / jsonTokens) * 100).toFixed(1)}%`,
  );
  console.log(
    "├──────────────────────────────────────────────────────────────────┤",
  );
  console.log("│ Compact TOON (new)               │");
  console.log(`│   Chars: ${compactToon.length}`);
  console.log(`│   Tokens: ${compactToonTokens}`);
  console.log(
    `│   Savings vs JSON: ${((1 - compactToonTokens / jsonTokens) * 100).toFixed(1)}%`,
  );
  console.log(
    `│   Improvement vs verbose TOON: ${((1 - compactToonTokens / verboseToonTokens) * 100).toFixed(1)}%`,
  );
  console.log(
    "└──────────────────────────────────────────────────────────────────┘\n",
  );

  console.log(
    "┌──────────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│                     CONTEXT PACK FORMATS                        │",
  );
  console.log(
    "├──────────────────────────────────────────────────────────────────┤",
  );
  console.log("│ JSON (full pack)                 │");
  console.log(`│   Chars: ${packJson.length}`);
  console.log(`│   Tokens: ${packJsonTokens}`);
  console.log(
    "├──────────────────────────────────────────────────────────────────┤",
  );
  console.log("│ Verbose TOON pack                │");
  console.log(`│   Chars: ${(packToon as string).length}`);
  console.log(`│   Tokens: ${packToonTokens}`);
  console.log(
    `│   Savings vs JSON: ${((1 - packToonTokens / packJsonTokens) * 100).toFixed(1)}%`,
  );
  console.log(
    "├──────────────────────────────────────────────────────────────────┤",
  );
  console.log("│ Compact TOON pack (new)          │");
  console.log(`│   Chars: ${(packToonCompact as string).length}`);
  console.log(`│   Tokens: ${packToonCompactTokens}`);
  console.log(
    `│   Savings vs JSON: ${((1 - packToonCompactTokens / packJsonTokens) * 100).toFixed(1)}%`,
  );
  console.log(
    `│   Improvement vs verbose TOON: ${((1 - packToonCompactTokens / packToonTokens) * 100).toFixed(1)}%`,
  );
  console.log(
    "└──────────────────────────────────────────────────────────────────┘\n",
  );

  // Show sample output
  console.log("=== Sample Output Comparison ===\n");
  console.log("--- Verbose TOON ---");
  console.log(verboseToon.split("\n").slice(0, 6).join("\n"));
  console.log("\n--- Compact TOON ---");
  console.log(compactToon.split("\n").slice(0, 6).join("\n"));

  // Show compact pack
  console.log("\n--- Compact TOON Context Pack ---");
  console.log((packToonCompact as string).split("\n").slice(0, 6).join("\n"));
}

run().catch(console.error);
