#!/usr/bin/env python3
"""Embed bridge.mjs into memos_backend.py for the one-file submission rule."""

from __future__ import annotations

from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE / "memos_backend.py"
BRIDGE = HERE / "bridge.mjs"
OUTPUT = HERE / "memos_backend_bundled.py"
PLACEHOLDER = 'BRIDGE_JS = "__MEMOS_BRIDGE_JS__"'


def main() -> None:
    source = BACKEND.read_text(encoding="utf-8")
    if PLACEHOLDER not in source:
        raise SystemExit(f"placeholder not found in {BACKEND}")
    bridge = BRIDGE.read_text(encoding="utf-8")
    bundled = source.replace(PLACEHOLDER, f"BRIDGE_JS = {bridge!r}")
    OUTPUT.write_text(bundled, encoding="utf-8")
    print(f"wrote {OUTPUT} ({len(bundled)} bytes)")


if __name__ == "__main__":
    main()
