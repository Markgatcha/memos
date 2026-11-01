#!/usr/bin/env python3
"""One-shot check that the controller endpoint is reachable and fast.

Usage:
    python lme-v2/controller_check.py

Reads the key from MEMOS_CONTROLLER_API_KEY, RIVER_API_KEY, or
~/.config/opencode/river.key (single line). Never prints the key.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from memos_backend import Controller  # noqa: E402


def main() -> None:
    controller = Controller()
    if not controller.enabled:
        raise SystemExit(
            "No controller key found. Set MEMOS_CONTROLLER_API_KEY, "
            "RIVER_API_KEY, or write the key to ~/.config/opencode/river.key"
        )
    print(f"endpoint: {controller.base_url}")
    print(f"model:    {controller.model}")

    started = time.perf_counter()
    text = controller.chat(
        [
            {"role": "system", "content": "Reply with JSON only."},
            {"role": "user", "content": 'Return {"ok": true, "n": 7}'},
        ],
        max_tokens=40,
    )
    elapsed = time.perf_counter() - started
    print(f"latency:  {elapsed:.2f}s")
    print(f"reply:    {str(text)[:200]}")
    if text is None:
        raise SystemExit("controller call failed (see adapter stderr)")

    started = time.perf_counter()
    payload = controller.json_chat(
        [
            {"role": "system", "content": "Return JSON only."},
            {
                "role": "user",
                "content": 'Return {"verdict":"supported","reason":"ok"}',
            },
        ],
        max_tokens=60,
    )
    print(f"json:     {json.dumps(payload)}")
    print(f"latency:  {time.perf_counter() - started:.2f}s")
    print(f"calls={controller.calls} failures={controller.failures}")


if __name__ == "__main__":
    main()
