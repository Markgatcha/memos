"""Unit tests for the LME-V2 adapter's dataset-specific assumptions.

The site partition is the one place the adapter hard-codes knowledge of the
benchmark corpus, so it gets a direct test: a wrong mapping would silently
return evidence from the wrong site.
"""

from __future__ import annotations

import sys
from pathlib import Path

LME = Path(__file__).resolve().parents[1] / "lme-v2"
if str(LME) not in sys.path:
    sys.path.insert(0, str(LME))

from memos_backend import (  # noqa: E402
    Controller,
    _extract_affordances,
    _node_id,
    _note_digest,
    _parse_json_object,
    _partition_tags,
    _simplify_trajectory,
)


def test_partition_tags_map_webarena_ports_to_sites() -> None:
    assert _partition_tags({"environment": "webarena", "start_url": "http://localhost:9080/"}) == [
        "env:webarena",
        "site:forum",
    ]
    assert _partition_tags(
        {"environment": "webarena", "start_url": "http://localhost:9082/product"}
    ) == ["env:webarena", "site:shop"]
    assert _partition_tags(
        {"environment": "webarena", "start_url": "http://localhost:9083/admin/"}
    ) == ["env:webarena", "site:admin"]


def test_partition_tags_leave_enterprise_unpartitioned() -> None:
    # Enterprise is a single environment family; adding a site tag there would
    # let a wrong keyword drop every candidate.
    assert _partition_tags(
        {
            "environment": "workarena",
            "start_url": "https://empmassimo20.service-now.com/",
        }
    ) == ["env:workarena"]


def test_node_ids_are_deterministic_for_neighbour_lookup() -> None:
    assert _node_id("00c06bce", "state", 3) == "lme_00c06bce_state_3"
    assert _node_id("a/b c", "note") == "lme_a_b_c_note"


def test_simplify_collects_per_state_actions() -> None:
    # The public trajectories have no top-level "actions" list. Without this,
    # trajectory_to_nodes emits no procedure note at all.
    trajectory = {
        "id": "t1",
        "goal": "g",
        "outcome": "success",
        "start_url": "http://x",
        "states": [
            {"url": "http://x", "action": "click('A')", "accessibility_tree": "a"},
            {"url": "http://y", "action": None, "accessibility_tree": "b"},
            {"url": "http://z", "action": "fill('B')", "accessibility_tree": "c"},
        ],
    }
    simplified = _simplify_trajectory(trajectory)
    assert simplified["actions"] == ["click('A')", "fill('B')"]


def test_affordance_extraction_strips_icon_glyphs() -> None:
    tree = (
        "[141] link 'Magento Admin Panel', clickable\n"
        "[146] link '\\ue604 DASHBOARD', clickable\n"
        "[638] button 'System Messages: 2', clickable\n"
        "[662] heading 'Low Stock Report'\n"
        "[146] link '\\ue604 DASHBOARD', clickable\n"
    )
    assert _extract_affordances(tree) == [
        "link 'Magento Admin Panel'",
        "link 'DASHBOARD'",
        "button 'System Messages: 2'",
        "heading 'Low Stock Report'",
    ]


def test_partition_tags_include_trajectory_tag() -> None:
    # The rescue search filters on traj:<id>; without it the search has no way
    # to stay inside an already-selected trajectory.
    tags = _partition_tags(
        {
            "id": "00c06bce",
            "environment": "webarena",
            "start_url": "http://localhost:9082/",
        }
    )
    assert tags == ["traj:00c06bce", "env:webarena", "site:shop"]


def test_controller_json_parsing_is_tolerant() -> None:
    assert _parse_json_object('{"a": 1}') == {"a": 1}
    assert _parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert _parse_json_object('here: {"a": 1} done') == {"a": 1}
    assert _parse_json_object("not json") is None


def test_note_digest_includes_actions_and_is_bounded() -> None:
    simplified = {
        "id": "t1",
        "goal": "reset the router",
        "outcome": "success",
        "start_url": "http://router.local",
        "actions": [f"click({i})" for i in range(80)],
        "states": [
            {
                "url": f"http://router.local/{i}",
                "action": f"click({i})",
                "text": "x" * 2_000,
            }
            for i in range(40)
        ],
    }
    digest = _note_digest(simplified)
    assert "click(0)" in digest
    assert len(digest) <= 16_000


def test_controller_disabled_without_key(monkeypatch) -> None:
    monkeypatch.delenv("MEMOS_CONTROLLER_API_KEY", raising=False)
    monkeypatch.delenv("RIVER_API_KEY", raising=False)
    monkeypatch.setenv("MEMOS_CONTROLLER_KEY_FILE", "C:/nonexistent/river.key")
    controller = Controller()
    assert controller.enabled is False
    assert controller.chat([{"role": "user", "content": "hi"}]) is None
