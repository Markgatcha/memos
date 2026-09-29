#!/usr/bin/env bash
# Native-addon smoke test for better-sqlite3 across distro images.
# The distro's package manager must have already installed node/npm/pnpm/python/make/g++
# before this runs (the docker command does that via matrix.bootstrap).
#
# Strategy:
#   - `pnpm install` installs deps. pnpm blocks install scripts by default
#     (onlyBuiltDependencies), so better-sqlite3's native binary may be
#     missing. We then compile it directly with node-gyp. Only do this when
#     the binary is absent, so we never rebuild a working binary with an
#     unrelated node-gyp version.
#   - Pin node-gyp to an exact version: node-gyp@13's undici crashes on Node 20
#     (Debian/Ubuntu/Rocky), so @10 is the safe cross-version choice; pinning
#     exact avoids floating @10 patch drift.
#   - We do NOT run `tsc`/`pnpm build` here: that is the TypeScript dev
#     toolchain, covered by the TypeScript CI job on pinned Node LTS lines.
#     Some distro Node versions (e.g. Rocky's older Node) can't load the
#     TypeScript 7 native bin, which is irrelevant to runtime distro support.
set -euxo pipefail

pnpm install --frozen-lockfile --prefer-offline

BINARY=node_modules/better-sqlite3/build/Release/better_sqlite3.node
if [ ! -f "$BINARY" ]; then
  ( cd node_modules/better-sqlite3 && pnpm dlx node-gyp@10.2.0 rebuild --release )
fi

pnpm test --runInBand --testPathPatterns=memos.test.ts
