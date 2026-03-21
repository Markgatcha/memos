"""
MemOS LangChain Adapter — memory integration for LangChain chains and agents.

Provides a LangChain-compatible `BaseMemory` implementation backed by
MemOS. Drop it into any LangChain chain or agent to give it persistent,
graph-based memory with zero configuration.

Installation:
    pip install memos langchain

Usage:
    from langchain_openai import ChatOpenAI
    from langchain.chains import ConversationChain
    from memos.adapters.langchain import MemOSMemory

    memory = MemOSMemory()
    chain = ConversationChain(llm=ChatOpenAI(), memory=memory)

    chain.invoke({"input": "I prefer dark mode"})
    chain.invoke({"input": "What theme do I like?"})
    # → The chain recalls "dark mode" from MemOS
"""

from __future__ import annotations

import json
import os
import urllib.request
from typing import Any

from langchain.memory.chat_memory import BaseMemory
from langchain.schema import BaseMessage, HumanMessage, AIMessage
from pydantic import Field


class MemOSMemory(BaseMemory):
    """
    LangChain `BaseMemory` implementation backed by MemOS.

    Stores conversation context and extracted facts in the MemOS
    graph, providing persistent memory across sessions.

    All data stays local — no cloud dependencies.
    """

    memos_url: str = Field(
        default_factory=lambda: os.environ.get("MEMOS_URL", "http://localhost:7400")
    )
    """URL of the MemOS HTTP server."""

    max_context_memories: int = 5
    """Maximum number of memories to inject into context."""

    auto_extract_facts: bool = True
    """Automatically extract and store facts from user messages."""

    min_message_length: int = 15
    """Minimum message length to trigger fact extraction."""

    memory_key: str = "history"
    """Key used in the chain's prompt variables."""

    return_messages: bool = True
    """Whether to return messages as BaseMessage objects or strings."""

    # Internal state
    _conversation_buffer: list[BaseMessage] = []
    _session_id: str = ""

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True

    def __init__(self, **kwargs: Any):
        """
        Create a new MemOSMemory instance.

        Args:
            **kwargs: Configuration overrides (memos_url, max_context_memories, etc.).
        """
        super().__init__(**kwargs)
        self._conversation_buffer = []
        self._session_id = kwargs.get("session_id", "")

    @property
    def memory_variables(self) -> list[str]:
        """Return the memory variables this class adds to the prompt."""
        return [self.memory_key]

    def load_memory_variables(
        self, inputs: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """
        Load memory variables for chain injection.

        Retrieves relevant memories from MemOS based on the current
        input, then combines them with the conversation buffer.

        Args:
            inputs: The current chain inputs (used for relevance search).

        Returns:
            Dict with the memory_key containing memory context.
        """
        memories = []

        # Search for relevant memories based on current input
        if inputs:
            query = inputs.get("input", "") or inputs.get("query", "") or ""
            if query:
                memories = self._memos_search(query, limit=self.max_context_memories)

        # Build context from memories
        memory_texts = []
        for m in memories:
            node = m.get("node", m)
            content = node.get("content", "")
            mem_type = node.get("type", "fact")
            memory_texts.append(f"[{mem_type}] {content}")

        # Combine with conversation buffer
        if self.return_messages:
            result_messages = list(self._conversation_buffer)
            if memory_texts:
                memory_context = "Relevant memories:\n" + "\n".join(memory_texts)
                result_messages.insert(
                    0, HumanMessage(content=f"(System: {memory_context})")
                )
            return {self.memory_key: result_messages}
        else:
            buffer_str = self._buffer_as_str()
            if memory_texts:
                memory_context = "Relevant memories:\n" + "\n".join(memory_texts)
                return {self.memory_key: f"{memory_context}\n\n{buffer_str}"}
            return {self.memory_key: buffer_str}

    def save_context(self, inputs: dict[str, Any], outputs: dict[str, str]) -> None:
        """
        Save the context of this chain run to memory.

        Called by LangChain after each chain execution. Stores the
        interaction in both the conversation buffer and MemOS.

        Args:
            inputs: The inputs to the chain (typically has 'input' key).
            outputs: The outputs from the chain (typically has 'output' key).
        """
        input_str = inputs.get("input", "") or inputs.get("query", "") or ""
        output_str = outputs.get("output", "") or outputs.get("response", "") or ""

        # Add to conversation buffer
        if input_str:
            self._conversation_buffer.append(HumanMessage(content=input_str))
        if output_str:
            self._conversation_buffer.append(AIMessage(content=output_str))

        # Auto-extract facts from user messages
        if (
            self.auto_extract_facts
            and input_str
            and len(input_str) >= self.min_message_length
        ):
            self._memos_store(
                content=input_str,
                type="fact",
                metadata={
                    "source": "langchain",
                    "session_id": self._session_id,
                },
            )

    def clear(self) -> None:
        """Clear the conversation buffer. Does not delete MemOS memories."""
        self._conversation_buffer.clear()

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    def remember(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """
        Manually store a memory.

        Args:
            content: Text to remember.
            **kwargs: Additional memory parameters (type, metadata, importance).

        Returns:
            The created memory node.
        """
        return self._memos_store(content, **kwargs)

    def recall(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Search for relevant memories.

        Args:
            query: Search query.
            limit: Maximum results.

        Returns:
            List of scored memory nodes.
        """
        return self._memos_search(query, limit=limit)

    def forget(self, memory_id: str) -> bool:
        """
        Delete a specific memory.

        Args:
            memory_id: ID of the memory to forget.

        Returns:
            True if deleted.
        """
        try:
            self._memos_post("/api/mem/forget", {"id": memory_id})
            return True
        except Exception:
            return False

    def summarize_all(self) -> str:
        """
        Get a summary of all stored memories.

        Returns:
            Summary string.
        """
        result = self._memos_post("/api/mem/summarize", {})
        return result.get("summary", "")

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _buffer_as_str(self) -> str:
        """Convert conversation buffer to a string representation."""
        lines = []
        for msg in self._conversation_buffer:
            if isinstance(msg, HumanMessage):
                lines.append(f"Human: {msg.content}")
            elif isinstance(msg, AIMessage):
                lines.append(f"AI: {msg.content}")
            else:
                lines.append(f"{msg.type}: {msg.content}")
        return "\n".join(lines)

    def _memos_search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """Search memories via MemOS API."""
        payload = {"query": query, "limit": limit}
        result = self._memos_post("/api/mem/search", payload)
        if isinstance(result, list):
            return result
        return []

    def _memos_store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Store a memory via MemOS API."""
        payload = {"content": content, **kwargs}
        return self._memos_post("/api/mem/store", payload)

    def _memos_post(self, path: str, data: dict[str, Any]) -> Any:
        """POST to the MemOS server."""
        url = f"{self.memos_url}{path}"
        body = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.URLError as exc:
            raise ConnectionError(
                f"Cannot reach MemOS at {self.memos_url}. "
                f"Start it with: npx @memos/sdk serve. Error: {exc}"
            ) from exc
