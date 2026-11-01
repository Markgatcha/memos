/**
 * Meaning-preservation suite for `compressText` (audit finding 1).
 *
 * The original `AGGRESSIVE_DROPS` set contained `not`, `never`, `no`,
 * `only`, `all`, `some`, `must`, `may`, `might`, `can`, `could`,
 * `should`, `would`, `will`, `do`, `does`, `did`, `have`, `has`, `had`.
 * Dropping those inverts facts:
 *
 *   "This is the only migration that has not failed."
 *     → aggressive: "migration not failed"   (a scoped exception became a blanket failure)
 *   "Never store API keys. Do not log tokens."
 *     → aggressive: "not log tokens"          (the instruction itself was deleted)
 *   "Latency budget is 250ms, not 250s."
 *     → the contrast that IS the fact was degraded
 *
 * No test caught it — `__tests__/context-pack-compression.test.ts` only
 * asserts that text gets shorter, that separators don't glue, and that
 * code is untouched. This suite asserts the inverse property: every
 * negation, quantifier, modal, number and unit that carries meaning in
 * the input MUST survive `compressText` at BOTH levels.
 *
 * This is the repo's first semantic-preservation test. Treat any new
 * drop-set word added to `src/compression.ts` as a meaning-loss candidate
 * and extend this file when adding it.
 */

import { compressText } from "../src/compression";

/** Strip leading/trailing punctuation so "failed." matches "failed". */
function bare(w: string): string {
  return w.toLowerCase().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

/** Every token of the input, normalized, with punctuation stripped. */
function tokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(bare)
    .filter((t) => t.length > 0);
}

/**
 * Assert every listed phrase (word-wise, punctuation-insensitive)
 * survives compression at both levels. A phrase like "not 250s" fails
 * if `not` or `250s` is gone, or if they are no longer adjacent —
 * adjacency is what carries "250ms, not 250s".
 */
function expectPhrasesSurvive(
  input: string,
  phrases: string[],
  { adjacent = false } = {},
): void {
  for (const level of ["light", "aggressive"] as const) {
    const out = compressText(input, level);
    const outTokens = tokens(out);
    const label = `[${level}] "${input}" -> "${out}"`;

    for (const phrase of phrases) {
      const phraseTokens = tokens(phrase);
      const present = outTokens.filter((t) => phraseTokens.includes(t)).length;
      expect(present).toBe(phraseTokens.length);
      if (present !== phraseTokens.length) {
        throw new Error(`${label} lost token(s) from "${phrase}"`);
      }

      if (adjacent && phraseTokens.length > 1) {
        const idx = outTokens.findIndex((t) => t === phraseTokens[0]);
        const window = outTokens.slice(idx, idx + phraseTokens.length);
        expect(window, `${label} broke adjacency of "${phrase}"`).toEqual(
          phraseTokens,
        );
      }
    }
  }
}

describe("compressText preserves meaning — negation", () => {
  test("simple negation survives at both levels", () => {
    expectPhrasesSurvive("The build did not fail.", ["not", "fail"]);
  });

  test("'do not' survives — the old aggressive set dropped 'do'", () => {
    expectPhrasesSurvive("Do not log tokens in production.", [
      "not",
      "log",
      "tokens",
    ]);
  });

  test("'does not' survives", () => {
    expectPhrasesSurvive(
      "The user does not want to be emailed about deploys.",
      ["does", "not", "want", "emailed"],
    );
  });

  test("contraction 'don't' survives", () => {
    expectPhrasesSurvive("Don't rotate the deploy key automatically.", [
      "don't",
      "rotate",
      "deploy",
    ]);
  });

  test("'never' survives — the old aggressive set dropped it", () => {
    expectPhrasesSurvive("Never store API keys.", ["never", "store", "keys"]);
  });

  test("'no' as a quantifier survives", () => {
    expectPhrasesSurvive("No test may run against the production cluster.", [
      "no",
      "test",
      "may",
      "run",
    ]);
  });

  test("negated exception keeps its scope word ('only ... not failed')", () => {
    // The audit's worst case: losing `only` turned a scoped exception
    // into an unqualified failure claim.
    const input = "This is the only migration that has not failed.";
    expectPhrasesSurvive(input, ["only", "has", "not", "failed"]);
    const out = compressText(input, "aggressive");
    expect(out).toContain("only");
    expect(out).toContain("not failed");
  });

  test("'without' survives", () => {
    expectPhrasesSurvive("You cannot rotate keys without a backup.", [
      "without",
      "backup",
    ]);
  });

  test("negation survives inside multi-line text", () => {
    const text = "Never store API keys.\nDo not log tokens.";
    for (const level of ["light", "aggressive"] as const) {
      const out = compressText(text, level);
      expect(out.split("\n")).toHaveLength(2);
      expect(out).toContain("Never");
      expect(out).toContain("not");
    }
  });
});

