#!/usr/bin/env node
// MemOS SessionStart hook — injects a compact memory summary into fresh
// Claude Code sessions so recalled context is available from turn one.
//
// Fail-soft by design: any error (missing database, no npx, timeout) exits 0
// with no output so it can never block session startup.

import { execFile } from "node:child_process";

execFile(
	"npx",
	["-y", "@mem-os/sdk@1.6.26", "summarize", "--json"],
	{ timeout: 10_000, shell: process.platform === "win32" },
	(error, stdout) => {
		if (error || !stdout.trim()) return;
		try {
			const { summary } = JSON.parse(stdout);
			if (summary && String(summary).trim()) {
				console.log(`[MemOS] remembered context:\n${String(summary).trim()}`);
			}
		} catch {
			// Non-JSON output — ignore.
		}
	},
);
