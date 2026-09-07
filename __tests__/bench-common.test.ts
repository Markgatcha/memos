/**
 * Unit tests for the shared benchmark infrastructure
 * (scripts/lib/bench-common.ts): provider arg parsing (CLI > env),
 * strict-mode fallback enforcement, dataset hashing, and FastEmbed
 * runtime-info exposure.
 */

import { jest } from "@jest/globals";
import {
  parseProviderArgs,
  buildProvider,
  assertNoFallback,
  hashFile,
  gitSha,
  benchMetadata,
} from "../scripts/lib/bench-common";
import { FastEmbedEmbeddingProvider } from "../src/embeddings";
import type { EmbeddingProvider, EmbeddingRuntimeInfo } from "../src/types";
import { writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("parseProviderArgs", () => {
  const ENV_KEYS = [
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_API_KEY",
    "VOYAGE_API_KEY",
    "COHERE_API_KEY",
  ] as const;

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test("defaults to local-hash with no flags and no env", () => {
    const args = parseProviderArgs([]);
    expect(args.provider).toBe("local-hash");
    expect(args.failOnEmbeddingFallback).toBe(false);
  });

  test("CLI --provider= wins over env var", () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    const args = parseProviderArgs(["--provider=fastembed"]);
    expect(args.provider).toBe("fastembed");
  });

  test("env var is used when no CLI flag", () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    const args = parseProviderArgs([]);
    expect(args.provider).toBe("ollama");
  });

  test("parses --model and --dimensions", () => {
    const args = parseProviderArgs([
      "--provider=fastembed",
      "--model=Xenova/gemma-300m-e5-it-v1",
      "--dimensions=768",
    ]);
    expect(args.model).toBe("Xenova/gemma-300m-e5-it-v1");
    expect(args.dimensions).toBe(768);
  });

  test("provider-specific API key envs are consulted", () => {
    process.env.VOYAGE_API_KEY = "pa-test";
    const args = parseProviderArgs(["--provider=voyage"]);
    expect(args.apiKey).toBe("pa-test");
  });

  test("strict mode flag", () => {
    expect(
      parseProviderArgs(["--fail-on-embedding-fallback"])
        .failOnEmbeddingFallback,
    ).toBe(true);
  });
});

describe("buildProvider", () => {
  test("local-hash builds", () => {
    const p = buildProvider(parseProviderArgs(["--provider=local-hash"]));
    expect(p.id).toBe("local-hash");
  });

  test("unknown provider throws (no silent substitution)", () => {
    expect(() =>
      buildProvider(parseProviderArgs(["--provider=does-not-exist"])),
    ).toThrow(/Unknown embedding provider/);
  });

  test("voyage without key throws", () => {
    expect(() =>
      buildProvider(parseProviderArgs(["--provider=voyage"])),
    ).toThrow(/voyage provider requires/);
  });
});

describe("assertNoFallback — strict benchmark mode", () => {
  test("fastembed with an unloadable model is detected as fallback", async () => {
    // A model name that cannot resolve forces `pipeline()` to throw, which
    // MUST surface as the local-hash fallback. This is the exact
    // silent-fallback the flag guards against. NOTE: no
    // --fail-on-embedding-fallback here — this test only verifies the
    // DETECTION (warn mode); termination is covered separately below.
    const provider = new FastEmbedEmbeddingProvider({
      model: "definitely-not-a-real-model-xyz",
    });
    const args = parseProviderArgs(["--provider=fastembed"]);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const info = await assertNoFallback(provider, args);
      expect(info.fallbackActive).toBe(true);
      expect(info.resolvedProvider).toBe("local-hash-fallback");
      expect(info.fallbackReason).toMatch(/pipeline construction failed/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("local-hash reports no fallback", async () => {
    const provider = buildProvider(
      parseProviderArgs(["--provider=local-hash"]),
    );
    const info = await assertNoFallback(
      provider,
      parseProviderArgs(["--provider=local-hash"]),
    );
    expect(info.fallbackActive).toBe(false);
    expect(info.resolvedProvider).toBe("local-hash");
  });

  test("providers without getRuntimeInfo get synthesized info", async () => {
    const provider: EmbeddingProvider = {
      id: "custom",
      model: "custom-model",
      dimensions: 8,
      embed: async () => [0.1, 0.2],
    };
    const info = await assertNoFallback(provider, {
      provider: "custom",
      failOnEmbeddingFallback: false,
    });
    expect(info.resolvedProvider).toBe("custom");
    expect(info.fallbackActive).toBe(false);
  });

  test("strict mode terminates the process on fallback (exit 1)", async () => {
    const provider = new FastEmbedEmbeddingProvider({
      model: "definitely-not-a-real-model-xyz",
    });
    const args = parseProviderArgs([
      "--provider=fastembed",
      "--fail-on-embedding-fallback",
    ]);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    let exitCode: number | null = null;
    try {
      await expect(
        assertNoFallback(provider, args, {
          exit: (code) => {
            exitCode = code;
            throw new Error(`injected-exit:${code}`);
          },
        }),
      ).rejects.toThrow("injected-exit:1");
      expect(exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("dataset hashing & metadata", () => {
  test("hashFile is a stable sha256", () => {
    const p = join(tmpdir(), `bench-hash-test-${Date.now()}.txt`);
    writeFileSync(p, "hello memos");
    try {
      const h1 = hashFile(p);
      const h2 = hashFile(p);
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      // sha256("hello memos")
      expect(h1).toBe(
        "4cf2225c005c59c9b8992e6e3ddaa8d553554bec20fb9ae9942347fcc4623c30",
      );
    } finally {
      rmSync(p);
    }
  });

  test("benchMetadata records git sha, node version, dataset path", () => {
    const provider = buildProvider(
      parseProviderArgs(["--provider=local-hash"]),
    );
    const runtime: EmbeddingRuntimeInfo = {
      requestedProvider: "local-hash",
      resolvedProvider: "local-hash",
      requestedModel: provider.model,
      resolvedModel: provider.model,
      modelRevision: null,
      requestedDimensions: provider.dimensions,
      observedDimensions: provider.dimensions,
      fallbackActive: false,
      fallbackReason: null,
    };
    const meta = benchMetadata(
      parseProviderArgs(["--provider=local-hash"]),
      runtime,
      { name: "synthetic", path: "nonexistent-file.json" },
    );
    expect(meta.schemaVersion).toBe(2);
    expect(meta.git.sha).toMatch(/^[0-9a-f]{40}$|unknown/);
    expect(meta.nodeVersion).toBe(process.version);
    expect(meta.dataset.sha256).toBe("file-not-found");
    expect(meta.embedding.providerKind).toBe("local-hash");
  });

  test("gitSha returns 40-hex or unknown", () => {
    expect(gitSha()).toMatch(/^[0-9a-f]{40}$|^unknown$/);
  });
});
