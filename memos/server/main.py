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

import contextlib
import hmac
import json
import os
import shutil
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .. import __version__
from .routes import router

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MEMOS_PORT = int(os.environ.get("MEMOS_PORT", 7400))
MEMOS_HOST = os.environ.get("MEMOS_HOST", "127.0.0.1")
MEMOS_DB_PATH = os.environ.get("MEMOS_DB_PATH", str(Path.home() / ".memos" / "memos.db"))
MEMOS_LOG_LEVEL = os.environ.get("MEMOS_LOG_LEVEL", "info").lower()

# better-sqlite3 is a native Node module, so it cannot ship inside the
# Python wheel — it is installed via npm on first server start when the
# bundled SDK copy is used (see _ensure_runtime_sdk below).
_BETTER_SQLITE3_SPEC = "better-sqlite3@^12.11.1"
# The SDK's default embedding provider is Model2Vec; the wheel does not ship
# node_modules, so stage the pure-JS model package next to better-sqlite3.
_POTION_SPEC = "@yarflam/potion-base-8m@1.0.4"
# Optional ANN extension. Installed best-effort; without it the bridge
# degrades to exact search even if MEMOS_SEMANTIC_SCAN=ann.
_SQLITE_VEC_SPEC = "sqlite-vec@0.1.9"


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
        # Newer better-sqlite3 releases put platform binaries directly under
        # prebuilds/ (win32-x64.node); older releases used per-platform
        # subdirectories. Support both.
        if any(prebuilds.glob("*.node")):
            return True
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


def _potion_in(node_modules: Path) -> bool:
    """True if the default Model2Vec embedding package is staged."""
    return (node_modules / "@yarflam" / "potion-base-8m" / "package.json").is_file()


