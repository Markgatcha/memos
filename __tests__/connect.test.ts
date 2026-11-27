/**
 * Tests for `memos connect`.
 *
 * The connect module is a pure function of (target, options) → config block.
 * These tests pin the config shapes the harnesses actually accept, so a
 * schema change in the harness docs shows up as a test failure rather than
 * a silent bad write.
 */

import { describe, expect, it } from "@jest/globals";
import { connectTarget, CONNECT_TARGETS } from "../src/connect.js";

const OPTS = { toolNames: ["memos_store", "memos_search"] };

describe("connect opencode (2.x / latest)", () => {
  it("writes the V2 mcp.servers shape", () => {
    const result = connectTarget("opencode", OPTS)!;
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.fileContents!);
    // V2 nests servers under mcp.servers; 1.x shape is rejected by the V2 schema.
    expect(parsed.mcp.servers.memos.type).toBe("local");
    expect(parsed.mcp.servers.memos.command).toEqual([
      "npx",
      "-y",
      "@mem-os/sdk",
      "mcp",
    ]);
    expect(parsed.mcp.memos).toBeUndefined();
    expect(parsed.mcp.servers.memos.enabled).toBe(true);
  });

  it("targets opencode.json", () => {
    expect(connectTarget("opencode", OPTS)!.configPath).toBe("opencode.json");
  });

  it("aliases opencode-v2 and opencode2 to the same target", () => {
    expect(connectTarget("opencode-v2", OPTS)!.fileContents).toBe(
      connectTarget("opencode", OPTS)!.fileContents,
    );
    expect(connectTarget("opencode2", OPTS)!.fileContents).toBe(
      connectTarget("opencode", OPTS)!.fileContents,
    );
  });

  it("--with-session-hook writes the V2 plugin directory and plugins array", () => {
    const result = connectTarget("opencode", { ...OPTS, withSessionHook: true })!;
    const parsed = JSON.parse(result.fileContents!);
    expect(parsed.plugins).toEqual(["./plugins/memos-session-hook"]);
    expect(result.extraFiles).toHaveLength(1);
    const plugin = result.extraFiles![0]!;
    expect(plugin.path.replaceAll("\\", "/")).toBe(
      ".opencode/plugins/memos-session-hook/index.ts",
    );
    expect(plugin.contents).toContain("Plugin.define");
    expect(plugin.contents).toContain("ctx.event.subscribe");
    expect(plugin.contents).not.toContain("async ({ $ })");
  });
});

describe("connect opencode-v1", () => {
  it("writes the V1 mcp.<name> shape", () => {
    const result = connectTarget("opencode-v1", OPTS)!;
    const parsed = JSON.parse(result.fileContents!);
    expect(parsed.mcp.memos.type).toBe("local");
    expect(parsed.mcp.memos.command).toEqual([
      "npx",
      "-y",
      "@mem-os/sdk",
      "mcp",
    ]);
    expect(parsed.mcp.servers).toBeUndefined();
  });

  it("--with-session-hook writes the V1 flat plugin file and plugin array", () => {
    const result = connectTarget("opencode-v1", {
      ...OPTS,
      withSessionHook: true,
    })!;
    const parsed = JSON.parse(result.fileContents!);
    const plugin = result.extraFiles![0]!;
    expect(plugin.path.replaceAll("\\", "/")).toBe(
      ".opencode/plugins/memos-session-hook.ts",
    );
    expect(plugin.contents).toContain("event: async ({ event })");
    expect(plugin.contents).toContain("session.deleted");
    expect(plugin.contents).not.toContain("Plugin.define");
  });
});

describe("connect dsh", () => {
  it("emits a Cordis patch row for @deepseek-ai/dsh-mcp-client", () => {
    const result = connectTarget("dsh", OPTS)!;
    expect(result).not.toBeNull();
    expect(result.fileContents).toContain("- insert:");
    expect(result.fileContents).toContain("@deepseek-ai/dsh-mcp-client");
    expect(result.fileContents).toContain("serverName: memos");
    expect(result.fileContents).toContain("transport: stdio");
    expect(result.fileContents).toContain('"npx"');
    expect(result.fileContents).toContain('"@mem-os/sdk"');
    expect(result.fileContents).toContain('"mcp"');
  });

  it("aliases deepseek and deepseek-harness to dsh", () => {
    expect(connectTarget("deepseek", OPTS)!.fileContents).toBe(
      connectTarget("dsh", OPTS)!.fileContents,
    );
    expect(connectTarget("deepseek-harness", OPTS)!.fileContents).toBe(
      connectTarget("dsh", OPTS)!.fileContents,
    );
  });

  it("carries MEMOS_DB_PATH as an env row when --db is given", () => {
    const result = connectTarget("dsh", { ...OPTS, dbPath: "/tmp/memos-test.db" })!;
    expect(result.fileContents).toContain("MEMOS_DB_PATH");
    expect(result.fileContents).toContain("/tmp/memos-test.db");
  });

  it("never targets the user's cordis.patch.yml for --write", () => {
    const result = connectTarget("dsh", OPTS)!;
    // Writing cordis.patch.yml wholesale would destroy unrelated patches,
    // so --write goes to a dedicated file instead.
    expect(result.configPath).not.toMatch(/cordis\.patch\.yml$/);
    expect(result.configPath).toMatch(/memos\.patch\.yml$/);
    expect(result.instructions).toContain("cordis.patch.yml");
    expect(result.instructions).toContain("dsh web --patch");
  });

  it("advertises the mcp__memos__ namespace", () => {
    expect(connectTarget("dsh", OPTS)!.instructions).toContain("mcp__memos__");
  });
});

describe("connect coverage", () => {
  it("has an entry for every advertised target", () => {
    for (const target of CONNECT_TARGETS) {
      const result = connectTarget(target, OPTS);
      expect(result).not.toBeNull();
      expect(result!.instructions.length).toBeGreaterThan(0);
    }
  });

  it("returns null and does not throw for unknown targets", () => {
    expect(connectTarget("not-a-harness", OPTS)).toBeNull();
  });
});
