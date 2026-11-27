def test_api_key_guard(monkeypatch) -> None:
    from memos.server.main import _is_authorized

    monkeypatch.setenv("MEMOS_API_KEY", "s3cret")
    assert _is_authorized("/health", "") is True
    assert _is_authorized("/api/mem/count", "") is False
    assert _is_authorized("/api/mem/count", "Bearer wrong") is False
    assert _is_authorized("/api/mem/count", "Bearer s3cret") is True


def test_api_key_guard_disabled(monkeypatch) -> None:
    from memos.server.main import _is_authorized

    monkeypatch.delenv("MEMOS_API_KEY", raising=False)
    assert _is_authorized("/api/mem/count", "") is True


def test_cors_defaults_to_no_cross_origin(monkeypatch) -> None:
    from memos.server.main import _resolve_cors_origins

    monkeypatch.delenv("MEMOS_CORS_ORIGINS", raising=False)
    assert _resolve_cors_origins() == []


def test_cors_reads_explicit_allowlist(monkeypatch) -> None:
    from memos.server.main import _resolve_cors_origins

    monkeypatch.setenv(
        "MEMOS_CORS_ORIGINS",
        "http://localhost:3000, https://example.test ,",
    )
    assert _resolve_cors_origins() == [
        "http://localhost:3000",
        "https://example.test",
    ]
