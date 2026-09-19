#!/usr/bin/env python3
"""GPU embedding server for MemOS — OpenAI-compatible `/v1/embeddings`.

MemOS's built-in Node embedding pipeline (fastembed/ONNX) is CPU-only. When
you have a GPU (NVIDIA CUDA, or AMD via ROCm on Linux), serve the same model
weights from sentence-transformers on the GPU and point MemOS at this server
with the `openai-compatible` provider for much faster ingestion.

Requires: pip install torch sentence-transformers
  NVIDIA: the default torch wheel already includes CUDA support.
  AMD (Linux): install the ROCm torch build instead, e.g.
      pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm6.4
      pip install sentence-transformers
  (PyTorch's ROCm build exposes the same torch.cuda API, so device="cuda"
  below just works on AMD GPUs.)

Usage:
    python scripts/embed-server.py --model BAAI/bge-base-en-v1.5 --port 8081

    # then, in another terminal:
    MEMOS_EMBEDDING_PROVIDER=openai-compatible \\
    MEMOS_EMBEDDING_MODEL=BAAI/bge-base-en-v1.5 \\
    MEMOS_EMBEDDING_BASE_URL=http://127.0.0.1:8081/v1 \\
    MEMOS_EMBEDDING_DIMENSIONS=768 \\
    npx @mem-os/sdk store "remember this"

Or via the SDK config:
    new MemOS({
      embeddings: {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8081/v1",
        model: "BAAI/bge-base-en-v1.5",
        dimensions: 768,
      },
    })

The `model` you configure in MemOS must match the model this server loads:
MemOS only compares vectors produced by the same model.
"""

import argparse
import contextlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-base-en-v1.5")
DEFAULT_PORT = int(os.environ.get("EMBED_PORT", "8081"))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="OpenAI-compatible GPU embedding server for MemOS.")
    p.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"HuggingFace model id (default: {DEFAULT_MODEL})",
    )
    p.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Local port to listen on (default: {DEFAULT_PORT})",
    )
    p.add_argument(
        "--device",
        default=None,
        help="torch device: 'cuda' (covers NVIDIA CUDA and AMD ROCm), 'cpu', … "
        "(default: cuda when a GPU is available)",
    )
    p.add_argument(
        "--batch-size",
        type=int,
        default=64,
        help="sentence-transformers encode batch size (default: 64)",
    )
    p.add_argument(
        "--normalize",
        action="store_true",
        help="L2-normalize embeddings before returning them",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    try:
        import torch
    except ImportError:
        print(
            "error: torch is not installed. Run: pip install torch sentence-transformers",
            file=sys.stderr,
        )
        return 1
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print(
            "error: sentence-transformers is not installed. Run: pip install sentence-transformers",
            file=sys.stderr,
        )
        return 1

    # Backend detection: ROCm builds of torch expose the same torch.cuda API
    # (torch.version.hip is set), so device="cuda" works on AMD GPUs too.
    _ver = getattr(torch, "version", None)
    hip_version = getattr(_ver, "hip", None)
    cuda_version = getattr(_ver, "cuda", None)
    if hip_version and torch.cuda.is_available():
        backend = f"ROCm {hip_version}"
    elif cuda_version and torch.cuda.is_available():
        backend = f"CUDA {cuda_version}"
    else:
        backend = "CPU"

    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    if device.startswith("cuda") and not torch.cuda.is_available():
        print(
            "warning: --device=cuda but torch reports no GPU "
            f"(torch {torch.__version__}); falling back to cpu. "
            "AMD users need the ROCm torch build: pip install torch torchvision "
            "--index-url https://download.pytorch.org/whl/rocm6.4",
            file=sys.stderr,
        )
        device = "cpu"
        backend = "CPU"

    gpu_name = ""
    if device.startswith("cuda") and torch.cuda.is_available():
        with contextlib.suppress(Exception):
            gpu_name = f" ({torch.cuda.get_device_name(0)})"

    print(f"[embed-server] torch {torch.__version__} | backend: {backend}", flush=True)
    print(f"[embed-server] loading {args.model} on {device}{gpu_name} …", flush=True)
    model = SentenceTransformer(args.model, device=device)
    dims = model.get_sentence_embedding_dimension()
    print(
        f"[embed-server] ready: {args.model} ({dims}d) on http://127.0.0.1:{args.port}",
        flush=True,
    )

    batch_size = args.batch_size
    normalize = args.normalize
    served_model = args.model

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # noqa: ANN002, ANN202 — stdlib signature
            pass

        def _json(self, obj, code=200):  # noqa: ANN001, ANN202
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: ANN202
            if self.path == "/health":
                self._json({"status": "ok", "model": served_model})
            elif self.path == "/v1/models":
                self._json(
                    {
                        "object": "list",
                        "data": [{"id": served_model, "object": "model"}],
                    }
                )
            else:
                self._json({"error": "not found"}, 404)

        def do_POST(self):  # noqa: ANN202
            if self.path != "/v1/embeddings":
                self._json({"error": "not found"}, 404)
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                req = json.loads(self.rfile.read(length) or b"{}")
            except Exception:
                self._json({"error": "invalid JSON"}, 400)
                return
            inp = req.get("input", "")
            texts = [inp] if isinstance(inp, str) else list(inp)
            try:
                vecs = model.encode(
                    texts,
                    batch_size=batch_size,
                    show_progress_bar=False,
                    convert_to_numpy=True,
                    normalize_embeddings=normalize,
                )
            except Exception as exc:  # noqa: BLE001 — report, don't crash
                self._json({"error": f"encode failed: {exc}"}, 500)
                return
            self._json(
                {
                    "object": "list",
                    "model": req.get("model", served_model),
                    "data": [
                        {"object": "embedding", "index": i, "embedding": v.tolist()}
                        for i, v in enumerate(vecs)
                    ],
                    "usage": {"prompt_tokens": 0, "total_tokens": 0},
                }
            )

    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
