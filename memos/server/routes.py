"""
MemOS REST API routes.

All endpoints are mounted under `/api/mem` and communicate with
the Node.js MemOS subprocess via JSON-RPC over stdin/stdout.
"""

from __future__ import annotations

import base64
import io
import json
import os
import zipfile
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

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


class ForgetSourceRequest(BaseModel):
    """Request body for source-scoped erasure."""

    source: str = Field(..., min_length=1, description="Path, URL, or source id.")
    field: str | None = None
    prefix: bool = False
    namespace: str | None = None
    dry_run: bool = False


class TtlRequest(BaseModel):
    """Request body for setting TTL."""

    seconds: int = Field(..., ge=1, description="TTL in seconds.")


class TagsRequest(BaseModel):
    """Request body for adding tags."""

    tags: list[str] = Field(..., min_length=1, description="Tags to add.")


class ProfileRequest(BaseModel):
    """Request body for the one-call user profile."""

    query: str | None = None
    namespace: str | None = None
    scope: dict[str, str] | None = None
    max_static: int | None = Field(None, ge=1, le=500)
    max_dynamic: int | None = Field(None, ge=1, le=500)
    recent_days: int | None = Field(None, ge=1, le=3650)


class TriggerRequest(BaseModel):
    """Request body for pre-action procedural recall."""

    task: str = Field(..., min_length=1)
    entities: list[str] | None = None
    namespace: str | None = None
    scope: dict[str, str] | None = None
    limit: int | None = Field(None, ge=1, le=20)


class BriefRequest(BaseModel):
    """Request body for a per-subject memory brief."""

    subject: str = Field(..., min_length=1)
    namespace: str | None = None
    limit: int | None = Field(None, ge=1, le=100)
    include_closed: bool = True


class ContextPackRequest(BaseModel):
    """Request body for a token-budgeted context pack."""

    query: str = Field(..., min_length=1)
    token_budget: int = Field(1200, ge=128, le=1_000_000)
    namespace: str | None = None
    scope: dict[str, str] | None = None
    format: str = Field("json", description="json, toon, or toon-compact")
    include_summary: bool = True
    semantic_dedup: bool = False
    multi_stream: bool = True
    rerank: bool = False


class HandoffRequest(BaseModel):
    """Request body for a cross-harness handoff brief."""

    task: str = Field(..., min_length=1)
    token_budget: int = Field(1200, ge=128, le=1_000_000)
    namespace: str | None = None
    scope: dict[str, str] | None = None
    lessons: int = Field(5, ge=0, le=50)
    include_reminders: bool = True
    from_harness: str | None = None
    to_harness: str | None = None
    format: str = Field("markdown", description="markdown or json")


class AuditRequest(BaseModel):
    """Request body for the audit artifact."""

    expect_tip: str | None = None
    limit: int = Field(100, ge=1, le=10_000)


class EvalRequest(BaseModel):
    """Request body for retrieval evaluation."""

    k: int = Field(5, ge=1, le=100)
    limit: int = Field(20, ge=1, le=1000)
    from_sessions: bool = False
    namespace: str | None = None
    cases: list[dict[str, Any]] | None = None


class PromoteRequest(BaseModel):
    """Request body for procedure promotion."""

    apply: bool = False
    min_successes: int = Field(2, ge=1, le=100)
    max_failure_ratio: float = Field(0.2, ge=0.0, le=1.0)
    limit: int = Field(20, ge=1, le=500)
    namespace: str | None = None


class IngestRequest(BaseModel):
    """Ingest a server-local file or folder into memory."""

    path: str = Field(..., min_length=1, description="File or directory to ingest.")
    namespace: str | None = "documents"
    chunk_chars: int | None = Field(None, ge=200, le=20_000)
    extensions: list[str] | None = None


class ImageAddRequest(BaseModel):
    """Store an image from a server-local path or base64 bytes."""

    model_config = ConfigDict(populate_by_name=True)

    path: str | None = None
    base64_data: str | None = Field(None, alias="base64")
    mime: str = "image/png"
    caption: str = Field(..., min_length=1)
    kind: str = "image"
    tags: list[str] = Field(default_factory=list)
    namespace: str | None = None


class ImageSearchRequest(BaseModel):
    """Search image memories by caption or CLIP pixels."""

    query: str = Field(..., min_length=1)
    limit: int = Field(20, ge=1, le=200)
    threshold: float = Field(0.15, ge=0.0, le=1.0)
    namespace: str | None = None
    kind: str | None = None


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


@router.post("/forget-source", summary="Delete every memory from a source")
async def forget_source(req: ForgetSourceRequest):
    """Source-scoped erasure with proof-of-forgetting certificates."""
    params: dict[str, Any] = {
        "source": req.source,
        "prefix": req.prefix,
        "dryRun": req.dry_run,
    }
    if req.field is not None:
        params["field"] = req.field
    if req.namespace is not None:
        params["namespace"] = req.namespace
    return _rpc_call("forgetSource", params)