def _runtime_deps_present(node_modules: Path) -> bool:
    return _better_sqlite3_in(node_modules) and _potion_in(node_modules)


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
    if (checkout_dist / "index.js").is_file() and _runtime_deps_present(repo_root / "node_modules"):
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

    if not _runtime_deps_present(runtime / "node_modules"):
        npm = shutil.which("npm")
        if npm is None:
            raise RuntimeError(
                "MemOS runtime dependencies are missing and npm was not found.\n"
                f"  Run manually: cd {runtime} && npm install "
                f"{_BETTER_SQLITE3_SPEC} {_POTION_SPEC}"
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
        print(
            f"  First run: installing {_BETTER_SQLITE3_SPEC} and {_POTION_SPEC} into {runtime} ..."
        )
        subprocess.run(
            [
                npm,
                "install",
                "--no-audit",
                "--no-fund",
                _BETTER_SQLITE3_SPEC,
                _POTION_SPEC,
            ],
            cwd=str(runtime),
            check=True,
        )
        # Optional: ANN on platforms with a sqlite-vec prebuilt. Failure must
        # not break the core install; the bridge falls back to exact scan.
        with contextlib.suppress(OSError):
            subprocess.run(
                [
                    npm,
                    "install",
                    "--no-audit",
                    "--no-fund",
                    _SQLITE_VEC_SPEC,
                ],
                cwd=str(runtime),
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    return runtime


def _start_node_server() -> subprocess.Popen:
    """Start the Node.js MemOS server as a subprocess."""
    sdk_dir = _ensure_runtime_sdk()
    bridge_script = sdk_dir / "_bridge.mjs"

    # Always rewrite the bridge script: it is versioned with the Python
    # package, and a stale _bridge.mjs silently lacks newly added methods.
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

PUBLIC_PATHS = {"/health", "/docs", "/redoc", "/openapi.json"}

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "localhost.localdomain"}


def _resolve_cors_origins() -> list[str]:
    """Browser origins allowed to call the API.

    Default is no cross-origin access. Swagger UI is same-origin and does
    not need CORS. Set MEMOS_CORS_ORIGINS to a comma-separated allowlist
    when a local frontend on another port needs to call the API.
    """
    raw = os.environ.get("MEMOS_CORS_ORIGINS", "")
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def _is_loopback_host(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    return normalized in LOOPBACK_HOSTS


def _validate_bind_security(host: str, api_key: str) -> None:
    """Refuse an unauthenticated memory API on a network interface.

    The default bind is 127.0.0.1, where the OS user boundary is the
    protection. A non-loopback bind exposes ingest, search, and delete to
    the network, so it must carry a bearer key.
    """
    if _is_loopback_host(host):
        return
    if not api_key.strip():
        raise RuntimeError(
            "Refusing to bind MemOS to a non-loopback host without "
            "MEMOS_API_KEY. Set MEMOS_API_KEY, or bind 127.0.0.1."
        )


def _is_authorized(path: str, authorization: str) -> bool:
    """Bearer check used by the HTTP middleware (unit-testable)."""
    expected = os.environ.get("MEMOS_API_KEY", "").strip()
    if not expected or path in PUBLIC_PATHS:
        return True
    return hmac.compare_digest(authorization, f"Bearer {expected}")


@app.middleware("http")
async def require_api_key(request, call_next):
    """Bearer auth when MEMOS_API_KEY is set.

    The server reads local files for /api/mem/ingest, so leaving it open on a
    network interface would expose the filesystem. Health and the generated
    docs stay public so probes and the Swagger UI keep working.
    """
    if not _is_authorized(request.url.path, request.headers.get("authorization", "")):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
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
    # Explicit UTF-8: from Python 3.15 the locale default is UTF-8 (PEP 686),
    # but pinning it keeps the write/read pair identical on 3.11–3.14 too.
    Path(manifest_path).write_text(json.dumps(manifest, indent=2), encoding="utf-8")

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
        with open(manifest_path, encoding="utf-8") as f:
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

    _validate_bind_security(MEMOS_HOST, os.environ.get("MEMOS_API_KEY", ""))

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
import { buildSelfEvalCases, runRetrievalEval } from './eval.js';
import { ingestPath } from './ingest.js';

const dbPath = process.argv[2] || undefined;

// Embedding configuration via MEMOS_EMBEDDING_* environment variables.
// Without MEMOS_EMBEDDING_PROVIDER the bridge uses the SDK default
// (Model2Vec, zero native dependencies).
const env = process.env;
const memosConfig = { dbPath };
if (env.MEMOS_SEMANTIC_SCAN) {
  memosConfig.storageOptions = { semanticScan: env.MEMOS_SEMANTIC_SCAN };
}
if (env.MEMOS_VISION === '1') {
  memosConfig.vision = {
    enabled: true,
    ...(env.MEMOS_VISION_CLIP === '1' ? { clip: { enabled: true } } : {}),
  };
}
if (env.MEMOS_EMBEDDING_PROVIDER) {
  const dimensions = env.MEMOS_EMBEDDING_DIMENSIONS;
  memosConfig.experimental = { semanticSearch: true };
  memosConfig.embeddings = {
    enabled: true,
    provider: env.MEMOS_EMBEDDING_PROVIDER,
    ...(env.MEMOS_EMBEDDING_MODEL ? { model: env.MEMOS_EMBEDDING_MODEL } : {}),
    ...(env.MEMOS_EMBEDDING_BASE_URL ? { baseUrl: env.MEMOS_EMBEDDING_BASE_URL } : {}),
    ...(env.MEMOS_EMBEDDING_API_KEY ? { apiKey: env.MEMOS_EMBEDDING_API_KEY } : {}),
    ...(dimensions ? { dimensions: parseInt(dimensions, 10) } : {}),
    ...(env.MEMOS_EMBEDDING_QUERY_PREFIX ? { queryPrefix: env.MEMOS_EMBEDDING_QUERY_PREFIX } : {}),
    ...(env.MEMOS_EMBEDDING_DOCUMENT_PREFIX ? { documentPrefix: env.MEMOS_EMBEDDING_DOCUMENT_PREFIX } : {}),
  };
  if (env.MEMOS_EMBEDDING_BATCH_SIZE) {
    memosConfig.embeddingQueue = {
      batchSize: parseInt(env.MEMOS_EMBEDDING_BATCH_SIZE, 10),
    };
  }
}

const memos = new MemOS(memosConfig);
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
      case 'forgetSource':
        result = await memos.forgetSource(params.source, {
          ...(params.field ? { field: params.field } : {}),
          ...(params.prefix ? { prefix: true } : {}),
          ...(params.namespace ? { namespace: params.namespace } : {}),
          ...(params.dryRun ? { dryRun: true } : {}),
        });
        break;
      case 'deletionStatus':
        result = await memos.deletionStatus(params.nodeId);
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
      case 'profile':
        result = await memos.profile(params || {});
        break;
      case 'overview':
        result = await memos.overview(params || {});
        break;
      case 'trigger':
        result = await memos.trigger(params || {});
        break;
      case 'brief':
        result = await memos.brief(params || {});
        break;
      case 'contextPack':
        result = await memos.contextPack(params || {});
        break;
      case 'handoff':
        result = await memos.handoff(params || {});
        break;
      case 'audit':
        result = await memos.auditReport(params || {});
        break;
      case 'eval': {
        const cases =
          Array.isArray(params.cases) && params.cases.length > 0
            ? params.cases
            : await buildSelfEvalCases(memos, {
                limit: params.limit,
                fromSessions: params.fromSessions,
                namespace: params.namespace,
              });
        result = cases.length === 0
          ? { cases: 0, hitAtK: 0, mrr: 0, avgLatencyMs: 0, avgTokens: 0, tokensPerHit: null, weakCases: [], results: [] }
          : await runRetrievalEval(memos, cases, {
              k: params.k,
              mode: Array.isArray(params.cases) && params.cases.length > 0 ? 'corpus' : 'self',
              namespace: params.namespace,
            });
        break;
      }
      case 'promote':
        result = await memos.promoteProcedures(params || {});
        break;
      case 'diagnostics':
        result = await memos.diagnostics();
        break;
      case 'embeddingHealth':
        result = await memos.probeEmbeddingHealth();
        break;
      case 'health':
        result = await memos.health();
        break;
      case 'usage':
        result = memos.usageStats();
        break;
      case 'ingest':
        result = await ingestPath(memos, params.path, {
          ...(params.namespace ? { namespace: params.namespace } : {}),
          ...(params.chunkChars ? { chunkChars: params.chunkChars } : {}),
          ...(Array.isArray(params.extensions) && params.extensions.length
            ? { extensions: params.extensions.map(String) }
            : {}),
        });
        break;
      case 'imageAdd':
        result = await memos.addImageMemory(params.input, params.opts || {});
        break;
      case 'imageSearch':
        result = await memos.searchImages(params.query, params.opts || {});
        break;
      case 'imageRecall': {
        const image = await memos.imageMemory(params.ref);
        result = image
          ? {
              data: image.buffer.toString('base64'),
              mime: image.mime,
              ref: image.ref,
            }
          : null;
        break;
      }
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
