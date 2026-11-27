"""Recompute Track B accuracy and timing from two redacted per-question JSONL files."""

import argparse
import json
import statistics
from collections import Counter
from fractions import Fraction
from hashlib import sha256
from pathlib import Path
from typing import Any

Row = dict[str, Any]
Report = dict[str, Any]


def integer(value: object, minimum: int = 0) -> bool:
    return type(value) is int and value >= minimum


def load_rows(path: Path, expected: int) -> tuple[dict[str, Row], str]:
    raw = path.read_bytes()
    rows = {}
    ordinals = set()
    for number, line in enumerate(raw.splitlines(), 1):
        row = json.loads(line)
        try:
            key = row["question_id"]
            verdict = row["verdict"]
            ordinal = row["ordinal"]
            valid = (
                isinstance(key, str)
                and bool(key)
                and key not in rows
                and integer(ordinal, 1)
                and ordinal not in ordinals
                and integer(row["run"], 1)
                and type(row["abstention"]) is bool
                and isinstance(row["task"], str)
                and verdict in ("yes", "no", None)
                and (row["judge_status"] == "judged") == (verdict is not None)
                and (verdict is None or row["generation_status"] == "complete")
                and all(
                    row[field] is None or integer(row[field])
                    for field in ("reader_latency_ms", "judge_latency_ms")
                )
            )
        except (KeyError, TypeError) as error:
            raise ValueError(f"{path}:{number}: invalid row fields") from error
        if not valid:
            raise ValueError(f"{path}:{number}: invalid or duplicate row")
        rows[key] = row
        ordinals.add(ordinal)
    if ordinals != set(range(1, expected + 1)) or len({r["run"] for r in rows.values()}) != 1:
        raise ValueError(f"{path}: expected one round with ordinals 1 through {expected}")
    return rows, sha256(raw).hexdigest()


def timing(row: Row) -> int | None:
    reader, judge = row["reader_latency_ms"], row["judge_latency_ms"]
    return reader + judge if reader is not None and judge is not None else None


def summarize(rows: list[Row]) -> Report:
    verdicts = Counter(row["verdict"] for row in rows)
    reader = [row["reader_latency_ms"] for row in rows if row["reader_latency_ms"] is not None]
    judge = [row["judge_latency_ms"] for row in rows if row["judge_latency_ms"] is not None]
    combined = [value for row in rows if (value := timing(row)) is not None]
    return {
        "questions": len(rows),
        "correct": verdicts["yes"],
        "incorrect": verdicts["no"],
        "unresolved": verdicts[None],
        "accuracy": verdicts["yes"] / len(rows) if rows else None,
        "reader_latency_n": len(reader),
        "judge_latency_n": len(judge),
        "reader_latency_p50_ms": statistics.median(reader) if reader else None,
        "judge_latency_p50_ms": statistics.median(judge) if judge else None,
        "reader_judge_latency_sum_n": len(combined),
        "reader_judge_latency_sum_p50_ms": statistics.median(combined) if combined else None,
    }


def difference(original: Report, rerun: Report) -> Report:
    old_accuracy, new_accuracy = (
        Fraction(result["correct"], result["questions"]) if result["questions"] else None
        for result in (original, rerun)
    )
    old_p50, new_p50 = (result["reader_judge_latency_sum_p50_ms"] for result in (original, rerun))
    accuracy_change = (
        (new_accuracy - old_accuracy)
        if old_accuracy is not None and new_accuracy is not None
        else None
    )
    p50_change = (new_p50 - old_p50) if old_p50 is not None and new_p50 is not None else None
    accuracy_relative = (
        accuracy_change / old_accuracy if accuracy_change is not None and old_accuracy else None
    )
    p50_relative = (
        Fraction(p50_change) / Fraction(old_p50) if p50_change is not None and old_p50 else None
    )
    return {
        "correct": rerun["correct"] - original["correct"],
        "accuracy_percentage_points": float(accuracy_change * 100)
        if accuracy_change is not None
        else None,
        "accuracy_relative_change_pct": float(accuracy_relative * 100)
        if accuracy_relative is not None
        else None,
        "p50_ms": p50_change,
        "p50_relative_change_pct": float(p50_relative * 100) if p50_relative is not None else None,
        "accuracy_within_10pct_relative": abs(accuracy_relative) <= Fraction(1, 10)
        if accuracy_relative is not None
        else None,
        "p50_within_10pct_relative_for_available_timings": abs(p50_relative) <= Fraction(1, 10)
        if p50_relative is not None
        else None,
    }


def comparison(original_rows: list[Row], rerun_rows: list[Row], *, paired: bool = False) -> Report:
    result = {
        "original": summarize(original_rows),
        "rerun": summarize(rerun_rows),
    }
    result["delta_rerun_minus_original"] = difference(result["original"], result["rerun"])
    if paired:
        changes = Counter(
            (old["verdict"] == "yes", new["verdict"] == "yes")
            for old, new in zip(original_rows, rerun_rows, strict=True)
        )
        result["newly_correct"], result["formerly_correct"] = (
            changes[False, True],
            changes[True, False],
        )
    return result


def compare(original: Path, rerun: Path, expected: int) -> Report:
    old, old_hash = load_rows(original, expected)
    new, new_hash = load_rows(rerun, expected)
    shared = sorted(old.keys() & new.keys(), key=lambda key: old[key]["ordinal"])
    if any(
        any(old[key][field] != new[key][field] for field in ("ordinal", "task", "abstention"))
        for key in shared
    ):
        raise ValueError("Question ID, ordinal, task and abstention metadata disagree")
    timed = [key for key in shared if timing(old[key]) is not None and timing(new[key]) is not None]
    timed_judged = [
        key for key in timed if all(side[key]["verdict"] is not None for side in (old, new))
    ]
    matching_prompt = [
        key
        for key in shared
        if old[key].get("reader_prompt_sha256")
        and old[key]["reader_prompt_sha256"] == new[key].get("reader_prompt_sha256")
    ]

    def pairs(keys: list[str]) -> Report:
        return comparison([old[key] for key in keys], [new[key] for key in keys], paired=True)

    all_questions = comparison(list(old.values()), list(new.values()))
    return {
        "per_question_sha256": {"original": old_hash, "rerun": new_hash},
        "all_questions": all_questions,
        "all_questions_have_paired_timings": len(timed) == expected,
        "matching_question_ids": pairs(shared),
        "matching_ids_with_both_timings": pairs(timed),
        "matching_ids_with_both_timings_and_judgments": pairs(timed_judged),
        "matching_reader_prompt_sha256": pairs(matching_prompt),
        "questions_only_in_original": len(old) - len(shared),
        "questions_only_in_rerun": len(new) - len(shared),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("original", type=Path)
    parser.add_argument("rerun", type=Path)
    parser.add_argument("--expected-questions", type=int, default=500)
    args = parser.parse_args()
    if args.expected_questions < 1:
        parser.error("expected questions must be positive")
    try:
        print(json.dumps(compare(args.original, args.rerun, args.expected_questions), indent=2))
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
