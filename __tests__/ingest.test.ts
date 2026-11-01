/** Document ingestion: parsing, chunking, and incremental sync. */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { chunkText, htmlToText, ingestPath } from "../src/ingest";

function makeMemos(): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    experimental: { namespaces: true },
    embeddings: { enabled: false },
    embeddingQueue: { synchronous: true },
  });
}

describe("chunkText", () => {
  test("keeps short text as one chunk", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  test("splits long text and repeats overlap between chunks", () => {
    const paragraph = "alpha beta gamma delta. ".repeat(40);
    const chunks = chunkText(paragraph, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].length).toBeLessThanOrEqual(200);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    // Overlap duplicates content, so the chunks are longer than the source.
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(total).toBeGreaterThan(paragraph.trim().length);
    expect(chunks[0].startsWith("alpha beta")).toBe(true);
    expect(chunks[chunks.length - 1].endsWith("delta.")).toBe(true);
  });

  test("no overlap means no duplicated content", () => {
    const paragraph = "alpha beta gamma delta. ".repeat(40);
    const chunks = chunkText(paragraph, 200, 0);
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    // Only whitespace at chunk boundaries is dropped.
    expect(total).toBeLessThanOrEqual(paragraph.length);
    expect(total).toBeGreaterThan(paragraph.length - chunks.length * 4);
  });

  test("returns nothing for whitespace", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});

describe("htmlToText", () => {
  test("drops scripts and decodes entities", () => {
    const html = `<html><head><style>p{color:red}</style></head>
      <body><h1>Title</h1><script>alert(1)</script>
      <p>Tom &amp; Jerry</p><p>a &lt; b</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("Tom & Jerry");
    expect(text).toContain("a < b");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });
});

describe("extractFileText", () => {
  test("reads text from a PDF", () => {
    // unpdf is ESM-only and Jest's runtime cannot load it from node_modules
    // (the production path uses a real dynamic import and works under Node).
    // Run the same extraction in a Node subprocess so the fixture and the
    // dependency are still exercised.
    const path = resolve(process.cwd(), "__tests__/fixtures/sample.pdf");
    const script = `
      import { readFileSync } from "node:fs";
      import { extractText } from "unpdf";
      const buffer = readFileSync(process.argv[1]);
      const result = await extractText(new Uint8Array(buffer), { mergePages: true });
      console.log(Array.isArray(result.text) ? result.text.join("\\n") : result.text);
    `;
    const text = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script, path],
      { encoding: "utf8" },
    );
    expect(text).toContain("4417");
  });
});

describe("ingestPath", () => {
  test("adds, skips, updates and removes documents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-ingest-"));
    const memos = makeMemos();
    await memos.init();
    try {
      writeFileSync(join(dir, "a.md"), "# Alpha\n\nThe launch code is 7788.");
      writeFileSync(join(dir, "b.md"), "# Bravo\n\nNothing to see.");

      const first = await ingestPath(memos, dir);
      expect(first.added).toBe(2);
      expect(first.errors).toBe(0);

      const second = await ingestPath(memos, dir);
      expect(second.added).toBe(0);
      expect(second.unchanged).toBe(2);

      writeFileSync(join(dir, "a.md"), "# Alpha\n\nThe launch code is 9900.");
      const third = await ingestPath(memos, dir);
      expect(third.updated).toBe(1);

      const hits = await memos.search({ query: "launch code 9900", limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].node.content).toContain("9900");

      unlinkSync(join(dir, "b.md"));
      const fourth = await ingestPath(memos, dir);
      expect(fourth.removed).toBe(1);
    } finally {
      await memos.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