@router.get(
    "/deletion-status/{node_id}",
    summary="Whether a memory is present, deleted, or unknown",
)
async def deletion_status(node_id: str):
    """Return the deletion state and, when deleted, the certificate."""
    return _rpc_call("deletionStatus", {"nodeId": node_id})


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


# ---------------------------------------------------------------------------
# Agent surfaces: profile, context pack, handoff, audit, eval, promotion
# ---------------------------------------------------------------------------


@router.post("/profile", summary="One-call user profile")
async def profile(req: ProfileRequest):
    """Static durable facts plus recent activity, ready for a system prompt."""
    params: dict[str, Any] = {}
    if req.query is not None:
        params["query"] = req.query
    if req.namespace is not None:
        params["namespace"] = req.namespace
    if req.scope is not None:
        params["scope"] = req.scope
    if req.max_static is not None:
        params["maxStatic"] = req.max_static
    if req.max_dynamic is not None:
        params["maxDynamic"] = req.max_dynamic
    if req.recent_days is not None:
        params["recentDays"] = req.recent_days
    return _rpc_call("profile", params)


@router.get("/overview", summary="What the memory store knows")
async def overview(namespace: str | None = None):
    """Counts, namespaces, tags, freshness, and trust — no memory contents."""
    params: dict[str, Any] = {}
    if namespace is not None:
        params["namespace"] = namespace
    return _rpc_call("overview", params)


@router.post("/trigger", summary="Procedures to recall before acting")
async def trigger(req: TriggerRequest):
    """Rank procedural lessons for an upcoming task and explain each match."""
    params: dict[str, Any] = {"task": req.task}
    if req.entities is not None:
        params["entities"] = req.entities
    if req.namespace is not None:
        params["namespace"] = req.namespace
    if req.scope is not None:
        params["scope"] = req.scope
    if req.limit is not None:
        params["limit"] = req.limit
    return _rpc_call("trigger", params)


@router.post("/brief", summary="Open/closed brief for one subject")
async def brief(req: BriefRequest):
    """Maintained subject brief; closed items are dropped from the prompt."""
    params: dict[str, Any] = {
        "subject": req.subject,
        "includeClosed": req.include_closed,
    }
    if req.namespace is not None:
        params["namespace"] = req.namespace
    if req.limit is not None:
        params["limit"] = req.limit
    return _rpc_call("brief", params)


@router.post("/context-pack", summary="Token-budgeted context pack")
async def context_pack(req: ContextPackRequest):
    """Retrieve a budgeted, citable slice of memory for prompt injection."""
    params: dict[str, Any] = {
        "query": req.query,
        "tokenBudget": req.token_budget,
        "format": req.format,
        "includeSummary": req.include_summary,
        "semanticDedup": req.semantic_dedup,
        "multiStream": req.multi_stream,
        "rerank": req.rerank,
    }
    if req.namespace is not None:
        params["namespace"] = req.namespace
    if req.scope is not None:
        params["scope"] = req.scope
    return _rpc_call("contextPack", params)


@router.post("/context_pack", include_in_schema=False)
async def context_pack_alias(req: ContextPackRequest):
    """Snake-case alias for clients that mirror the MCP tool name."""
    return await context_pack(req)


@router.post("/handoff", summary="Cross-harness handoff brief")
async def handoff(req: HandoffRequest):
    """Build a compact continue-here brief for another harness or session."""
    params: dict[str, Any] = {
        "task": req.task,
        "tokenBudget": req.token_budget,
        "lessons": req.lessons,
        "includeReminders": req.include_reminders,
        "format": req.format,
    }
    if req.namespace is not None:
        params["namespace"] = req.namespace
    if req.scope is not None:
        params["scope"] = req.scope
    if req.from_harness is not None:
        params["fromHarness"] = req.from_harness
    if req.to_harness is not None:
        params["toHarness"] = req.to_harness
    return _rpc_call("handoff", params)


@router.post("/audit", summary="Auditable memory report")
async def audit(req: AuditRequest):
    """Tamper chain, provenance, quarantine, deletions, and search health."""
    params: dict[str, Any] = {"limit": req.limit}
    if req.expect_tip is not None:
        params["expectTip"] = req.expect_tip
    return _rpc_call("audit", params)


@router.post("/eval", summary="Retrieval evaluation")
async def evaluate(req: EvalRequest):
    """Self-recall or labelled-corpus retrieval evaluation."""
    params: dict[str, Any] = {
        "k": req.k,
        "limit": req.limit,
        "fromSessions": req.from_sessions,
    }
    if req.namespace is not None:
        params["namespace"] = req.namespace
    if req.cases is not None:
        params["cases"] = req.cases
    return _rpc_call("eval", params)


