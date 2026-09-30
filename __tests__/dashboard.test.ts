/**
 * Tests for the local dashboard (Feature 4).
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { startDashboard } from "../src/dashboard.js";
import { MemOS } from "../src/memory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("dashboard", () => {
  let memos: MemOS;
  let dbDir: string;
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), "memos-dashboard-test-"));
    memos = new MemOS({
      dbPath: join(dbDir, "test.db"),
      embeddings: { enabled: false },
    });
    await memos.init();
    // Seed some test data
    await memos.store("Test memory one", { type: "note" });
    await memos.store("Test memory two", { type: "preference" });
    server = await startDashboard(memos, { port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await memos.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("serves the dashboard HTML", async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("MemOS Dashboard");
  });

  it("/api/memories returns memories", async () => {
    const res = await fetch(`${server.url}/api/memories?limit=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.memories).toBeDefined();
    expect(data.total).toBeGreaterThanOrEqual(2);
  });

  it("/api/search returns results", async () => {
    const res = await fetch(`${server.url}/api/search?q=Test&limit=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.results).toBeDefined();
    expect(data.query).toBe("Test");
  });

  it("/api/graph returns nodes and edges", async () => {
    const res = await fetch(`${server.url}/api/graph`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.nodes).toBeDefined();
    expect(data.edges).toBeDefined();
  });

  it("/api/stats returns statistics", async () => {
    const res = await fetch(`${server.url}/api/stats`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.total).toBeGreaterThanOrEqual(2);
    expect(data.byType).toBeDefined();
  });

  it("/api/memory/:id returns a single memory", async () => {
    const listRes = await fetch(`${server.url}/api/memories?limit=1`);
    const listData = (await listRes.json()) as any;
    const id = listData.memories[0].id;
    const res = await fetch(`${server.url}/api/memory/${id}`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.memory.id).toBe(id);
  });

  it("/api/memory/:id returns 404 for unknown id", async () => {
    const res = await fetch(`${server.url}/api/memory/nonexistent-id-12345`);
    expect(res.status).toBe(404);
  });
});
