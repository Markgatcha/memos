/**
 * Tests for session hooks (Feature 3).
 */

import { describe, it, expect } from "@jest/globals";
import {
  parseClaudeTranscript,
  parseClaudeTranscriptText,
  parsePlainTranscript,
  parseTranscriptFile,
  findOpenCodeSessionMessages,
  claudeCodeHookConfig,
  openCodePluginSource,
  sessionHookInstructions,
} from "../src/session-hooks.js";
import {
  writeFileSync,
  unlinkSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseClaudeTranscript", () => {
  it("parses a Claude Code JSONL transcript", () => {
    const path = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "My name is Alice" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Nice to meet you, Alice!" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "read", input: {} }],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));
    try {
      const messages = parseClaudeTranscript(path);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        role: "user",
        content: "My name is Alice",
      });
      expect(messages[1]).toEqual({
        role: "assistant",
        content: "Nice to meet you, Alice!",
      });
    } finally {
      unlinkSync(path);
    }
  });

  it("skips malformed lines", () => {
    const path = join(tmpdir(), `test-transcript-${Date.now()}.jsonl`);
    writeFileSync(
      path,
      "not json\n" +
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Hello" },
        }),
    );
    try {
      const messages = parseClaudeTranscript(path);
      expect(messages).toHaveLength(1);
    } finally {
      unlinkSync(path);
    }
  });

  it("throws for missing file", () => {
    expect(() => parseClaudeTranscript("/nonexistent/path.jsonl")).toThrow();
  });
});

describe("parsePlainTranscript", () => {
  it("parses User:/Assistant: format", () => {
    const text =
      "User: My name is Bob\nAssistant: Hi Bob!\nUser: I like coffee";
    const messages = parsePlainTranscript(text);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("handles multiline messages", () => {
    const text = "User: Line one\ncontinued\nAssistant: Reply";
    const messages = parsePlainTranscript(text);
    expect(messages[0].content).toContain("Line one");
    expect(messages[0].content).toContain("continued");
  });
});

describe("claudeCodeHookConfig", () => {
  it("generates valid hook config", () => {
    const config = claudeCodeHookConfig("memos") as any;
    expect(config.hooks.SessionEnd).toBeDefined();
    expect(config.hooks.SessionEnd[0].hooks[0].type).toBe("command");
    expect(config.hooks.SessionEnd[0].hooks[0].command).toContain(
      "memos session-hook",
    );
  });
});

describe("openCodePluginSource", () => {
  it("generates plugin source with session.deleted handler", () => {
    const source = openCodePluginSource("memos");
    expect(source).toContain("session.deleted");
    expect(source).toContain("memos session-hook");
  });
});

describe("sessionHookInstructions", () => {
  it("provides Claude Code instructions", () => {
    const instructions = sessionHookInstructions("claude-code");
    expect(instructions).toContain("SessionEnd");
    expect(instructions).toContain("settings.json");
  });

  it("provides OpenCode instructions", () => {
    const instructions = sessionHookInstructions("opencode");
    expect(instructions).toContain("session.deleted");
    expect(instructions).toContain(".opencode/plugins");
  });
});

describe("parseClaudeTranscriptText", () => {
  it("parses transcript text directly", () => {
    const text = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "My name is Alice" },
      }),
      "not json",
    ].join("\n");
    const messages = parseClaudeTranscriptText(text);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: "user", content: "My name is Alice" });
  });
});

describe("parseTranscriptFile", () => {
  it("prefers Claude JSONL when valid", () => {
    const path = join(tmpdir(), `test-ptf-${Date.now()}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Hello" },
      }),
    );
    try {
      const messages = parseTranscriptFile(path);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("Hello");
    } finally {
      unlinkSync(path);
    }
  });

  it("falls back to plain text when JSONL yields no messages", () => {
    // Regression test: parseClaudeTranscript returns [] (no throw) for
    // non-JSONL input, which used to bypass the plain-text fallback.
    const path = join(tmpdir(), `test-ptf-${Date.now()}.txt`);
    writeFileSync(path, "User: My name is Bob\nAssistant: Hi Bob!");
    try {
      const messages = parseTranscriptFile(path);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: "user", content: "My name is Bob" });
      expect(messages[1]).toEqual({ role: "assistant", content: "Hi Bob!" });
    } finally {
      unlinkSync(path);
    }
  });

  it("returns [] for an empty file", () => {
    const path = join(tmpdir(), `test-ptf-${Date.now()}.txt`);
    writeFileSync(path, "   \n  ");
    try {
      expect(parseTranscriptFile(path)).toEqual([]);
    } finally {
      unlinkSync(path);
    }
  });

  it("throws for a missing file", () => {
    expect(() => parseTranscriptFile("/nonexistent/path.jsonl")).toThrow();
  });
});

describe("findOpenCodeSessionMessages", () => {
  function makeDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "opencode-data-"));
    const msgDir = join(dir, "project", "proj1", "storage", "message", "info");
    const partDir = join(dir, "project", "proj1", "storage", "part", "info");
    mkdirSync(msgDir, { recursive: true });
    mkdirSync(partDir, { recursive: true });
    const msg = (
      id: string,
      sessionID: string,
      role: string,
      created: number,
    ) =>
      writeFileSync(
        join(msgDir, `${id}.json`),
        JSON.stringify({ id, sessionID, role, time: { created } }),
      );
    const part = (id: string, messageID: string, type: string, text: string) =>
      writeFileSync(
        join(partDir, `${id}.json`),
        JSON.stringify({ id, messageID, type, text }),
      );
    msg("m1", "sess1", "user", 1000);
    msg("m2", "sess1", "assistant", 2000);
    msg("m3", "other", "user", 1500);
    part("p1", "m1", "text", "My name is Alice");
    part("p2", "m2", "text", "Hello Alice");
    part("p3", "m2", "tool", "should be skipped");
    return dir;
  }

  it("loads user/assistant text parts in time order", () => {
    const dir = makeDataDir();
    try {
      const messages = findOpenCodeSessionMessages("sess1", dir);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        role: "user",
        content: "My name is Alice",
      });
      expect(messages[1]).toEqual({
        role: "assistant",
        content: "Hello Alice",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for an unknown session id", () => {
    const dir = makeDataDir();
    try {
      expect(findOpenCodeSessionMessages("nope", dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the data dir does not exist", () => {
    expect(
      findOpenCodeSessionMessages("sess1", "/nonexistent/opencode-data"),
    ).toEqual([]);
  });
});

describe("openCodePluginSource (--opencode-session is implemented)", () => {
  it("passes the session id via the implemented flag", () => {
    const source = openCodePluginSource("memos");
    expect(source).toContain("--opencode-session");
  });
});
