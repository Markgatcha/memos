/**
 * Tests for secret redaction before logging (CodeQL js/clear-text-logging
 * defense in depth).
 */

import { redactSecrets } from "../src/redact";

describe("redactSecrets", () => {
  test("redacts common secret assignments", () => {
    expect(redactSecrets("login failed: password=hunter2")).toBe(
      "login failed: password=[REDACTED]",
    );
    expect(redactSecrets("decrypt: --key supersecret")).toBe(
      "decrypt: --key [REDACTED]",
    );
    expect(redactSecrets("bad token: abc123")).toBe("bad token: [REDACTED]");
    expect(redactSecrets("env MEMOS_KEY=topsecretvalue")).toBe(
      "env MEMOS_KEY=[REDACTED]",
    );
    expect(redactSecrets("api-key: deadbeefcafe")).toBe("api-key: [REDACTED]");
  });

  test("redacts long opaque tokens but keeps UUIDs", () => {
    const rawKey = "a".repeat(64);
    expect(redactSecrets(`key material ${rawKey} leaked`)).toBe(
      "key material [REDACTED] leaked",
    );
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(redactSecrets(`memory ${uuid} not found`)).toBe(
      `memory ${uuid} not found`,
    );
  });

  test("leaves ordinary messages untouched", () => {
    const msg = "Fatal: Database not found at /home/mark/.memos/memos.db";
    expect(redactSecrets(msg)).toBe(msg);
    expect(redactSecrets("")).toBe("");
    // words merely containing "key" must not trigger redaction
    expect(redactSecrets("monkey business as usual")).toBe(
      "monkey business as usual",
    );
    // prose with a bare keyword and no separator stays readable
    expect(redactSecrets("raw key must be 32 bytes")).toBe(
      "raw key must be 32 bytes",
    );
  });
});
