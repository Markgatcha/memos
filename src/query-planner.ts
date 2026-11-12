/**
 * Query planner: route a query to a retrieval strategy by intent.
 *
 * MemOS already has the pieces — temporal anchoring, multi-hop expansion,
 * candidate-depth control — but they were opt-in flags. The planner decides
 * which ones a query actually needs, so the default path adapts to the
 * question instead of running one fixed pipeline.
 *
 * Rules are lexical and deliberately cheap: no model call, no allocation
 * beyond a lowercase copy. The output is advisory; callers can override
 * every switch.
 *
 * @module @mem-os/sdk/query-planner
 */

import type { QueryIntent } from "./types.js";

/** Retrieval switches recommended for one query. */
export interface QueryPlan {
  intent: QueryIntent;
  /** 0-1; share of matched signal weight won by the chosen intent. */
  confidence: number;
  /** Human-readable signal labels, e.g. `["how many", "total"]`. */
  signals: string[];
  /** Enable second-hop entity expansion (multi-session / aggregation). */
  multiHop: boolean;
  /** Pull a deeper candidate pool before ranking (aggregation). */
  widenCandidates: boolean;
  /** Prefer recent memories when scores are close (knowledge-update). */
  recencyBias: boolean;
  /** The query is a plausible "do you know?" abstention case. */
  abstentionHint: boolean;
}

interface Rule {
  intent: Exclude<QueryIntent, "general">;
  weight: number;
  signal: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  // Temporal
  { intent: "temporal", weight: 2, signal: "when", pattern: /\bwhen\b/ },
  {
    intent: "temporal",
    weight: 2,
    signal: "how long",
    pattern: /\bhow long\b/,
  },
  { intent: "temporal", weight: 1, signal: "before", pattern: /\bbefore\b/ },
  { intent: "temporal", weight: 1, signal: "after", pattern: /\bafter\b/ },
  { intent: "temporal", weight: 1, signal: "first", pattern: /\bfirst\b/ },
  { intent: "temporal", weight: 1, signal: "last", pattern: /\blast\b/ },
  {
    intent: "temporal",
    weight: 2,
    signal: "yesterday",
    pattern: /\byesterday\b/,
  },
  {
    intent: "temporal",
    weight: 2,
    signal: "relative week/month/year",
    pattern: /\b(last|this|next|past)\s+(week|month|year|quarter)\b/,
  },
  {
    intent: "temporal",
    weight: 2,
    signal: "year mention",
    pattern: /\b(in|since|during|back in)\s+(19|20)\d{2}\b/,
  },
  {
    intent: "temporal",
    weight: 1,
    signal: "month name",
    pattern:
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
  },

  // Knowledge update
  {
    intent: "knowledge-update",
    weight: 2,
    signal: "current",
    pattern: /\bcurrent(ly)?\b/,
  },
  {
    intent: "knowledge-update",
    weight: 2,
    signal: "latest",
    pattern: /\blatest\b/,
  },
  { intent: "knowledge-update", weight: 1, signal: "now", pattern: /\bnow\b/ },
  {
    intent: "knowledge-update",
    weight: 2,
    signal: "still",
    pattern: /\bstill\b/,
  },
  {
    intent: "knowledge-update",
    weight: 2,
    signal: "used to",
    pattern: /\bused to\b/,
  },
  {
    intent: "knowledge-update",
    weight: 1,
    signal: "changed",
    pattern: /\bchanged?\b/,
  },
  {
    intent: "knowledge-update",
    weight: 1,
    signal: "update",
    pattern: /\bupdate(d)?\b/,
  },
  {
    intent: "knowledge-update",
    weight: 2,
    signal: "anymore",
    pattern: /\banymore\b/,
  },

  // Aggregation
  {
    intent: "aggregation",
    weight: 4,
    signal: "how many",
    pattern: /\bhow many\b/,
  },
  {
    intent: "aggregation",
    weight: 4,
    signal: "how much",
    pattern: /\bhow much\b/,
  },
  { intent: "aggregation", weight: 2, signal: "total", pattern: /\btotal\b/ },
  { intent: "aggregation", weight: 1, signal: "count", pattern: /\bcount\b/ },
  { intent: "aggregation", weight: 1, signal: "all", pattern: /\ball\b/ },
  { intent: "aggregation", weight: 2, signal: "every", pattern: /\bevery\b/ },
  { intent: "aggregation", weight: 1, signal: "list", pattern: /\blist\b/ },

