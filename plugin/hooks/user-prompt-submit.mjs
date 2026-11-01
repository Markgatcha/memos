#!/usr/bin/env node
// MemOS UserPromptSubmit hook — per-prompt recall.
//
// This is the missing middle leg of the three-hook harness recipe:
//
//   SessionStart      → load durable context         (session-start.mjs)
//   UserPromptSubmit  → enrich with relevant memory  (this file)
//   SessionEnd        → save + consolidate           (session-end.mjs)
//
// Without it, memory is consulted exactly once per session. A long session
// then drifts: whatever was recalled at turn 1 is stale by turn 40, and a
// question that could have been answered from memory gets answered from
// guesswork because nothing re-injects context when the topic changes.
//
// Fail-soft by design: any error (missing database, no npx, timeout, bad
// JSON) exits 0 with no output, so it can never block or slow a prompt.

import { execFile } from "node:child_process";

const MAX_PROMPT_CHARS = 500;
const MIN_PROMPT_CHARS = 12;
const TIMEOUT_MS = 8000;
const MAX_MEMORIES = 5;
const MAX_CONTEXT_CHARS = 1500;
/** Skip weak matches — injecting noise is worse than injecting nothing. */
const MIN_SCORE = 0.15;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context,
      },
    }),
  );
}

const raw = await readStdin();

let prompt = "";
try {
  const parsed = JSON.parse(raw || "{}");
  prompt = String(parsed.prompt ?? "").trim();
} catch {
  prompt = "";
}

// Skip slash commands, shell passthrough, and trivially short prompts —
// recalling on "y" or "/help" costs latency and buys nothing.
if (
  prompt.length < MIN_PROMPT_CHARS ||
  prompt.startsWith("/") ||
  prompt.startsWith("!")
) {
  process.exit(0);
}

const query = prompt.slice(0, MAX_PROMPT_CHARS);

execFile(
  "npx",
  [
    "-y",
    "@mem-os/sdk",
    "search",
    query,
    "--limit",
    String(MAX_MEMORIES),
    "--json",
  ],
  { timeout: TIMEOUT_MS, shell: process.platform === "win32" },
  (error, stdout) => {
    if (error || !stdout || !stdout.trim()) return;

    let results;
    try {
      results = JSON.parse(stdout);
    } catch {
      return;
    }
    if (!Array.isArray(results) || results.length === 0) return;

    const lines = [];
    let used = 0;
    for (const r of results) {
      const content = String(r?.node?.content ?? "").trim();
      const score = typeof r?.score === "number" ? r.score : 0;
      if (!content || score < MIN_SCORE) continue;
      const line = `- (${score.toFixed(2)}) ${content}`;
      if (used + line.length > MAX_CONTEXT_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    if (lines.length === 0) return;

    emit(
      `Relevant memories from MemOS (local SQLite). Use only if genuinely ` +
        `relevant to the current request:\n${lines.join("\n")}`,
    );
  },
);
