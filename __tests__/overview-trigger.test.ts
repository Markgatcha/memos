import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemOS } from "../src/memory.js";

async function fresh(): Promise<MemOS> {
  const memos = new MemOS({
    dbPath: ":memory:",
    embeddings: { enabled: false },
  });
  await memos.init();
  return memos;
}

describe("overview", () => {
  it("counts what the store knows without listing contents", async () => {
    const memos = await fresh();
    try {
      await memos.store("User prefers dark mode", {
        type: "preference",
        tags: ["ui", "editor"],
        namespace: "work",
      });
      await memos.store("Project uses pnpm workspaces", {
        type: "fact",
        tags: ["tooling"],
        namespace: "work",
      });
      await memos.store("User lives in Berlin", {
        type: "fact",
        tags: ["location"],
        namespace: "personal",
      });

      const all = await memos.overview();
      expect(all.total).toBe(3);
      expect(all.active).toBe(3);
      expect(all.historical).toBe(0);
      expect(all.quarantined).toBe(0);
      expect(all.namespaces).toEqual(
        expect.arrayContaining([
          { namespace: "work", count: 2 },
          { namespace: "personal", count: 1 },
        ]),
      );
      expect(all.types).toEqual(
        expect.arrayContaining([
          { type: "fact", count: 2 },
          { type: "preference", count: 1 },
        ]),
      );
      expect(all.tags.map((tag) => tag.tag)).toEqual(
        expect.arrayContaining(["ui", "tooling", "location"]),
      );
      expect(all.trust.mean).toBeGreaterThan(0);
      expect(all.oldest).not.toBeNull();

      const work = await memos.overview({ namespace: "work" });
      expect(work.total).toBe(2);
      expect(work.namespaces).toEqual([{ namespace: "work", count: 2 }]);
    } finally {
      await memos.close();
    }
  });
});

describe("trigger", () => {
  it("ranks lessons for a task and explains why each fired", async () => {
    const memos = await fresh();
    try {
      await memos.memorizeProcedural(
        "Check the rate limit before bulk importing from GitHub",
        { tags: ["github", "import"], context: "bulk imports" },
      );
      await memos.memorizeProcedural("Ask before deleting production data", {
        tags: ["production", "delete"],
      });

      const result = await memos.trigger({
        task: "bulk import repositories from GitHub",
        entities: ["github"],
        limit: 3,
      });

      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0]!.lesson).toContain("rate limit");
      expect(result.matches[0]!.reason).toMatch(/relevance \d+%/);
      expect(result.matches[0]!.matchedTags).toContain("github");

      const unrelated = await memos.trigger({
        task: "compose newsletter copy",
        entities: ["newsletter"],
      });
      expect(unrelated.matches).toHaveLength(0);
    } finally {
      await memos.close();
    }
  });
});

describe("review queue", () => {
  it("holds inferred memories until approved, and rejects by deleting", async () => {
    const memos = new MemOS({
      dbPath: ":memory:",
      embeddings: { enabled: false },
      review: { autoApproveTags: ["trusted"] },
    });
    await memos.init();
    try {
      const pending = await memos.store("User mentioned they like jazz", {
        review: true,
        tags: ["inferred"],
      });
      const auto = await memos.store("User's timezone is CET", {
        review: true,
        tags: ["trusted"],
      });
      expect(pending.node.metadata.reviewStatus).toBe("pending");
      expect(pending.node.quarantined).toBe(true);
      expect(auto.node.metadata.reviewStatus).toBe("approved");
      expect(auto.node.quarantined).toBe(false);

      expect(await memos.search("jazz")).toHaveLength(0);
      const queue = await memos.reviewQueue();
      expect(queue.map((node) => node.id)).toEqual([pending.node.id]);

      await memos.reviewApprove(pending.node.id);
      expect((await memos.search("jazz")).length).toBeGreaterThan(0);
      expect(await memos.reviewQueue()).toHaveLength(0);

      const rejected = await memos.store("Speculative inference", {
        review: true,
      });
      expect(await memos.reviewReject(rejected.node.id)).toBe(true);
      expect((await memos.deletionStatus(rejected.node.id)).status).toBe(
        "deleted",
      );
    } finally {
      await memos.close();
    }
  });
});

