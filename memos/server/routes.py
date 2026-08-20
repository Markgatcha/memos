"""
MemOS REST API routes.

All endpoints are mounted under `/api/mem` and communicate with
the Node.js MemOS subprocess via JSON-RPC over stdin/stdout.
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / Response Models
# ---------------------------------------------------------------------------


class StoreRequest(BaseModel):
    """Request body for storing a new memory."""

    content: str = Field(..., min_length=1, description="Text content to remember.")
    type: str = Field(
        "fact",
        description="Memory type: fact, preference, context, relationship, entity, custom.",
    )
    metadata: dict[str, Any] = Field(default_factory=dict, description="Arbitrary metadata.")
    summary: str | None = Field(None, description="Optional summary. Auto-generated if omitted.")
    importance: float = Field(0.5, ge=0.0, le=1.0, description="Importance score [0, 1].")
    ttl: int | None = Field(None, description="TTL in seconds.")
    tags: list[str] = Field(default_factory=list, description="Custom tags.")


class SearchRequest(BaseModel):
    """Request body for searching memories."""

    query: str | None = Field(None, description="Full-text search query.")
    type: str | None = Field(None, description="Filter by memory type.")
    min_importance: float | None = Field(None, ge=0.0, le=1.0)
    max_importance: float | None = Field(None, ge=0.0, le=1.0)
    metadata: dict[str, Any] | None = Field(None, description="Metadata filter.")
    limit: int = Field(20, ge=1, le=1000)
    offset: int = Field(0, ge=0)
    sort_by: str = Field("updated_at", description="Sort field.")
    sort_order: str = Field("desc", description="Sort order: asc or desc.")
    tags: list[str] = Field(default_factory=list, description="Filter by tags (AND logic).")


class LinkRequest(BaseModel):
    """Request body for creating a manual link between memories."""

    source_id: str = Field(..., description="Source node ID.")
    target_id: str = Field(..., description="Target node ID.")
    relation: str = Field("relates_to", description="Edge relation type.")
    weight: float = Field(0.5, ge=0.0, le=1.0)


class UpdateRequest(BaseModel):
    """Request body for updating an existing memory."""

    content: str | None = None
    summary: str | None = None
    type: str | None = None
    metadata: dict[str, Any] | None = None
    importance: float | None = Field(None, ge=0.0, le=1.0)
    tags: list[str] | None = None


class ForgetRequest(BaseModel):
    """Request body for forgetting (deleting) a memory."""

    id: str = Field(..., description="Memory node ID to forget.")


class TtlRequest(BaseModel):
    """Request body for setting TTL."""

    seconds: int = Field(..., ge=1, description="TTL in seconds.")


class TagsRequest(BaseModel):
    """Request body for adding tags."""

    tags: list[str] = Field(..., min_length=1, description="Tags to add.")


# ---------------------------------------------------------------------------
# Bridge communication
# ---------------------------------------------------------------------------


def _get_bridge():
    """Get the Node.js bridge subprocess from the app state."""
    from .main import _node_process

    if _node_process is None or _node_process.poll() is not None:
        raise HTTPException(status_code=503, detail="MemOS bridge process not running.")
    return _node_process


def _rpc_call(method: str, params: dict[str, Any] | None = None) -> Any:
    """Send a JSON-RPC call to the Node.js bridge and return the result."""
    import uuid as _uuid

    bridge = _get_bridge()
    msg_id = str(_uuid.uuid4())
    payload = json.dumps({"id": msg_id, "method": method, "params": params or {}}) + "\n"

    try:
        bridge.stdin.write(payload)
        bridge.stdin.flush()

        line = bridge.stdout.readline()
        if not line:
            raise HTTPException(status_code=502, detail="No response from MemOS bridge.")

        response = json.loads(line.strip())

        if "error" in response and response["error"]:
            raise HTTPException(status_code=400, detail=response["error"])

        return response.get("result")
    except BrokenPipeError as err:
        raise HTTPException(status_code=503, detail="MemOS bridge process crashed.") from err


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/store", summary="Store a new memory")
async def store_memory(req: StoreRequest):
    """
    Store a new memory node. Automatically generates a summary
    and links related memories when auto-linking is enabled.
    """
    opts: dict[str, Any] = {
        "type": req.type,
        "metadata": req.metadata,
        "importance": req.importance,
    }
    if req.summary:
        opts["summary"] = req.summary
    if req.ttl is not None:
        opts["ttl"] = req.ttl
    if req.tags:
        opts["tags"] = req.tags

    result = _rpc_call("store", {"content": req.content, "opts": opts})
    return result


@router.post("/retrieve", summary="Retrieve a memory by ID")
async def retrieve_memory(body: dict[str, str]):
    """Retrieve a single memory node by its unique ID."""
    node_id = body.get("id")
    if not node_id:
        raise HTTPException(status_code=400, detail="Missing 'id' field.")
    result = _rpc_call("retrieve", {"id": node_id})
    if result is None:
        raise HTTPException(status_code=404, detail=f"Memory not found: {node_id}")
    return result


@router.post("/search", summary="Search memories")
async def search_memories(req: SearchRequest):
    """Search memories by text query and/or structured filters."""
    filter_obj: dict[str, Any] = {
        "limit": req.limit,
        "offset": req.offset,
        "sortBy": req.sort_by,
        "sortOrder": req.sort_order,
    }
    if req.query:
        filter_obj["query"] = req.query
    if req.type:
        filter_obj["type"] = req.type
    if req.min_importance is not None:
        filter_obj["minImportance"] = req.min_importance
    if req.max_importance is not None:
        filter_obj["maxImportance"] = req.max_importance
    if req.metadata:
        filter_obj["metadata"] = req.metadata
    if req.tags:
        filter_obj["tags"] = req.tags

    result = _rpc_call("search", {"filter": filter_obj})
    return result


@router.post("/forget", summary="Forget (delete) a memory")
async def forget_memory(req: ForgetRequest):
    """Permanently remove a memory and all its connected edges."""
    result = _rpc_call("forget", {"id": req.id})
    if not result:
        raise HTTPException(status_code=404, detail=f"Memory not found: {req.id}")
    return {"deleted": True, "id": req.id}


@router.post("/summarize", summary="Summarize all memories")
async def summarize_memories():
    """Generate an extractive summary of all stored memories."""
    result = _rpc_call("summarize")
    return {"summary": result}


@router.post("/link", summary="Link two memories")
async def link_memories(req: LinkRequest):
    """Manually create a link (edge) between two memory nodes."""
    result = _rpc_call(
        "link",
        {
            "sourceId": req.source_id,
            "targetId": req.target_id,
            "relation": req.relation,
            "weight": req.weight,
        },
    )
    return result


@router.get("/graph", summary="Get the full memory graph")
async def get_graph():
    """Return all nodes and edges in the memory graph."""
    result = _rpc_call("graph")
    return result


@router.post("/neighbours", summary="Get neighbours of a memory")
async def get_neighbours(body: dict[str, str]):
    """Get all nodes directly connected to the given node."""
    node_id = body.get("nodeId")
    if not node_id:
        raise HTTPException(status_code=400, detail="Missing 'nodeId' field.")
    result = _rpc_call("neighbours", {"nodeId": node_id})
    return result


@router.get("/count", summary="Memory count")
async def get_count():
    """Return the total number of stored memories."""
    result = _rpc_call("count")
    return {"count": result}


@router.post("/update", summary="Update an existing memory")
async def update_memory(node_id: str, req: UpdateRequest):
    """Partially update an existing memory node."""
    params: dict[str, Any] = {"id": node_id}
    if req.content is not None:
        params["content"] = req.content
    if req.summary is not None:
        params["summary"] = req.summary
    if req.type is not None:
        params["type"] = req.type
    if req.metadata is not None:
        params["metadata"] = req.metadata
    if req.importance is not None:
        params["importance"] = req.importance
    if req.tags is not None:
        params["tags"] = req.tags

    result = _rpc_call("update", params)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Memory not found: {node_id}")
    return result


# ---------------------------------------------------------------------------
# TTL Endpoints
# ---------------------------------------------------------------------------


@router.patch("/mem/{mem_id}/ttl", summary="Set TTL on a memory")
async def set_ttl(mem_id: str, req: TtlRequest):
    """Set a time-to-live on a memory node."""
    _rpc_call("setTTL", {"id": mem_id, "seconds": req.seconds})
    return {"id": mem_id, "ttl": req.seconds}


@router.delete("/mem/{mem_id}/ttl", summary="Clear TTL on a memory")
async def clear_ttl(mem_id: str):
    """Clear the TTL on a memory node."""
    _rpc_call("clearTTL", {"id": mem_id})
    return {"id": mem_id, "ttl": None}


# ---------------------------------------------------------------------------
# Tags Endpoints
# ---------------------------------------------------------------------------


@router.post("/mem/{mem_id}/tags", summary="Add tags to a memory")
async def add_tags(mem_id: str, req: TagsRequest):
    """Add tags to a memory node."""
    _rpc_call("tag", {"id": mem_id, "tags": req.tags})
    return {"id": mem_id, "tags": req.tags}


@router.delete("/mem/{mem_id}/tags/{tag}", summary="Remove a tag from a memory")
async def remove_tag(mem_id: str, tag: str):
    """Remove a tag from a memory node."""
    _rpc_call("untag", {"id": mem_id, "tags": [tag]})
    return {"id": mem_id, "removed": tag}


@router.get("/tags/{tag}", summary="List memories by tag")
async def list_by_tag(tag: str):
    """List all memories that have a specific tag."""
    result = _rpc_call("listByTag", {"tag": tag})
    return result


# ---------------------------------------------------------------------------
# Export Endpoint
# ---------------------------------------------------------------------------


@router.get("/export", summary="Export memories")
async def export_memories(
    format: str = Query("json", description="Export format: json, markdown, obsidian"),
    tag: str | None = Query(None, description="Filter by tag"),
):
    """Export memories in the specified format. Returns JSON or a zip file."""
    opts: dict[str, Any] = {"format": format}
    if tag:
        opts["tag"] = tag

    result = _rpc_call("export", {"opts": opts})

    if format == "json":
        return json.loads(result["data"])

    # For markdown/obsidian, create a zip file
    export_dir = result["data"]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if os.path.isdir(export_dir):
            for root, _dirs, files in os.walk(export_dir):
                for fname in files:
                    filepath = os.path.join(root, fname)
                    arcname = os.path.relpath(filepath, export_dir)
                    zf.write(filepath, arcname)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="memos-export-{format}.zip"'},
    )
