/**
 * Tests for session hooks (Feature 3).
 */

import { describe, it, expect } from "@jest/globals";
import {
  parseClaudeTranscript,
  parsePlainTranscript,
  claudeCodeHookConfig,
  openCodePluginSource,
  sessionHookInstructions,
} from "../src/session-hooks.js";
import { writeFileSync, unlinkSync } from "node:fs";
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
      expect(messages[0]).toEqual({ role: "user", content: "My name is Alice" });
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
    writeFileSync(path, "not json\n" + JSON.stringify({
      type: "user",
      message: { role: "user", content: "Hello" },
    }));
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
    const text = "User: My name is Bob\nAssistant: Hi Bob!\nUser: I like coffee";
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
    expect(config.hooks.SessionEnd[0].hooks[0].command).toContain("memos session-hook");
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
