#!/usr/bin/env sh
# memos installer — no Node.js required.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Markgatcha/memos/main/scripts/install.sh | sh
#
# What it does:
#   1. Installs everything under $MEMOS_HOME (default: $HOME/.memos).
#   2. Uses your system Node >= 20 if one exists; otherwise downloads an
#      official Node.js LTS binary from nodejs.org (no sudo, no compiler).
#   3. Installs the latest @mem-os/sdk into $MEMOS_HOME/pkg via npm.
#   4. Symlinks $MEMOS_HOME/bin/memos and tells you how to put it on PATH.
#
# Env overrides:
#   MEMOS_HOME   install location (default $HOME/.memos)
#   MEMOS_NODE   "system" to force system node, or a path to a node binary
#   MEMOS_NPM_TAG  npm dist-tag / version of @mem-os/sdk (default: latest)

set -eu

MEMOS_HOME="${MEMOS_HOME:-$HOME/.memos}"
MEMOS_NPM_TAG="${MEMOS_NPM_TAG:-latest}"
NODE_MIN_MAJOR=20

log() { printf '%s\n' "memos-install: $*"; }
die() { printf '%s\n' "memos-install: ERROR: $*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

need_cmd uname
need_cmd curl
need_cmd tar

# --- platform ---------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Linux) NODE_OS=linux ;;
  Darwin) NODE_OS=darwin ;;
  *) die "unsupported OS: $OS (this script supports Linux and macOS)" ;;
esac
case "$ARCH" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  arm64|aarch64) NODE_ARCH=arm64 ;;
  *) die "unsupported architecture: $ARCH" ;;
esac
log "platform: $NODE_OS-$NODE_ARCH"

# --- node -------------------------------------------------------------------
node_ok() {
  # prints node major version if usable, else nothing
  _node="$1"
  if [ -x "$_node" ] || command -v "$_node" >/dev/null 2>&1; then
    _v="$("$_node" -v 2>/dev/null | sed 's/^v//;s/\..*//')"
    case "$_v" in ''|*[!0-9]*) return 1 ;; esac
    if [ "$_v" -ge "$NODE_MIN_MAJOR" ]; then
      printf '%s' "$_v"
      return 0
    fi
  fi
  return 1
}

NODE_BIN=""
# Find an npm we can run: prefer npm on PATH, else the npm bundled with
# a downloaded node, invoked explicitly through that node binary.
# (No function — inline to avoid sh function quirks on macOS.)
if [ "${MEMOS_NODE:-}" = "system" ]; then
  node_ok node >/dev/null || die "MEMOS_NODE=system but no usable node >= $NODE_MIN_MAJOR found"
  NODE_BIN="$(command -v node)"
elif [ -n "${MEMOS_NODE:-}" ]; then
  node_ok "$MEMOS_NODE" >/dev/null || die "MEMOS_NODE=$MEMOS_NODE is not a usable node >= $NODE_MIN_MAJOR"
  NODE_BIN="$MEMOS_NODE"
elif _v="$(node_ok node 2>/dev/null)"; then
  log "using system node (v$_v)"
  NODE_BIN="$(command -v node)"
fi

