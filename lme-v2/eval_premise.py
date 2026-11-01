#!/usr/bin/env python3
"""Score the controller's premise verdicts against the known abstention labels.

Every ``*-abs`` question has a deliberately false premise, so the label is free
ground truth: a good support check says "unsupported" or "contradicted" on
those and "supported" on the rest.

Reads an ``eval_retrieval.py`` JSON produced with ``--controller-premise``.
"""

from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path


def main() -> None:
    path = Path(sys.argv[1])
    rows = json.loads(path.read_text(encoding="utf-8"))["results"]
    scored = 0
    tp = fp = tn = fn = 0
    verdicts: Counter[str] = Counter()
    per_type: dict[str, list[tuple[bool, str]]] = {}

    for row in rows:
        premise = row.get("premise") or {}
        verdict = str(premise.get("verdict") or "").strip().lower()
        if not verdict:
            continue
        scored += 1
        is_abs = row["type"].endswith("-abs")
        flagged = verdict in {"unsupported", "contradicted"}
        verdicts[verdict] += 1
        per_type.setdefault(row["type"], []).append((flagged, verdict))
        if is_abs and flagged:
            tp += 1
        elif is_abs and not flagged:
            fn += 1
        elif not is_abs and flagged:
            fp += 1
        else:
            tn += 1

    if not scored:
        raise SystemExit("no premise verdicts in this file")

    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    accuracy = (tp + tn) / scored
    print(f"rows with a verdict: {scored}/{len(rows)}")
    print(f"verdicts: {dict(verdicts)}")
    print(f"abstention detection: precision {precision:.3f} recall {recall:.3f} accuracy {accuracy:.3f}")
    print(f"confusion: tp={tp} fp={fp} tn={tn} fn={fn}")
    print()
    for name, items in sorted(per_type.items()):
        flagged = sum(1 for f, _ in items if f)
        print(f"  {name:24s} n={len(items):3d} flagged={flagged/len(items):.1%}")


if __name__ == "__main__":
    main()
