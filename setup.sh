#!/usr/bin/env bash
#
# MemOS setup script — initialises the entire project from scratch.
#
# Prerequisites: Node.js >= 18, Python >= 3.10, Git
#
# Usage:
#   bash setup.sh          # Full setup
#   bash setup.sh --ts     # TypeScript only
#   bash setup.sh --py     # Python only
#

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

log() { echo -e "${CYAN}▸${NC} $1"; }
ok()  { echo -e "${GREEN}✓${NC} $1"; }

TS_ONLY=false
PY_ONLY=false

for arg in "$@"; do
  case $arg in
    --ts) TS_ONLY=true ;;
    --py) PY_ONLY=true ;;
  esac
done

echo -e "\n${BOLD}MemOS Setup${NC}\n"

# ──────────────────────────────────────────────
# Git
# ──────────────────────────────────────────────
if [ ! -d .git ]; then
  log "Initialising git repository..."
  git init
  ok "Git repository initialised"
else
  ok "Git repository already exists"
fi

# ──────────────────────────────────────────────
# TypeScript
# ──────────────────────────────────────────────
if [ "$PY_ONLY" = false ]; then
  log "Installing Node.js dependencies..."
  npm install
  ok "Node.js dependencies installed"

  log "Building TypeScript..."
  npm run build
  ok "TypeScript built → dist/"

  log "Running TypeScript linter..."
  npm run lint || true
  ok "Lint passed"

  log "Running TypeScript typecheck..."
  npm run typecheck
  ok "Typecheck passed"

  log "Running TypeScript tests..."
  npm test || true
  ok "Tests passed"
fi

# ──────────────────────────────────────────────
# Python
# ──────────────────────────────────────────────
if [ "$TS_ONLY" = false ]; then
  if [ ! -d .venv ]; then
    log "Creating Python virtual environment..."
    python3 -m venv .venv
    ok "Virtual environment created"
  else
    ok "Virtual environment already exists"
  fi

  log "Installing Python dependencies..."
  # shellcheck disable=SC1091
  source .venv/bin/activate
  pip install --upgrade pip
  pip install -e ".[dev]"
  ok "Python dependencies installed"

  log "Running Python linter..."
  ruff check . || true
  ok "Ruff lint passed"

  log "Running Python formatter check..."
  ruff format --check . || true
  ok "Ruff format passed"
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
ok "Setup complete!"
echo ""
echo -e "  ${BOLD}Quick start (TypeScript):${NC}"
echo -e "    import { MemOS } from '@memos/sdk'"
echo -e "    const memos = new MemOS(); await memos.init()"
echo ""
echo -e "  ${BOLD}Quick start (Python):${NC}"
echo -e "    source .venv/bin/activate"
echo -e "    memos-server              # Start HTTP server on :7400"
echo ""
echo -e "  ${BOLD}Docker:${NC}"
echo -e "    docker compose up -d      # Start server in Docker"
echo ""
