"""
MemOS Python HTTP Server — FastAPI application entry point.

Provides a REST API to the MemOS memory layer, allowing Python
applications (and non-JS frameworks) to interact with MemOS
over HTTP. The server wraps a headless Node.js subprocess that
runs the TypeScript SDK.

Usage:
    python -m memos.server.main    # Default: localhost:7400
    MEMOS_PORT=8080 python -m memos.server.main
    memos-server backup            # Backup the database
    memos-server restore <path>    # Restore from backup
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .. import __version__
from .routes import router

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MEMOS_PORT = int(os.environ.get("MEMOS_PORT", 7400))
MEMOS_HOST = os.environ.get("MEMOS_HOST", "0.0.0.0")
MEMOS_DB_PATH = os.environ.get("MEMOS_DB_PATH", str(Path.home() / ".memos" / "memos.db"))
MEMOS_LOG_LEVEL = os.environ.get("MEMOS_LOG_LEVEL", "info").lower()

# better-sqlite3 is a native Node module, so it cannot ship inside the
# Python wheel — it is installed via npm on first server start when the
# bundled SDK copy is used (see _ensure_runtime_sdk below).
_BETTER_SQLITE3_SPEC = "better-sqlite3@^12.11.1"


# ---------------------------------------------------------------------------
# Node.js SDK resolution
# ---------------------------------------------------------------------------


def _find_node_binary() -> str:
    """Locate the Node.js binary on the system."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError(
            "Node.js not found. Install Node.js >= 18 to run the MemOS server.\n"
            "  https://nodejs.org/"
        )
    return node


def _native_binding_present(pkg_dir: Path) -> bool:
    """True if better-sqlite3's native binding was actually built/installed.

    A bare ``node_modules/better-sqlite3`` folder is not enough — if npm's
    install scripts were blocked, the folder exists but the ``.node`` binary
    is missing and ``require()`` crashes at runtime.
    """
    if (pkg_dir / "build" / "Release" / "better_sqlite3.node").is_file():
        return True
    # prebuild-install layout: prebuilds/<platform-arch>/*.node
    prebuilds = pkg_dir / "prebuilds"
    if prebuilds.is_dir():
        for sub in prebuilds.iterdir():
            if sub.is_dir() and any(sub.glob("*.node")):
                return True
    return False


def _better_sqlite3_in(node_modules: Path) -> bool:
    """True if better-sqlite3 sits in THIS node_modules with a native binding.

    Deliberately does not walk up the directory tree: ancestor node_modules
    (e.g. a stray one in the user's home directory) may hold a broken copy
    that Node would resolve and crash on.
    """
    pkg = node_modules / "better-sqlite3"
    return pkg.is_dir() and _native_binding_present(pkg)


