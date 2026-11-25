"""Reproduce the full retrieval run from a clean checkout using Python and Node."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
DATASET_SHA = "08d8dad4be43ee2049a22ff5674eb86725d0ce5ff434cde2627e5e8e7e117894"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=pathlib.Path)
    parser.add_argument("out", type=pathlib.Path, help="New directory for three independent runs")
    args = parser.parse_args()
    with args.dataset.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != DATASET_SHA:
            sys.exit("Dataset SHA-256 mismatch. Use the original S split identified in README.md.")
    args.out.mkdir(parents=True, exist_ok=False)
    node = shutil.which("node")
    if not node:
        sys.exit("Node.js is required.")
    published = [json.loads(line) for line in (HERE / "per-question.jsonl").read_text(encoding="utf8").splitlines()]
    if len(published) != 500:
        sys.exit("Expected 500 published ranks.")
    projector = [sys.executable, "-s", str(HERE / "project-data.py"), "score", str(args.dataset)]
    annotations = [json.loads(line) for line in subprocess.check_output(projector).splitlines()]
    if len(annotations) != 500:
        sys.exit("Expected 500 annotations.")
    for number in range(1, 4):
        run_file = args.out / f"run-{number}.jsonl"
        subprocess.run([node, str(HERE / "retrieve.mjs"), str(args.dataset),
                        str(HERE / "memory-store.mjs"), str(run_file)], check=True)
        matches, complete, fraction = 0, 0, 0.
        lines = run_file.read_text(encoding="utf8").splitlines()
        for index, (line, expected, annotated) in enumerate(zip(lines, published, annotations, strict=True), 1):
            observed = json.loads(line)
            ranks = observed["rankedSessionOrdinals"]
            if not (observed["ordinal"] == expected["datasetOrdinal"] == annotated["ordinal"] == index
                    and annotated["questionId"] == expected["question_id"] and ranks == expected["rankedSessionOrdinals"]):
                sys.exit(f"Rank mismatch in run {number}, case {index}.")
            sessions, gold = annotated["sessionIds"], set(annotated["goldSessions"])
            if not (len(sessions) > 20 and len(ranks) == len(set(ranks)) <= 20
                    and all(0 <= ordinal < len(sessions) for ordinal in ranks) and gold and gold <= set(sessions)):
                sys.exit(f"Invalid corpus, ranks or annotations in case {index}.")
            found = len(gold.intersection(sessions[ordinal] for ordinal in ranks))
            matches += int(found > 0)
            complete += int(found == len(gold))
            fraction += found / len(gold)
        metrics = dict(cases=len(lines), hit_at_k=matches / len(lines), evidence_recall_at_k=fraction / len(lines),
                       all_evidence_at_k=complete / len(lines))
        print(json.dumps(dict(run=number, exact_ranks=True, **metrics)), flush=True)


if __name__ == "__main__":
    main()
