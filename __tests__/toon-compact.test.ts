/**
 * Tests for the v2 compact TOON wire format.
 *
 * Pins the lossless round-trip guarantees of `searchResultsToToonCompact()`
 * / `packToToonCompact()` -> `parseToonCompact()`:
 *   - IDs survive exactly (dashed UUIDs re-dashed, hex/foreign shapes
 *     untouched, `~` escape path).
 *   - Timestamps survive at second precision via header epoch anchor +
 *     per-row deltas.
 *   - Tags survive through the optional header dictionary AND its
 *     fallback-to-literal path (dictionary never used for all-digit tags,
 *     where numeric row fields would be ambiguous with indices).
 *   - v1 strings (absolute epochs, no dictionary) still decode.
 */

import { describe, test, expect } from "@jest/globals";
import {
  searchResultsToToonCompact,
  packToToonCompact,
  parseToonCompact,
  encodeCompactId,
  decodeCompactId,
} from "../src/context-pack";
import type { ScoredMemory } from "../src/types";

const UUID = "3f8a2b1c-9d4e-4f5a-8b7c-1e2d3f4a5b6c";

function makeScored(
  id: string,
  content: string,
  score: number,
  tags: string[],
  updatedAtMs: number,
): ScoredMemory {
  return {
    node: {
      id,
      content,
      summary: content.slice(0, 40),
      type: "fact",
      metadata: {},
      importance: 0.7,
      createdAt: updatedAtMs - 1000,
      updatedAt: updatedAtMs,
      accessCount: 3,
      lastAccessed: updatedAtMs,
      tags,
      expiresAt: null,
      namespace: "default",
      validFrom: null,
      validTo: null,
      source: "user_input",
      trustScore: 0.9,
    },
    score,
    scores: {},
  };
}

describe("compact ID codec", () => {
  test("canonical dashed UUID encodes to 23 chars and round-trips", () => {
    const wire = encodeCompactId(UUID);
    expect(wire.length).toBe(23); // ~ + ceil(128 bits / 6) = 1 + 22
    expect(wire.startsWith("~")).toBe(true);
    expect(decodeCompactId(wire)).toBe(UUID);
  });

  test("even-length plain-hex IDs round-trip; odd or non-hex pass through", () => {
    expect(decodeCompactId(encodeCompactId("abcdef123456"))).toBe(
      "abcdef123456",
    );
    // Bare 32-hex must NOT encode: decode would re-dash it as a UUID body.
    const hex32 = "0123456789abcdef0123456789abcdef";
    expect(encodeCompactId(hex32)).toBe(hex32);
    expect(encodeCompactId("abc")).toBe("abc");
    expect(encodeCompactId("plain-id-42")).toBe("plain-id-42");
    expect(decodeCompactId("plain-id-42")).toBe("plain-id-42");
  });

  test("literal tilde IDs are escaped and restored", () => {
    const id = "~weird-id";
    expect(encodeCompactId(id)).toBe("~~weird-id");
    expect(decodeCompactId("~~weird-id")).toBe(id);
  });
});