describe("forgetSource", () => {
  it("previews, deletes, and proves source-scoped erasure", async () => {
    const memos = await fresh();
    try {
      const first = await memos.store("Chunk one from the handbook", {
        metadata: { sourcePath: "docs/handbook.md" },
      });
      const second = await memos.store("Chunk two from the handbook", {
        metadata: { sourcePath: "docs/handbook.md" },
      });
      const other = await memos.store("Unrelated note", {
        metadata: { sourcePath: "docs/notes.md" },
      });

      const preview = await memos.forgetSource("docs/handbook.md", {
        dryRun: true,
      });
      expect(preview.matched).toBe(2);
      expect(preview.deleted).toBe(0);
      expect(await memos.search("handbook")).toHaveLength(2);

      const result = await memos.forgetSource("docs/handbook.md");
      expect(result.matched).toBe(2);
      expect(result.deleted).toBe(2);
      expect(result.certificates).toHaveLength(2);
      expect(await memos.search("handbook")).toHaveLength(0);
      expect(
        (await memos.search("unrelated")).some(
          (hit) => hit.node.id === other.node.id,
        ),
      ).toBe(true);

      const deleted = await memos.deletionStatus(first.node.id);
      expect(deleted.status).toBe("deleted");
      expect(deleted.certificate?.nodeId).toBe(first.node.id);

      const present = await memos.deletionStatus(other.node.id);
      expect(present.status).toBe("present");
      expect(present.certificate).toBeNull();

      expect(second.node.id).not.toBe(first.node.id);
    } finally {
      await memos.close();
    }
  });

  it("matches a prefix and scopes by namespace", async () => {
    const memos = await fresh();
    try {
      await memos.store("A", {
        namespace: "one",
        metadata: { sourcePath: "docs/guide/intro.md" },
      });
      await memos.store("B", {
        namespace: "one",
        metadata: { sourcePath: "docs/guide/advanced.md" },
      });
      await memos.store("C", {
        namespace: "two",
        metadata: { sourcePath: "docs/guide/intro.md" },
      });

      const result = await memos.forgetSource("docs/guide/", {
        prefix: true,
        namespace: "one",
      });
      expect(result.deleted).toBe(2);
      expect((await memos.overview({ namespace: "two" })).total).toBe(1);
    } finally {
      await memos.close();
    }
  });
});

describe("brief", () => {
  it("splits open and closed items for one subject", async () => {
    const memos = await fresh();
    try {
      await memos.store("Project Alpha is waiting on the legal review", {
        tags: ["alpha", "open"],
      });
      await memos.store("Project Alpha shipped version 1", {
        tags: ["alpha", "done"],
      });
      await memos.store("Unrelated note about the office move", {
        tags: ["office"],
      });

      const brief = await memos.brief({ subject: "Project Alpha" });
      expect(brief.open.map((item) => item.content)).toEqual([
        "Project Alpha is waiting on the legal review",
      ]);
      expect(brief.closed.map((item) => item.content)).toEqual([
        "Project Alpha shipped version 1",
      ]);
      expect(brief.policy.dropClosedFromPrompt).toBe(true);

      const withoutClosed = await memos.brief({
        subject: "Project Alpha",
        includeClosed: false,
      });
      expect(withoutClosed.closed).toHaveLength(0);
    } finally {
      await memos.close();
    }
  });
});

describe("knowledge pages", () => {
  it("re-renders a saved query and cites live memories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memos-pages-"));
    const memos = new MemOS({
      dbPath: join(dir, "memos.db"),
      embeddings: { enabled: false },
    });
    await memos.init();
    try {
      const pinned = await memos.store("Runbook lives in docs/runbook.md", {
        tags: ["ops"],
      });
      await memos.store("Deploys happen on Fridays", { tags: ["ops"] });

      const def = await memos.savePage({
        name: "ops-runbook",
        title: "Ops runbook",
        query: "deploys runbook",
        pinnedIds: [pinned.node.id],
      });
      expect(def.name).toBe("ops-runbook");

      const page = await memos.readPage("ops-runbook");
      expect(page.markdown).toContain("# Ops runbook");
      expect(page.markdown).toContain("[mem:");
      expect(page.citations.some((c) => c.pinned)).toBe(true);
      expect(page.citations.length).toBeGreaterThanOrEqual(2);

      // The page is a view: a new memory appears on the next read.
      await memos.store("Deploy rollback is documented in docs/rollback.md", {
        tags: ["ops"],
      });
      const reread = await memos.readPage("ops-runbook");
      expect(reread.citations.length).toBeGreaterThanOrEqual(
        page.citations.length,
      );

      expect((await memos.listPages()).map((p) => p.name)).toEqual([
        "ops-runbook",
      ]);
      expect(await memos.deletePage("ops-runbook")).toBe(true);
      await expect(memos.readPage("ops-runbook")).rejects.toThrow(/not found/);
    } finally {
      await memos.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
