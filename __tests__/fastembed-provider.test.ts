/**
 * Tests for FastEmbedEmbeddingProvider.
 *
 * The provider dynamically requires `@xenova/transformers` if it is
 * installed. When it isn't, it falls back to a deterministic local
 * feature-hash that runs anywhere with zero dependencies. Both modes
 * expose the same shape so swapping in the real model is a no-op
 * for downstream code.
 */

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Mode-agnostic __dirname: undefined under --experimental-vm-modules ESM.
const testDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

import {
  FastEmbedEmbeddingProvider,
  createEmbeddingProvider,
} from "../src/embeddings";

describe("FastEmbedEmbeddingProvider", () => {
  test("constructs with FastEmbed-style defaults", () => {
    const p = new FastEmbedEmbeddingProvider();
    expect(p.id).toBe("fastembed");
    expect(p.model).toBe("BAAI/bge-small-en-v1.5");
    expect(p.dimensions).toBe(384);
  });

  test("accepts a custom model and dimensions", () => {
    const p = new FastEmbedEmbeddingProvider({
      model: "BAAI/bge-base-en-v1.5",
      dimensions: 768,
    });
    expect(p.model).toBe("BAAI/bge-base-en-v1.5");
    expect(p.dimensions).toBe(768);
  });

  test("real pipeline: embed/batchEmbed are normalized, 384-d, deterministic", () => {
    // Spawned process: the onnxruntime backend builds tensors in Node's
    // own realm, and jest's VM realm has a different Float32Array
    // identity — the tensor constructor rejects them under jest.
    const dir = mkdtempSync(join(tmpdir(), "fastembed-test-"));
    const script = join(dir, "probe.mts");
    const srcPath = pathToFileURL(
      join(testDir, "..", "src", "embeddings.ts"),
    ).href;
    writeFileSync(
      script,
      [
        `import { FastEmbedEmbeddingProvider } from "${srcPath}";`,
        "const p = new FastEmbedEmbeddingProvider();",
        'const v = await p.embed("hello world");',
        'const a = await p.embed("dark mode preference");',
        'const b = await p.embed("dark mode preference");',
        'const vs = await p.batchEmbed(["first", "second", "third"]);',
        "const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));",
        "console.log(JSON.stringify({ dim: v.length, norm,",
        "  deterministic: JSON.stringify(a) === JSON.stringify(b),",
        "  batch: vs.length, batchDim: vs[0].length }));",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [join(testDir, "..", "node_modules", "tsx", "dist", "cli.mjs"), script],
      { encoding: "utf8", timeout: 120_000 },
    );

    rmSync(dir, { recursive: true, force: true });
    const line = result.stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .pop();
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string) as {
      dim: number;
      norm: number;
      deterministic: boolean;
      batch: number;
      batchDim: number;
    };
    expect(parsed.dim).toBe(384);
    expect(parsed.norm).toBeGreaterThan(0.99);
    expect(parsed.norm).toBeLessThan(1.01);
    expect(parsed.deterministic).toBe(true);
    expect(parsed.batch).toBe(3);
    expect(parsed.batchDim).toBe(384);
  }, 180_000);

  test("createEmbeddingProvider recognizes provider: 'fastembed'", () => {
    const p = createEmbeddingProvider({ provider: "fastembed" });
    expect(p.id).toBe("fastembed");
  });
});
