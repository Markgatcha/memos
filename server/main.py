"""
MemOS Python HTTP Server — FastAPI application entry point.

Provides a REST API to the MemOS memory layer, allowing Python
applications (and non-JS frameworks) to interact with MemOS
over HTTP. The server wraps a headless Node.js subprocess that
runs the TypeScript SDK.

Usage:
    python -m server.main            # Default: localhost:7400
    MEMOS_PORT=8080 python -m server.main
    memos-server backup              # Backup the database
    memos-server restore <path>      # Restore from backup
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routes import router

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MEMOS_PORT = int(os.environ.get("MEMOS_PORT", 7400))
MEMOS_HOST = os.environ.get("MEMOS_HOST", "0.0.0.0")
MEMOS_DB_PATH = os.environ.get("MEMOS_DB_PATH", str(Path.home() / ".memos" / "memos.db"))
MEMOS_LOG_LEVEL = os.environ.get("MEMOS_LOG_LEVEL", "info").lower()


# ---------------------------------------------------------------------------
# Lifespan — start/stop Node.js subprocess
# ---------------------------------------------------------------------------

_node_process: subprocess.Popen | None = None


def _find_node_binary() -> str:
    """Locate the Node.js binary on the system."""
    node = shutil.which("node")
    if node is None:
        raise RuntimeError(
            "Node.js not found. Install Node.js >= 18 to run the MemOS server.\n"
            "  https://nodejs.org/"
        )
    return node


def _start_node_server() -> subprocess.Popen:
    """Start the Node.js MemOS server as a subprocess."""
    sdk_dir = Path(__file__).resolve().parent.parent / "src"
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
    version="1.5.0-beta.1",
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
    return {"status": "ok", "service": "memos", "version": "1.5.0-beta.1"}


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
        "version": "1.5.0-beta.1",
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
        "server.main:app",
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