describe("v2 wire format round-trip", () => {
  const now = Date.now();
  const results = [
    makeScored(
      UUID,
      "User likes dark mode in editors",
      0.95,
      ["ui", "editor"],
      now,
    ),
    makeScored(
      "abc123ef",
      "Works at Google on Spanner",
      0.9,
      ["work"],
      now - 86_400_000,
    ),
    makeScored(
      "plain-id-42",
      "Drinks pour-over coffee",
      0.85,
      ["lifestyle"],
      now + 3_600_000,
    ),
  ];

  test("header carries v2 marker and epoch anchor", () => {
    const toon = searchResultsToToonCompact(results);
    expect(toon).toContain("# memos.search.v2|e=");
    expect(toon).toContain("# f=~id|s|t|c|e|g|ct");
  });

  test("IDs, scores, trust, source, timestamps, tags, content all round-trip", () => {
    const parsed = parseToonCompact(searchResultsToToonCompact(results));
    expect(parsed).toHaveLength(results.length);
    parsed.forEach((item, i) => {
      expect(item.id).toBe(results[i].node.id);
      expect(Math.abs(item.score - results[i].score)).toBeLessThan(0.0011);
      expect(item.nodeSource).toBe(results[i].node.source);
      expect(new Date(item.updatedAt).getTime()).toBe(
        Math.floor(results[i].node.updatedAt / 1000) * 1000,
      );
      expect(item.tags).toEqual(results[i].node.tags);
      expect(item.content).toBe(results[i].node.content);
    });
  });

  test("delta encoding shrinks rows relative to absolute epochs", () => {
    const toon = searchResultsToToonCompact(results);
    // The oldest row anchors the header; the newest stores a day-scale delta,
    // not a 10-char absolute epoch.
    const anchorMatch = toon.match(/# memos\.search\.v2\|e=(\d+)/);
    const anchor = anchorMatch ? Number(anchorMatch[1]) : 0;
    // Match by content — the hex ID itself is encoded on the wire.
    const dataLine = toon
      .split("\n")
      .find((l) => l.includes("Works at Google"))!;
    const delta = dataLine.split("|")[4];
    expect(Number(delta)).toBeLessThan(200_000);
    expect(String(anchor).length).toBeGreaterThanOrEqual(10);
  });

  test("tag dictionary activates for repeated long tags and round-trips", () => {
    const taggy = Array.from({ length: 8 }, (_, i) =>
      makeScored(
        `row${i}-not-hex`,
        `memory number ${i}`,
        0.9 - i * 0.01,
        ["work", "longlivedtagname", "ui"],
        now - i * 60_000,
      ),
    );
    const toon = searchResultsToToonCompact(taggy);
    expect(toon).toContain("|t=work,longlivedtagname,ui");
    const parsed = parseToonCompact(toon);
    parsed.forEach((item, i) => {
      expect(item.tags).toEqual(taggy[i].node.tags);
      expect(item.id).toBe(taggy[i].node.id);
    });
  });

  test("all-digit tags suppress the dictionary (index ambiguity guard)", () => {
    const tagged = [
      makeScored("aa11", "digit-tagged", 0.9, ["2024", "work"], now),
    ];
    const toon = searchResultsToToonCompact(tagged);
    expect(toon).not.toContain("|t=");
    expect(parseToonCompact(toon)[0].tags).toEqual(["2024", "work"]);
  });

  test("empty result set still emits parseable headers", () => {
    const toon = searchResultsToToonCompact([]);
    expect(toon).toContain("# memos.search.v2");
    expect(parseToonCompact(toon)).toHaveLength(0);
  });
});

describe("pack envelope and v1 back-compat", () => {
  test("pack path keeps schema/query/namespace/budget header line", () => {
    const toon = packToToonCompact({
      schema: "ai-trio.memos.context-pack.v1",
      query: "test q",
      namespace: "default",
      tokenBudget: 8000,
      items: [],
      tokensSaved: 0,
    });
    expect(
      toon.startsWith(
        "# ai-trio.memos.context-pack.v1|q=test q|n=default|b=8000",
      ),
    ).toBe(true);
  });

  test("v1 strings (absolute epochs, no dictionary) still decode", () => {
    const sec = Math.floor(Date.now() / 1000);
    const v1 = [
      "# memos.search.v1",
      "# toon|compact",
      "# f=i|scr|trc|sce|ts|tg|ct",
      `abc123ef|950|9|ui|${sec}|work|Old format line`,
    ].join("\n");
    const parsed = parseToonCompact(v1);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("mem_abc123ef"); // v1 legacy prefix restore
    expect(new Date(parsed[0].updatedAt).getTime()).toBe(sec * 1000);
    expect(parsed[0].tags).toEqual(["work"]);
  });
});