describe("compressText preserves meaning — quantifiers", () => {
  test("'only' survives — it scopes the claim", () => {
    expectPhrasesSurvive("Only the runner can reach the internal registry.", [
      "only",
      "runner",
    ]);
  });

  test("'all' survives — universality is the fact", () => {
    expectPhrasesSurvive("All users must reset their tokens.", [
      "all",
      "users",
      "must",
    ]);
  });

  test("'some' survives — the existential half of the sentence", () => {
    expectPhrasesSurvive("Some tokens cannot be rotated automatically.", [
      "some",
      "tokens",
      "cannot",
    ]);
  });

  test("'both' survives", () => {
    expectPhrasesSurvive("Both the build and the tag are blocked.", [
      "both",
      "build",
      "tag",
    ]);
  });

  test("'each' survives", () => {
    expectPhrasesSurvive("Each deployment waits for the health check.", [
      "each",
      "deployment",
    ]);
  });

  test("'any' survives", () => {
    expectPhrasesSurvive("Any token without a scope is rejected.", [
      "any",
      "token",
    ]);
  });

  test("quantifier + negation combination survives", () => {
    expectPhrasesSurvive("All users must reset their tokens; some cannot.", [
      "all",
      "must",
      "some",
      "cannot",
    ]);
  });
});

describe("compressText preserves meaning — modals", () => {
  test("'must' survives — obligation vs possibility differ", () => {
    expectPhrasesSurvive("The deploy key must be rotated weekly.", [
      "must",
      "rotated",
    ]);
  });

  test("'should' survives — recommendation vs requirement", () => {
    expectPhrasesSurvive("The cache should be warmed before the release.", [
      "should",
      "warmed",
    ]);
  });

  test("'could' survives — a hypothesis is not a fact", () => {
    expectPhrasesSurvive("The retry loop could mask a real failure.", [
      "could",
      "mask",
    ]);
  });

  test("'may' / 'might' survive — uncertainty is the content", () => {
    expectPhrasesSurvive("The migration may fail on the hobby plan.", [
      "may",
      "fail",
    ]);
    expectPhrasesSurvive("A cold start might add 200ms of latency.", [
      "might",
      "add",
    ]);
  });

  test("'can' / 'cannot' survive", () => {
    expectPhrasesSurvive(
      "The runner can reach the cluster; the laptop cannot.",
      ["can", "cannot"],
    );
  });

  test("'will' / 'would' survive", () => {
    expectPhrasesSurvive("The build will fail without the token.", [
      "will",
      "fail",
    ]);
    expectPhrasesSurvive("A larger pool would cut the queue time.", [
      "would",
      "cut",
    ]);
  });

  test("auxiliary 'have' / 'has' / 'had' survive", () => {
    expectPhrasesSurvive("The migration has not failed yet.", [
      "has",
      "not",
      "failed",
    ]);
    expectPhrasesSurvive("The runner had already been drained.", [
      "had",
      "drained",
    ]);
  });

  test("auxiliary 'do' / 'does' / 'did' survive", () => {
    expectPhrasesSurvive("The retries did fix the flake.", ["did", "fix"]);
  });
});

