/**
 * Tests for the CLI help module (`suggestCommand` / `getCommandHelp` /
 * `CLI_COMMANDS`). These guard the usability fixes: typo'd commands get a
 * "did you mean" hint instead of a bare full-help dump, and
 * `memos <command> --help` resolves to focused usage text.
 */

import { CLI_COMMANDS, suggestCommand, getCommandHelp } from "../src/cli-help";

describe("CLI_COMMANDS", () => {
  test("has no duplicates", () => {
    expect(new Set(CLI_COMMANDS).size).toBe(CLI_COMMANDS.length);
  });

  test("covers the core verbs a new user reaches for", () => {
    for (const cmd of ["init", "store", "search", "forget", "help"]) {
      expect(CLI_COMMANDS).toContain(cmd);
    }
  });

  test("does not advertise unimplemented commands", () => {
    // `serve` was listed in --help but had no implementation.
    expect(CLI_COMMANDS).not.toContain("serve");
  });
});

describe("suggestCommand", () => {
  test("suggests the right command for common typos", () => {
    expect(suggestCommand("serach")).toBe("search");
    expect(suggestCommand("frobnicate")).toBeNull(); // too far from anything
    expect(suggestCommand("stor")).toBe("store");
    expect(suggestCommand("retreive")).toBe("retrieve");
    expect(suggestCommand("impot")).toBe("import");
    expect(suggestCommand("consoldiate")).toBe("consolidate");
  });

  test("is case-insensitive", () => {
    expect(suggestCommand("SEARCH")).toBe("search");
  });

  test("returns null for empty or garbage input", () => {
    expect(suggestCommand("")).toBeNull();
    expect(suggestCommand("xyzzy-plugh")).toBeNull();
  });

  test("never suggests 'help' itself", () => {
    // "help" is excluded so typos resolve to real actions.
    expect(suggestCommand("hep")).not.toBe("help");
  });
});

describe("getCommandHelp", () => {
  test("every listed command has help text", () => {
    for (const cmd of CLI_COMMANDS) {
      const help = getCommandHelp(cmd);
      expect(help).not.toBeNull();
      expect(help!).toContain(cmd);
    }
  });

  test("returns null for unknown commands", () => {
    expect(getCommandHelp("frobnicate")).toBeNull();
    expect(getCommandHelp("serve")).toBeNull();
  });

  test("help text shows usage, not just a description", () => {
    const help = getCommandHelp("search")!;
    expect(help).toContain("memos search");
    expect(help).toContain("--limit");
  });
});
