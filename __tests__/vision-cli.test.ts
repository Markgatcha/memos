/**
 * CLI `memos image` subcommand tests.
 *
 * These exercise the real argument-parsing and dispatch path (not just
 * the MemOS API), because that is where the `--vision` flag has to be
 * translated into config. The pattern: build argv, run the CLI's
 * dispatch against a temp DB, and assert on what it printed.
 *
 * Kept deliberately small — the behaviour itself is covered in
 * `vision-memory.test.ts`; what is under test HERE is that the flags,
 * the vision-disabled guidance, and the output shapes are wired.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** A real 1x1 PNG (valid IHDR, so dimensions parse). */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// The tests run as ESM (no `__dirname`), so derive the entry path from
// this module's own URL.
const CLI_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memos-cli-image-"));
  dbPath = join(dir, "cli.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

/** Run the CLI against a private DB, returning combined stdout+stderr. */
function cli(args: string[]): string {
  // `--db` is parsed from the post-command args, so it goes AFTER the
  // subcommand (passing it first reads as an unknown command).
  const fullArgs = [...args, "--db", dbPath];
  try {
    return execFileSync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...fullArgs],
      {
        encoding: "utf8",
        env: { ...process.env, MEMOS_VISION: "" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

/** Write the test PNG into the temp dir and return its path. */
function writeImage(): string {
  const p = join(dir, "diagram.png");
  writeFileSync(p, PNG_1X1);
  return p;
}

describe("memos image CLI", () => {
  test("explains how to enable vision instead of failing silently", () => {
    const out = cli(["image", "list"]);
    expect(out).toContain("image memory is disabled");
    expect(out).toContain("--vision");
  });

  test("add stores the image and prints the ref and node id", () => {
    const out = cli([
      "image",
      "add",
      writeImage(),
      "--caption",
      "deploy topology with a retry loop",
      "--kind",
      "diagram",
      "--vision",
    ]);
    expect(out).toMatch(/Image stored: img_[a-f0-9]{12}/);
    expect(out).toContain("Node:");
    expect(out).toContain("diagram");
    expect(out).toContain("1x1");
  });

  test("list shows the stored image", () => {
    cli([
      "image",
      "add",
      writeImage(),
      "--caption",
      "cli listed image",
      "--vision",
    ]);
    const out = cli(["image", "list", "--vision"]);
    expect(out).toContain("1 image(s)");
    expect(out).toContain("cli listed image");
  });

  test("search finds it by caption text", () => {
    cli([
      "image",
      "add",
      writeImage(),
      "--caption",
      "cli searchable caption",
      "--vision",
    ]);
    const out = cli(["image", "search", "searchable caption", "--vision"]);
    expect(out).toMatch(/Found 1 image/);
    expect(out).toContain("cli searchable caption");
  });

  test("re-adding identical bytes reports the dedupe instead of duplicating", () => {
    cli([
      "image",
      "add",
      writeImage(),
      "--caption",
      "dedupe probe",
      "--vision",
    ]);
    const out = cli([
      "image",
      "add",
      writeImage(),
      "--caption",
      "dedupe probe",
      "--vision",
    ]);
    expect(out).toContain("already stored");
    // Still exactly one node.
    expect(cli(["image", "list", "--vision"])).toContain("1 image(s)");
  });

  test("show resolves the ref and --out writes the bytes", () => {
    cli([
      "image",
      "add",
      writeImage(),
      "--caption",
      "resolvable via cli",
      "--vision",
    ]);
    const listed = cli(["image", "list", "--vision", "--json"]);
    const ref = listed.match(/"ref":\s*"([^"]+)"/)?.[1];
    expect(ref).toBeDefined();

    const shown = cli(["image", "show", ref!, "--vision"]);
    expect(shown).toContain(ref!);
    expect(shown).toContain("image/png");

    const outPath = join(dir, "restored.png");
    const wrote = cli(["image", "show", ref!, "--out", outPath, "--vision"]);
    expect(wrote).toContain("Wrote");
  });

  test("purge reports when there is nothing to clean", () => {
    const out = cli(["image", "purge", "--vision"]);
    expect(out).toContain("No orphaned image blobs");
  });

  test("an unknown subcommand prints usage rather than crashing", () => {
    const out = cli(["image", "frobnicate", "--vision"]);
    expect(out).toContain("image subcommand is required");
    expect(out).toContain("Usage:");
  });

  test("MEMOS_VISION=1 enables vision without the flag", () => {
    // Same as the other cases but with the env var set — this is the
    // scripting path (CI, .memos.json alternatives).
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        CLI_ENTRY,
        "image",
        "add",
        writeImage(),
        "--caption",
        "env enabled",
        "--db",
        dbPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, MEMOS_VISION: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
    expect(out).toMatch(/Image stored: img_/);
  });
});
