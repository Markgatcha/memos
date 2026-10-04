import { extractTriples, triplesMatch } from "../src/triple-extraction.js";

describe("extractTriples", () => {
  it("extracts 'X is Y' triples", () => {
    const triples = extractTriples("The user is a software engineer.");
    expect(triples.length).toBeGreaterThan(0);
    expect(triples[0]).toMatchObject({
      predicate: "is",
    });
  });

  it("extracts 'X has Y' triples", () => {
    const triples = extractTriples("Alice has a red bicycle.");
    expect(triples.some((t) => t.predicate === "has")).toBe(true);
  });

  it("extracts preference triples", () => {
    const triples = extractTriples("Bob prefers dark mode.");
    expect(triples.some((t) => t.predicate === "prefers")).toBe(true);
  });

  it("returns empty for short text", () => {
    expect(extractTriples("hi")).toEqual([]);
    expect(extractTriples("")).toEqual([]);
  });

  it("caps at 10 triples", () => {
    const text = Array(20)
      .fill("Alice is an engineer.")
      .join(" ");
    expect(extractTriples(text).length).toBeLessThanOrEqual(10);
  });
});

describe("triplesMatch", () => {
  it("matches on subject+predicate", () => {
    const q = [{ subject: "user", predicate: "prefers", object: "dark mode" }];
    const s = [{ subject: "user", predicate: "prefers", object: "light mode" }];
    expect(triplesMatch(q, s)).toBe(true);
  });

  it("does not match different subjects", () => {
    const q = [{ subject: "alice", predicate: "is", object: "engineer" }];
    const s = [{ subject: "bob", predicate: "is", object: "engineer" }];
    expect(triplesMatch(q, s)).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(triplesMatch([], [])).toBe(false);
  });
});
