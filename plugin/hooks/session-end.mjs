#!/usr/bin/env node
// MemOS SessionEnd hook — runs a fast consolidation pass (dedupe + archive
// + decay, no clustering) when a session ends, so memory maintains itself
// without anyone remembering to run `memos consolidate`.
//
// Fail-soft by design: MEMOS_SKIP_SESSION_CONSOLIDATE=1 opts out, and any
// error (missing DB, no npx, timeout) exits 0 silently.

import { spawn } from "node:child_process";

if (process.env.MEMOS_SKIP_SESSION_CONSOLIDATE) process.exit(0);

const child = spawn(
	"npx",
	["-y", "@mem-os/sdk", "consolidate", "--no-summarize", "--json"],
	{ timeout: 30_000, shell: process.platform === "win32" },
);
child.on("error", () => process.exit(0));
child.on("close", () => process.exit(0));