def _ensure_runtime_sdk() -> Path:
    """Return a directory containing index.js plus a working better-sqlite3.

    Two layouts are supported:

    1. **Source checkout** — the compiled ``dist/`` sits below the repo's
       ``node_modules`` (from ``npm install``), so it is used directly.
    2. **pip-installed wheel** — the compiled SDK is bundled at
       ``memos/_js``. It is staged into ``~/.memos/runtime/js`` and
       better-sqlite3 is npm-installed there on first run (the native
       module cannot ship inside a wheel).
    """
    here = Path(__file__).resolve().parent  # memos/server/
    pkg_root = here.parent  # memos/
    repo_root = pkg_root.parent  # repository root (dev layout)

    # Layout 1: source checkout with a working repo-level better-sqlite3
    checkout_dist = repo_root / "dist"
    if (checkout_dist / "index.js").is_file() and _better_sqlite3_in(repo_root / "node_modules"):
        return checkout_dist

    # Layout 2: bundled wheel SDK
    bundled = pkg_root / "_js"
    if not (bundled / "index.js").is_file():
        raise RuntimeError(
            "MemOS TypeScript SDK not found. Build it first:\n"
            "  npm install && npm run build\n"
            "(looked for dist/index.js in the source checkout and the bundled copy)"
        )

    # Stage the bundled SDK into a writable runtime directory. A version
    # marker keeps the staged copy in sync across package upgrades.
    runtime = Path(
        os.environ.get("MEMOS_RUNTIME_DIR", str(Path.home() / ".memos" / "runtime" / "js"))
    )
    marker = runtime / ".memos-sdk-version"
    needs_copy = (
        not marker.is_file()
        or marker.read_text(encoding="utf-8").strip() != __version__
        or not (runtime / "index.js").is_file()
    )
    if needs_copy:
        runtime.mkdir(parents=True, exist_ok=True)
        for item in bundled.iterdir():
            if item.name == "node_modules":
                continue
            dest = runtime / item.name
            if item.is_dir():
                if dest.exists():
                    shutil.rmtree(dest)
                shutil.copytree(item, dest)
            else:
                shutil.copy2(item, dest)
        marker.write_text(__version__, encoding="utf-8")

    if not _better_sqlite3_in(runtime / "node_modules"):
        npm = shutil.which("npm")
        if npm is None:
            raise RuntimeError(
                "better-sqlite3 is missing and npm was not found to install it.\n"
                f"  Run manually: cd {runtime} && npm install {_BETTER_SQLITE3_SPEC}"
            )
        # npm 11+ gates install scripts behind package.json "allowScripts".
        # Without this, better-sqlite3's prebuild-install step is blocked
        # and the native binding never lands. "type": "module" also keeps
        # Node from reparsing the ESM bridge files.
        runtime_pkg = runtime / "package.json"
        if not runtime_pkg.exists():
            runtime_pkg.write_text(
                json.dumps(
                    {
                        "name": "memos-runtime",
                        "private": True,
                        "type": "module",
                        "allowScripts": {"better-sqlite3": True},
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
        print(f"  First run: installing {_BETTER_SQLITE3_SPEC} into {runtime} ...")
        subprocess.run(
            [npm, "install", "--no-audit", "--no-fund", _BETTER_SQLITE3_SPEC],
            cwd=str(runtime),
            check=True,
        )
    return runtime


def _start_node_server() -> subprocess.Popen:
    """Start the Node.js MemOS server as a subprocess."""
    sdk_dir = _ensure_runtime_sdk()
    bridge_script = sdk_dir / "_bridge.mjs"

    # Write bridge script if it doesn't exist
    if not bridge_script.exists():
        bridge_script.write_text(_BRIDGE_SCRIPT, encoding="utf-8")

    node_bin = _find_node_binary()
    proc = subprocess.Popen(
        [node_bin, str(bridge_script), MEMOS_DB_PATH],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return proc


# ---------------------------------------------------------------------------
# Lifespan — start/stop Node.js subprocess
# ---------------------------------------------------------------------------

_node_process: subprocess.Popen | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan — manage the Node.js subprocess."""
    global _node_process
    _node_process = _start_node_server()
    yield
    if _node_process:
        _node_process.terminate()
        try:
            _node_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _node_process.kill()


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

app = FastAPI(
    title="MemOS",
    description="Universal memory layer for AI agents — REST API",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/mem")


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok", "service": "memos", "version": __version__}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _safe_cli_path(path: str) -> str:
    """Resolve a CLI file path and require it to stay under the current
    working directory (blocks ../ and absolute-path escapes)."""
    resolved = os.path.realpath(path)
    base = os.path.realpath(os.getcwd())
    try:
        contained = os.path.commonpath([resolved, base]) == base
    except ValueError:
        # Different drives / unreachable roots on Windows
        contained = False
    if not contained:
        print(f"Error: Path must stay inside the working directory: {path}")
        sys.exit(1)
    return resolved


def _cli_backup(output: str | None = None) -> None:
    """CLI backup subcommand."""
    import json
    import sqlite3
    from datetime import datetime

    db_path = MEMOS_DB_PATH
    if not os.path.exists(db_path):
        print(f"Error: Database not found at {db_path}")
        sys.exit(1)

    timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    default_output = f"./memos-backup-{timestamp}.db"
    output_path = _safe_cli_path(output or default_output)

    shutil.copy2(db_path, output_path)

    # Get stats
    db_size = os.path.getsize(db_path)
    conn = sqlite3.connect(db_path)
    node_count = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    edge_count = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    conn.close()

    manifest = {
        "timestamp": datetime.now().isoformat(),
        "version": __version__,
        "nodeCount": node_count,
        "edgeCount": edge_count,
        "dbSizeBytes": db_size,
    }

    # Rebuild the manifest path from sanitized components; basename()
    # strips any directory the resolved path may still carry.
    manifest_path = _safe_cli_path(
        os.path.join(
            os.path.dirname(output_path),
            os.path.basename(output_path) + ".manifest.json",
        )
    )
    Path(manifest_path).write_text(json.dumps(manifest, indent=2))

    print(f"Backup created: {output_path}")
    print(f"  Nodes: {node_count}, Edges: {edge_count}")
    print(f"  DB size: {db_size / 1024:.1f} KB")
    print(f"  Manifest: {manifest_path}")


def _cli_restore(path: str) -> None:
    """CLI restore subcommand."""
    import json

    backup_path = _safe_cli_path(path)
    manifest_path = f"{backup_path}.manifest.json"

    if not os.path.exists(backup_path):
        print(f"Error: Backup file not found: {backup_path}")
        sys.exit(1)

    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
        print("Backup manifest:")
        print(f"  Timestamp: {manifest['timestamp']}")
        print(f"  Version: {manifest['version']}")
        print(f"  Nodes: {manifest['nodeCount']}, Edges: {manifest['edgeCount']}")

    db_path = MEMOS_DB_PATH
    db_dir = os.path.dirname(db_path)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)

    shutil.copy2(backup_path, db_path)

    # Report restored state
    import sqlite3

    conn = sqlite3.connect(db_path)
    node_count = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    edge_count = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    conn.close()

    print(f"\nRestored from: {backup_path}")
    print(f"  Nodes: {node_count}, Edges: {edge_count}")


def main():
    """Run the MemOS server with uvicorn, or handle CLI subcommands."""
    # Handle CLI subcommands
    if len(sys.argv) > 1:
        subcmd = sys.argv[1]
        if subcmd == "backup":
            output = None
            if "--output" in sys.argv:
                idx = sys.argv.index("--output")
                if idx + 1 < len(sys.argv):
                    output = sys.argv[idx + 1]
            _cli_backup(output)
            return
        elif subcmd == "restore":
            if len(sys.argv) < 3:
                print(
                    "Error: restore requires a path argument.\n  Usage: memos-server restore <path>"
                )
                sys.exit(1)
            _cli_restore(sys.argv[2])
            return

    import uvicorn

    print(f"  MemOS server starting on {MEMOS_HOST}:{MEMOS_PORT}")
    print(f"  Database: {MEMOS_DB_PATH}")
    print(f"  Docs: http://{MEMOS_HOST}:{MEMOS_PORT}/docs")

    uvicorn.run(
        "memos.server.main:app",
        host=MEMOS_HOST,
        port=MEMOS_PORT,
        log_level=MEMOS_LOG_LEVEL,
        reload=False,
    )


if __name__ == "__main__":
    main()


# ---------------------------------------------------------------------------
# Node.js bridge script (inline, written to disk on first run)
# ---------------------------------------------------------------------------

_BRIDGE_SCRIPT = r"""/**
 * Node.js bridge — reads JSON-RPC messages from stdin, executes
 * MemOS operations, and writes results to stdout.
 *
 * This allows the Python server to call the TypeScript SDK
 * without an HTTP round-trip.
 */

import { MemOS } from './index.js';

const dbPath = process.argv[2] || undefined;
const memos = new MemOS({ dbPath });
await memos.init();

const rl = (await import('readline')).createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    writeResponse({ error: 'Invalid JSON' });
    return;
  }

  const { id, method, params } = msg;

  try {
    let result;
    switch (method) {
      case 'store':
        result = await memos.store(params.content, params.opts || {});
        break;
      case 'retrieve':
        result = await memos.retrieve(params.id);
        break;
      case 'search':
        result = await memos.search(params.filter || params.query);
        break;
      case 'forget':
        result = await memos.forget(params.id);
        break;
      case 'summarize':
        result = await memos.summarize();
        break;
      case 'link':
        result = await memos.link(
          params.sourceId,
          params.targetId,
          params.relation,
          params.weight
        );
        break;
      case 'graph':
        result = await memos.getGraph();
        break;
      case 'neighbours':
        result = await memos.getNeighbours(params.nodeId);
        break;
      case 'edges':
        result = await memos.getEdges(params.nodeId);
        break;
      case 'count':
        result = memos.count;
        break;
      case 'setTTL':
        await memos.setTTL(params.id, params.seconds);
        result = true;
        break;
      case 'clearTTL':
        await memos.clearTTL(params.id);
        result = true;
        break;
      case 'tag':
        await memos.tag(params.id, params.tags);
        result = true;
        break;
      case 'untag':
        await memos.untag(params.id, params.tags);
        result = true;
        break;
      case 'listByTag':
        result = await memos.listByTag(params.tag);
        break;
      case 'export':
        result = await memos.export(params.opts || {});
        break;
      case 'semanticSearch':
        result = await memos.semanticSearch(params.query, params.limit, params.threshold);
        break;
      case 'graphViz':
        result = await memos.graphViz();
        break;
      case 'listNamespaces':
        result = await memos.listNamespaces();
        break;
      case 'namespaceCount':
        result = await memos.namespaceCount(params.namespace);
        break;
      case 'injectContext':
        result = await memos.injectContext(params.id, params.depth, params.maxChars);
        break;
      default:
        writeResponse({ id, error: `Unknown method: ${method}` });
        return;
    }
    writeResponse({ id, result });
  } catch (err) {
    writeResponse({ id, error: err.message || String(err) });
  }
});

function writeResponse(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
"""
