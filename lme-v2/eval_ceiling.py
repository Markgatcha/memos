#!/usr/bin/env python3
"""How much answerable evidence exists as text in the LME-V2 small haystack?

Some LME-V2 answers live only in screenshots or are paraphrased by the
question, so a text-only retrieval metric has a ceiling below 100%. This
script measures that ceiling: for every scorable question, how many raw
states contain the full reference answer as text?

Used to interpret ``eval_retrieval.py`` numbers honestly.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from eval_retrieval import (  # noqa: E402
    answer_phrases,
    detect_environment,
    load_haystack,
    load_questions,
    normalize,
)


def main() -> None:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\marki\memos-data\lme-v2")
    questions = load_questions(root)
    haystack = load_haystack(root, "small")
    wanted = {tid for ids in haystack.values() for tid in ids}
    print(f"loading {len(wanted)} trajectories ...", flush=True)

    trajectories: dict[str, dict] = {}
    with (root / "trajectories.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if str(record.get("id")) in wanted:
                trajectories[str(record["id"])] = record
                if len(trajectories) == len(wanted):
                    break
    print(f"loaded {len(trajectories)}", flush=True)

    # Per-trajectory normalized state texts, built once.
    texts: dict[str, list[str]] = {}
    for tid, trajectory in trajectories.items():
        texts[tid] = [
            normalize(str(state.get("accessibility_tree") or ""))
            for state in trajectory.get("states") or []
        ]
    environment = {
        tid: str(trajectory.get("environment") or "") for tid, trajectory in trajectories.items()
    }

    zero = 0
    scored = 0
    counts: list[int] = []
    cross_env = 0
    by_type: dict[str, Counter] = {}
    missing_examples: list[tuple[str, str, str]] = []

    for question in questions:
        phrases, mode = answer_phrases(question)
        if mode not in {"phrase", "choice"} or not phrases:
            continue
        scored += 1
        needles = [normalize(p) for p in phrases]
        needles = [n for n in needles if n]
        env = detect_environment(question["question"])
        matches = 0
        in_env = 0
        for tid, state_texts in texts.items():
            for text in state_texts:
                padded = f" {text} "
                if all(f" {needle} " in padded for needle in needles):
                    matches += 1
                    if environment.get(tid) == env:
                        in_env += 1
        counts.append(matches)
        counter = by_type.setdefault(question["question_type"], Counter())
        counter["n"] += 1
        if matches == 0:
            zero += 1
            counter["zero"] += 1
            if len(missing_examples) < 12:
                missing_examples.append(
                    (question["id"], question["question_type"], phrases[0][:60])
                )
        if matches and in_env == 0:
            cross_env += 1

    print(f"\nscored questions: {scored}")
    print(f"no text match anywhere: {zero} ({zero / scored:.1%})")
    print(f"matches exist but none in the question's environment: {cross_env}")
    buckets = Counter(
        "0" if c == 0 else "1" if c == 1 else "2-5" if c <= 5 else "6+" for c in counts
    )
    print("matching-state count buckets:", dict(buckets))
    print("\nby type (n, no-text-match):")
    for name, counter in sorted(by_type.items()):
        print(f"  {name}: {counter['n']}, {counter['zero']}")
    if missing_examples:
        print("\nexamples with no text match:")
        for qid, qtype, phrase in missing_examples:
            print(f"  {qid} {qtype}: {phrase}")


if __name__ == "__main__":
    main()