describe("compressText preserves meaning — numbers and units", () => {
  test("a bare number survives", () => {
    expectPhrasesSurvive("Set the pool size to 20 connections.", [
      "20",
      "connections",
    ]);
  });

  test("a number with its unit survives", () => {
    expectPhrasesSurvive("The latency budget is 250ms.", ["250ms"]);
  });

  test("units survive: ms, s, %, $, MB, GB", () => {
    expectPhrasesSurvive("The query takes 250ms and costs $5.", [
      "250ms",
      "$5",
    ]);
    expectPhrasesSurvive("The cache holds 512MB of keys.", ["512mb"]);
  });

  test("a contrasting number pair survives with its negation and adjacency", () => {
    // The contrast IS the fact; breaking adjacency destroys it.
    expectPhrasesSurvive(
      "The latency budget is 250ms, not 250s.",
      ["not", "250s"],
      { adjacent: true },
    );
    expectPhrasesSurvive("The pool size is 20, not 10.", ["not", "10"], {
      adjacent: true,
    });
  });

  test("ordinals and dates survive", () => {
    expectPhrasesSurvive("The rollback happened on March 3rd.", [
      "march",
      "3rd",
    ]);
  });

  test("a number inside a negated sentence survives", () => {
    expectPhrasesSurvive("No build may take longer than 30 seconds.", [
      "no",
      "30",
      "seconds",
    ]);
  });
});

describe("compressText preserves meaning — structure and stability", () => {
  test("newlines and indentation are preserved", () => {
    const text =
      "Step one: never log tokens.\n    await run(target);\nStep two: do not skip the check.";
    const out = compressText(text, "aggressive");
    expect(out.split("\n")).toHaveLength(3);
    expect(out.split("\n")[1]).toBe("    await run(target);");
  });

  test("code-like lines pass through untouched", () => {
    const code = "const deploy = async (target) => {\n  await run(target);\n};";
    expect(compressText(code, "aggressive")).toBe(code);
  });

  test("empty and whitespace-only input is returned unchanged", () => {
    expect(compressText("", "aggressive")).toBe("");
    expect(compressText("   \n  ", "aggressive")).toBe("   \n  ");
  });

  test("compression is deterministic — identical output for identical input", () => {
    const input =
      "Never store API keys. Do not log tokens. The budget is 250ms, not 250s.";
    for (const level of ["light", "aggressive"] as const) {
      const a = compressText(input, level);
      const b = compressText(input, level);
      expect(a).toBe(b);
    }
  });

  test("polarity tokens survive a long multi-sentence paragraph", () => {
    const text =
      "The team must not deploy on Friday. Only the on-call engineer can " +
      "approve a rollback, and no rollback may happen without a snapshot. " +
      "The pool size is 20, not 10, and some tenants cannot be migrated yet. " +
      "Never rotate the deploy key automatically.";
    for (const level of ["light", "aggressive"] as const) {
      const out = compressText(text, level);
      for (const token of [
        "must",
        "not",
        "only",
        "can",
        "no",
        "may",
        "without",
        "20",
        "10",
        "some",
        "cannot",
        "never",
      ]) {
        const survives =
          tokens(out).includes(token) ||
          bare(out)
            .split(/[^A-Za-z0-9]+/)
            .includes(token);
        if (!survives) {
          throw new Error(`[${level}] "${token}" lost from: ${out}`);
        }
        expect(survives).toBe(true);
      }
    }
  });

  test("still compresses — the fix must not disable compression", () => {
    const prose =
      "The release of the alpha build was delayed by the flaky test suite, " +
      "and the team agreed that the retry on the runner should be the one " +
      "that runs before the tag is pushed. The team also really just " +
      "literally wants the deploy pipeline to be quite stable, and the " +
      "quite slow build actually stops everyone else from shipping.";
    const light = compressText(prose, "light");
    const aggressive = compressText(prose, "aggressive");
    expect(light.length).toBeLessThan(prose.length);
    expect(aggressive.length).toBeLessThan(light.length);
  });
});
