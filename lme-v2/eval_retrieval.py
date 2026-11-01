#!/usr/bin/env python3
"""Retrieval-only evaluation of the MemOS LME-V2 adapter on the real dataset.

Why this exists: the official harness measures end-to-end answer accuracy and
needs a reader model plus a judge. That makes every retrieval change expensive
to evaluate. This script keeps the same ingest path and the same ``query`` call
but scores what actually matters for retrieval: whether the reference answer is
present in the returned context.

Scored question types (the answer is a concrete phrase or a multiple-choice
option, so presence is checkable):

- ``norm_phrase_set_match`` / ``norm_phrase_set_match_ordered``
- ``mc_choice_match`` / ``mc_choice_set_match``

Not scored (they need the LLM judge): ``llm_abstention_checker`` and
``llm_gotchas_checker``. They are counted and reported separately so the
scored subset is never mistaken for the full benchmark.

This is a proxy, not a leaderboard number. It measures recall of the answer
string, which bounds what the reader can copy; it cannot tell you whether the
reader reasoned correctly over it.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

DEFAULT_DATA_ROOT = os.getenv("LME_DATA_ROOT", str(Path.home() / "memos-data" / "lme-v2"))

PHRASE_EVALS = {"norm_phrase_set_match", "norm_phrase_set_match_ordered"}
CHOICE_EVALS = {"mc_choice_match", "mc_choice_set_match"}
UNSCORED_PREFIXES = ("llm_abstention_checker", "llm_gotchas_checker")

PROFILES = {
    "fast": {"token_budget": 40_000, "top_k": 12, "state_chars": 4_000},
    "balanced": {"token_budget": 120_000, "top_k": 20, "state_chars": 6_000},
    "accurate": {"token_budget": 200_000, "top_k": 40, "state_chars": 8_000},
}


def normalize(text: str) -> str:
    """Lowercase, unify hyphens, drop punctuation, collapse whitespace."""
    text = text.lower().replace("-", " ")
    text = re.sub(r"[^0-9a-z\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def contains_phrase(haystack: str, phrase: str) -> bool:
    needle = normalize(phrase)
    if not needle:
        return False
    # Normalize the haystack too: callers pass raw context, and padding with
    # spaces keeps "300" from matching inside "3000".
    return f" {needle} " in f" {normalize(haystack)} "


def split_phrases(answer: str, eval_function: str) -> list[str]:
    separators = ";"
    match = re.search(r"separators=([^|]+)", eval_function)
    if match:
        separators = match.group(1)
    parts = [answer]
    for separator in separators:
        next_parts: list[str] = []
        for part in parts:
            next_parts.extend(part.split(separator))
        parts = next_parts
    return [part.strip() for part in parts if part.strip()]


def parse_choices(question: str) -> dict[str, str]:
    """Extract ``A. option text`` lines from a multiple-choice question."""
    choices: dict[str, str] = {}
    for line in question.splitlines():
        match = re.match(r"^\s*([A-H])\.\s*(.+?)\s*$", line)
        if match:
            choices[match.group(1)] = match.group(2)
    return choices


def eval_name(eval_function: str) -> str:
    return eval_function.split("|", 1)[0]


def answer_phrases(question: dict[str, Any]) -> tuple[list[str], str]:
    """Return the strings that must appear, and the scoring mode."""
    name = eval_name(question["eval_function"])
    if name in PHRASE_EVALS:
        return split_phrases(question["answer"], question["eval_function"]), "phrase"
    if name in CHOICE_EVALS:
        answer = str(question["answer"]).strip().upper()
        choices = parse_choices(question["question"])
        if answer and answer[0] in choices:
            return [choices[answer[0]]], "choice"
        return [], "choice-unparsed"
    return [], "unscored"


def rank_metrics(item_texts: list[str], phrases: list[str]) -> tuple[int | None, int | None]:
    """First rank with any phrase, and the rank where all phrases are present."""
    if not phrases:
        return None, None
    found: set[int] = set()
    first_any: int | None = None
    for rank, text in enumerate(item_texts, start=1):
        normalized = normalize(text)
        hit = False
        for index, phrase in enumerate(phrases):
            if index in found:
                continue
            needle = normalize(phrase)
            if needle and f" {needle} " in f" {normalized} ":
                found.add(index)
                hit = True
        if hit and first_any is None:
            first_any = rank
        if len(found) == len(phrases):
            return first_any, rank
    return first_any, None


def score_question(
    question: dict[str, Any],
    context: str,
) -> tuple[float, bool, str]:
    """Return (phrase coverage, all present, how it was scored)."""
    phrases, mode = answer_phrases(question)
    if mode == "choice-unparsed":
        return 0.0, False, mode
    if mode == "unscored" or not phrases:
        return 0.0, False, "unscored" if mode == "unscored" else "empty"
    found = [contains_phrase(context, phrase) for phrase in phrases]
    return sum(found) / len(found), all(found), mode


def load_questions(data_root: Path) -> list[dict[str, Any]]:
    path = data_root / "questions.jsonl"
    if not path.exists():
        raise SystemExit(f"missing {path}")
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def load_haystack(data_root: Path, tier: str) -> dict[str, list[str]]:
    path = data_root / "haystacks" / f"lme_v2_{tier}.json"
    if not path.exists():
        raise SystemExit(f"missing {path}")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_trajectories(data_root: Path, wanted: set[str]) -> list[dict[str, Any]]:
    path = data_root / "trajectories.jsonl"
    if not path.exists():
        raise SystemExit(f"missing {path}")
    found: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            trajectory = json.loads(line)
            if str(trajectory.get("id")) in wanted:
                found.append(trajectory)
                if len(found) == len(wanted):
                    break
    return found


def build_memory(
    workspace: Path,
    profile: str,
    state_chars: int | None,
    token_budget: int | None,
    top_k: int | None,
    neighbor_radius: int | None = None,
    strip_preamble: bool = False,
    env_filter: bool = False,
    multi_query: bool = False,
    ui_elements: bool = True,
    query_mode: str = "full",
    rescue: bool = False,
    controller_notes: bool = False,
    controller_decompose: bool = False,
    controller_premise: bool = False,
):
    from memos_backend import MemosMemory

    params = dict(PROFILES[profile])
    if state_chars is not None:
        params["state_chars"] = state_chars
    if token_budget is not None:
        params["token_budget"] = token_budget
    if top_k is not None:
        params["top_k"] = top_k
    if neighbor_radius is not None:
        params["neighbor_radius"] = neighbor_radius
    memory = MemosMemory(
        {
            "workspace_dir": str(workspace),
            "checkpoint_every": 0,
            "strip_preamble": strip_preamble,
            "env_filter": env_filter,
            "multi_query": multi_query,
            "ui_elements": ui_elements,
            "query_mode": query_mode,
            "within_trajectory_rescue": rescue,
            "controller_notes": controller_notes,
            "controller_decompose": controller_decompose,
            "controller_premise": controller_premise,
            **params,
        }
    )
    memory.configure_runtime()
    return memory


def detect_environment(text: str) -> str | None:
    """Map the question's opening boilerplate to a dataset environment label.

    Questions are formulaic ("I am working with our ServiceNow portal"), and
    the corpus contains three web environments plus one enterprise
    environment, so a deterministic rule is enough to measure how much
    cross-environment noise retrieval is returning.
    """
    lowered = text.lower()
    if "servicenow" in lowered:
        return "workarena"
    if "reddit" in lowered or "forum" in lowered:
        return "webarena-reddit"
    if "shopping admin" in lowered or "admin dashboard" in lowered:
        return "webarena-cms"
    if "shopping website" in lowered or "shopping site" in lowered:
        return "webarena-onestopshop"
    return None


def run_domain(
    data_root: Path,
    domain: str,
    questions: list[dict[str, Any]],
    haystack: dict[str, list[str]],
    args: argparse.Namespace,
) -> list[dict[str, Any]]:
    wanted: set[str] = set()
    for question in questions:
        wanted.update(haystack.get(question["id"], []))
    print(f"[{domain}] {len(questions)} questions over {len(wanted)} trajectories")
    trajectories = load_trajectories(data_root, wanted)
    missing = wanted - {str(t.get("id")) for t in trajectories}
    if missing:
        print(f"[{domain}] WARNING {len(missing)} haystack ids missing from data")

    workspace = Path(args.workspace) / domain
    workspace.mkdir(parents=True, exist_ok=True)
    marker = workspace / ".ingested"
    memory = build_memory(
        workspace,
        args.profile,
        args.state_chars,
        args.token_budget,
        args.top_k,
        args.neighbor_radius,
        args.strip_preamble,
        args.env_filter,
        args.multi_query,
        args.ui_elements if args.ui_elements is not None else domain == "web",
        args.query_mode,
        args.rescue,
        args.controller_notes,
        args.controller_decompose,
        args.controller_premise,
    )
    try:
        started = time.time()
        # MemosMemory opens the DB eagerly, so the DB existing is not proof
        # that anything was ingested. Use an explicit marker.
        already = marker.exists() and not args.reingest
        if not already:
            for index, trajectory in enumerate(trajectories, start=1):
                memory.insert(trajectory)
                if index % 20 == 0:
                    print(f"[{domain}] ingested {index}/{len(trajectories)}")
            marker.write_text(str(len(trajectories)), encoding="utf-8")
        print(f"[{domain}] ingest {time.time() - started:.1f}s")

        results: list[dict[str, Any]] = []
        for index, question in enumerate(questions, start=1):
            began = time.time()
            items = memory.query(question["question"])
            elapsed = time.time() - began
            texts = [
                item["value"]
                for item in items
                if item["type"] == "text" and not item["value"].startswith("Support check:")
            ]
            context = "\n".join(texts)
            coverage, complete, mode = score_question(question, context)
            phrases, _ = answer_phrases(question)
            first_any, complete_rank = rank_metrics(texts, phrases)
            scores = [
                row.get("score")
                for row in memory.last_debug
                if row.get("type") == "text" and isinstance(row.get("score"), (int, float))
            ]
            results.append(
                {
                    "id": question["id"],
                    "domain": domain,
                    "type": question["question_type"],
                    "mode": mode,
                    "environment": detect_environment(question["question"]),
                    "coverage": coverage,
                    "complete": complete,
                    "first_any_rank": first_any,
                    "complete_rank": complete_rank,
                    "items": len(items),
                    "item_ids": [row.get("id", "") for row in memory.last_debug],
                    "context_chars": len(context),
                    "context_tokens": len(context) // 4,
                    "top_score": max(scores) if scores else None,
                    "premise": getattr(memory, "last_premise", {}),
                    "latency_s": round(elapsed, 3),
                }
            )
            if index % 25 == 0:
                print(f"[{domain}] queried {index}/{len(questions)}")
        return results
    finally:
        memory.close()


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [row for row in results if row["mode"] in {"phrase", "choice"}]
    by_type: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in scored:
        by_type[row["type"]].append(row)

    def stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
        if not rows:
            return {}
        ranks = [r["first_any_rank"] for r in rows if r["first_any_rank"]]
        complete_ranks = [r["complete_rank"] for r in rows if r["complete_rank"]]
        return {
            "n": len(rows),
            "complete_rate": round(sum(r["complete"] for r in rows) / len(rows), 4),
            "coverage": round(sum(r["coverage"] for r in rows) / len(rows), 4),
            "mrr": round(sum(1 / rank for rank in ranks) / len(rows), 4),
            "complete_in_top5": round(
                sum(1 for r in rows if r["complete_rank"] and r["complete_rank"] <= 5) / len(rows),
                4,
            ),
            "complete_in_top10": round(
                sum(1 for r in rows if r["complete_rank"] and r["complete_rank"] <= 10) / len(rows),
                4,
            ),
            "median_complete_rank": sorted(complete_ranks)[len(complete_ranks) // 2]
            if complete_ranks
            else None,
            "avg_context_tokens": int(sum(r["context_tokens"] for r in rows) / len(rows)),
            "avg_latency_s": round(sum(r["latency_s"] for r in rows) / len(rows), 3),
        }

    return {
        "scored": stats(scored),
        "by_type": {name: stats(rows) for name, rows in sorted(by_type.items())},
        "unscored": len(results) - len(scored),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", default=DEFAULT_DATA_ROOT)
    parser.add_argument("--tier", choices=["small", "medium"], default="small")
    parser.add_argument("--domain", choices=["web", "enterprise", "both"], default="both")
    parser.add_argument("--profile", choices=sorted(PROFILES), default="balanced")
    parser.add_argument("--state-chars", type=int, default=None)
    parser.add_argument("--token-budget", type=int, default=None)
    parser.add_argument("--top-k", type=int, default=None)
    parser.add_argument("--neighbor-radius", type=int, default=None)
    parser.add_argument("--strip-preamble", action="store_true")
    parser.add_argument("--env-filter", action="store_true")
    parser.add_argument("--multi-query", action="store_true")
    parser.add_argument("--query-mode", choices=["full", "keywords"], default="full")
    parser.add_argument(
        "--rescue",
        action="store_true",
        help="Add the best lexical states from already-retrieved trajectories.",
    )
    parser.add_argument("--controller-notes", action="store_true")
    parser.add_argument("--controller-decompose", action="store_true")
    parser.add_argument("--controller-premise", action="store_true")
    parser.add_argument(
        "--ui-elements",
        dest="ui_elements",
        action="store_true",
        default=None,
        help="Force UI label nodes on. Default matches the runner: web only.",
    )
    parser.add_argument(
        "--no-ui-elements",
        dest="ui_elements",
        action="store_false",
        help="Disable UI label nodes for every domain.",
    )
    parser.add_argument("--limit", type=int, default=0, help="Questions per domain (0 = all)")
    parser.add_argument("--workspace", default="")
    parser.add_argument("--reingest", action="store_true")
    parser.add_argument("--json-out", default="")
    args = parser.parse_args()

    data_root = Path(args.data_root).expanduser().resolve()
    questions = load_questions(data_root)
    haystack = load_haystack(data_root, args.tier)
    domains = ["web", "enterprise"] if args.domain == "both" else [args.domain]

    if not args.workspace:
        args.workspace = tempfile.mkdtemp(prefix=f"memos-lme-eval-{args.profile}-")

    all_results: list[dict[str, Any]] = []
    for domain in domains:
        subset = [q for q in questions if q["domain"] == domain]
        if args.limit:
            subset = subset[: args.limit]
        all_results.extend(run_domain(data_root, domain, subset, haystack, args))

    summary = summarize(all_results)
    summary["config"] = {
        "profile": args.profile,
        "tier": args.tier,
        "state_chars": args.state_chars,
        "token_budget": args.token_budget,
        "top_k": args.top_k,
        "neighbor_radius": args.neighbor_radius,
        "strip_preamble": args.strip_preamble,
        "env_filter": args.env_filter,
        "multi_query": args.multi_query,
        "query_mode": args.query_mode,
        "rescue": args.rescue,
        "controller_notes": args.controller_notes,
        "controller_decompose": args.controller_decompose,
        "controller_premise": args.controller_premise,
        "ui_elements": args.ui_elements,
        "workspace": args.workspace,
    }
    print(json.dumps(summary, indent=2))

    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps({"summary": summary, "results": all_results}, indent=2),
            encoding="utf-8",
        )
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
