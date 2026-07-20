#!/usr/bin/env bash
# Native-addon smoke test for better-sqlite3 across distro images.
# The distro's package manager must have already installed node/npm/python/make/g++
# before this runs (the docker command does that via matrix.bootstrap).
#
# Strategy:
#   - `npm ci` installs deps. On npm <=9 distros (Debian/Ubuntu/Rocky/Fedora/
#     openSUSE) the better-sqlite3 install script runs and builds the native
#     binary natively -- nothing else needed.
#   - On npm 12 (Arch) native install scripts are blocked by default
#     (allow-scripts), so the binary is missing. We then compile it directly
#     with node-gyp (bypassing npm privilege management). Only do this when the
#     binary is absent, so we never rebuild a working binary with an unrelated
#     node-gyp version.
#   - Pin node-gyp to an exact version: node-gyp@13's undici crashes on Node 20
#     (Debian/Ubuntu/Rocky), so @10 is the safe cross-version choice; pinning
#     exact avoids floating @10 patch drift.
#   - We do NOT run `tsc`/`npm run build` here: that is the TypeScript dev
#     toolchain, covered by the TypeScript CI job on pinned Node LTS lines.
#     Some distro Node versions (e.g. Rocky's older Node) can't load the
#     TypeScript 7 native bin, which is irrelevant to runtime distro support.
set -euxo pipefail

npm ci --prefer-offline

BINARY=node_modules/better-sqlite3/build/Release/better_sqlite3.node
if [ ! -f "$BINARY" ]; then
  ( cd node_modules/better-sqlite3 && npx --yes node-gyp@10.2.0 rebuild --release )
fi

npm test -- --runInBand --testPathPatterns=memos.test.ts
