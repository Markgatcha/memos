import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MemOSError,
  asMemOSError,
  classifyError,
  errorPayload,
  explainErrorCode,
  formatErrorCard,
  formatErrorExplainer,
  listErrorExplainers,
  normalizeErrorCode,
  readLatestCrashReport,
  writeCrashReport,
} from "../src/errors";
import { CLI_COMMANDS, getCommandHelp } from "../src/cli-help";

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
    expect(card).toContain("what probably went wrong:");
    expect(card).toContain("what to do:");
    expect(card).toContain("dbPath: /tmp/x.db");
    expect(card).toContain("MEMOS_DEBUG=1");
    expect(card).not.toContain("    at ");
  });

  test("errorPayload carries the explainer alongside the hint", () => {
    const payload = errorPayload(
      new MemOSError("locked", { code: "MEMOS_DB_LOCKED" }),
    ) as { error: Record<string, unknown> };
    expect(payload.error["explanation"]).toContain("lock");
    expect(payload.error["hint"]).toContain("Another MemOS process");
  });

  test("classifies bridge failures to bridge codes", () => {
    expect(classifyError("MemOS bridge process not running.")).toBe(
      "MEMOS_BRIDGE_UNAVAILABLE",
    );
    expect(classifyError("No response from MemOS bridge.")).toBe(
      "MEMOS_BRIDGE_CRASHED",
    );
  });

  test("every error code has a complete explainer", () => {
    const explainers = listErrorExplainers();
    // 19 codes today; keep this loose so adding a code does not fail the test,
    // but every code must always be explainable.
    expect(explainers.length).toBeGreaterThanOrEqual(19);
    for (const explainer of explainers) {
      expect(explainer.summary.length).toBeGreaterThan(0);
      expect(explainer.explanation.length).toBeGreaterThan(20);
      expect(explainer.likelyCauses.length).toBeGreaterThanOrEqual(2);
      expect(explainer.hint.length).toBeGreaterThan(0);
      expect(explainer.docsUrl).toContain("troubleshooting.md");
    }
  });

  test("normalized code spellings resolve to the same explainer", () => {
    for (const input of [
      "MEMOS_DB_LOCKED",
      "db_locked",
      "memos-db-locked",
      "  Db-Locked ",
    ]) {
      expect(explainErrorCode(input)?.code).toBe("MEMOS_DB_LOCKED");
      expect(normalizeErrorCode(input)).toBe("MEMOS_DB_LOCKED");
    }
    expect(explainErrorCode("NOT_A_CODE")).toBeNull();
    expect(normalizeErrorCode("")).toBeNull();
  });

  test("formatErrorExplainer prints causes and the fix", () => {
    const card = formatErrorExplainer(
      explainErrorCode("MEMOS_BRIDGE_CRASHED")!,
    );
    expect(card).toContain("MEMOS_BRIDGE_CRASHED");
    expect(card).toContain("What probably went wrong:");
    expect(card).toContain("Likely causes");
    expect(card).toContain("What to do:");
  });

  test("explain-error docs entry exists in the CLI reference help", () => {
    // The dispatch and the help listing must stay in sync; cli-help.ts is the
    // canonical list used by the docs coverage audit.
    expect(CLI_COMMANDS).toContain("explain-error");
    expect(getCommandHelp("explain-error")).toContain("explain-error");
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
