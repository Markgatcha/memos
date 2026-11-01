#!/usr/bin/env node
// MemOS SessionStart hook — injects a compact handoff brief into fresh
// harness sessions so the next agent knows who it is talking to, what
// happened recently, and which lessons/reminders apply.
//
// Falls back to the older `summarize` command so the plugin keeps working
// against a pinned SDK release that predates `handoff`.
//
// Fail-soft by design: any error (missing database, no npx, timeout) exits 0
// with no output so it can never block session startup.

import { execFile } from "node:child_process";
import { basename } from "node:path";

const project = basename(process.cwd());

function run(args, callback) {
	execFile(
		"npx",
		args,
		{ timeout: 10_000, shell: process.platform === "win32" },
		(error, stdout) => callback(error, stdout),
	);
}

run(
	[
		"-y",
		"@mem-os/sdk",
		"handoff",
		`session start in ${project}`,
		"--token-budget",
		"800",
		"--json",
	],
	(error, stdout) => {
		if (!error && stdout.trim()) {
			try {
				const brief = JSON.parse(stdout);
				const markdown = String(brief?.markdown ?? "").trim();
				if (markdown) {
					console.log(`[MemOS] handoff context:\n${markdown}`);
					return;
				}
			} catch {
				// fall through to the legacy summary path
			}
		}
		runSummary();
	},
);

function runSummary() {
	run(["-y", "@mem-os/sdk", "summarize", "--json"], (error, stdout) => {
		if (error || !stdout.trim()) return;
		try {
			const { summary } = JSON.parse(stdout);
			if (summary && String(summary).trim()) {
				console.log(
					`[MemOS] remembered context:\n${String(summary).trim()}`,
				);
			}
		} catch {
			// Non-JSON output — ignore.
		}
	});
}
