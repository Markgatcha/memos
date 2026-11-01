import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemOSError,
  asMemOSError,
  classifyError,
  formatErrorCard,
  readLatestCrashReport,
  writeCrashReport,
} from "../src/errors";

describe("structured errors", () => {
  test("classifies common SQLite/provider failures", () => {
    expect(classifyError("SQLITE_BUSY: database is locked")).toBe(
      "MEMOS_DB_LOCKED",
    );
    expect(
      classifyError("SQLITE_CORRUPT: database disk image is malformed"),
    ).toBe("MEMOS_DB_CORRUPT");
    expect(classifyError("401 Unauthorized: invalid api key")).toBe(
      "MEMOS_PROVIDER_AUTH",
    );
    expect(classifyError("429 rate limit exceeded")).toBe(
      "MEMOS_PROVIDER_RATE_LIMIT",
    );
    expect(classifyError("fetch timed out")).toBe("MEMOS_PROVIDER_TIMEOUT");
  });

  test("wraps a raw error with a code, hint, and context", () => {
    const error = asMemOSError(
      new Error("database is locked"),
      "MEMOS_DB_OPEN",
      {
        dbPath: "/tmp/memos.db",
      },
    );
    expect(error).toBeInstanceOf(MemOSError);
    expect(error.code).toBe("MEMOS_DB_LOCKED");
    expect(error.hint).toContain("Another MemOS process");
    expect(error.context.dbPath).toBe("/tmp/memos.db");
  });

  test("error cards are actionable and hide the stack by default", () => {
    const error = new MemOSError("could not open store", {
      code: "MEMOS_DB_OPEN",
      context: { dbPath: "/tmp/x.db" },
    });
    const card = formatErrorCard(error);
    expect(card).toContain("MemOS error [MEMOS_DB_OPEN]");
    expect(card).toContain("what to do:");
    expect(card).toContain("dbPath: /tmp/x.db");
    expect(card).toContain("MEMOS_DEBUG=1");
    expect(card).not.toContain("    at ");
  });

  test("crash reports are written redacted and can be read back", () => {
    const dir = mkdtempSync(join(tmpdir(), "memos-crash-"));
    const previous = process.env.MEMOS_CRASH_DIR;
    process.env.MEMOS_CRASH_DIR = dir;
    try {
      const error = new MemOSError("api_key=secret-value failed", {
        code: "MEMOS_PROVIDER_AUTH",
        context: { token: "secret-value" },
      });
      const path = writeCrashReport(error, { command: "search" });
      expect(path).not.toBeNull();
      const report = readLatestCrashReport();
      expect(report?.code).toBe("MEMOS_PROVIDER_AUTH");
      expect(JSON.stringify(report)).not.toContain("secret-value");
      expect(report?.command).toBe("search");
    } finally {
      if (previous === undefined) delete process.env.MEMOS_CRASH_DIR;
      else process.env.MEMOS_CRASH_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
