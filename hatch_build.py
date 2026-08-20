"""Custom hatch build hook — bundle the compiled TypeScript SDK into the wheel.

The MemOS Python package drives the TypeScript SDK through a Node.js
subprocess, so the wheel ships the compiled JS at ``memos/_js``. The native
``better-sqlite3`` module cannot be bundled and is npm-installed at runtime.

This hook copies ``dist/`` -> ``memos/_js`` **only when ``dist/`` exists**:

- Release / publish builds run ``npm run build`` first, so ``dist/`` is
  present and the SDK is bundled into the wheel.
- ``pip install -e .`` in a fresh checkout (and the CI lint/test jobs) have
  no ``dist/`` yet; the hook then skips bundling instead of failing, so the
  install still succeeds. The server simply requires ``npm run build``
  before it can start (it raises a clear error otherwise).
"""

from __future__ import annotations

import os

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class MemOSBundleJSHook(BuildHookInterface):
    PLUGIN_NAME = "memos-bundle-js"

    def initialize(self, version: str, build_data: dict) -> None:
        dist = os.path.join(self.root, "dist")
        if os.path.isfile(os.path.join(dist, "index.js")):
            build_data.setdefault("force_include", {})[dist] = "memos/_js"
