#!/usr/bin/env python3
"""
Mem0 vendor bridge for MemOS's same-protocol benchmark
(`scripts/bench-vendors.ts`).

Speaks one JSON object per line over stdin/stdout:

  ←  {"cmd": "init", "embedder": {...}, "vector_store": {...}, "history_db_path": "..."}
  →  {"ok": true, "version": "...", "embedder_used": {...}, "store_used": "..."}
  ←  {"cmd": "ingest", "user_id": "locomo_conv_0", "text": "Carrie: ...", "dia_ids": ["D1:3"]}
  →  {"ok": true, "id": "<mem0 uuid>"}
  ←  {"cmd": "search", "user_id": "locomo_conv_0", "query": "...", "limit": 10}
  →  {"ok": true, "ids": ["D1:3", "D1:5", ...]}
  ←  {"cmd": "close"}
  →  {"ok": true}

Design notes (why it looks like this):

- `infer=False` on every `add()`: the whole point of the harness is that
  ingestion is RAW for every engine — no LLM fact extraction on the
  vendor side, because MemOS's ingestion is deterministic and local.
  An LLM-extracting vendor would be measured on its extractor, not its
  retrieval.
- The dia_id map lives in a sidecar JSON next to the history DB, not in
  Mem0 metadata passthrough — search results across mem0 versions have
  inconsistent metadata shapes, and an ID mapping must never be a
  guess. If a result ID is missing from the sidecar the bridge reports
  it (never silently drops).
- Vector store defaults to chroma-local (persistent dir, no server);
  qdrant `path` mode is the fallback. Both keep the whole run on one
  machine — a comparison that needs a running Qdrant server is not a
  comparison, it is an infrastructure project.
- Any failure returns {"ok": false, "error": "..."} and the harness
  records the engine as skipped with that reason. A vendor that cannot
  boot must degrade the table, not crash the run.

Usage (normally spawned by bench-vendors.ts):
    python mem0_bridge.py --workdir /tmp/bench-vendors-mem0-1234
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import traceback


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class Sidecar:
    """mem0 result id -> LoCoMo dia_ids, persisted as JSON."""

    def __init__(self, path: str):
        self.path = path
        self.map: dict[str, list[str]] = {}
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    self.map = json.load(fh)
            except Exception:
                self.map = {}

    def put(self, mem_id: str, dia_ids: list[str]) -> None:
        self.map[mem_id] = list(dia_ids)

    def get(self, mem_id: str) -> list[str]:
        return self.map.get(mem_id, [])

    def save(self) -> None:
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.map, fh)
        os.replace(tmp, self.path)


class Mem0Bridge:
    def __init__(self, workdir: str):
        self.workdir = workdir
        os.makedirs(workdir, exist_ok=True)
        self.memory = None
        self.sidecar = Sidecar(os.path.join(workdir, "dia-map.json"))
        self.embedder_used: dict = {}
        self.store_used = ""

    # ── init ────────────────────────────────────────────────────────────
    def init(self, cfg: dict) -> dict:
        try:
            from mem0 import Memory  # type: ignore
        except Exception as exc:  # pragma: no cover - env dependent
            return {
                "ok": False,
                "error": (
                    f"mem0ai is not installed in this Python environment "
                    f"({exc.__class__.__name__}: {exc}). Install with "
                    f"`pip install mem0ai` — the vendor engine is skipped "
                    f"until then; the MemOS leg still runs."
                ),
            }

        embedder = cfg.get("embedder") or {
            "provider": "ollama",
            "config": {
                "model": "nomic-embed-text",
                "ollama_base_url": "http://127.0.0.1:11434",
            },
        }
        store_name = cfg.get("vector_store", "chroma")
        history_db = cfg.get("history_db_path") or os.path.join(self.workdir, "mem0-history.db")
        # An LLM block is required to CONSTRUCT Memory even with
        # infer=False (mem0 2.x still runs an LLM memory-decision step
        # during add()). Keep it cheap, local, and INSTALLED — the
        # default is a small local Ollama model. It is never on the
        # measured retrieval path; it never sees the cloud (see
        # scrub_cloud_env()).
        llm = cfg.get("llm") or {
            "provider": "ollama",
            "config": {
                "model": "qwen2.5:0.5b",
                "ollama_base_url": "http://127.0.0.1:11434",
            },
        }

        vector_store = self._vector_store_cfg(store_name, cfg)

        # NOTE: the pydantic key is `embedder` (NOT `embeddings` — an
        # unknown key is silently ignored and falls back to mem0's
        # OpenAI default, which then fails the credential check). We
        # send BOTH keys so the config is explicit either way.
        config = {
            "embedder": embedder,
            "embeddings": embedder,
            "vector_store": vector_store,
            "llm": llm,
            "history_db_path": history_db,
            "version": "v1.1",
        }

        try:
            self.memory = Memory.from_config(config)
        except Exception:
            # Retry once without the (unused) LLM block — some mem0
            # builds accept a config with no llm when infer=False.
            try:
                config.pop("llm", None)
                self.memory = Memory.from_config(config)
            except Exception as exc:
                return {
                    "ok": False,
                    "error": (f"mem0 Memory.from_config failed: {exc.__class__.__name__}: {exc}"),
                }

        self.embedder_used = embedder
        self.store_used = vector_store.get("provider", store_name)
        import mem0

        return {
            "ok": True,
            "version": getattr(mem0, "__version__", "unknown"),
            "embedder_used": self.embedder_used,
            "store_used": self.store_used,
        }

    @staticmethod
    def _vector_store_cfg(store_name: str, cfg: dict) -> dict:
        collection = cfg.get("collection", "memos-bench-vendors")
        if store_name == "qdrant":
            # Local mode: no server, no port. mem0 >= 0.1.100 supports
            # `path`; older builds need the client-side :memory: mode.
            return {
                "provider": "qdrant",
                "config": {
                    "collection_name": collection,
                    "path": cfg.get("vector_store_dir")
                    or os.path.join(cfg.get("_workdir", "."), "qdrant"),
                    "on_disk": True,
                },
            }
        # chroma: persistent dir, zero servers.
        return {
            "provider": "chroma",
            "config": {
                "collection_name": collection,
                "path": cfg.get("vector_store_dir")
                or os.path.join(cfg.get("_workdir", "."), "chroma"),
            },
        }

    # ── ingest ──────────────────────────────────────────────────────────
    def ingest(self, cmd: dict) -> dict:
        if self.memory is None:
            return {"ok": False, "error": "init not completed (memory is None)"}
        user_id = cmd["user_id"]
        text = cmd["text"]
        dia_ids = cmd.get("dia_ids") or []
        metadata = {
            "benchmark": "locomo",
            "instanceId": user_id,
            "dia_ids": dia_ids,
        }
        try:
            res = self.memory.add(
                messages=[{"role": "user", "content": text}],
                user_id=user_id,
                metadata=metadata,
                infer=False,
            )
        except Exception as exc:
            return {
                "ok": False,
                "error": f"mem0 add failed: {exc.__class__.__name__}: {exc}",
            }
        # mem0 returns the created memory rows (or a dict summary). Map
        # every returned id back to this utterance's dia_ids.
        ids: list[str] = []
        if isinstance(res, dict):
            for key in ("results", "memories"):
                rows = res.get(key) or []
                if isinstance(rows, list):
                    ids.extend(
                        str(r.get("id")) for r in rows if isinstance(r, dict) and r.get("id")
                    )
            if not ids and res.get("id"):
                ids.append(str(res["id"]))
        elif isinstance(res, list):
            ids.extend(str(r.get("id")) for r in res if isinstance(r, dict) and r.get("id"))
        for mem_id in ids:
            self.sidecar.put(mem_id, dia_ids)
        self.sidecar.save()
        return {"ok": True, "id": ids[0] if ids else None, "ids": ids}

    # ── search ──────────────────────────────────────────────────────────
    def search(self, cmd: dict) -> dict:
        if self.memory is None:
            return {"ok": False, "error": "init not completed (memory is None)"}
        query = cmd["query"]
        user_id = cmd["user_id"]
        limit = int(cmd.get("limit", 10))
        try:
            # mem0 2.x: top-level entity params (user_id) are rejected in
            # search(); they live under `filters` now.
            res = self.memory.search(
                query=query,
                limit=limit,
                filters={"user_id": user_id},
            )
        except Exception as exc:
            return {
                "ok": False,
                "error": f"mem0 search failed: {exc.__class__.__name__}: {exc}",
            }
        rows = res.get("results", []) if isinstance(res, dict) else res
        ids: list[str] = []
        missing: list[str] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            mem_id = str(row.get("id", ""))
            dia_ids = self.sidecar.get(mem_id)
            if not dia_ids:
                # Fallback: metadata passthrough, when the mem0 build
                # returns it. Still never a guess — recorded as missing.
                meta = row.get("metadata") or {}
                if isinstance(meta, dict) and isinstance(meta.get("dia_ids"), list):
                    dia_ids = [str(x) for x in meta["dia_ids"]]
            if not dia_ids:
                missing.append(mem_id)
                continue
            ids.extend(dia_ids)
        return {
            "ok": True,
            "ids": ids,
            "returned": len(rows or []),
            **({"unmapped_ids": missing} if missing else {}),
        }

    def close(self) -> dict:
        with contextlib.suppress(Exception):
            self.sidecar.save()
        return {"ok": True}


def scrub_cloud_env() -> None:
    """Remove OpenAI/Anthropic endpoint env vars BEFORE mem0 is imported.

    mem0's client stack resolves OpenAI-compatible endpoints from env
    vars, so an inherited OPENAI_BASE_URL (e.g. a local gateway) makes
    a "local" mem0 run phone a third party — or 404. The vendor leg of
    the benchmark must be reproducible and offline; anything the
    harness did not explicitly configure must not reach mem0.
    """
    for key in list(os.environ):
        upper = key.upper()
        if upper.startswith(("OPENAI_", "ANTHROPIC_")):
            os.environ.pop(key, None)


def main() -> int:
    workdir = "."
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--workdir" and i + 1 < len(argv):
            workdir = argv[i + 1]

    scrub_cloud_env()
    bridge = Mem0Bridge(workdir)
    # NOTE: no "ready" line here. The harness pairs responses strictly
    # FIFO with its requests; an unprompted hello would be consumed as
    # the init response and desync every later command.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except Exception as exc:
            emit({"ok": False, "error": f"bad json from harness: {exc}"})
            continue
        kind = cmd.get("cmd")
        try:
            if kind == "init":
                cmd.setdefault("vector_store_dir", os.path.join(workdir, "store"))
                cmd["_workdir"] = workdir
                emit(bridge.init(cmd))
            elif kind == "ingest":
                emit(bridge.ingest(cmd))
            elif kind == "search":
                emit(bridge.search(cmd))
            elif kind == "close":
                emit(bridge.close())
                return 0
            else:
                emit({"ok": False, "error": f"unknown cmd: {kind!r}"})
        except Exception as exc:
            emit(
                {
                    "ok": False,
                    "error": f"{exc.__class__.__name__}: {exc}",
                    "trace": traceback.format_exc(limit=3),
                }
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