  // Multi-session
  {
    intent: "multi-session",
    weight: 2,
    signal: "across",
    pattern: /\bacross\b/,
  },
  {
    intent: "multi-session",
    weight: 2,
    signal: "compare",
    pattern: /\bcompare\b/,
  },
  { intent: "multi-session", weight: 1, signal: "both", pattern: /\bboth\b/ },
  {
    intent: "multi-session",
    weight: 2,
    signal: "difference",
    pattern: /\bdifference\b/,
  },
  {
    intent: "multi-session",
    weight: 2,
    signal: "over time",
    pattern: /\bover time\b/,
  },
  {
    intent: "multi-session",
    weight: 2,
    signal: "session",
    pattern: /\bsessions?\b/,
  },
  {
    intent: "multi-session",
    weight: 2,
    signal: "we discussed",
    pattern: /\bwe (discussed|talked|mentioned)\b/,
  },
  {
    intent: "multi-session",
    weight: 1,
    signal: "previously",
    pattern: /\bpreviously\b/,
  },

  // Abstention
  {
    intent: "abstention",
    weight: 3,
    signal: "do you know/remember",
    pattern: /\bdo you (know|remember)\b/,
  },
  {
    intent: "abstention",
    weight: 3,
    signal: "did i ever",
    pattern: /\bdid i (ever|mention)\b/,
  },
  { intent: "abstention", weight: 2, signal: "have i", pattern: /\bhave i\b/ },
  {
    intent: "abstention",
    weight: 2,
    signal: "is there any",
    pattern: /\bis there any\b/,
  },
  {
    intent: "abstention",
    weight: 1,
    signal: "any idea",
    pattern: /\bany idea\b/,
  },
];

const INTENTS: ReadonlyArray<Exclude<QueryIntent, "general">> = [
  "temporal",
  "knowledge-update",
  "aggregation",
  "multi-session",
  "abstention",
];

/**
 * Classify a query and return the retrieval switches it implies.
 *
 * Deterministic and allocation-light; safe to call on every search.
 */
export function planQuery(query: string): QueryPlan {
  const text = query.toLowerCase();
  const scores = new Map<Exclude<QueryIntent, "general">, number>();
  const signals: string[] = [];

  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    scores.set(rule.intent, (scores.get(rule.intent) ?? 0) + rule.weight);
    signals.push(rule.signal);
  }

  let intent: QueryIntent = "general";
  let topScore = 0;
  let totalScore = 0;
  for (const candidate of INTENTS) {
    const score = scores.get(candidate) ?? 0;
    totalScore += score;
    if (score > topScore) {
      topScore = score;
      intent = candidate;
    }
  }

  const confidence = totalScore > 0 ? topScore / totalScore : 0;
  return {
    intent,
    confidence,
    signals: [...new Set(signals)],
    multiHop: intent === "multi-session" || intent === "aggregation",
    widenCandidates: intent === "aggregation",
    recencyBias: intent === "knowledge-update",
    abstentionHint: intent === "abstention",
  };
}

/** Human-readable one-liner for CLI output. */
export function formatQueryPlan(plan: QueryPlan): string {
  const lines = [
    `Intent: ${plan.intent} (confidence ${plan.confidence.toFixed(2)})`,
  ];
  if (plan.signals.length > 0) {
    lines.push(`Signals: ${plan.signals.join(", ")}`);
  }
  const switches = [
    plan.multiHop ? "multi-hop" : null,
    plan.widenCandidates ? "wider candidates" : null,
    plan.recencyBias ? "recency bias" : null,
    plan.abstentionHint ? "abstention hint" : null,
  ].filter((value): value is string => value !== null);
  lines.push(
    `Strategy: ${switches.length > 0 ? switches.join(", ") : "default"}`,
  );
  return lines.join("\n");
}
