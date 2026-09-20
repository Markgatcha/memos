#!/usr/bin/env npx tsx
/**
 * Measure tokens-per-level for fidelity-level compaction.
 *
 * Builds a 50-memory fixture with realistic multi-sentence content,
 * runs `buildContextPack` at each fidelity level (L0–L3), and prints
 * the tokens-per-item table. Pure function path — no database needed.
 *
 * Usage: npx tsx scripts/measure-fidelity-tokens.ts
 */
import { buildContextPack, estimateTokens } from "../src/context-pack.js";
import { stampFidelityCache } from "../src/fidelity.js";
import type { FidelityLevel } from "../src/fidelity.js";
import type { MemoryNode, ScoredMemory } from "../src/types.js";

const TOPICS: Array<{
  tags: string[];
  entities: string[];
  sentences: string[];
}> = [
  {
    tags: ["database", "postgres"],
    entities: ["postgres", "connection pool"],
    sentences: [
      "The Postgres connection pool is configured with a maximum of 25 connections.",
      "The pool saturates under peak load every Friday afternoon when batch jobs run.",
      "We tuned the connection timeouts after last week's outage caused cascading failures.",
      "The on-call engineer paged the database team at 3am during the incident.",
      "Connection pool metrics are exported to Prometheus every fifteen seconds.",
    ],
  },
  {
    tags: ["editor", "preferences"],
    entities: ["zed", "dark mode"],
    sentences: [
      "Mark prefers dark mode across all of his development tools.",
      "He uses the Zed editor with the One Dark theme and a customized status bar.",
      "His terminal uses the Tokyo Night color scheme with ligature support enabled.",
      "Font size is set to fourteen points with a line height of one point six.",
      "He disables minimap and breadcrumbs to keep the interface minimal.",
    ],
  },
  {
    tags: ["cache", "redis"],
    entities: ["redis", "session cache"],
    sentences: [
      "The Redis session cache uses a thirty minute TTL with sliding expiration.",
      "Cache stampedes are prevented with probabilistic early refresh on hot keys.",
      "We migrated from Memcached to Redis in March for persistence support.",
      "Eviction policy is set to allkeys-lru across the three node cluster.",
      "Session data is namespaced by deployment region to avoid collisions.",
    ],
  },
  {
    tags: ["ci", "deploy"],
    entities: ["github actions", "docker"],
    sentences: [
      "The deploy pipeline runs on GitHub Actions with a matrix of Node versions.",
      "Docker images are built with multi-stage builds to keep them small.",
      "Rollbacks are automated via the previous successful artifact tag.",
      "Integration tests run against an ephemeral Postgres service container.",
      "Deployments to production require two approvals from the platform team.",
    ],
  },
  {
    tags: ["auth", "security"],
    entities: ["oauth", "jwt"],
    sentences: [
      "Authentication uses OAuth two with PKCE for the mobile clients.",
      "JWT access tokens expire after fifteen minutes and refresh tokens after seven days.",
      "Token revocation is handled through a Redis denylist checked on every request.",
      "The auth migration from session cookies finished in January without downtime.",
      "Service-to-service calls use mTLS with certificates rotated monthly.",
    ],
  },
];

function makeNode(id: string, topicIdx: number, variant: number): MemoryNode {
  const topic = TOPICS[topicIdx % TOPICS.length]!;
  // Rotate sentence order per variant so fixtures are not identical.
  const sentences = [
    ...topic.sentences.slice(variant % topic.sentences.length),
    ...topic.sentences.slice(0, variant % topic.sentences.length),
  ];
  const content = sentences.join(" ");
  const node = {
    id: `fixture-${id}`,
    content,
    summary: sentences[0]!,
    type: "fact",
    metadata: { entities: topic.entities },
    importance: 0.5,
    createdAt: 1000,
    updatedAt: 1000,
    accessCount: 0,
    lastAccessed: 1000,
    tags: topic.tags,
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    trustScore: 1.0,
  } as MemoryNode;
  stampFidelityCache(node);
  return node;
}

function main(): void {
  const nodes: MemoryNode[] = [];
  for (let i = 0; i < 50; i += 1) {
    nodes.push(makeNode(String(i), Math.floor(i / 10), i));
  }
  const items: ScoredMemory[] = nodes.map((node, i) => ({
    node,
    score: 1 - i / 100,
  }));

  const levels: FidelityLevel[] = ["L0", "L1", "L2", "L3"];
  console.log("fidelity tokens-per-level (50 memories, context-pack):\n");
  console.log(
    "  level  label               tok/item   total tok   vs verbatim",
  );
  let baseline = 0;
  const rows: Array<{ level: FidelityLevel; perItem: number; total: number }> =
    [];
  for (const level of levels) {
    const pack = buildContextPack({
      query: "fixture measurement",
      namespace: "default",
      tokenBudget: 1_000_000,
      items,
      fidelity: level,
      debloat: false,
      dedup: false,
      includeSummary: false,
    });
    const total = pack.items.reduce(
      (sum, item) => sum + estimateTokens(item.content),
      0,
    );
    if (level === "L3") baseline = total;
    rows.push({ level, perItem: total / pack.items.length, total });
  }
  const labels: Record<FidelityLevel, string> = {
    L0: "tags + entities",
    L1: "typed facts",
    L2: "extractive summary",
    L3: "verbatim",
  };
  for (const row of rows) {
    const saved =
      row.level === "L3"
        ? "baseline"
        : `-${((1 - row.total / baseline) * 100).toFixed(1)}%`;
    console.log(
      `  ${row.level}     ${labels[row.level].padEnd(18)} ${row.perItem.toFixed(1).padStart(8)} ${String(row.total).padStart(11)}   ${saved}`,
    );
  }
}

main();
