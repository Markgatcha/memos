#!/usr/bin/env node
// MemOS auto-capture hook — runs on UserPromptSubmit. Scans the user's prompt
// for explicit "remember this" style requests and stores the fact via the
// memos CLI, so durable facts are captured without a slash command.
//
// Conservative by design: only explicit remember/don't-forget phrasing
// triggers a store. Slash-command prompts ("/...") are skipped so /memos and
// /recall don't double-store. Secrets are never stored.
//
// Fail-soft: any error (no stdin, no npx, timeout) exits 0 silently so the
// hook can never block prompt submission.

import { execFile } from "node:child_process";

// Explicit memory-request phrasing. Each pattern captures the fact text.
const PATTERNS = [
	/\bremember\s+(?:this|that)\b[:\s,]*(.+)/i,
	/\bdon'?t\s+forget\s+(?:that\s+)?(.+)/i,
	/\bkeep\s+in\s+mind\s+(?:that\s+)?(.+)/i,
	/\bnote\s+(?:this\s+)?down\b[:\s,]*(.+)/i,
	/\bcommit\s+(?:this\s+)?to\s+memory\b[:\s,]*(.+)/i,
];

// Never store anything that looks like a credential.
const SECRET_RE = /(api[_-]?key|password|passwd|secret|token|bearer|private[_-]?key)\s*[:=]/i;

// Preference phrasing → store as a preference, not a plain fact.
const PREFERENCE_RE = /\b(prefer|preference|always|never|like|dislike|favo[u]?rite|hate)\b/i;

function extractFact(prompt) {
	if (!prompt || /^\s*\//.test(prompt)) return null; // skip slash commands
	for (const re of PATTERNS) {
		const m = prompt.match(re);
		if (!m) continue;
		// Take the first line of the captured fact — prompts often continue
		// with unrelated follow-up text.
		const fact = m[1].split("\n")[0].replace(/[.!?]+$/, "").trim();
		if (fact.length < 4) continue;
		if (SECRET_RE.test(fact)) return null;
		return fact;
	}
	return null;
}

function main() {
	let raw = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => (raw += chunk));
	process.stdin.on("end", () => {
		try {
			const input = JSON.parse(raw || "{}");
			const fact = extractFact(input.prompt);
			if (!fact) return; // nothing to capture — stay silent
			const type = PREFERENCE_RE.test(fact) ? "preference" : "fact";
			execFile(
				"npx",
				["-y", "@mem-os/sdk", "store", fact, "--type", type],
				{ timeout: 15_000, shell: process.platform === "win32" },
				(error) => {
					if (!error) console.log(`[MemOS] auto-remembered (${type}): ${fact}`);
					// On error: stay silent, exit 0 — never block the prompt.
				},
			);
		} catch {
			// Malformed stdin — ignore.
		}
	});
	// If stdin never ends (shouldn't happen), don't hang the prompt.
	setTimeout(() => process.exit(0), 20_000).unref();
}

main();
