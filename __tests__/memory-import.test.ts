/**
 * Tests for chat-export imports (ChatGPT / Claude / Slack).
 *
 * Covered (one per importer, with fixtures):
 *   - ChatGPT `conversations.json`: user turns extracted with timestamps
 *     and conversation attribution; assistant turns skipped; duplicate
 *     content imported once (content-hash dedupe);
 *   - Claude export directory: `conversations.json` + `.jsonl` history
 *     scanned; human turns extracted;
 *   - Slack export directory: `channels.json` / `users.json` /
 *     per-day message files; author + channel attribution; `ts`
 *     timestamps; HTML entities unescaped;
 *   - tag/source attribution: every imported memory carries
 *     `source: "external_data"` and `["imported", "<source>"]` tags;
 *   - `--synthesize`: rule-based extraction of decisions / preferences /
 *     milestones into structured, tagged memories (no LLM);
 *   - dry-run imports nothing.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  contentHash,
  parseExportDirectory,
  parseExternalMemoryExport,
  parseSlackExportDirectory,
  synthesizeImportInsights,
} from "../src/external-import";

// Mode-agnostic __dirname: undefined under --experimental-vm-modules ESM.
const testDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const FIXTURES = join(testDir, "fixtures", "imports");

function makeMemos(): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    embeddings: { enabled: false },
  });
}

describe("content-hash dedupe", () => {
  test("hash is stable and normalization-insensitive", () => {
    expect(contentHash("Hello  World")).toBe(contentHash("hello world"));
    expect(contentHash("Hello  World")).toBe(contentHash("  HELLO world\n"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("parseExternalMemoryExport dedupes repeated content", () => {
    const parsed = parseExternalMemoryExport(
      [
        { content: "Same text" },
        { content: "same TEXT" },
        { content: "Other" },
      ],
      "generic",
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.skipped).toBe(1);
  });
});

describe("ChatGPT importer", () => {
  test("extracts user turns with timestamps and conversation titles", async () => {
    const memos = makeMemos();
    await memos.init();
    const result = await memos.importExternal({
      file: join(FIXTURES, "chatgpt-conversations.json"),
      source: "chatgpt",
    });
    expect(result.detected).toBe("chatgpt");
    // 4 user turns in the fixture, one duplicated → 3 unique.
    expect(result.total).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(1);

    const memories = await memos.search({ query: "Postgres", limit: 10 });
    expect(memories.length).toBeGreaterThan(0);
    const node = memories[0]!.node;
    expect(node.source).toBe("external_data");
    expect(node.tags).toContain("imported");
    expect(node.tags).toContain("chatgpt");
    expect(node.metadata.importSource).toBe("chatgpt");
    expect(node.metadata.importConversation).toBe("Database planning");
    // create_time (seconds) → ms.
    expect(node.validFrom).toBe(1718452800 * 1000);
    await memos.close();
  });

  test("assistant turns are not imported", async () => {
    const memos = makeMemos();
    await memos.init();
    await memos.importExternal({
      file: join(FIXTURES, "chatgpt-conversations.json"),
      source: "chatgpt",
    });
    const memories = await memos.search({ query: "solid default", limit: 10 });
    expect(memories).toHaveLength(0);
    await memos.close();
  });

  test("directory scan works for chatgpt too", async () => {
    const parsed = await parseExportDirectory(
      join(FIXTURES, "claude-export"),
      "chatgpt",
    );
    // chatgpt parser finds no mapping trees here → generic fallback items
    expect(parsed.detected).toBe("chatgpt");
    expect(parsed.items.length).toBeGreaterThan(0);
  });
});

describe("Claude importer", () => {
  test("scans an export directory: conversations.json + jsonl", async () => {
    const memos = makeMemos();
    await memos.init();
    const result = await memos.importExternal({
      dir: join(FIXTURES, "claude-export"),
      source: "claude",
    });
    expect(result.detected).toBe("claude");
    // 2 human turns from conversations.json + 2 user lines from history.jsonl
    expect(result.total).toBe(4);
    expect(result.imported).toBe(4);

    const memories = await memos.search({ query: "SQLite", limit: 10 });
    expect(memories.length).toBeGreaterThan(0);
    const node = memories[0]!.node;
    expect(node.tags).toContain("imported");
    expect(node.tags).toContain("claude");
    expect(node.metadata.importSource).toBe("claude");

    const api = await memos.search({ query: "REST", limit: 10 });
    expect(api[0]!.node.metadata.importConversation).toBe("API design");
    // ISO-8601 created_at → ms.
    expect(api[0]!.node.validFrom).toBe(Date.parse("2024-06-15T10:01:00Z"));
    await memos.close();
  });

  test("dry-run imports nothing", async () => {
    const memos = makeMemos();
    await memos.init();
    const result = await memos.importExternal({
      dir: join(FIXTURES, "claude-export"),
      source: "claude",
      dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.imported).toBe(0);
    expect(result.total).toBe(4);
    expect(memos.count).toBe(0);
    await memos.close();
  });
});

describe("Slack importer", () => {
  test("parses channels, users, and per-day files", async () => {
    const parsed = await parseSlackExportDirectory(
      join(FIXTURES, "slack-export"),
    );
    expect(parsed.detected).toBe("slack");
    // 4 messages, one duplicate → 3 unique, chronological.
    expect(parsed.items).toHaveLength(3);
    expect(parsed.skipped).toBe(1);
    const [first, second, third] = parsed.items;
    expect(first!.content).toBe(
      "We deployed the new homepage & it looks great",
    );
    expect(first!.author).toBe("Alice Adams");
    expect(first!.channel).toBe("general");
    expect(first!.createdAt).toBe(1718452800 * 1000);
    expect(second!.content).toBe("Standup at 10");
    expect(second!.author).toBe("Alice Adams");
    expect(third!.content).toBe("I prefer dark mode for the dashboard");
    expect(third!.author).toBe("Bob");
    expect(third!.channel).toBe("random");
  });

  test("slack entity decoding is single-pass (&amp; decoded last)", async () => {
    // Regression: decoding &amp; first turned "&amp;lt;" into "&lt;",
    // which the next pass decoded AGAIN into "<" (double-unescape).
    const dir = mkdtempSync(join(tmpdir(), "slack-entities-"));
    writeFileSync(
      join(dir, "channels.json"),
      JSON.stringify([{ id: "C01", name: "general" }]),
    );
    writeFileSync(join(dir, "users.json"), JSON.stringify([]));
    mkdirSync(join(dir, "general"), { recursive: true });
    writeFileSync(
      join(dir, "general", "2024-06-15.json"),
      JSON.stringify([
        {
          text: "use &amp;lt;tag&amp;gt; and &amp;amp; stays",
          ts: "1718452800.000200",
          type: "message",
          user: "U01",
        },
      ]),
    );
    const parsed = await parseSlackExportDirectory(dir);
    expect(parsed.detected).toBe("slack");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]!.content).toBe("use &lt;tag&gt; and &amp; stays");
  });

  test("importExternal stores slack messages with attribution", async () => {
    const memos = makeMemos();
    await memos.init();
    const result = await memos.importExternal({
      dir: join(FIXTURES, "slack-export"),
      source: "slack",
    });
    expect(result.detected).toBe("slack");
    expect(result.imported).toBe(3);

    const memories = await memos.search({ query: "homepage", limit: 10 });
    const node = memories[0]!.node;
    expect(node.source).toBe("external_data");
    expect(node.tags).toContain("imported");
    expect(node.tags).toContain("slack");
    expect(node.metadata.importSource).toBe("slack");
    expect(node.metadata.importAuthor).toBe("Alice Adams");
    expect(node.metadata.importChannel).toBe("general");
    expect(node.validFrom).toBe(1718452800 * 1000);
    await memos.close();
  });

  test("slack requires a directory (file path is rejected)", async () => {
    const memos = makeMemos();
    await memos.init();
    const parsed = await parseSlackExportDirectory(
      join(FIXTURES, "chatgpt-conversations.json"),
    );
    expect(parsed.items).toHaveLength(0);
    await memos.close();
  });

  test("missing directory yields an empty result, not a throw", async () => {
    const parsed = await parseSlackExportDirectory(join(FIXTURES, "nope"));
    expect(parsed.items).toHaveLength(0);
    expect(parsed.detected).toBe("slack");
  });
});

describe("post-import synthesis (rule-based)", () => {
  test("classifies decisions, preferences, milestones by sentence", () => {
    const insights = synthesizeImportInsights([
      {
        content: "We decided to use Postgres for the new service. It is fast.",
      },
      { content: "I prefer dark mode for the dashboard, honestly." },
      { content: "We shipped v2 of the API yesterday! Big day." },
      { content: "Standup at 10." },
    ]);
    expect(insights).toEqual([
      {
        kind: "decision",
        text: "We decided to use Postgres for the new service.",
      },
      {
        kind: "preference",
        text: "I prefer dark mode for the dashboard, honestly.",
      },
      { kind: "milestone", text: "We shipped v2 of the API yesterday!" },
    ]);
  });

  test("importExternal --synthesize stores structured memories", async () => {
    const memos = makeMemos();
    await memos.init();
    const result = await memos.importExternal({
      file: join(FIXTURES, "chatgpt-conversations.json"),
      source: "chatgpt",
      synthesize: true,
    });
    expect(result.synthesized).toEqual({
      decisions: 1,
      preferences: 1,
      milestones: 1,
    });

    const decisions = await memos.search({ query: "Postgres", limit: 20 });
    const synthesized = decisions.filter((r) =>
      r.node.tags.includes("synthesized"),
    );
    expect(synthesized).toHaveLength(1);
    const node = synthesized[0]!.node;
    expect(node.tags).toEqual(
      expect.arrayContaining([
        "synthesized",
        "imported",
        "chatgpt",
        "decision",
      ]),
    );
    expect(node.metadata.synthesized).toBe(true);
    expect(node.metadata.synthesizedKind).toBe("decision");
    expect(node.source).toBe("external_data");

    const prefs = await memos.search({ query: "dark mode", limit: 20 });
    const prefSynth = prefs.filter((r) => r.node.tags.includes("synthesized"));
    expect(prefSynth).toHaveLength(1);
    expect(prefSynth[0]!.node.type).toBe("preference");
    await memos.close();
  });

  test("no synthesize flag → no synthesized memories", async () => {
    const memos = makeMemos();
    await memos.init();
    const result = await memos.importExternal({
      file: join(FIXTURES, "chatgpt-conversations.json"),
      source: "chatgpt",
    });
    expect(result.synthesized).toEqual({
      decisions: 0,
      preferences: 0,
      milestones: 0,
    });
    const tagged = await memos.search({ query: "Postgres", limit: 20 });
    expect(
      tagged.filter((r) => r.node.tags.includes("synthesized")),
    ).toHaveLength(0);
    await memos.close();
  });
});
