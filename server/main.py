"""
MemOS Python HTTP Server — FastAPI application entry point.

Provides a REST API to the MemOS memory layer, allowing Python
applications (and non-JS frameworks) to interact with MemOS
over HTTP. The server wraps a headless Node.js subprocess that
runs the TypeScript SDK.

Usage:
    python -m server.main            # Default: localhost:7400
    MEMOS_PORT=8080 python -m server.main
"""

from __future__ import annotations

import os
import signal
import sys
import json
import subprocess
import shutil
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .routes import router


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MEMOS_PORT = int(os.environ.get("MEMOS_PORT", 7400))
MEMOS_HOST = os.environ.get("MEMOS_HOST", "0.0.0.0")
MEMOS_DB_PATH = os.environ.get(
    "MEMOS_DB_PATH", str(Path.home() / ".memos" / "memos.db")
)
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
    version="0.1.0",
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
    return {"status": "ok", "service": "memos"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    """Run the MemOS server with uvicorn."""
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
