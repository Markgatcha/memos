/**
 * Cross-harness handoff briefs.
 *
 * A handoff is the compact "what you need to know to continue" artifact for
 * switching agent harnesses (Claude Code → Codex → OpenCode), models, or
 * sessions. It is deliberately assembled from existing, already-budgeted
 * surfaces: the user profile, a TOON context pack, procedural lessons,
 * reminders, memory health, and harness attribution. It does not write or
 * mutate anything.
 */

import type {
  HarnessCount,
  MemoryHealth,
  MemoryProfile,
  MemoryScope,
  ProceduralLesson,
} from "./types.js";
import type { ReminderEntry } from "./event-memory.js";
import { citationToken } from "./citations.js";

export interface HandoffOptions {
  /** The task or question the next harness should continue. */
  task: string;
  namespace?: string;
  scope?: MemoryScope;
  /** Token budget for the context slice. Default 1200. */
  tokenBudget?: number;
  maxStatic?: number;
  maxDynamic?: number;
  /** Procedural lessons to include. Default 5. */
  lessons?: number;
  /** Include scheduled reminders. Default true. */
  includeReminders?: boolean;
  /** Attribution for the harness the brief is leaving. */
  fromHarness?: string;
  /** Attribution for the harness the brief is going to. */
  toHarness?: string;
  /** `markdown` (default) or `json`. */
  format?: "markdown" | "json";
}

export interface HandoffItem {
  id: string;
  content: string;
  citation: string;
  score?: number;
  trust?: string;
  untrusted?: boolean;
}

export interface HandoffBrief {
  schema: "memos.handoff.v1";
  generatedAt: number;
  task: string;
  fromHarness?: string;
  toHarness?: string;
  profile: {
    static: HandoffItem[];
    dynamic: HandoffItem[];
  };
  context: {
    query: string;
    tokenBudget: number;
    items: HandoffItem[];
  };
  lessons: Array<{
    id: string;
    lesson: string;
    context?: string;
    score: number;
    citation: string;
  }>;
  reminders: Array<{
    label: string;
    at: string;
    reminderAt: string;
    due: boolean;
    citation: string;
  }>;
  health: {
    score: number;
    grade: string;
    embeddingStatus: string;
    unresolvedContradictions: number | null;
  } | null;
  harnesses: Array<{ harness: string; count: number }>;
  markdown: string;
}

/** Structural subset shared by the internal and public context-pack types. */
export interface HandoffPack {
  query: string;
  tokenBudget: number;
  items: Array<{
    id: string;
    content: string;
    summary?: string | null;
    score: number;
    trust: string;
    untrustedSource?: boolean;
  }>;
}

export interface BuildHandoffInput {
  task: string;
  generatedAt?: number;
  fromHarness?: string;
  toHarness?: string;
  profile: MemoryProfile;
  pack: HandoffPack;
  lessons: ProceduralLesson[];
  reminders: ReminderEntry[];
  health?: MemoryHealth | null;
  harnesses?: HarnessCount[];
}

export function buildHandoffBrief(input: BuildHandoffInput): HandoffBrief {
  const brief: HandoffBrief = {
    schema: "memos.handoff.v1",
    generatedAt: input.generatedAt ?? Date.now(),
    task: input.task,
    ...(input.fromHarness ? { fromHarness: input.fromHarness } : {}),
    ...(input.toHarness ? { toHarness: input.toHarness } : {}),
    profile: {
      static: input.profile.static.map(toItem),
      dynamic: input.profile.dynamic.map(toItem),
    },
    context: {
      query: input.pack.query,
      tokenBudget: input.pack.tokenBudget,
      items: input.pack.items.map((item) => ({
        id: item.id,
        content: item.summary || item.content,
        citation: citationToken(item.id),
        score: item.score,
        trust: item.trust,
        ...(item.untrustedSource ? { untrusted: true } : {}),
      })),
    },
    lessons: input.lessons.map((lesson) => ({
      id: lesson.id,
      lesson: lesson.lesson,
      ...(lesson.context ? { context: lesson.context } : {}),
      score: lesson.score,
      citation: citationToken(lesson.id),
    })),
    reminders: input.reminders.map((reminder) => ({
      label: reminder.label,
      at: reminder.at,
      reminderAt: reminder.reminderAt,
      due: reminder.due,
      citation: citationToken(reminder.id),
    })),
    health: input.health
      ? {
          score: input.health.score,
          grade: input.health.grade,
          embeddingStatus: input.health.embeddingHealth.status,
          unresolvedContradictions:
            input.health.metrics.unresolvedContradictions,
        }
      : null,
    harnesses: (input.harnesses ?? []).map((entry) => ({
      harness: entry.harness,
      count: entry.count,
    })),
    markdown: "",
  };
  brief.markdown = renderHandoffMarkdown(brief);
  return brief;
}

export function renderHandoffMarkdown(brief: HandoffBrief): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${brief.task}`);
  lines.push("");
  lines.push(`Generated: ${new Date(brief.generatedAt).toISOString()}`);
  if (brief.fromHarness || brief.toHarness) {
    lines.push(
      `Harness: ${brief.fromHarness ?? "unknown"} -> ${brief.toHarness ?? "next"}`,
    );
  }
  lines.push("");

  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push("");
  };

  section(
    "Durable context",
    brief.profile.static.map((item) =>
      `${item.content} ${item.citation}`.trim(),
    ),
  );
  section(
    "Recent activity",
    brief.profile.dynamic.map((item) =>
      `${item.content} ${item.citation}`.trim(),
    ),
  );
  section(
    "Relevant memories",
    brief.context.items.map(
      (item) =>
        `${item.content} ${item.citation}`.trim() +
        (item.untrusted ? " (untrusted: confirm before acting)" : ""),
    ),
  );
  section(
    "Lessons",
    brief.lessons.map(
      (lesson) =>
        `${lesson.lesson} ${lesson.citation}`.trim() +
        (lesson.context ? ` (${lesson.context})` : ""),
    ),
  );
  section(
    "Reminders",
    brief.reminders.map(
      (reminder) =>
        `${reminder.due ? "[due] " : ""}${reminder.label} at ${reminder.at} ${reminder.citation}`,
    ),
  );

  if (brief.health) {
    lines.push("## Memory health");
    lines.push(
      `- ${brief.health.score}/100 (${brief.health.grade}); semantic search: ${brief.health.embeddingStatus}; unresolved contradictions: ${
        brief.health.unresolvedContradictions ?? "unknown"
      }`,
    );
    lines.push("");
  }
  if (brief.harnesses.length > 0) {
    lines.push("## Harness attribution");
    lines.push(
      `- ${brief.harnesses
        .map((entry) => `${entry.harness}: ${entry.count}`)
        .join(", ")}`,
    );
    lines.push("");
  }

  return lines.join("\n").trim();
}

function toItem(node: {
  id: string;
  content: string;
  summary?: string;
  trustScore?: number;
  metadata?: Record<string, unknown>;
}): HandoffItem {
  return {
    id: node.id,
    content: node.summary || node.content,
    citation: citationToken(node.id),
    ...(typeof node.trustScore === "number"
      ? { trust: node.trustScore.toFixed(2) }
      : {}),
  };
}
