"""
MemOS Ollama Adapter — zero-config memory for Ollama chat completions.

Wraps the `ollama` Python client to automatically store and retrieve
relevant memories during chat interactions. No API keys, no cloud
dependencies — everything runs 100% locally.

Installation:
    pip install memos ollama

Usage:
    from memos.adapters.ollama import OllamaMemory

    chat = OllamaMemory(model="llama3")
    await chat.init()

    # Memories are automatically injected and extracted
    response = await chat.chat("I prefer dark mode in all my apps")
    response = await chat.chat("What theme do I like?")
    # → The model will recall "dark mode" from memory
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class OllamaConfig:
    """Configuration for the Ollama adapter."""

    base_url: str = field(
        default_factory=lambda: os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    )
    model: str = "llama3"
    memos_url: str = field(
        default_factory=lambda: os.environ.get("MEMOS_URL", "http://localhost:7400")
    )
    """URL of the MemOS HTTP server."""
    max_context_memories: int = 5
    """Maximum number of memories to inject into the system prompt."""
    auto_store: bool = True
    """Automatically store user messages as memories."""
    memory_types: list[str] = field(
        default_factory=lambda: ["preference", "fact", "context"]
    )
    """Memory types to store when auto-storing is enabled."""
    store_threshold: int = 20
    """Minimum message length to trigger auto-storage."""


class OllamaMemory:
    """
    Ollama chat wrapper with automatic memory management.

    Connects to the Ollama API for chat completions and the MemOS
    REST API for memory operations. All communication stays local.
    """

    def __init__(self, config: OllamaConfig | None = None, **kwargs: Any):
        """
        Create a new OllamaMemory instance.

        Args:
            config: Full configuration object. If not provided, defaults are used.
            **kwargs: Override individual config fields (model, base_url, etc.).
        """
        if config is None:
            config = OllamaConfig()
        # Apply keyword overrides
        for key, value in kwargs.items():
            if hasattr(config, key):
                setattr(config, key, value)
        self.config = config
        self._messages: list[dict[str, str]] = []
        self._initialized = False

    async def init(self) -> None:
        """
        Verify connectivity to both Ollama and MemOS servers.

        Raises:
            ConnectionError: If either server is unreachable.
        """
        self._check_ollama()
        self._check_memos()
        self._initialized = True

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def chat(self, message: str, **ollama_kwargs: Any) -> str:
        """
        Send a message and get a response with memory-augmented context.

        1. Retrieves relevant memories for the message.
        2. Injects them into the system prompt.
        3. Sends the conversation to Ollama.
        4. Optionally stores the user message as a memory.

        Args:
            message: The user's message.
            **ollama_kwargs: Additional parameters for Ollama (temperature, etc.).

        Returns:
            The model's response string.
        """
        self._assert_init()

        # Retrieve relevant memories
        memories = self._memos_search(message)
        system_prompt = self._build_system_prompt(memories)

        # Build messages
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(self._messages)
        messages.append({"role": "user", "content": message})

        # Call Ollama
        response = self._ollama_chat(messages, **ollama_kwargs)
        assistant_msg = response.get("message", {}).get("content", "")

        # Update conversation history
        self._messages.append({"role": "user", "content": message})
        self._messages.append({"role": "assistant", "content": assistant_msg})

        # Auto-store user message
        if self.config.auto_store and len(message) >= self.config.store_threshold:
            self._memos_store(
                content=message,
                metadata={"source": "ollama-chat", "model": self.config.model},
            )

        return assistant_msg

    async def chat_stream(
        self, message: str, **ollama_kwargs: Any
    ) -> AsyncIterator[str]:
        """
        Stream a chat response token by token.

        Args:
            message: The user's message.
            **ollama_kwargs: Additional parameters for Ollama.

        Yields:
            Response tokens as they arrive.
        """
        self._assert_init()

        memories = self._memos_search(message)
        system_prompt = self._build_system_prompt(memories)

        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(self._messages)
        messages.append({"role": "user", "content": message})

        ollama_kwargs["stream"] = True
        full_response = ""

        for chunk in self._ollama_chat_stream(messages, **ollama_kwargs):
            token = chunk.get("message", {}).get("content", "")
            full_response += token
            yield token

        self._messages.append({"role": "user", "content": message})
        self._messages.append({"role": "assistant", "content": full_response})

        if self.config.auto_store and len(message) >= self.config.store_threshold:
            self._memos_store(
                content=message,
                metadata={"source": "ollama-chat", "model": self.config.model},
            )

    def remember(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """
        Manually store a memory.

        Args:
            content: Text to remember.
            **kwargs: Additional memory parameters (type, metadata, importance).

        Returns:
            The created memory node.
        """
        self._assert_init()
        return self._memos_store(content, **kwargs)

    def recall(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Search for relevant memories.

        Args:
            query: Search query.
            limit: Maximum results to return.

        Returns:
            List of scored memory nodes.
        """
        self._assert_init()
        return self._memos_search(query, limit=limit)

    def forget(self, memory_id: str) -> bool:
        """
        Delete a specific memory.

        Args:
            memory_id: ID of the memory to forget.

        Returns:
            True if the memory was deleted.
        """
        self._assert_init()
        return self._memos_forget(memory_id)

    def clear_history(self) -> None:
        """Clear the conversation history (does not affect memories)."""
        self._messages.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_system_prompt(self, memories: list[dict[str, Any]]) -> str:
        """Build a system prompt with injected memories."""
        if not memories:
            return "You are a helpful assistant. Answer based on the conversation."

        mem_lines = []
        for i, m in enumerate(memories, 1):
            node = m.get("node", m)
            content = node.get("content", "")
            mem_type = node.get("type", "fact")
            mem_lines.append(f"  {i}. [{mem_type}] {content}")

        mem_block = "\n".join(mem_lines)

        return (
            "You are a helpful assistant with access to the user's stored memories.\n"
            "Use the following memories to personalize your responses. "
            "Do not mention that you have access to memories unless asked.\n\n"
            f"Relevant memories:\n{mem_block}\n\n"
            "Answer naturally based on both the conversation and your memories."
        )

    def _check_ollama(self) -> None:
        """Verify Ollama is running."""
        try:
            self._http_get(f"{self.config.base_url}/api/tags")
        except (urllib.error.URLError, ConnectionError) as exc:
            raise ConnectionError(
                f"Cannot reach Ollama at {self.config.base_url}. "
                f"Is Ollama running? Error: {exc}"
            ) from exc

    def _check_memos(self) -> None:
        """Verify MemOS server is running."""
        try:
            self._http_get(f"{self.config.memos_url}/health")
        except (urllib.error.URLError, ConnectionError) as exc:
            raise ConnectionError(
                f"Cannot reach MemOS at {self.config.memos_url}. "
                f"Start it with: npx @memos/sdk serve. Error: {exc}"
            ) from exc

    def _ollama_chat(
        self, messages: list[dict[str, str]], **kwargs: Any
    ) -> dict[str, Any]:
        """Call Ollama chat completion API."""
        payload = {
            "model": self.config.model,
            "messages": messages,
            "stream": False,
            **kwargs,
        }
        return self._http_post(f"{self.config.base_url}/api/chat", payload)

    def _ollama_chat_stream(
        self, messages: list[dict[str, str]], **kwargs: Any
    ) -> list[dict[str, Any]]:
        """Call Ollama chat with stream=True and collect chunks."""
        payload = {
            "model": self.config.model,
            "messages": messages,
            "stream": True,
            **kwargs,
        }
        return self._http_post_stream(f"{self.config.base_url}/api/chat", payload)

    def _memos_store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Store a memory via MemOS API."""
        payload = {"content": content, **kwargs}
        return self._http_post(f"{self.config.memos_url}/api/mem/store", payload)

    def _memos_search(
        self, query: str, limit: int | None = None
    ) -> list[dict[str, Any]]:
        """Search memories via MemOS API."""
        payload: dict[str, Any] = {"query": query}
        if limit is not None:
            payload["limit"] = limit
        else:
            payload["limit"] = self.config.max_context_memories
        if self.config.memory_types:
            payload["type"] = None  # Search all types

        result = self._http_post(f"{self.config.memos_url}/api/mem/search", payload)
        if isinstance(result, list):
            return result
        return []

    def _memos_forget(self, memory_id: str) -> bool:
        """Delete a memory via MemOS API."""
        try:
            self._http_post(
                f"{self.config.memos_url}/api/mem/forget", {"id": memory_id}
            )
            return True
        except Exception:
            return False

    # ------------------------------------------------------------------
    # HTTP helpers (stdlib only, no external deps)
    # ------------------------------------------------------------------

    @staticmethod
    def _http_get(url: str) -> dict[str, Any]:
        """Simple GET request."""
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())

    @staticmethod
    def _http_post(url: str, data: dict[str, Any]) -> dict[str, Any]:
        """Simple POST request with JSON body."""
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())

    @staticmethod
    def _http_post_stream(url: str, data: dict[str, Any]) -> list[dict[str, Any]]:
        """POST with streamed NDJSON response."""
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        chunks: list[dict[str, Any]] = []
        with urllib.request.urlopen(req, timeout=120) as resp:
            for line in resp:
                line = line.strip()
                if line:
                    chunks.append(json.loads(line.decode()))
        return chunks

    def _assert_init(self) -> None:
        """Assert the adapter has been initialised."""
        if not self._initialized:
            raise RuntimeError(
                "OllamaMemory not initialised. Call `await chat.init()` first."
            )
