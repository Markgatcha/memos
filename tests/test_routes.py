"""Parity checks for the Python HTTP bridge and the new agent surfaces."""

from memos.server.main import _BRIDGE_SCRIPT, _native_binding_present, app


def _registered_paths() -> set[str]:
    """Paths from plain routes and FastAPI's included-router wrapper."""
    paths: set[str] = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        if path:
            paths.add(path)
        candidates = getattr(route, "effective_candidates", None)
        if callable(candidates):
            for candidate in candidates():
                candidate_path = getattr(candidate, "path", None)
                if candidate_path:
                    paths.add(candidate_path)
    return paths


def test_new_agent_routes_are_registered() -> None:
    paths = _registered_paths()
    assert {
        "/api/mem/profile",
        "/api/mem/overview",
        "/api/mem/trigger",
        "/api/mem/brief",
        "/api/mem/context-pack",
        "/api/mem/handoff",
        "/api/mem/audit",
        "/api/mem/eval",
        "/api/mem/promote",
        "/api/mem/embedding-health",
        "/api/mem/diagnostics",
        "/api/mem/health-report",
        "/api/mem/usage",
        "/api/mem/ingest",
        "/api/mem/forget-source",
        "/api/mem/deletion-status/{node_id}",
        "/api/mem/image/add",
        "/api/mem/image/search",
        "/api/mem/image/{ref}",
    } <= paths


def test_native_binding_detects_flat_prebuild_layout(tmp_path) -> None:
    pkg = tmp_path / "better-sqlite3"
    prebuilds = pkg / "prebuilds"
    prebuilds.mkdir(parents=True)
    (prebuilds / "win32-x64.node").write_bytes(b"not-a-real-binary")
    assert _native_binding_present(pkg) is True


def test_bridge_exposes_new_methods() -> None:
    for method in (
        "profile",
        "contextPack",
        "handoff",
        "audit",
        "eval",
        "promote",
        "diagnostics",
        "embeddingHealth",
        "health",
        "usage",
        "ingest",
        "imageAdd",
        "imageSearch",
        "imageRecall",
    ):
        assert f"case '{method}'" in _BRIDGE_SCRIPT


def test_ingest_path_guard(tmp_path, monkeypatch) -> None:
    from fastapi import HTTPException

    from memos.server.routes import _safe_ingest_path

    inside = tmp_path / "notes"
    inside.mkdir()
    monkeypatch.setenv("MEMOS_INGEST_ROOT", str(tmp_path))
    assert _safe_ingest_path(str(inside)) == str(inside.resolve())

    outside = tmp_path.parent
    try:
        _safe_ingest_path(str(outside))
    except HTTPException as error:
        assert error.status_code == 400
    else:  # pragma: no cover - the guard must reject
        raise AssertionError("path outside the ingest root was accepted")
