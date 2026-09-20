/**
 * Tests for memory-grounded citations.
 *
 * Covered:
 *   - token format stability: `[mem:a3f9]` shape, lowercase hex,
 *     dashed/dashless/uppercase ids normalize identically;
 *   - token parsing: `[mem:a3f9]`, bare `a3f9`, and full ids accepted;
 *     garbage rejected;
 *   - pack uniqueness: colliding 4-hex prefixes are lengthened
 *     git-style until unique within the pack;
 *   - round-trip: store → pack with `citations: true` → `resolveCitation`
 *     returns the same memory;
 *   - ambiguity: a short token matching two memories resolves to an
 *     explicit `ambiguous` result with candidates (never a guess);
 *   - CLI output: `formatCitationResolution` renders exactly what
 *     `memos cite` prints (resolved / not_found / ambiguous, text + json).
 */

import { MemOS } from "../src/memory";
import { SQLiteStorage } from "../src/storage/sqlite";
import {
  buildContextPack,
  packToToon,
  packToToonCompact,
} from "../src/context-pack";
import {
  assignCitationTokens,
  citationToken,
  formatCitationResolution,
  parseCitationToken,
  shortCitationId,
} from "../src/citations";
import type { MemoryNode, ScoredMemory } from "../src/types";

function makeMemos(): MemOS {
  return new MemOS({
    storage: new SQLiteStorage(":memory:", true),
    embeddings: { enabled: false },
  });
}

function scored(id: string, content: string, score = 0.9): ScoredMemory {
  const node = {
    id,
    content,
    summary: "",
    type: "fact",
    metadata: {},
    importance: 0.5,
    createdAt: 1_718_452_800_000,
    updatedAt: 1_718_452_800_000,
    accessCount: 0,
    lastAccessed: 0,
    tags: [],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "user_input",
    pool: "event",
    trustScore: 1,
    confidence: 0.5,
    evidenceCount: 0,
  } as MemoryNode;
  return { node, score, scores: {} };
}

describe("token format", () => {
  test("citationToken is [mem:<4 hex>], stable across id shapes", () => {
    expect(citationToken("a3f9c2e1-1234-5678-9abc-def123456789")).toBe(
      "[mem:a3f9]",
    );
    expect(citationToken("a3f9c2e1123456789abcdef123456789")).toBe(
      "[mem:a3f9]",
    );
    expect(citationToken("A3F9C2E1-1234-5678-9ABC-DEF123456789")).toBe(
      "[mem:a3f9]",
    );
    expect(shortCitationId("a3f9c2e1-1234-5678-9abc-def123456789")).toBe(
      "a3f9",
    );
    expect(citationToken("a3f9c2e1-1234-5678-9abc-def123456789")).toMatch(
      /^\[mem:[0-9a-f]{4}\]$/,
    );
  });

  test("parseCitationToken accepts wrapped, bare, and full ids", () => {
    expect(parseCitationToken("[mem:a3f9]")).toBe("a3f9");
    expect(parseCitationToken("a3f9")).toBe("a3f9");
    expect(parseCitationToken("A3F9")).toBe("a3f9");
    expect(parseCitationToken("a3f9c2e1-1234-5678-9abc-def123456789")).toBe(
      "a3f9c2e1123456789abcdef123456789",
    );
    expect(parseCitationToken("zzz")).toBeNull();
    expect(parseCitationToken("[mem:zzz]")).toBeNull();
    expect(parseCitationToken("ab")).toBe("ab"); // 2 = minimum usable prefix
    expect(parseCitationToken("a")).toBeNull(); // too short
    expect(parseCitationToken("")).toBeNull();
  });

  test("assignCitationTokens lengthens only on collision", () => {
    const tokens = assignCitationTokens([
      "a3f91111-0000-0000-0000-000000000000",
      "b7e22222-0000-0000-0000-000000000000",
    ]);
    expect(tokens.get("a3f91111-0000-0000-0000-000000000000")).toBe(
      "[mem:a3f9]",
    );
    expect(tokens.get("b7e22222-0000-0000-0000-000000000000")).toBe(
      "[mem:b7e2]",
    );

    const colliding = assignCitationTokens([
      "a3f91111-0000-0000-0000-000000000000",
      "a3f92222-0000-0000-0000-000000000000",
      "a3f93333-0000-0000-0000-000000000000",
    ]);
    const values = [...colliding.values()];
    expect(new Set(values).size).toBe(3); // unique within the pack
    expect(values[0]).toBe("[mem:a3f91]");
    expect(values[1]).toBe("[mem:a3f92]");
    expect(values[2]).toBe("[mem:a3f93]");
  });
});

describe("pack rendering", () => {
  test("citations: true tags every item and renders tokens in TOON", () => {
    const pack = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 2000,
      citations: true,
      items: [
        scored("a3f91111-0000-0000-0000-000000000000", "First memory."),
        scored("b7e22222-0000-0000-0000-000000000000", "Second memory.", 0.8),
      ],
    });
    expect(pack.items[0]!.citation).toBe("[mem:a3f9]");
    expect(pack.items[1]!.citation).toBe("[mem:b7e2]");

    const toon = packToToon(pack);
    expect(toon).toContain("[mem:a3f9] First memory.");
    expect(toon).toContain("[mem:b7e2] Second memory.");

    const compact = packToToonCompact(pack) as string;
    expect(compact).toContain("[mem:a3f9]");
  });

  test("citations default off — packs are byte-identical to before", () => {
    const items = [
      scored("a3f91111-0000-0000-0000-000000000000", "First memory."),
    ];
    const plain = buildContextPack({
      query: "q",
      namespace: "default",
      tokenBudget: 2000,
      items,
    });
    expect(plain.items[0]!.citation).toBeUndefined();
    expect(packToToon(plain)).not.toContain("[mem:");
  });
});

