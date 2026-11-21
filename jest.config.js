/** @type {import('@jest/types').Config.InitialOptions} */
export default {
  transform: {
    "^.+\\.tsx?$": [
      "@swc/jest",
      {
        // swc is TS-version-agnostic (works with TypeScript 7+), unlike
        // ts-jest@29 which peer-depends on typescript <7 and crashes loading
        // the tsconfig. Type-checking is still enforced by `tsc --noEmit`
        // / `npm run build` in CI, so swc only needs to transpile to JS.
        jsc: {
          parser: {
            syntax: "typescript",
          },
          target: "es2022",
        },
        // Emit ESM to match the tsconfig (NodeNext) + extensionsToTreatAsEsm.
        module: {
          type: "es6",
        },
        sourceMaps: true,
      },
    ],
  },
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  // V8 coverage instead of the default babel/istanbul instrumentation.
  // The babel provider instruments every transformed file and made the
  // coverage run ~8x slower than the plain suite (measured locally:
  // 8.5 s -> 66.6 s for 95 suites; ~16 s -> ~97 s on CI's 4-core runner).
  // V8 coverage rides on Node's built-in profiler: 10.5 s locally, and it
  // still emits the same lcov.info artifact.
  coverageProvider: "v8",
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
