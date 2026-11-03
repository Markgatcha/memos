import pytest


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


@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"],
)
def test_loopback_hosts(host: str) -> None:
    from memos.server.main import _is_loopback_host

    assert _is_loopback_host(host) is True


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.10", "example.test"])
def test_non_loopback_hosts(host: str) -> None:
    from memos.server.main import _is_loopback_host

    assert _is_loopback_host(host) is False


def test_non_loopback_bind_without_key_is_refused() -> None:
    from memos.server.main import _validate_bind_security

    with pytest.raises(RuntimeError, match="MEMOS_API_KEY"):
        _validate_bind_security("0.0.0.0", "")


def test_non_loopback_bind_with_key_is_allowed() -> None:
    from memos.server.main import _validate_bind_security

    _validate_bind_security("0.0.0.0", "s3cret")


def test_loopback_bind_without_key_is_allowed() -> None:
    from memos.server.main import _validate_bind_security

    _validate_bind_security("127.0.0.1", "")
