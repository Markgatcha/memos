/**
 * Tests for shell completion (`memos completion <bash|zsh|fish>`).
 *
 * Guards: every real command is completable in every shell, the scripts
 * stay in sync with the canonical command list, enum-valued flags offer
 * their values, and the generated scripts pass the shells' own syntax
 * checkers (when those shells exist on the test machine).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCompletionScript, COMPLETION_SHELLS } from "../src/cli-completion";
import { CLI_COMMANDS } from "../src/cli-help";

const COMMANDS = CLI_COMMANDS.filter((c) => c !== "help");

function shellExists(shell: string): boolean {
  try {
    execFileSync(shell, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Write the script to a temp file and run the shell's own syntax checker. */
function syntaxCheck(shell: string, args: string[], script: string): void {
  const dir = mkdtempSync(join(tmpdir(), "memos-complete-"));
  const file = join(dir, "script");
  writeFileSync(file, script);
  execFileSync(shell, [...args, file], { stdio: "ignore" });
}

describe("getCompletionScript", () => {
  test("generates a script for every supported shell", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = getCompletionScript(shell);
      expect(script).not.toBeNull();
      expect(script!.length).toBeGreaterThan(100);
    }
  });

  test("returns null for unknown shells", () => {
    expect(getCompletionScript("powershell")).toBeNull();
    expect(getCompletionScript("")).toBeNull();
  });

  test("every command is completable in every shell (no drift)", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = getCompletionScript(shell)!;
      for (const cmd of COMMANDS) {
        expect(script).toContain(cmd);
      }
    }
  });
});

describe("bash completion", () => {
  const script = getCompletionScript("bash")!;

  test("completes enum-valued flags", () => {
    expect(script).toContain("--from");
    expect(script).toContain("chatgpt claude slack");
    expect(script).toContain("--format");
    expect(script).toContain("json markdown obsidian");
  });

  test("completes the shell name after `memos completion`", () => {
    expect(script).toContain("bash zsh fish");
  });

  test("registers itself for the memos command", () => {
    expect(script).toContain("complete -F _memos memos");
  });

  test("passes bash syntax check", () => {
    if (!shellExists("bash")) return;
    expect(() => syntaxCheck("bash", ["-n"], script)).not.toThrow();
  });
});

describe("zsh completion", () => {
  const script = getCompletionScript("zsh")!;

  test("has a compdef header", () => {
    expect(script.startsWith("#compdef memos")).toBe(true);
  });

  test("describes commands for _describe", () => {
    expect(script).toContain("'search:Search memories by text'");
  });

  test("offers enum values for valued flags", () => {
    expect(script).toContain("(chatgpt claude slack)");
  });

  test("passes zsh syntax check", () => {
    if (!shellExists("zsh")) return;
    expect(() => syntaxCheck("zsh", ["-n"], script)).not.toThrow();
  });
});

describe("fish completion", () => {
  const script = getCompletionScript("fish")!;

  test("uses the complete builtin with descriptions", () => {
    expect(script).toContain("complete -c memos");
    expect(script).toContain("-d 'Search memories by text'");
  });

  test("scopes flags to their subcommand", () => {
    expect(script).toContain("__fish_seen_subcommand_from search");
  });

  test("passes fish syntax check", () => {
    if (!shellExists("fish")) return;
    expect(() => syntaxCheck("fish", ["--no-execute"], script)).not.toThrow();
  });
});
