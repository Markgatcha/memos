#!/usr/bin/env python3
"""Calibrate the low-confidence signal against the abstention labels.

The 128 ``-abs`` questions presuppose something that does not exist, so the
useful behaviour is "say the premise is unsupported". A retrieval system can
only contribute a confidence signal; this script asks how well the top
retrieval score separates abstention questions from answerable ones.

Reads an ``eval_retrieval.py`` JSON and prints AUC plus trigger rates at a few
thresholds, so the note fires on few answerable questions.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def auc(pos: list[float], neg: list[float]) -> float:
    """Probability a random positive scores above a random negative."""
    if not pos or not neg:
        return float("nan")
    wins = 0.0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1.0
            elif p == n:
                wins += 0.5
    return wins / (len(pos) * len(neg))


def main() -> None:
    path = Path(sys.argv[1])
    rows = [
        row
        for row in json.loads(path.read_text(encoding="utf-8"))["results"]
        if row.get("top_score") is not None
    ]
    abst = [row["top_score"] for row in rows if row["type"].endswith("-abs")]
    answerable = [row["top_score"] for row in rows if not row["type"].endswith("-abs")]
    print(f"{path.name}: {len(abst)} abstention, {len(answerable)} answerable")
    print(
        f"mean top score  abstention {sum(abst) / len(abst):.3f}  answerable {sum(answerable) / len(answerable):.3f}"
    )
    print(
        f"AUC (inverted score predicts abstention): {auc([-a for a in abst], [-a for a in answerable]):.3f}"
    )

    for threshold in (0.35, 0.40, 0.45, 0.50, 0.55, 0.60):
        fired_abst = sum(1 for s in abst if s < threshold) / len(abst)
        fired_ans = sum(1 for s in answerable if s < threshold) / len(answerable)
        print(
            f"  threshold {threshold:.2f}: fires on {fired_abst:5.1%} of abstention,"
            f" {fired_ans:5.1%} of answerable"
        )


if __name__ == "__main__":
    main()