describe("resolveCitation", () => {
  test("round-trip: pack token → full source memory", async () => {
    const memos = makeMemos();
    await memos.init();
    const { node } = await memos.store("The user likes dark mode.", {
      type: "preference",
    });
    const pack = await memos.contextPack({
      query: "dark mode",
      tokenBudget: 2000,
      citations: true,
    });
    if (typeof pack === "string") throw new Error("expected pack object");
    const token = pack.items[0]!.citation!;
    expect(token).toMatch(/^\[mem:[0-9a-f]{4}\]$/);

    for (const input of [token, token.slice(5, -1), node.id]) {
      const resolved = await memos.resolveCitation(input);
      expect(resolved.status).toBe("resolved");
      if (resolved.status === "resolved") {
        expect(resolved.memory.id).toBe(node.id);
        expect(resolved.memory.content).toBe("The user likes dark mode.");
        expect(resolved.memory.source).toBe("user_input");
      }
    }
    await memos.close();
  });

  test("unknown token → not_found", async () => {
    const memos = makeMemos();
    await memos.init();
    const resolved = await memos.resolveCitation("[mem:ffff]");
    expect(resolved.status).toBe("not_found");
    const garbage = await memos.resolveCitation("not-a-token!!!");
    expect(garbage.status).toBe("not_found");
    await memos.close();
  });

  test("shared prefix → ambiguous with candidates, never a guess", async () => {
    const storage = new SQLiteStorage(":memory:", true);
    const memos = new MemOS({ storage, embeddings: { enabled: false } });
    await memos.init();
    // Note: save AFTER init — SQLiteStorage.init() re-opens `:memory:` DBs,
    // so a second init would wipe rows saved beforehand.
    const mkNode = (id: string, content: string): MemoryNode =>
      ({
        id,
        content,
        summary: "",
        type: "fact",
        metadata: {},
        importance: 0.5,
        createdAt: 1_718_452_800_000,
        updatedAt: 1_718_452_800_000,
        accessCount: 0,
        lastAccessed: 0,
        tags: [],
        expiresAt: null,
        namespace: "default",
        validFrom: null,
        validTo: null,
        source: "user_input",
        pool: "event",
        trustScore: 1,
        confidence: 0.5,
        evidenceCount: 0,
      }) as MemoryNode;
    await storage.saveNode(
      mkNode("a3f91111-0000-0000-0000-000000000000", "First colliding memory."),
    );
    await storage.saveNode(
      mkNode(
        "a3f92222-0000-0000-0000-000000000000",
        "Second colliding memory.",
      ),
    );

    const ambiguous = await memos.resolveCitation("[mem:a3f9]");
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.candidates).toHaveLength(2);
    }
    // A longer token still resolves exactly.
    const exact = await memos.resolveCitation("a3f911");
    expect(exact.status).toBe("resolved");
    if (exact.status === "resolved") {
      expect(exact.memory.content).toBe("First colliding memory.");
    }
    await memos.close();
  });
});

describe("CLI output (formatCitationResolution)", () => {
  const node = {
    id: "a3f9c2e1-1234-5678-9abc-def123456789",
    content: "The user likes dark mode.",
    summary: "",
    type: "preference",
    metadata: {},
    importance: 0.5,
    createdAt: 1_718_452_800_000,
    updatedAt: 1_718_452_800_000,
    accessCount: 0,
    lastAccessed: 0,
    tags: ["imported", "chatgpt"],
    expiresAt: null,
    namespace: "default",
    validFrom: null,
    validTo: null,
    source: "external_data",
    pool: "event",
    trustScore: 0.9,
    confidence: 0.5,
    evidenceCount: 0,
  } as MemoryNode;

  test("resolved prints the full source memory", () => {
    const out = formatCitationResolution({
      status: "resolved",
      token: "[mem:a3f9]",
      memory: node,
    });
    expect(out).toContain("[mem:a3f9] → a3f9c2e1-1234-5678-9abc-def123456789");
    expect(out).toContain("The user likes dark mode.");
    expect(out).toContain("Source: external_data");
    expect(out).toContain("Tags: imported, chatgpt");
    expect(out).toContain("2024-06-15");
    expect(out).toContain("Namespace: default");
  });

  test("not_found prints a plain message", () => {
    const out = formatCitationResolution({
      status: "not_found",
      token: "[mem:ffff]",
    });
    expect(out).toBe("No memory found for citation [mem:ffff].");
  });

  test("ambiguous lists candidates and asks for a longer token", () => {
    const out = formatCitationResolution({
      status: "ambiguous",
      token: "[mem:a3f9]",
      candidates: [
        node,
        { ...node, id: "a3f90000-0000-0000-0000-000000000000" },
      ],
    });
    expect(out).toContain("ambiguous");
    expect(out).toContain("a3f9c2e1-1234-5678-9abc-def123456789");
    expect(out).toContain("longer token");
  });

  test("json mode emits structured output", () => {
    const out = formatCitationResolution(
      { status: "resolved", token: "[mem:a3f9]", memory: node },
      true,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("resolved");
    expect(parsed.memory.id).toBe(node.id);
    expect(parsed.memory.content).toBe("The user likes dark mode.");
  });
});
