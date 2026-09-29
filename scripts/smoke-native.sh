#!/usr/bin/env bash
# Native-addon smoke test for better-sqlite3 across distro images.
# The distro's package manager must have already installed node/npm/pnpm/python/make/g++
# before this runs (the docker command does that via matrix.bootstrap).
#
# Strategy:
#   - `pnpm install` installs deps. pnpm blocks install scripts by default
#     (onlyBuiltDependencies), so better-sqlite3 is never compiled from
#     source here -- but v13 ships prebuilt binaries in prebuilds/, which
#     load with no build step. Verify the module actually loads; only fall
#     back to compiling with node-gyp when the require fails (exotic
#     platform with no matching prebuild).
#   - Pin node-gyp to an exact version: node-gyp@13's undici crashes on Node 20
#     (Debian/Ubuntu/Rocky), so @10 is the safe cross-version choice; pinning
#     exact avoids floating @10 patch drift.
#   - We do NOT run `tsc`/`pnpm build` here: that is the TypeScript dev
#     toolchain, covered by the TypeScript CI job on pinned Node LTS lines.
#     Some distro Node versions (e.g. Rocky's older Node) can't load the
#     TypeScript 7 native bin, which is irrelevant to runtime distro support.
set -euxo pipefail

pnpm install --frozen-lockfile --prefer-offline

# better-sqlite3 v13 loads its prebuilt binary from prebuilds/ with no
# compile step; only build from source when the module fails to load.
if ! node -e "require('better-sqlite3')"; then
  ( cd node_modules/better-sqlite3 && pnpm dlx node-gyp@10.2.0 rebuild --release )
fi

pnpm test --runInBand --testPathPatterns=memos.test.ts
