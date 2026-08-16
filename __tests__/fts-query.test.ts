/**
 * Tests for the FTS5 query builder (`buildFtsTerms` / `buildFtsQuery`).
 *
 * These guard the fix for the phrase-search bug: natural-language
 * queries must be tokenized into individually quoted terms (with
 * function-word removal) instead of being wrapped as a single phrase,
 * which silently matched nothing.
 */

import { buildFtsTerms, buildFtsQuery } from "../src/storage/sqlite";

describe("buildFtsTerms", () => {
  test("splits a natural-language query into quoted terms", () => {
    expect(buildFtsTerms("dark mode")).toEqual(['"dark"', '"mode"']);
  });

  test("removes function words", () => {
    // "where", "does", "the", "in" are stopwords; "user" and "live" survive.
    expect(buildFtsTerms("where does the user live")).toEqual([
      '"user"',
      '"live"',
    ]);
  });

  test("lowercases terms", () => {
    expect(buildFtsTerms("Dark MODE")).toEqual(['"dark"', '"mode"']);
  });

  test("drops single-character tokens", () => {
    expect(buildFtsTerms("a b c dark")).toEqual(['"dark"']);
  });

  test("strips punctuation around words", () => {
    // Quotes and other non-alphanumerics are token boundaries, so
    // 'say "hello"' tokenizes to the bare words.
    expect(buildFtsTerms('say "hello"')).toEqual(['"say"', '"hello"']);
  });

  test("falls back to raw tokens when all words are stopwords", () => {
    // "what is it" is all stopwords — must not produce an empty query.
    expect(buildFtsTerms("what is it")).toEqual(['"what"', '"is"', '"it"']);
  });

  test("quotes punctuation-only input as a literal phrase", () => {
    expect(buildFtsTerms("!!!")).toEqual(['"!!!"']);
  });
});

describe("buildFtsQuery", () => {
  test("joins terms with AND by default", () => {
    expect(buildFtsQuery("dark mode")).toBe('"dark" AND "mode"');
  });

  test("joins terms with OR when requested", () => {
    expect(buildFtsQuery("dark mode", " OR ")).toBe('"dark" OR "mode"');
  });

  test("single-term query is identical under AND and OR", () => {
    expect(buildFtsQuery("pixel")).toBe('"pixel"');
    expect(buildFtsQuery("pixel", " OR ")).toBe('"pixel"');
  });
});
