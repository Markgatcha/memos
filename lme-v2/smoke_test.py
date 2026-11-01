#!/usr/bin/env python3
"""Bridge-only smoke test: no LME-V2 dataset, reader, or judge required."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

if not os.getenv("MEMOS_SDK_PATH"):
    repo_dist = HERE.parent / "dist" / "index.js"
    if repo_dist.exists():
        os.environ["MEMOS_SDK_PATH"] = str(repo_dist)

from memos_backend import MemosMemory  # noqa: E402


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="memos-lme-smoke-") as tmp:
        memory = MemosMemory(
            {
                "workspace_dir": str(Path(tmp) / "workspace"),
                "namespace": "lme-v2:smoke",
                "token_budget": 20_000,
                "top_k": 8,
                "embedding_provider": "model2vec",
            }
        )
        memory.configure_runtime()
        try:
            memory.insert(
                {
                    "id": "traj-smoke-1",
                    "goal": "Reset the router to factory settings",
                    "start_url": "http://router.local/settings",
                    "outcome": "success",
                    "actions": ["click Factory Reset", "confirm dialog"],
                    "states": [
                        {
                            "url": "http://router.local/settings",
                            "action": "click Factory Reset",
                            "thought": "the reset control is under Administration",
                            "text": "Administration panel. Factory Reset button. "
                            "Warning: this clears all configuration.",
                            "screenshot": "",
                        },
                        {
                            "url": "http://router.local/settings/confirm",
                            "action": "confirm dialog",
                            "thought": "confirmation is required",
                            "text": "Confirm factory reset. This cannot be undone.",
                            "screenshot": "",
                        },
                    ],
                }
            )
            items = memory.query("Where is the factory reset control?")
            print(f"items={len(items)}")
            for item in items[:5]:
                print(f"- {item['type']}: {item['value'][:240]}")
            text = "\n".join(
                item["value"] for item in items if item["type"] == "text"
            ).lower()
            if "reset" not in text:
                raise SystemExit("smoke test failed: retrieval did not return reset evidence")
            print("OK")
        finally:
            memory.close()


if __name__ == "__main__":
    main()
