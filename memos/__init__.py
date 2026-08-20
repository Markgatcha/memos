"""MemOS — universal, local-first, persistent memory layer for AI agents.

This is the Python distribution of MemOS (PyPI: ``mem-os-sdk``). It provides:

- ``memos.server`` — a FastAPI HTTP server wrapping the TypeScript SDK
  (run with ``memos-server`` or ``python -m memos.server.main``)
- ``memos.adapters`` — framework integrations (Ollama, LangChain, CrewAI)

The core memory engine is the TypeScript SDK (npm: ``@mem-os/sdk``); the
Python server drives it through a Node.js subprocess, so Node.js >= 18 is
required at runtime.
"""

__version__ = "1.6.26"

__all__ = ["__version__"]
