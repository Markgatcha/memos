/**
 * Regression tests for CodeQL js/sql-injection (alert #19): `sortOrder`
 * arrives as unchecked runtime data (e.g. MCP JSON) but was interpolated
 * into SQL. It must be allowlisted, never interpolated.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { MemOS } from "../src/memory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("search sortOrder SQL-injection safety", () => {
  let memos: MemOS;
  let dbDir: string;

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "memos-sort-safety-"));
    memos = new MemOS({
      dbPath: join(dbDir, "test.db"),
      embeddings: { enabled: false },
    });
    await memos.init();
    await memos.store("first memory for sort test");
    await memos.store("second memory for sort test");
  });

  afterAll(async () => {
    await memos.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("neutralizes a malicious sortOrder instead of interpolating it", async () => {
    const results = await memos.search({
      sortBy: "createdAt",
      // Simulates unchecked runtime input (MCP JSON ignores the TS type).
      sortOrder: "desc; DROP TABLE nodes; --" as unknown as "desc",
      limit: 10,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The nodes table must still exist and be queryable.
    const again = await memos.search({
      sortBy: "createdAt",
      sortOrder: "desc",
      limit: 10,
    });
    expect(again.length).toBeGreaterThanOrEqual(2);
  });

  it("still honors a valid asc sortOrder", async () => {
    const results = await memos.search({
      sortBy: "createdAt",
      sortOrder: "asc",
      limit: 10,
    });
    expect(results.length).toBeGreaterThanOrEqual(2);
    const times = results.map((r) => r.node.createdAt);
    const sorted = [...times].sort((a, b) => a - b);
    expect(times).toEqual(sorted);
  });
});
