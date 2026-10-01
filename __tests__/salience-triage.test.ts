/**
 * Tests for write-side salience triage (innovation round 3).
 *
 * Accuracy gate: the triage is conservative-first — a write is skipped
 * only on positive evidence of noise. The labeled set below pins the
 * contract:
 *   - substantive recall MUST be 1.0 (no substantive memory silently
 *     dropped, ever),
 *   - trivial skip rate is reported (high is good, misses are the
 *     conservative choice).
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import { MemorySkippedError } from "../src/memory";
import { decideRetain } from "../src/retain-filter";
import type { EmbeddingProvider, EmbeddingVector } from "../src/types";

/** Must ALL be retained — dropping any of these is a data-loss bug. */
const SUBSTANTIVE = [
  "User prefers dark mode",
  "My favorite food is pizza",
  "i like pizza",
  "The deploy is scheduled for Friday at 3pm",
  "Meeting moved to next Monday",
  "Alice's phone number is 555-1234",
  "The API key is stored in 1Password under Production",
  "We decided to use Postgres for the new service",
  "Server migration completed successfully last night",
  "The bug was fixed by updating the auth middleware",
  "Reminder: call mom tomorrow at 9am",
  "Q3 revenue grew 12% year over year",
  "The new office is located at 200 Main Street",
  "John Smith is the new on-call lead",
  "I was born on June 1 2010",
  "The meeting notes from yesterday: launch delayed two weeks",
  "Use `pnpm install` to set up the repo",
  "The config file lives at config/settings.yaml",
  "She switched from VSCode to Zed for Rust work",
  "The wifi password is hunter2guest",
  "Buy milk on the way home",
  "Dentist appointment is Thursday 2pm",
  "The project deadline is December 15",
  "He dislikes meetings before 10am",
];

/** Should be skipped — pure noise with no retrieval value. */
const TRIVIAL = [
  "ok",
  "thanks",
  "lol",
  "got it",
  "sure thing",
  "yep",
  "hello",
  "cool",
  "nice!",
  "haha",
  "k",
  "will do",
  "sounds good",
  "perfect",
  "no problem",
  "...",
  "ok ok ok",
  "yes",
  // Ambiguous fragments: the conservative choice is to KEEP these
  // (counted as triage misses, not failures).
  "test",
  "asdf",
];

async function makeMemos() {
  const stub: EmbeddingProvider = {
    id: "stub",
    model: "stub-v1",
    dimensions: 4,
    embed: async (_text: string): Promise<EmbeddingVector> => [0, 0, 0, 0],
  };
  const memos = new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    embeddings: { enabled: true, provider: stub },
    embeddingQueue: { synchronous: true },
  });
  await memos.init();
  return memos;
}

describe("salience triage labeled set", () => {
  test("substantive recall is 1.0 — no substantive memory is dropped", () => {
    const dropped: string[] = [];
    for (const content of SUBSTANTIVE) {
      const d = decideRetain({ content });
      if (!d.retain) dropped.push(`${content} (score=${d.score.toFixed(2)})`);
    }
    // Hard gate: ANY dropped substantive memory fails the suite.
    expect(dropped).toEqual([]);
  });

  test("trivial skip rate is reported (conservative misses allowed)", () => {
    let skipped = 0;
    const kept: string[] = [];
    for (const content of TRIVIAL) {
      const d = decideRetain({ content });
      if (d.retain) kept.push(content);
      else skipped++;
    }
    const rate = skipped / TRIVIAL.length;
    // eslint-disable-next-line no-console
    console.log(
      `triage labeled set: substantive recall 1.000, ` +
        `trivial skip rate ${rate.toFixed(3)} (${skipped}/${TRIVIAL.length}); ` +
        `conservative keeps: ${JSON.stringify(kept)}`,
    );
    // The triage must actually do something: skip the clear-cut noise.
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });

  test("near-duplicates are skipped, genuine updates are kept", () => {
    const existing = ["User prefers dark mode"];
    expect(
      decideRetain({
        content: "user prefers dark mode!",
        existingContent: existing,
      }).retain,
    ).toBe(false);
    expect(
      decideRetain({
        content: "User prefers light mode for presentations",
        existingContent: existing,
      }).retain,
    ).toBe(true);
  });
});

describe("salience triage write path", () => {
  test("filterRetain skips trivial writes via MemorySkippedError", async () => {
    const memos = await makeMemos();
    await expect(
      memos.store("ok got it", { filterRetain: true }),
    ).rejects.toBeInstanceOf(MemorySkippedError);
  });

  test("filterRetain keeps substantive writes", async () => {
    const memos = await makeMemos();
    const { node } = await memos.store("User prefers dark mode", {
      filterRetain: true,
    });
    expect(node.content).toBe("User prefers dark mode");
  });

  test("filterRetain skips a same-scope near-duplicate on the second write", async () => {
    const memos = await makeMemos();
    await memos.store("User prefers dark mode", { filterRetain: true });
    await expect(
      memos.store("user prefers dark mode!", { filterRetain: true }),
    ).rejects.toBeInstanceOf(MemorySkippedError);
  });

  test("near-duplicate detection is scope-local", async () => {
    const memos = await makeMemos();
    await memos.store("User prefers dark mode", {
      namespace: "project:alpha",
      filterRetain: true,
    });
    // Same content in a different scope is NOT a duplicate — kept.
    const { node } = await memos.store("User prefers dark mode", {
      namespace: "project:beta",
      filterRetain: true,
    });
    expect(node.namespace).toBe("project:beta");
  });

  test("without filterRetain, trivial writes still store (force path)", async () => {
    const memos = await makeMemos();
    const { node } = await memos.store("ok got it");
    expect(node.content).toBe("ok got it");
  });
});