NODE_DIR="$MEMOS_HOME/node"
if [ -z "$NODE_BIN" ]; then
  if [ -x "$NODE_DIR/bin/node" ] && _v="$(node_ok "$NODE_DIR/bin/node" 2>/dev/null)"; then
    log "using previously downloaded node (v$_v)"
    NODE_BIN="$NODE_DIR/bin/node"
  else
    log "no usable system node found; downloading official Node.js LTS…"
    INDEX_JSON="$(curl -fsSL --retry 3 https://nodejs.org/dist/index.json)"
    # one JSON object per line; pick the newest with a string "lts" field
    NODE_VER="$(printf '%s\n' "$INDEX_JSON" | grep '"lts":"[A-Za-z]' | head -1 | sed 's/.*"version":"\(v[^"]*\)".*/\1/')"
    if [ -z "$NODE_VER" ]; then
      NODE_VER="$(printf '%s' "$INDEX_JSON" | python3 -c "import json,sys; ds=json.load(sys.stdin); print(next(x['version'] for x in ds if isinstance(x.get('lts'), str)))" 2>/dev/null || true)"
    fi
    [ -n "$NODE_VER" ] || die "could not determine latest Node.js LTS version"
    log "downloading node $NODE_VER…"
    TARBALL="node-$NODE_VER-$NODE_OS-$NODE_ARCH.tar.gz"
    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"
    curl -fsSL --retry 3 "https://nodejs.org/dist/$NODE_VER/$TARBALL" -o /tmp/memos-node.tgz
    # macOS quarantines curl downloads; a quarantined node binary refuses to
    # run. Strip the flag from the tarball and everything extracted from it.
    if [ "$NODE_OS" = "darwin" ]; then
      xattr -d com.apple.quarantine /tmp/memos-node.tgz 2>/dev/null || true
    fi
    tar -xzf /tmp/memos-node.tgz -C "$NODE_DIR" --strip-components=1
    rm -f /tmp/memos-node.tgz
    if [ "$NODE_OS" = "darwin" ]; then
      xattr -dr com.apple.quarantine "$NODE_DIR" 2>/dev/null || true
    fi
    NODE_BIN="$NODE_DIR/bin/node"
    _v="$(node_ok "$NODE_BIN")" || die "downloaded node is not usable"
    log "installed node v$_v under $NODE_DIR"
  fi
fi

# Find npm: prefer PATH, else the npm bundled next to the node binary.
if command -v npm >/dev/null 2>&1; then
  NPM_CMD="npm"
elif [ -n "$NODE_BIN" ] && [ -f "$NODE_DIR/lib/node_modules/npm/bin/npm-cli.js" ]; then
  NPM_CMD="$NODE_BIN $NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
else
  die "found node but no usable npm (not on PATH, not bundled with downloaded node)"
fi
log "node: $NODE_BIN"
log "npm: $NPM_CMD"

# --- install @mem-os/sdk -----------------------------------------------------
PKG_DIR="$MEMOS_HOME/pkg"
BIN_DIR="$MEMOS_HOME/bin"
log "installing @mem-os/sdk@$MEMOS_NPM_TAG into $PKG_DIR…"
mkdir -p "$PKG_DIR" "$BIN_DIR"
# shellcheck disable=SC2086 — $NPM_CMD may be "node /path/to/npm-cli.js"
$NPM_CMD install --prefix "$PKG_DIR" --no-audit --no-fund "@mem-os/sdk@$MEMOS_NPM_TAG"

MEMOS_BIN="$BIN_DIR/memos"
# npm normally links package binaries into node_modules/.bin, but don't
# depend on it — fall back to a direct wrapper if the link is missing
# (seen on macOS runners where npm skips .bin linking).
if [ -e "$PKG_DIR/node_modules/.bin/memos" ]; then
  ln -sf "$PKG_DIR/node_modules/.bin/memos" "$MEMOS_BIN"
elif [ -f "$PKG_DIR/node_modules/@mem-os/sdk/dist/cli.js" ]; then
  log "npm did not link .bin/memos; creating wrapper script instead"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$PKG_DIR/node_modules/@mem-os/sdk/dist/cli.js" > "$MEMOS_BIN"
  chmod +x "$MEMOS_BIN"
else
  die "npm install did not provide a memos binary (checked .bin/memos and @mem-os/sdk/dist/cli.js)"
fi

# --- verify ------------------------------------------------------------------
"$MEMOS_BIN" --help >/dev/null 2>&1 || die "install finished but 'memos --help' failed"
log "memos is installed and runnable"

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) log "$BIN_DIR is already on your PATH — you're done." ;;
  *)
    printf '\n'
    log "add memos to your PATH with one of:"
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\n' "$BIN_DIR"
    printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc\n' "$BIN_DIR"
    printf '  fish_add_path %s\n' "$BIN_DIR"
    printf '\n'
    ;;
esac
log "try it: memos init"
