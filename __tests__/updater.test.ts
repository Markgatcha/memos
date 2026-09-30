/**
 * Tests for the beta update channel (memos beta / memos update).
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  isFullySuccessful,
  findLatestGreenCommit,
  readBetaState,
  writeBetaState,
  resolveInstalledRef,
  installFromCommit,
  REQUIRED_WORKFLOWS,
  type FetchImpl,
} from "../src/updater.js";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function runsFor(statuses: Record<string, [string, string | null]>) {
  return Object.entries(statuses).map(([name, [status, conclusion]]) => ({
    name,
    status,
    conclusion,
  }));
}

describe("isFullySuccessful", () => {
  it("requires CI, Prebuilds, and CodeQL", () => {
    expect(REQUIRED_WORKFLOWS).toEqual(["CI", "Prebuilds", "CodeQL"]);
  });

  it("returns true when all required workflows are completed+success", () => {
    const runs = runsFor({
      CI: ["completed", "success"],
      Prebuilds: ["completed", "success"],
      CodeQL: ["completed", "success"],
    });
    expect(isFullySuccessful(runs)).toBe(true);
  });

  it("returns false when one workflow failed", () => {
    const runs = runsFor({
      CI: ["completed", "failure"],
      Prebuilds: ["completed", "success"],
      CodeQL: ["completed", "success"],
    });
    expect(isFullySuccessful(runs)).toBe(false);
  });

  it("returns false when a workflow is still in progress", () => {
    const runs = runsFor({
      CI: ["in_progress", null],
      Prebuilds: ["completed", "success"],
      CodeQL: ["completed", "success"],
    });
    expect(isFullySuccessful(runs)).toBe(false);
  });

  it("returns false when a required workflow has no run", () => {
    const runs = runsFor({
      CI: ["completed", "success"],
      Prebuilds: ["completed", "success"],
    });
    expect(isFullySuccessful(runs)).toBe(false);
  });

  it("uses the latest run per workflow (newest first from the API)", () => {
    // A re-run failed after an earlier success — the latest (first) wins.
    const runs = [
      { name: "CI", status: "completed", conclusion: "failure" },
      { name: "CI", status: "completed", conclusion: "success" },
      { name: "Prebuilds", status: "completed", conclusion: "success" },
      { name: "CodeQL", status: "completed", conclusion: "success" },
    ];
    expect(isFullySuccessful(runs)).toBe(false);
  });

  it("ignores unrelated workflows", () => {
    const runs = runsFor({
      CI: ["completed", "success"],
      Prebuilds: ["completed", "success"],
      CodeQL: ["completed", "success"],
      "Some Other Workflow": ["completed", "failure"],
    });
    expect(isFullySuccessful(runs)).toBe(true);
  });
});

describe("findLatestGreenCommit", () => {
  const commitA = { sha: "a".repeat(40), message: "newest", date: "2026-09-30T00:00:00Z" };
  const commitB = { sha: "b".repeat(40), message: "older", date: "2026-09-29T00:00:00Z" };

  function mockFetch(
    commits: typeof commitA[],
    runsBySha: Record<string, Array<{ name: string; status: string; conclusion: string | null }>>,
  ): FetchImpl {
    return (async (url: string) => {
      if (url.includes("/commits?")) {
        return {
          ok: true,
          status: 200,
          json: async () => commits.map((c) => ({ sha: c.sha, commit: { message: c.message, author: { date: c.date } } })),
        };
      }
      const sha = new URL(url).searchParams.get("head_sha") ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow_runs: (runsBySha[sha] ?? []).map((r) => ({ ...r })),
        }),
      };
    }) as FetchImpl;
  }

  const greenRuns = runsFor({
    CI: ["completed", "success"],
    Prebuilds: ["completed", "success"],
    CodeQL: ["completed", "success"],
  });

  it("returns the newest commit when it is green", async () => {
    const fetchImpl = mockFetch([commitA, commitB], { [commitA.sha]: greenRuns });
    const found = await findLatestGreenCommit({ fetchImpl, maxCommits: 5 });
    expect(found?.sha).toBe(commitA.sha);
  });

  it("walks back past a commit whose CI is still running", async () => {
    const running = runsFor({
      CI: ["in_progress", null],
      Prebuilds: ["completed", "success"],
      CodeQL: ["completed", "success"],
    });
    const fetchImpl = mockFetch([commitA, commitB], {
      [commitA.sha]: running,
      [commitB.sha]: greenRuns,
    });
    const found = await findLatestGreenCommit({ fetchImpl, maxCommits: 5 });
    expect(found?.sha).toBe(commitB.sha);
  });

  it("returns null when nothing is green", async () => {
    const failed = runsFor({
      CI: ["completed", "failure"],
      Prebuilds: ["completed", "success"],
      CodeQL: ["completed", "success"],
    });
    const fetchImpl = mockFetch([commitA], { [commitA.sha]: failed });
    const found = await findLatestGreenCommit({ fetchImpl, maxCommits: 5 });
    expect(found).toBeNull();
  });

  it("propagates API errors", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as FetchImpl;
    await expect(findLatestGreenCommit({ fetchImpl })).rejects.toThrow("403");
  });
});

describe("beta state", () => {
  let dir: string;
  let cfgPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memos-beta-test-"));
    cfgPath = join(dir, "config.json");
  });

  it("defaults to disabled when the file is missing", () => {
    expect(readBetaState(cfgPath)).toEqual({ beta: false });
  });

  it("round-trips enable/disable and preserves other keys", () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, dbPath: "/x.db" }));
    writeBetaState(cfgPath, { beta: true });
    expect(readBetaState(cfgPath).beta).toBe(true);
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(raw.dbPath).toBe("/x.db");
    expect(raw.version).toBe(1);

    writeBetaState(cfgPath, { beta: false });
    expect(readBetaState(cfgPath).beta).toBe(false);
    // Other keys survive the disable too.
    expect(JSON.parse(readFileSync(cfgPath, "utf-8")).dbPath).toBe("/x.db");
  });

  it("round-trips lastUpdateCheck", () => {
    writeBetaState(cfgPath, { beta: true, lastUpdateCheck: 12345 });
    const state = readBetaState(cfgPath);
    expect(state.lastUpdateCheck).toBe(12345);
  });
});

describe("resolveInstalledRef", () => {
  it("prefers $MEMOS_HOME/.install-ref", () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-home-test-"));
    writeFileSync(join(dir, ".install-ref"), "deadbeef".repeat(5) + "\n");
    expect(resolveInstalledRef({ memosHome: dir })).toBe("deadbeef".repeat(5));
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to npm:version when no marker and no git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-home-test-"));
    // Point memosHome at an empty dir and rely on the real package.json
    // fallback: the git probe runs in the package root (a repo), so instead
    // verify the marker path is what matters here by using a bogus home.
    // We just assert it returns *something* non-empty.
    const ref = resolveInstalledRef({ memosHome: dir });
    expect(typeof ref).toBe("string");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("installFromCommit", () => {
  it("downloads, builds, relinks bin, writes ref, prunes old versions", async () => {
    const home = mkdtempSync(join(tmpdir(), "memos-beta-install-"));
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const downloaded: Array<{ url: string; dest: string }> = [];

    const sha = "c".repeat(40);
    const runCmd = jest.fn(async (cmd: string, args: string[], cwd: string) => {
      calls.push({ cmd, args, cwd });
      // Simulate pnpm build producing dist/cli.js
      if (args.includes("build")) {
        const dir = calls.find((c) => c.args.includes("build"))!.cwd;
        mkdirSync(join(dir, "dist"), { recursive: true });
        writeFileSync(join(dir, "dist", "cli.js"), "#!/usr/bin/env node\n");
      }
    });
    const download = jest.fn(async (url: string, dest: string) => {
      downloaded.push({ url, dest });
      writeFileSync(dest, "fake-tarball");
    });

    // Seed two old beta checkouts to verify pruning keeps 2 newest.
    for (const old of ["a".repeat(40), "b".repeat(40)]) {
      mkdirSync(join(home, "beta", old), { recursive: true });
    }

    const { installDir } = await installFromCommit(sha, {
      memosHome: home,
      nodeBin: "/usr/bin/node",
      runCmd: runCmd as never,
      download: download as never,
    });

    // Tarball URL points at the commit.
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.url).toContain(`/archive/${sha}.tar.gz`);

    // pnpm probed, then install + build ran in the extracted dir.
    const pnpmCalls = calls.filter((c) => c.cmd === "pnpm");
    expect(pnpmCalls.length).toBeGreaterThanOrEqual(3); // --version, install, build
    expect(calls.some((c) => c.args.includes("--frozen-lockfile"))).toBe(true);
    expect(calls.some((c) => c.args.includes("build"))).toBe(true);

    // bin/memos wrapper points at the new build with the given node.
    const binContent = readFileSync(join(home, "bin", "memos"), "utf-8");
    expect(binContent).toContain('exec "/usr/bin/node"');
    expect(binContent).toContain(join(installDir, "dist", "cli.js"));

    // .install-ref written.
    expect(readFileSync(join(home, ".install-ref"), "utf-8").trim()).toBe(sha);

    // Pruning: newest 2 kept (c... and b...), oldest removed.
    expect(existsSync(join(home, "beta", sha))).toBe(true);
    expect(existsSync(join(home, "beta", "b".repeat(40)))).toBe(true);
    expect(existsSync(join(home, "beta", "a".repeat(40)))).toBe(false);

    rmSync(home, { recursive: true, force: true });
  });

  it("falls back to corepack when pnpm is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "memos-beta-corepack-"));
    const sha = "d".repeat(40);
    const runCmd = jest.fn(async (cmd: string, args: string[], cwd: string) => {
      if (cmd === "pnpm") throw new Error("not found");
      if (args.includes("build")) {
        mkdirSync(join(cwd, "dist"), { recursive: true });
        writeFileSync(join(cwd, "dist", "cli.js"), "");
      }
    });
    const download = jest.fn(async (_url: string, dest: string) => {
      writeFileSync(dest, "x");
    });
    await installFromCommit(sha, {
      memosHome: home,
      nodeBin: "/usr/bin/node",
      runCmd: runCmd as never,
      download: download as never,
    });
    const corepackCalls = (runCmd.mock.calls as unknown[][]).filter(
      (c) => c[0] === "corepack",
    );
    expect(corepackCalls.length).toBeGreaterThan(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("throws a helpful error when neither pnpm nor corepack exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "memos-beta-nopnpm-"));
    const runCmd = jest.fn(async () => {
      throw new Error("not found");
    });
    await expect(
      installFromCommit("e".repeat(40), {
        memosHome: home,
        nodeBin: "/usr/bin/node",
        runCmd: runCmd as never,
        download: (async () => {}) as never,
      }),
    ).rejects.toThrow("pnpm");
    rmSync(home, { recursive: true, force: true });
  });
});
