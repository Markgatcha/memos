"""
MemOS CrewAI Adapter — persistent memory for CrewAI agents and crews.

Provides a CrewAI-compatible memory implementation backed by MemOS.
Drop it into any CrewAI crew to give all agents persistent, graph-based
memory with zero configuration.

Installation:
    pip install mem-os-sdk crewai

Usage:
    from memos.adapters.crewai import MemOSMemory

    # As CrewAI short-term memory
    from crewai import Agent, Crew, Task, Process
    from memos.adapters.crewai import MemOSMemory

    memory = MemOSMemory()

    researcher = Agent(
        role="Researcher",
        goal="Find accurate information",
        backstory="You are a meticulous researcher.",
        memory=True,
        # CrewAI will use the memory system automatically
    )

    # Or use the memory tool directly
    from memos.adapters.crewai import MemOSTool

    tool = MemOSTool()
    result = tool._run("search", query="dark mode")
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def _validate_url(url: str) -> str:
    """SSRF guard: require http(s) with a host, and reject requests to
    link-local / cloud-metadata addresses after DNS resolution.

    Loopback and private ranges are intentionally allowed — this is a
    local-first product whose services live on the user's own machine.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"Unsupported URL (must be http/https with a host): {url!r}")
    try:
        infos = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as exc:
        raise ValueError(f"Cannot resolve host in URL: {url!r}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_link_local:
            raise ValueError(
                f"Refusing request to link-local/metadata address {ip} (SSRF guard): {url!r}"
            )
    return url


class MemOSTool:
    """
    CrewAI-compatible tool for interacting with MemOS.

    Provides store, search, retrieve, and forget operations
    that agents can use during their tasks.
    """

    name: str = "memos_memory"
    description: str = (
        "Access persistent memory. Use this to store important findings, "
        "search for previously stored information, or retrieve specific memories. "
        "Input should be a JSON string with 'action' and relevant parameters."
    )

    memos_url: str
    """URL of the MemOS HTTP server."""

    def __init__(self, memos_url: str | None = None) -> None:
        """Create a MemOS tool bound to an HTTP server."""
        self.memos_url = memos_url or os.environ.get("MEMOS_URL", "http://localhost:7400")

    def _run(self, action: str, **kwargs: Any) -> str:
        """
        Execute a memory action.

        Args:
            action: One of 'store', 'search', 'retrieve', 'forget', 'summarize'.
            **kwargs: Action-specific parameters.

        Returns:
            JSON string with the result.
        """
        try:
            if action == "store":
                result = self._memos_store(
                    content=kwargs.get("content", ""),
                    type=kwargs.get("type", "fact"),
                    tags=kwargs.get("tags", []),
                )
                return json.dumps(
                    {
                        "status": "success",
                        "id": result.get("node", {}).get("id"),
                        "summary": result.get("node", {}).get("summary"),
                    }
                )

            elif action == "search":
                results = self._memos_search(
                    query=kwargs.get("query", ""),
                    limit=kwargs.get("limit", 5),
                )
                memories = []
                for r in results:
                    node = r.get("node", r)
                    memories.append(
                        {
                            "content": node.get("content"),
                            "type": node.get("type"),
                            "score": r.get("score", 0),
                            "id": node.get("id"),
                        }
                    )
                return json.dumps({"status": "success", "results": memories})

            elif action == "retrieve":
                node = self._memos_retrieve(kwargs.get("id", ""))
                if node:
                    return json.dumps({"status": "success", "memory": node})
                return json.dumps({"status": "not_found"})

            elif action == "forget":
                deleted = self._memos_forget(kwargs.get("id", ""))
                return json.dumps({"status": "success", "deleted": deleted})

            elif action == "summarize":
                result = self._memos_post("/api/mem/summarize", {})
                return json.dumps(
                    {
                        "status": "success",
                        "summary": result.get("summary", ""),
                    }
                )

            else:
                return json.dumps({"status": "error", "message": f"Unknown action: {action}"})

        except Exception as e:
            return json.dumps({"status": "error", "message": str(e)})

    def remember(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """
        Manually store a memory.

        Args:
            content: Text to remember.
            **kwargs: Additional parameters (type, tags, metadata).

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
        return self._memos_forget(memory_id)

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

    def _memos_store(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """Store a memory via MemOS API."""
        payload = {"content": content, **kwargs}
        return self._memos_post("/api/mem/store", payload)

    def _memos_search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """Search memories via MemOS API."""
        payload = {"query": query, "limit": limit}
        result = self._memos_post("/api/mem/search", payload)
        if isinstance(result, list):
            return result
        return []

    def _memos_retrieve(self, memory_id: str) -> dict[str, Any] | None:
        """Retrieve a memory via MemOS API."""
        try:
            result = self._memos_post("/api/mem/retrieve", {"id": memory_id})
            return result
        except Exception:
            return None

    def _memos_forget(self, memory_id: str) -> bool:
        """Delete a memory via MemOS API."""
        try:
            self._memos_post("/api/mem/forget", {"id": memory_id})
            return True
        except Exception:
            return False

    def _memos_post(self, path: str, data: dict[str, Any]) -> Any:
        """POST to the MemOS server."""
        url = _validate_url(f"{self.memos_url}{path}")
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
                f"Start it with: npx @mem-os/sdk serve. Error: {exc}"
            ) from exc


class MemOSMemory:
    """
    CrewAI-compatible memory class backed by MemOS.

    Provides short-term and long-term memory for CrewAI agents
    by storing and retrieving memories from the MemOS graph.

    Usage with CrewAI:
        from crewai import Agent, Crew, Task, Process
        from memos.adapters.crewai import MemOSMemory

        memory = MemOSMemory()

        agent = Agent(
            role="Researcher",
            goal="Find information",
            backstory="You are a researcher.",
            memory=True,
        )

        # The memory will be used automatically by CrewAI
    """

    memos_url: str = os.environ.get("MEMOS_URL", "http://localhost:7400")
    """URL of the MemOS HTTP server."""

    max_context_memories: int = 5
    """Maximum number of memories to inject into context."""

    auto_store: bool = True
    """Automatically store agent observations."""

    session_id: str = ""
    """Session identifier for memory grouping."""

    class Config:
        """Pydantic config."""

        arbitrary_types_allowed = True

    def __init__(self, **kwargs: Any):
        """Create a new MemOSMemory instance."""
        for key, value in kwargs.items():
            if hasattr(self, key):
                setattr(self, key, value)
        self._tool = MemOSTool(memos_url=self.memos_url)

    def save(self, content: str, **kwargs: Any) -> dict[str, Any]:
        """
        Store a memory from an agent's observation.

        Args:
            content: Text content to remember.
            **kwargs: Additional parameters (type, tags, metadata).

        Returns:
            The created memory node.
        """
        metadata = kwargs.pop("metadata", {})
        if self.session_id:
            metadata["session_id"] = self.session_id
        metadata["source"] = "crewai"
        return self._tool.remember(content, metadata=metadata, **kwargs)

    def search(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        """
        Search for relevant memories.

        Args:
            query: Search query.
            limit: Maximum results.

        Returns:
            List of scored memory nodes.
        """
        return self._tool.recall(query, limit=limit)

    def get_context(self, query: str) -> str:
        """
        Get memory context for injection into agent prompts.

        Args:
            query: The current task or question.

        Returns:
            Formatted memory context string.
        """
        memories = self.search(query, limit=self.max_context_memories)
        if not memories:
            return ""

        lines = ["Relevant memories:"]
        for i, m in enumerate(memories, 1):
            node = m.get("node", m)
            content = node.get("content", "")
            mem_type = node.get("type", "fact")
            lines.append(f"  {i}. [{mem_type}] {content}")

        return "\n".join(lines)

    def forget(self, memory_id: str) -> bool:
        """
        Delete a specific memory.

        Args:
            memory_id: ID of the memory to forget.

        Returns:
            True if deleted.
        """
        return self._tool.forget(memory_id)

    def summarize(self) -> str:
        """
        Get a summary of all stored memories.

        Returns:
            Summary string.
        """
        return self._tool.summarize_all()