@router.post("/promote", summary="Promote successful recall patterns")
async def promote(req: PromoteRequest):
    """Review or apply repeated successful recall patterns as procedures."""
    params: dict[str, Any] = {
        "apply": req.apply,
        "minSuccesses": req.min_successes,
        "maxFailureRatio": req.max_failure_ratio,
        "limit": req.limit,
    }
    if req.namespace is not None:
        params["namespace"] = req.namespace
    return _rpc_call("promote", params)


@router.get("/embedding-health", summary="Semantic search health")
async def embedding_health():
    """Probe the active embedding provider and report degraded/fallback state."""
    return _rpc_call("embeddingHealth")


@router.get("/diagnostics", summary="Storage and retrieval diagnostics")
async def diagnostics():
    """Counts, embedding coverage, queue state, and vector-index status."""
    return _rpc_call("diagnostics")


@router.get("/health-report", summary="Memory hygiene and usefulness report")
async def health_report():
    """Contradictions, TTL, confidence, quarantine, and recall outcomes."""
    return _rpc_call("health")


@router.get("/usage", summary="Token-savings telemetry")
async def usage():
    """Context-pack token and format counters for this server process."""
    return _rpc_call("usage")


# ---------------------------------------------------------------------------
# Document ingestion
# ---------------------------------------------------------------------------


def _safe_ingest_path(path: str) -> str:
    """Keep ingestion inside the server root (or MEMOS_INGEST_ROOT).

    The HTTP server binds 0.0.0.0 by default; without this guard anyone on the
    network could read arbitrary files into the memory store.
    """
    base = os.path.realpath(os.environ.get("MEMOS_INGEST_ROOT") or os.getcwd())
    resolved = os.path.realpath(path)
    try:
        contained = os.path.commonpath([base, resolved]) == base
    except ValueError:
        contained = False
    if not contained:
        raise HTTPException(
            status_code=400,
            detail=(
                "Ingest path must stay inside the server root. "
                "Set MEMOS_INGEST_ROOT to widen it."
            ),
        )
    return resolved


@router.post("/ingest", summary="Ingest documents into memory")
async def ingest_documents(req: IngestRequest):
    """Ingest a file or folder (Markdown, HTML, PDF) incrementally."""
    path = _safe_ingest_path(req.path)
    params: dict[str, Any] = {"path": path}
    if req.namespace:
        params["namespace"] = req.namespace
    if req.chunk_chars:
        params["chunkChars"] = req.chunk_chars
    if req.extensions:
        params["extensions"] = req.extensions
    return _rpc_call("ingest", params)


# ---------------------------------------------------------------------------
# Image memory
# ---------------------------------------------------------------------------


def _safe_image_path(path: str) -> str:
    """Keep the HTTP image path endpoint inside the server's working dir."""
    base = os.path.realpath(os.getcwd())
    resolved = os.path.realpath(path)
    try:
        contained = os.path.commonpath([base, resolved]) == base
    except ValueError:
        contained = False
    if not contained:
        raise HTTPException(
            status_code=400,
            detail="Image path must stay inside the server working directory; "
            "use base64 for external images.",
        )
    return resolved


@router.post("/image/add", summary="Store an image memory")
async def image_add(req: ImageAddRequest):
    """Store an image with a caption; requires MEMOS_VISION=1."""
    if req.path:
        image_input = _safe_image_path(req.path)
    elif req.base64_data:
        image_input = f"data:{req.mime};base64,{req.base64_data}"
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide either 'path' or 'base64' image data.",
        )
    opts: dict[str, Any] = {
        "caption": req.caption,
        "kind": req.kind,
        "tags": req.tags,
    }
    if req.namespace is not None:
        opts["namespace"] = req.namespace
    return _rpc_call("imageAdd", {"input": image_input, "opts": opts})


@router.post("/image/search", summary="Search image memories")
async def image_search(req: ImageSearchRequest):
    """Caption search always works; CLIP pixel search needs MEMOS_VISION_CLIP=1."""
    opts: dict[str, Any] = {
        "limit": req.limit,
        "threshold": req.threshold,
    }
    if req.namespace is not None:
        opts["namespace"] = req.namespace
    if req.kind is not None:
        opts["kind"] = req.kind
    return _rpc_call("imageSearch", {"query": req.query, "opts": opts})


@router.get("/image/{ref}", summary="Retrieve image bytes")
async def image_recall(ref: str):
    """Resolve an `img_...` ref or node id to its original bytes."""
    result = _rpc_call("imageRecall", {"ref": ref})
    if not result:
        raise HTTPException(status_code=404, detail="Image not found.")
    return Response(
        content=base64.b64decode(result["data"]),
        media_type=result.get("mime", "image/png"),
    )
