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
  testMatch: ["**/__tests__/**/*.test.ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
