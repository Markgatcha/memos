#!/usr/bin/env bash
# Native-addon smoke test for better-sqlite3 across distro images.
# The distro's package manager must have already installed node/npm/python/make/g++
# before this runs (the docker command does that via matrix.bootstrap).
#
# Why node-gyp is invoked directly (instead of relying on `npm ci`):
#   - better-sqlite3 ships no prebuilt for very new Node majors (e.g. Node 26,
#     which Arch pulls in).
#   - npm 12 (Arch) blocks native addon install scripts by default
#     (allow-scripts) and, when run as root, drops privileges for lifecycle
#     scripts -> EACCES on the build dir, so `npm ci` never builds it.
#   - Debian ships Node 20, where node-gyp@13's bundled undici crashes
#     (webidl.util.markAsUncloneable missing). node-gyp@10 is compatible with
#     both old (Node 20) and new (Node 26) majors.
# Running node-gyp directly as root (no npm privilege management) builds the
# native .node binary reliably on every distro.
set -euxo pipefail

npm ci --prefer-offline
cd node_modules/better-sqlite3 && npx --yes node-gyp@10 rebuild --release && cd /repo
npm run typecheck
npm test -- --runInBand --testPathPatterns=memos.test.ts
npm run build
