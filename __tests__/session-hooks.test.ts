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
import Database from "better-sqlite3";

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

describe("findOpenCodeSessionMessages (real OpenCode layouts)", () => {
  /**
   * Real current layout: <dir>/opencode.db with `message`/`part`
   * tables (session_id / message_id columns, JSON `data` column).
   */
  function makeSqliteDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "opencode-sqlite-"));
    const db = new Database(join(dir, "opencode.db"));
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);" +
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);",
    );
    const msg = db.prepare(
      "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
    );
    const part = db.prepare(
      "INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)",
    );
    msg.run(
      "m1",
      "sess1",
      JSON.stringify({ id: "m1", role: "user", time: { created: 1000 } }),
    );
    msg.run(
      "m2",
      "sess1",
      JSON.stringify({ id: "m2", role: "assistant", time: { created: 2000 } }),
    );
    msg.run(
      "m3",
      "other",
      JSON.stringify({ id: "m3", role: "user", time: { created: 1500 } }),
    );
    part.run(
      "p1",
      "m1",
      JSON.stringify({ id: "p1", type: "text", text: "My name is Alice" }),
    );
    part.run(
      "p2",
      "m2",
      JSON.stringify({ id: "p2", type: "text", text: "Hello Alice" }),
    );
    part.run(
      "p3",
      "m2",
      JSON.stringify({ id: "p3", type: "tool", text: "should be skipped" }),
    );
    db.close();
    return dir;
  }

  /**
   * Legacy layout (pre-SQLite OpenCode):
   * <dir>/storage/message/<sessionId>/<messageId>.json and
   * <dir>/storage/part/<messageId>/<partId>.json.
   */
  function makeLegacyJsonDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "opencode-legacy-"));
    const msgDir = join(dir, "storage", "message", "sess1");
    mkdirSync(msgDir, { recursive: true });
    const writePart = (messageId: string, partId: string, body: object) => {
      const partDir = join(dir, "storage", "part", messageId);
      mkdirSync(partDir, { recursive: true });
      writeFileSync(join(partDir, `${partId}.json`), JSON.stringify(body));
    };
    writeFileSync(
      join(msgDir, "m1.json"),
      JSON.stringify({ id: "m1", role: "user", time: { created: 1000 } }),
    );
    writeFileSync(
      join(msgDir, "m2.json"),
      JSON.stringify({ id: "m2", role: "assistant", time: { created: 2000 } }),
    );
    writePart("m1", "p1", { id: "p1", type: "text", text: "My name is Alice" });
    writePart("m2", "p2", { id: "p2", type: "text", text: "Hello Alice" });
    writePart("m2", "p3", { id: "p3", type: "tool", text: "skipped" });
    return dir;
  }

  const expected = [
    { role: "user", content: "My name is Alice" },
    { role: "assistant", content: "Hello Alice" },
  ];

  it("loads user/assistant text parts in time order from opencode.db", () => {
    const dir = makeSqliteDataDir();
    try {
      expect(findOpenCodeSessionMessages("sess1", dir)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the legacy JSON layout when no database exists", () => {
    const dir = makeLegacyJsonDataDir();
    try {
      expect(findOpenCodeSessionMessages("sess1", dir)).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] for an unknown session id", () => {
    const dir = makeSqliteDataDir();
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

  it("returns [] for a corrupt database instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-corrupt-"));
    try {
      writeFileSync(join(dir, "opencode.db"), "not a sqlite database");
      expect(findOpenCodeSessionMessages("sess1", dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openCodePluginSource (--opencode-session is implemented)", () => {
  it("passes the session id via the implemented flag", () => {
    const source = openCodePluginSource("memos");
    expect(source).toContain("--opencode-session");
  });
});
