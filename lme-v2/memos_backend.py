"""
LongMemEval-V2 memory backend for MemOS.

Drop this file into the official LongMemEval-V2 repository as
`memory_modules/memos_backend.py`, import it once, and point the harness at a
memory config with `"memory_type": "memos"`.

The backend keeps one persistent Node bridge process per memory instance. The
bridge owns the SQLite database and exposes the MemOS TypeScript SDK through a
JSON-lines protocol, so the Python harness gets:

  * trajectory-level notes (goals, outcomes, action sequences)
  * per-state event memories with AXTree text and screenshot paths
  * procedure and gotcha notes for workflow/environment questions
  * token-budgeted context packs with [mem:hex] citations
  * screenshot evidence returned as image context items

The bridge source is embedded by `build_bundle.py` for the leaderboard's
single-code-file requirement. During development the sibling `bridge.mjs` is
used directly.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from collections import deque
from pathlib import Path
from typing import Any

try:
    from .memory import (
        Memory,
        MemoryContextItem,
        register_memory,
        require,
    )
except ImportError:  # pragma: no cover - only for direct script tests

    class Memory:  # type: ignore[no-redef]
        memory_type = ""

        def __init__(self, memory_params: dict[str, object]) -> None:
            self.memory_params = dict(memory_params)

    MemoryContextItem = dict[str, str]  # type: ignore[assignment,misc]

    def register_memory(cls):  # type: ignore[no-redef]
        return cls

    def require(condition: bool, message: str) -> None:  # type: ignore[no-redef]
        if not condition:
            raise RuntimeError(message)


BRIDGE_JS = "__MEMOS_BRIDGE_JS__"

DEFAULT_TOKEN_BUDGET = 120_000
DEFAULT_TOP_K = 20
DEFAULT_STATE_CHARS = 3_000
DEFAULT_NOTE_CHARS = 12_000
DEFAULT_PROCEDURE_CHARS = 6_000
DEFAULT_GOTCHA_CHARS = 6_000
DEFAULT_ELEMENTS_CHARS = 1_500

NOTE_SYSTEM_PROMPT = (
    "You convert one UI task trajectory into two reusable memory notes for a "
    "future agent that will see only these notes and some raw states. "
    "Preserve the workflow and the highest-value reusable facts from the "
    "touched pages. Write procedure_note (the reliable core steps) and "
    "hint_note (durable facts, option sets, pitfalls, absent functionality, "
    "distinctions between easily confused controls). Use only evidence "
    "grounded in the goal, outcome, actions and state text. Do not invent "
    "fields, filters, modules or outcomes. If the run failed, describe the "
    "intended workflow only where the evidence supports it. "
    'Return JSON only: {"procedure_note":{"title":"...","description":"...",'
    '"content":"- ..."},"hint_note":{"title":"...","description":"...",'
    '"content":"- ..."}}'
)

DECOMPOSE_SYSTEM_PROMPT = (
    "You write retrieval queries for a memory of web-agent trajectories. "
    'Return JSON only: {"queries":["..."]}. '
    "Emit at most 3 short, concrete queries. Target distinct surfaces or "
    "entities when the question compares things; otherwise one query is "
    "enough. Keep exact UI labels, module names and entity names from the "
    "question. Never answer the question."
)

PREMISE_SYSTEM_PROMPT = (
    "You check whether retrieved memory evidence supports the premise of a "
    'question. Return JSON only: {"verdict":"supported"|"unsupported"|'
    '"contradicted","reason":"..."}. '
    "Use 'contradicted' only when the evidence shows the premise is false "
    "(a claimed control, field or step does not exist). Use 'unsupported' "
    "when the evidence is silent. Use 'supported' when the evidence confirms "
    "the premise. Be strict: absence of evidence is not support."
)
DEFAULT_MAX_IMAGES = 4


def _bridge_source() -> str:
    if not BRIDGE_JS.startswith("__MEMOS_BRIDGE_JS__"):
        return BRIDGE_JS
    candidate = Path(__file__).with_name("bridge.mjs")
    require(
        candidate.exists(),
        "bridge.mjs is missing; run lme-v2/build_bundle.py or keep it next to memos_backend.py",
    )
    return candidate.read_text(encoding="utf-8")


def _truncate(text: str, limit: int) -> str:
    text = str(text or "")
    if limit <= 0 or len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def _node_id(trajectory_id: str, kind: str, index: int | None = None) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in trajectory_id)[:96]
    suffix = f"_{index}" if index is not None else ""
    return f"lme_{safe}_{kind}{suffix}"


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_as_text(item) for item in value)
    return str(value)


def _extract_affordances(text: str, limit: int = 80) -> list[str]:
    """Pull the labelled controls out of an accessibility tree.

    Static and dynamic questions ask about buttons, menu items and field
    labels, and those labels are scattered through tens of thousands of
    characters of tree text. A short, label-only node embeds far better than
    the full tree and survives the per-state truncation.
    """
    pattern = re.compile(
        r"\[\d+\]\s+"
        r"(link|button|heading|textbox|combobox|checkbox|radio|menuitem|"
        r"tab|option|searchbox|listbox)\s+'([^']{1,120})'",
        re.IGNORECASE,
    )
    seen: set[tuple[str, str]] = set()
    items: list[str] = []
    for role, label in pattern.findall(text):
        # Icon fonts leave private-use glyphs in labels ("\ue604 DASHBOARD").
        # The dataset stores some of them as literal "\uXXXX" text, so strip
        # both the real codepoints and the escaped form.
        clean = re.sub(r"[\ue000-\uf8ff]|\\u[0-9a-fA-F]{4}", " ", label)
        clean = " ".join(clean.split())
        if not clean:
            continue
        key = (role.lower(), clean.lower())
        if key in seen:
            continue
        seen.add(key)
        items.append(f"{role.lower()} '{clean}'")
        if len(items) >= limit:
            break
    return items


def _collect_actions(trajectory: dict[str, Any], states: list[dict[str, Any]]) -> list[str]:
    explicit = [
        str(action)
        for action in trajectory.get("actions") or []
        if isinstance(action, str) and action.strip()
    ]
    if explicit:
        return explicit
    return [
        str(state["action"])
        for state in states
        if isinstance(state.get("action"), str) and state["action"].strip()
    ]


def _simplify_trajectory(trajectory: dict[str, Any]) -> dict[str, Any]:
    """Normalize the two public trajectory shapes into one simplified shape."""
    if isinstance(trajectory.get("states"), list) and trajectory["states"]:
        states = []
        for index, state in enumerate(trajectory["states"]):
            states.append(
                {
                    "state_index": index,
                    "step": state.get("step", index),
                    "url": _as_text(state.get("url")),
                    "action": state.get("action"),
                    "thoughts": state.get("thought", state.get("thoughts")),
                    "text": _as_text(state.get("accessibility_tree", state.get("text"))),
                    "screenshot": _as_text(state.get("screenshot")),
                }
            )
        return {
            "id": _as_text(trajectory.get("id")),
            "goal": _as_text(trajectory.get("goal")),
            "outcome": trajectory.get("outcome"),
            "start_url": _as_text(trajectory.get("start_url")),
            # The public trajectories carry actions per state, not as a
            # top-level list. The official normalizer derives the list this
            # way; the fallback must match it or procedure notes silently
            # disappear (they are only emitted when actions exist).
            "actions": _collect_actions(trajectory, states),
            "states": states,
        }

    content = trajectory.get("content")
    require(
        isinstance(content, list) and content,
        f"trajectory {trajectory.get('id')!r} has neither states nor content",
    )
    metadata = trajectory.get("metadata") or {}
    states = []
    actions: list[str] = []
    start_url = ""
    for index, state in enumerate(content):
        observation = state.get("observation") or {}
        url = _as_text(state.get("url"))
        if not start_url:
            start_url = url
        action = state.get("action")
        if isinstance(action, str) and action.strip():
            actions.append(action)
        states.append(
            {
                "state_index": index,
                "step": state.get("step", index),
                "url": url,
                "action": action,
                "thoughts": state.get("thoughts"),
                "text": _as_text(observation.get("text")),
                "screenshot": _as_text(observation.get("screenshot")),
            }
        )
    goal = metadata.get("original_goal")
    return {
        "id": _as_text(trajectory.get("id")),
        "goal": _as_text(goal),
        "outcome": trajectory.get("outcome"),
        "start_url": start_url,
        "actions": actions,
        "states": states,
    }


def _prepare_trajectory(
    trajectory: dict[str, Any],
    trajectories_root_dir: Path | None,
) -> tuple[dict[str, Any], list[str]]:
    """Use the official normalizer when available; otherwise fall back."""
    if trajectories_root_dir is not None:
        try:
            from .trajectory_store import prepare_trajectory_insert

            prepared = prepare_trajectory_insert(
                trajectory,
                trajectories_root_dir=trajectories_root_dir,
            )
            return prepared.simplified, [str(path) for path in prepared.screenshot_sources]
        except Exception as exc:
            # Synthetic tests and non-standard trajectory payloads can opt
            # into the loose normalizer. A real dataset failure (for example a
            # missing screenshot) must surface instead of silently indexing
            # relative paths.
            if os.getenv("MEMOS_LME_ALLOW_LOOSE") != "1":
                raise RuntimeError(
                    f"official trajectory normalization failed for {trajectory.get('id')!r}: {exc}"
                ) from exc
    simplified = _simplify_trajectory(trajectory)
    screenshots = [state["screenshot"] for state in simplified["states"]]
    return simplified, screenshots


def trajectory_to_nodes(
    trajectory: dict[str, Any],
    *,
    trajectories_root_dir: Path | None = None,
    state_chars: int = DEFAULT_STATE_CHARS,
    note_chars: int = DEFAULT_NOTE_CHARS,
    procedure_chars: int = DEFAULT_PROCEDURE_CHARS,
    gotcha_chars: int = DEFAULT_GOTCHA_CHARS,
    elements_chars: int = DEFAULT_ELEMENTS_CHARS,
    namespace: str = "lme-v2",
    ui_elements: bool = True,
    prepared: tuple[dict[str, Any], list[str]] | None = None,
) -> list[dict[str, Any]]:
    """Convert one trajectory into retrievable MemOS nodes.

    This is deliberately deterministic and local: no controller LLM is needed
    to ingest. The official RAG baseline uses an LLM to write procedure/hint
    notes; this adapter derives them from the goal/actions/outcome and keeps
    raw state evidence in the event pool.
    """
    if prepared is not None:
        simplified, screenshots = prepared
    else:
        simplified, screenshots = _prepare_trajectory(trajectory, trajectories_root_dir)
    trajectory_id = simplified["id"]
    require(bool(trajectory_id), "trajectory id must be non-empty")
    goal = simplified.get("goal") or "<goal not found>"
    outcome = simplified.get("outcome")
    start_url = simplified.get("start_url") or ""
    states = simplified.get("states") or []
    actions = simplified.get("actions") or []
    common = {
        "trajectoryId": trajectory_id,
        "goal": _truncate(goal, 1_000),
        "startUrl": start_url,
        "outcome": outcome,
        "environment": trajectory.get("environment"),
        "benchmark": "longmemeval-v2",
    }

    nodes: list[dict[str, Any]] = []

    note_lines = [
        f"Trajectory {trajectory_id}",
        f"Goal: {goal}",
        f"Start URL: {start_url}",
        f"Outcome: {outcome if outcome is not None else 'unknown'}",
        f"Steps: {len(states)}",
        "Action sequence:",
    ]
    for index, action in enumerate(actions[:120], start=1):
        note_lines.append(f"{index}. {action}")
    note_lines.append("State index:")
    for index, state in enumerate(states[:200]):
        note_lines.append(
            f"{index}. {state.get('url', '')} | {state.get('action') or '(no action)'}"
        )
    nodes.append(
        {
            "id": _node_id(trajectory_id, "note"),
            "content": _truncate("\n".join(note_lines), note_chars),
            "pool": "note",
            "type": "context",
            "namespace": namespace,
            "metadata": {**common, "kind": "trajectory_note"},
        }
    )

    if actions:
        procedure_lines = [
            f"Procedure for: {goal}",
            f"Start URL: {start_url}",
            "Use these steps when a future task matches this goal:",
        ]
        for index, action in enumerate(actions[:120], start=1):
            procedure_lines.append(f"{index}. {action}")
        nodes.append(
            {
                "id": _node_id(trajectory_id, "procedure"),
                "content": _truncate("\n".join(procedure_lines), procedure_chars),
                "pool": "procedure",
                "type": "relationship",
                "namespace": namespace,
                "metadata": {**common, "kind": "procedure_note"},
            }
        )

    gotcha_lines: list[str] = []
    for index, state in enumerate(states):
        text = str(state.get("text") or "")
        for line in text.splitlines():
            lowered = line.lower()
            if any(
                marker in lowered
                for marker in (
                    "error",
                    "failed",
                    "denied",
                    "captcha",
                    "timeout",
                    "blocked",
                    "not found",
                    "invalid",
                    "unavailable",
                )
            ):
                gotcha_lines.append(f"step {index}: {line.strip()[:300]}")
                if len(gotcha_lines) >= 40:
                    break
        if len(gotcha_lines) >= 40:
            break
    if gotcha_lines or outcome:
        gotcha_lines = [
            f"Trajectory: {trajectory_id}",
            f"Goal: {goal}",
            f"Outcome: {outcome if outcome is not None else 'unknown'}",
            "Failure/environment signals:",
            *gotcha_lines,
        ]
        nodes.append(
            {
                "id": _node_id(trajectory_id, "gotcha"),
                "content": _truncate("\n".join(gotcha_lines), gotcha_chars),
                "pool": "procedure",
                "type": "relationship",
                "namespace": namespace,
                "metadata": {**common, "kind": "gotcha_note"},
            }
        )

    for index, state in enumerate(states):
        text = str(state.get("text") or "")
        content_lines = [
            f"[Trajectory {trajectory_id} | step {index} | {state.get('step')}]",
            f"URL: {state.get('url', '')}",
            f"Action: {state.get('action') or '(none)'}",
        ]
        if state.get("thoughts"):
            content_lines.append(f"Thought: {state.get('thoughts')}")
        content_lines.append("State:")
        content_lines.append(text)
        screenshot = (
            screenshots[index]
            if index < len(screenshots) and screenshots[index]
            else state.get("screenshot")
        )
        nodes.append(
            {
                "id": _node_id(trajectory_id, "state", index),
                "content": _truncate("\n".join(content_lines), state_chars),
                "pool": "event",
                "type": "fact",
                "namespace": namespace,
                "metadata": {
                    **common,
                    "kind": "state",
                    "stateIndex": index,
                    "step": state.get("step"),
                    "url": state.get("url"),
                    "action": state.get("action"),
                    "thoughts": state.get("thoughts"),
                    "screenshot": str(screenshot) if screenshot else "",
                },
            }
        )

        # A label-only companion node: short, dense, and immune to the
        # per-state truncation that hides controls in long trees.
        if ui_elements:
            elements = _extract_affordances(text)
            if len(elements) >= 3:
                header = (
                    f"UI elements on {state.get('url', '')} "
                    f"(trajectory {trajectory_id}, step {state.get('step')}):"
                )
                nodes.append(
                    {
                        "id": _node_id(trajectory_id, "elements", index),
                        "content": _truncate("\n".join([header, *elements]), elements_chars),
                        "pool": "note",
                        "type": "context",
                        "namespace": namespace,
                        "metadata": {
                            **common,
                            "kind": "ui_elements",
                            "stateIndex": index,
                            "step": state.get("step"),
                            "url": state.get("url"),
                        },
                    }
                )

    return _with_environment_tags(nodes, trajectory)


def _partition_tags(trajectory: dict[str, Any]) -> list[str]:
    """Tags that partition the corpus the way questions are written.

    ``trajectory["environment"]`` is coarse ("webarena" covers three sites),
    so the site tag comes from the start URL. Enterprise has a single
    environment family and gets no site tag, which makes filtering a no-op
    there rather than a risk.

    Every node also carries a ``traj:<id>`` tag so retrieval can pull more
    states from an already-selected trajectory with one filtered search
    instead of a primary-key walk per state.
    """
    tags: list[str] = []
    trajectory_id = str(trajectory.get("id") or "").strip()
    if trajectory_id and all(ch.isalnum() or ch in {"-", "_"} for ch in trajectory_id):
        tags.append(f"traj:{trajectory_id}")
    environment = str(trajectory.get("environment") or "").strip()
    if environment:
        tags.append(f"env:{environment}")
    start_url = str(trajectory.get("start_url") or "")
    # WebArena site ports: 9080 forum (Postmill), 9082 shop (One Stop
    # Market), 9083 admin (Magento Admin).
    for port, site in ((":9080", "forum"), (":9082", "shop"), (":9083", "admin")):
        if port in start_url:
            tags.append(f"site:{site}")
            break
    return tags


def _with_environment_tags(
    nodes: list[dict[str, Any]], trajectory: dict[str, Any]
) -> list[dict[str, Any]]:
    tags = _partition_tags(trajectory)
    if tags:
        for node in nodes:
            node["tags"] = list(tags)
    return nodes


class Controller:
    """OpenAI-compatible chat client for the memory controller.

    The benchmark fixes the reader and judge but not the model that builds
    memory, so a controller may write notes, decompose queries, or check a
    question's premise. Every method returns ``None`` on failure: the adapter
    then falls back to its deterministic path.
    """

    def __init__(
        self,
        *,
        base_url: str = "",
        model: str = "",
        api_key: str = "",
        timeout: float = 90.0,
        max_tokens: int = 1_200,
    ) -> None:
        self.base_url = (
            base_url or os.getenv("MEMOS_CONTROLLER_BASE_URL") or "https://api.river.ai/v1"
        ).rstrip("/")
        self.model = (
            model or os.getenv("MEMOS_CONTROLLER_MODEL") or "deepseek-ai/DeepSeek-V4.1-Flash-1017"
        )
        self.api_key = api_key or _controller_key()
        self.timeout = float(os.getenv("MEMOS_CONTROLLER_TIMEOUT", timeout))
        self.max_tokens = int(os.getenv("MEMOS_CONTROLLER_MAX_TOKENS", max_tokens))
        self.calls = 0
        self.failures = 0

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    def chat(self, messages: list[dict[str, str]], **overrides: Any) -> str | None:
        if not self.enabled:
            return None
        payload = {
            "model": overrides.get("model", self.model),
            "messages": messages,
            "temperature": 0.0,
            "max_tokens": overrides.get("max_tokens", self.max_tokens),
        }
        request = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        self.calls += 1
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
            choices = body.get("choices") or []
            if not choices:
                self.failures += 1
                return None
            content = (choices[0].get("message") or {}).get("content")
            return content if isinstance(content, str) else None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            self.failures += 1
            return None

    def json_chat(self, messages: list[dict[str, str]], **overrides: Any) -> dict[str, Any] | None:
        text = self.chat(messages, **overrides)
        return _parse_json_object(text) if text else None


def _controller_key() -> str:
    key = os.getenv("MEMOS_CONTROLLER_API_KEY") or os.getenv("RIVER_API_KEY") or ""
    if key.strip():
        return key.strip()
    path = Path(
        os.getenv(
            "MEMOS_CONTROLLER_KEY_FILE",
            str(Path.home() / ".config" / "opencode" / "river.key"),
        )
    )
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return ""


def _parse_json_object(text: str) -> dict[str, Any] | None:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(cleaned[start : end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _as_flag(value: object) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() not in {"", "0", "false", "no", "off"}


def _note_digest(
    simplified: dict[str, Any], *, max_states: int = 20, state_chars: int = 700
) -> str:
    """Compact trajectory digest for the controller (bounded token cost)."""
    lines = [
        f"Goal: {simplified.get('goal') or ''}",
        f"Outcome: {simplified.get('outcome')}",
        f"Start URL: {simplified.get('start_url') or ''}",
        "Actions (in order):",
    ]
    for index, action in enumerate((simplified.get("actions") or [])[:60], start=1):
        lines.append(f"{index}. {action}")
    lines.append("States:")
    states = simplified.get("states") or []
    step = max(1, len(states) // max_states) if states else 1
    for index in range(0, len(states), step):
        state = states[index]
        text = str(state.get("text") or "").replace("\n", " ")[:state_chars]
        lines.append(f"[{index}] {state.get('url', '')} | action={state.get('action')}\n{text}")
    return "\n".join(lines)[:16_000]


def _controller_notes(controller: Any, simplified: dict[str, Any]) -> list[dict[str, Any]]:
    """Ask the controller for procedure/hint notes; [] on any failure."""
    reply = controller.json_chat(
        [
            {"role": "system", "content": NOTE_SYSTEM_PROMPT},
            {"role": "user", "content": _note_digest(simplified)},
        ],
        max_tokens=1_200,
    )
    if not reply:
        return []
    trajectory_id = str(simplified.get("id") or "")
    require(bool(trajectory_id), "trajectory id must be non-empty")
    notes: list[dict[str, Any]] = []
    for field, kind in (("procedure_note", "llm_procedure"), ("hint_note", "llm_hint")):
        note = reply.get(field)
        if not isinstance(note, dict):
            continue
        title = str(note.get("title") or "").strip()
        description = str(note.get("description") or "").strip()
        content = str(note.get("content") or "").strip()
        if not content:
            continue
        body = "\n".join(part for part in (title, description, content) if part)
        notes.append(
            {
                "id": _node_id(trajectory_id, kind),
                "content": body[:4_000],
                "pool": "note",
                "type": "context",
                "metadata": {
                    "trajectoryId": trajectory_id,
                    "goal": simplified.get("goal"),
                    "startUrl": simplified.get("start_url"),
                    "outcome": simplified.get("outcome"),
                    "environment": simplified.get("environment"),
                    "benchmark": "longmemeval-v2",
                    "kind": kind,
                },
                "tags": [f"traj:{trajectory_id}", "llm_note"],
            }
        )
    return notes


@register_memory
class MemosMemory(Memory):
    """MemOS-backed memory for LongMemEval-V2."""

    memory_type = "memos"

    def __init__(self, memory_params: dict[str, object]) -> None:
        super().__init__(memory_params)
        params = dict(memory_params)
        workspace = params.get("workspace_dir")
        require(
            isinstance(workspace, str) and workspace.strip(),
            "memos memory_params.workspace_dir is required",
        )
        self.workspace_dir = Path(workspace).expanduser().resolve()
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = Path(params.get("db_path") or (self.workspace_dir / "memos.db"))
        self.namespace = str(params.get("namespace") or "lme-v2")
        self.token_budget = int(params.get("token_budget") or DEFAULT_TOKEN_BUDGET)
        self.top_k = int(params.get("top_k") or DEFAULT_TOP_K)
        self.state_chars = int(params.get("state_chars") or DEFAULT_STATE_CHARS)
        self.note_chars = int(params.get("note_chars") or DEFAULT_NOTE_CHARS)
        self.procedure_chars = int(params.get("procedure_chars") or DEFAULT_PROCEDURE_CHARS)
        self.gotcha_chars = int(params.get("gotcha_chars") or DEFAULT_GOTCHA_CHARS)
        self.elements_chars = int(params.get("elements_chars") or DEFAULT_ELEMENTS_CHARS)
        ui = params.get("ui_elements")
        if ui is None:
            ui = os.getenv("MEMOS_LME_UI_ELEMENTS", "1")
        self.ui_elements = _as_flag(ui)
        self.max_images = int(params.get("max_images") or DEFAULT_MAX_IMAGES)
        # Slice radius for raw states: after a seed is retrieved, its
        # neighbouring steps ride along. The official RAG baseline uses 1.
        radius = params.get("neighbor_radius")
        if radius is None:
            radius = os.getenv("MEMOS_LME_NEIGHBOR_RADIUS", "0")
        self.neighbor_radius = max(0, int(radius))
        strip = params.get("strip_preamble")
        if strip is None:
            strip = os.getenv("MEMOS_LME_STRIP_PREAMBLE", "0")
        self.strip_preamble = _as_flag(strip)
        env_filter = params.get("env_filter")
        if env_filter is None:
            env_filter = os.getenv("MEMOS_LME_ENV_FILTER", "0")
        self.env_filter = _as_flag(env_filter)
        multi = params.get("multi_query")
        if multi is None:
            multi = os.getenv("MEMOS_LME_MULTI_QUERY", "0")
        self.multi_query = _as_flag(multi)
        rescue = params.get("within_trajectory_rescue")
        if rescue is None:
            rescue = os.getenv("MEMOS_LME_RESCUE", "0")
        self.within_trajectory_rescue = _as_flag(rescue)
        self.query_mode = str(params.get("query_mode") or os.getenv("MEMOS_LME_QUERY_MODE", "full"))
        self.low_confidence_note = _as_flag(
            params.get("low_confidence_note")
            if params.get("low_confidence_note") is not None
            else os.getenv("MEMOS_LME_LOW_CONFIDENCE_NOTE", "0")
        )
        self.confidence_threshold = float(
            params.get("confidence_threshold") or os.getenv("MEMOS_LME_CONFIDENCE_THRESHOLD", "0")
        )
        self.checkpoint_every = int(
            params.get("checkpoint_every") or os.getenv("MEMOS_LME_CHECKPOINT_EVERY") or 25
        )
        self.checkpoint_path = self.workspace_dir / "checkpoint.db"
        # A checkpoint is a recovery copy, not the primary store. If the main
        # DB is missing (crash during setup), start from the last snapshot.
        if not self.db_path.exists() and self.checkpoint_path.exists():
            shutil.copy2(self.checkpoint_path, self.db_path)
        root = params.get("trajectories_root_dir")
        self.trajectories_root_dir = Path(str(root)).expanduser().resolve() if root else None
        self.embedding_base_url = str(
            params.get("embedding_base_url") or os.getenv("LME_EMBEDDING_BASE_URL") or ""
        ).strip()
        self.embedding_provider = str(
            params.get("embedding_provider") or os.getenv("MEMOS_EMBEDDING_PROVIDER") or "model2vec"
        ).strip()
        self.embedding_model = str(
            params.get("embedding_model")
            or os.getenv("LME_EMBEDDING_MODEL")
            or "Qwen/Qwen3-Embedding-8B"
        ).strip()
        self.embedding_dimensions = int(
            params.get("embedding_dimensions") or os.getenv("MEMOS_EMBEDDING_DIMENSIONS") or 4096
        )
        self.node_binary = str(os.getenv("MEMOS_NODE_BINARY", "node"))
        self._proc: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        # Per-query debug rows (ids/tokens) for local retrieval analysis.
        # The harness only sees MemoryContextItem; this never leaves the
        # adapter.
        self.last_debug: list[dict[str, object]] = []
        self.last_premise: dict[str, object] = {}
        self._stderr_tail: deque[str] = deque(maxlen=80)
        self._stderr_thread: threading.Thread | None = None
        self._inserted = 0
        # Controller-side features are opt-in and fail closed: if no key is
        # configured, the adapter behaves exactly as before.
        self.controller = Controller(
            base_url=str(params.get("controller_base_url") or ""),
            model=str(params.get("controller_model") or ""),
            api_key=str(params.get("controller_api_key") or ""),
        )
        self.controller_notes = (
            _as_flag(
                params.get("controller_notes")
                if params.get("controller_notes") is not None
                else os.getenv("MEMOS_LME_CONTROLLER_NOTES", "0")
            )
            and self.controller.enabled
        )
        self.controller_decompose = (
            _as_flag(
                params.get("controller_decompose")
                if params.get("controller_decompose") is not None
                else os.getenv("MEMOS_LME_CONTROLLER_DECOMPOSE", "0")
            )
            and self.controller.enabled
        )
        self.controller_premise = (
            _as_flag(
                params.get("controller_premise")
                if params.get("controller_premise") is not None
                else os.getenv("MEMOS_LME_CONTROLLER_PREMISE", "0")
            )
            and self.controller.enabled
        )

    # ---- process lifecycle -------------------------------------------------

    def _bridge_path(self) -> Path:
        path = self.workspace_dir / "_memos_bridge.mjs"
        path.write_text(_bridge_source(), encoding="utf-8")
        return path

    def _embedding_config(self) -> dict[str, Any]:
        if os.getenv("MEMOS_EMBEDDINGS", "").lower() in {"0", "false", "off"}:
            return {"enabled": False}
        if self.embedding_base_url:
            return {
                "provider": "openai-compatible",
                "baseUrl": self.embedding_base_url,
                "model": self.embedding_model,
                "dimensions": self.embedding_dimensions,
            }
        return {"provider": self.embedding_provider}

    def _ensure_bridge(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        bridge = self._bridge_path()
        env = dict(os.environ)
        # The bridge imports @mem-os/sdk from its own cwd. Point it at a local
        # checkout with MEMOS_SDK_PATH when running unreleased source.
        self._proc = subprocess.Popen(
            [self.node_binary, str(bridge)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
            cwd=str(self.workspace_dir),
            env=env,
        )
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr,
            args=(self._proc,),
            daemon=True,
        )
        self._stderr_thread.start()
        self._call(
            {
                "op": "init",
                "dbPath": str(self.db_path),
                "namespace": self.namespace,
                "tokenBudget": self.token_budget,
                "topK": self.top_k,
                "embeddings": self._embedding_config(),
            },
            timeout=300.0,
        )

    def _drain_stderr(self, proc: subprocess.Popen[str]) -> None:
        if proc.stderr is None:
            return
        for line in proc.stderr:
            line = line.rstrip()
            self._stderr_tail.append(line)
            if os.getenv("MEMOS_LME_DEBUG") == "1":
                print(f"[memos-bridge] {line}", file=sys.stderr)

    def _call(self, payload: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        with self._lock:
            if self._proc is None or self._proc.poll() is not None:
                raise RuntimeError("MemOS bridge is not running. Check `node` and @mem-os/sdk.")
            require(self._proc.stdin is not None, "bridge stdin unavailable")
            require(self._proc.stdout is not None, "bridge stdout unavailable")
            self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._proc.stdin.flush()
            _ = timeout  # kept for call-site documentation / future deadlines
            line = self._proc.stdout.readline()
            if line == "":
                tail = "\n".join(self._stderr_tail)
                raise RuntimeError(
                    "MemOS bridge exited unexpectedly." + (f"\n{tail}" if tail else "")
                )
            response = json.loads(line)
            if response.get("ok"):
                return response
            raise RuntimeError(
                f"MemOS bridge error: {response.get('error')}"
                + (f"\n{response.get('stack')}" if response.get("stack") else "")
            )

    # ---- LME-V2 Memory API -------------------------------------------------

    def configure_runtime(self, **kwargs: object) -> None:
        _ = kwargs
        self._ensure_bridge()

    def _checkpoint(self) -> None:
        """Snapshot the DB without losing the live bridge.

        The bridge's `save` closes SQLite and exits; restart it immediately so
        the next insert continues on the same database. The checkpoint is a
        recovery copy for a crashed run.
        """
        if self.checkpoint_every <= 0:
            return
        if self._proc is None or self._proc.poll() is not None:
            return
        proc = self._proc
        self._call(
            {"op": "save", "path": str(self.checkpoint_path)},
            timeout=600.0,
        )
        proc.wait(timeout=30)
        self._proc = None
        self._ensure_bridge()

    def insert(self, trajectory: dict[str, object]) -> None:
        self._ensure_bridge()
        prepared = _prepare_trajectory(trajectory, self.trajectories_root_dir)
        nodes = trajectory_to_nodes(
            trajectory,
            trajectories_root_dir=self.trajectories_root_dir,
            state_chars=self.state_chars,
            note_chars=self.note_chars,
            procedure_chars=self.procedure_chars,
            gotcha_chars=self.gotcha_chars,
            elements_chars=self.elements_chars,
            namespace=self.namespace,
            ui_elements=self.ui_elements,
            prepared=prepared,
        )
        if self.controller_notes:
            generated = _controller_notes(self.controller, prepared[0])
            extra_tags = _partition_tags(trajectory)
            for note in generated:
                note["tags"] = list(dict.fromkeys([*note.get("tags", []), *extra_tags]))
            nodes.extend(generated)
        for start in range(0, len(nodes), 100):
            self._call(
                {
                    "op": "insert",
                    "nodes": nodes[start : start + 100],
                    "concurrency": int(os.getenv("MEMOS_LME_INGEST_CONCURRENCY", "8")),
                },
                timeout=600.0,
            )
        self._inserted += 1
        if self.checkpoint_every > 0 and self._inserted % self.checkpoint_every == 0:
            self._checkpoint()

    def query(
        self,
        query: str,
        query_image: str | None = None,
    ) -> list[MemoryContextItem]:
        self._ensure_bridge()
        require(isinstance(query, str) and query.strip(), "query must be non-empty")
        queries = self._decompose(query)
        response = self._call(
            {
                "op": "query",
                "query": query,
                "queries": queries,
                "queryImage": query_image,
                "tokenBudget": self.token_budget,
                "topK": self.top_k,
                "maxImages": self.max_images,
                "neighborRadius": self.neighbor_radius,
                "stripPreamble": self.strip_preamble,
                "envFilter": self.env_filter,
                "multiQuery": self.multi_query,
                "withinTrajectoryRescue": self.within_trajectory_rescue,
                "queryMode": self.query_mode,
                "lowConfidenceNote": self.low_confidence_note,
                "confidenceThreshold": self.confidence_threshold,
            },
            timeout=300.0,
        )
        items = response.get("items") or []
        self.last_debug = [row for row in (response.get("debug") or []) if isinstance(row, dict)]
        items = self._premise_check(query, items)
        return [
            {"type": item["type"], "value": item["value"]}
            for item in items
            if isinstance(item, dict)
            and item.get("type") in {"text", "image"}
            and isinstance(item.get("value"), str)
            and item["value"].strip()
        ]

    def _decompose(self, query: str) -> list[str]:
        """Controller-written retrieval queries; empty means 'use the original'."""
        if not self.controller_decompose:
            return []
        reply = self.controller.json_chat(
            [
                {"role": "system", "content": DECOMPOSE_SYSTEM_PROMPT},
                {"role": "user", "content": f"Question: {query}"},
            ],
            max_tokens=250,
        )
        if not reply:
            return []
        raw = reply.get("queries")
        if not isinstance(raw, list):
            return []
        queries = [str(item).strip() for item in raw if str(item).strip()]
        return queries[:3]

    def _premise_check(self, query: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Prepend a support verdict when the evidence contradicts the premise.

        AgentRunbook's error analysis found RAG-style memory *hurts* abstention
        because the reader follows the premise anyway; their coding-agent
        variant fixes it by reporting the contradiction explicitly.
        """
        if not self.controller_premise or not items:
            return items
        self.last_premise = {}
        evidence = "\n".join(
            str(item.get("value") or "") for item in items if item.get("type") == "text"
        )[:8_000]
        if not evidence.strip():
            return items
        reply = self.controller.json_chat(
            [
                {"role": "system", "content": PREMISE_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": f"Question: {query}\n\nEvidence:\n{evidence}",
                },
            ],
            max_tokens=250,
        )
        if not reply:
            return items
        verdict = str(reply.get("verdict") or "").strip().lower()
        reason = str(reply.get("reason") or "").strip()
        self.last_premise = {"verdict": verdict, "reason": reason[:300]}
        if verdict in {"unsupported", "contradicted"}:
            note = f"Support check: {verdict}. {reason}".strip()[:400]
            return [{"type": "text", "value": note}, *items]
        return items

    def post_query_hook(
        self,
        *,
        query: str,
        query_image: str | None,
        memory_context: list[MemoryContextItem],
    ) -> dict[str, object] | None:
        return {
            "memory_system": "memos",
            "context_items": len(memory_context),
            "query_image_used": bool(query_image),
            "token_budget": self.token_budget,
            "inserted_trajectories": self._inserted,
            "checkpoint_every": self.checkpoint_every,
        }

    def _save_backend(self, output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=True)
        target = output_dir / "memos.db"
        if self._proc is not None and self._proc.poll() is None:
            proc = self._proc
            self._call({"op": "save", "path": str(target)}, timeout=600.0)
            proc.wait(timeout=30)
            self._proc = None
        elif self.db_path.exists():
            shutil.copy2(self.db_path, target)

    def _load_backend(self, input_dir: Path) -> None:
        source = input_dir / "memos.db"
        require(source.exists(), f"Missing MemOS snapshot: {source}")
        self.workspace_dir = input_dir
        self.db_path = source
        self._proc = None
        self._ensure_bridge()

    def close(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            proc = self._proc
            try:
                self._call({"op": "close"}, timeout=30.0)
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
                proc.wait(timeout=10)
            finally:
                self._proc = None
