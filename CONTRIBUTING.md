# Contributing to MemOS

Thanks for your interest in contributing. MemOS is built to be contributor-friendly — the codebase is small, well-documented, and designed for extensibility.

## Ways to contribute

| Type | Difficulty | Impact |
|------|-----------|--------|
| Report a bug | Easy | High |
| Improve documentation | Easy | High |
| Build an adapter for a new framework | Medium | Very High |
| Fix a bug | Medium | High |
| Propose a new feature | Medium | Medium |
| Implement a storage backend (Postgres, Redis) | Hard | Very High |

## Development setup

### Prerequisites

- Node.js >= 18
- Python >= 3.10
- Git

### Clone and install

```bash
git clone https://github.com/Markgatcha/memos.git
cd memos

# TypeScript
npm install
npm run build

# Python
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -e ".[dev]"
```

### Run tests

```bash
# TypeScript tests
npm test

# Python tests
pytest tests/ -v

# Lint
npm run lint
ruff check .
```

## Building an adapter

This is the highest-impact way to contribute. Adapters bridge MemOS with AI frameworks.

### What is an adapter?

An adapter is a thin integration layer that connects an AI framework (Ollama, LangChain, CrewAI, etc.) to the MemOS HTTP API. Adapters:

1. Retrieve relevant memories before a model call
2. Inject memories into the context/system prompt
3. Optionally store new information from the conversation

### Adapter template

Create a file in `adapters/<framework>.py`:

```python
"""
MemOS <Framework> Adapter

[Brief description of what this adapter does.]

Usage:
    [Minimal usage example]
"""

from __future__ import annotations
import json
import os
import urllib.request
from typing import Any


class <Framework>Memory:
    """<Framework> integration backed by MemOS."""

    def __init__(
        self,
        memos_url: str | None = None,
        max_context_memories: int = 5,
        **kwargs: Any,
    ):
        self.memos_url = memos_url or os.environ.get("MEMOS_URL", "http://localhost:7400")
        self.max_context_memories = max_context_memories
        # Framework-specific config here

    async def init(self) -> None:
        """Verify connectivity to MemOS."""
        self._check_memos()

    # --- Memory operations (delegate to MemOS API) ---

    def remember(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Store a memory."""
        return self._post("/api/mem/store", {"content": content, **kwargs})

    def recall(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """Search memories."""
        result = self._post("/api/mem/search", {"query": query, "limit": limit})
        return result if isinstance(result, list) else []

    def forget(self, memory_id: str) -> bool:
        """Delete a memory."""
        try:
            self._post("/api/mem/forget", {"id": memory_id})
            return True
        except Exception:
            return False

    # --- Framework integration ---
    # Implement the framework's memory interface here

    # --- HTTP helpers ---

    def _post(self, path: str, data: dict[str, Any]) -> Any:
        url = f"{self.memos_url}{path}"
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    def _check_memos(self) -> None:
        try:
            req = urllib.request.Request(f"{self.memos_url}/health", method="GET")
            urllib.request.urlopen(req, timeout=5)
        except Exception as exc:
            raise ConnectionError(
                f"Cannot reach MemOS at {self.memos_url}. "
                f"Start it with: memos-server"
            ) from exc
```

### Adapter checklist

Before submitting your adapter PR, make sure:

- [ ] File is in `adapters/<framework>.py`
- [ ] Class follows the naming convention `<Framework>Memory`
- [ ] Uses only stdlib HTTP (no requests/httpx dependency)
- [ ] Includes a docstring with usage example
- [ ] Handles connection errors gracefully
- [ ] Works with the default MemOS server port (7400)
- [ ] `ruff check` passes on your code
- [ ] Added your adapter to the README adapter table
- [ ] Added a usage example to `docs/adapters.md`

### Adapter guidelines

1. **Use stdlib `urllib`** for HTTP — don't add `requests` or `httpx` as dependencies
2. **Graceful degradation** — if MemOS is unreachable, the adapter should still work without memory
3. **Configuration via constructor** — accept `memos_url`, `max_context_memories`, and framework-specific kwargs
4. **Auto-store** — optionally store user messages as memories (with a length threshold)
5. **System prompt injection** — prepend relevant memories to the system prompt, not the user message

## Code style

### TypeScript

- ESLint + Prettier (configured in repo)
- `npm run lint` and `npm run format:check` must pass
- Use JSDoc for all public functions
- Prefer `const` over `let`
- No `any` — use proper types or `unknown`

### Python

- Ruff for linting and formatting
- Type hints on all function signatures
- Docstrings on all public classes and methods
- `ruff check .` and `ruff format --check .` must pass

## Commit messages

Use conventional commits:

```
feat: add Ollama adapter
fix: handle empty search queries
docs: update README install instructions
refactor: extract HTTP helpers from adapter
test: add graph engine unit tests
```

## Pull request process

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-adapter`)
3. Make your changes
4. Run lint + tests (`npm run lint && npm test && ruff check . && pytest`)
5. Open a PR with a clear description of what and why
6. Wait for review — we aim to review within 48 hours

## Good first issues

Look for issues tagged `good first issue` — these are scoped, well-documented tasks perfect for new contributors.

## Questions?

Open a [Discussion](https://github.com/Markgatcha/memos/discussions) or a [GitHub Issue](https://github.com/Markgatcha/memos/issues). We're responsive and happy to help.
