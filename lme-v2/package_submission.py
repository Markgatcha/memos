#!/usr/bin/env python3
"""Build a LongMemEval-V2 leaderboard package from MemOS run folders."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def run(command: list[str], cwd: Path) -> None:
    print("$ " + " ".join(command))
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lme-root", required=True)
    parser.add_argument("--runs-root", default="runs")
    parser.add_argument("--submission", default="memos_submission")
    parser.add_argument("--tier", choices=["small", "medium"], required=True)
    parser.add_argument(
        "--profiles",
        default="fast,balanced,accurate",
        help="Comma-separated profile names matching runs/memos_<profile>_<domain>_<tier>",
    )
    parser.add_argument("--system-description", required=True)
    parser.add_argument(
        "--code-file",
        default="",
        help="Defaults to memory_modules/memos_backend.py (bundled)",
    )
    args = parser.parse_args()

    lme = Path(args.lme_root).expanduser().resolve()
    runs = (lme / args.runs_root).resolve()
    profiles = [item.strip() for item in args.profiles.split(",") if item.strip()]
    if not profiles:
        raise SystemExit("no profiles supplied")

    code_file = (
        Path(args.code_file).expanduser().resolve()
        if args.code_file
        else lme / "memory_modules" / "memos_backend.py"
    )
    if not code_file.exists():
        raise SystemExit(f"code file not found: {code_file}")
    if code_file.is_dir():
        raise SystemExit("code file must be a single file, not a directory")

    operating_points: list[Path] = []
    for profile in profiles:
        web = runs / f"memos_{profile}_web_{args.tier}"
        enterprise = runs / f"memos_{profile}_enterprise_{args.tier}"
        for label, path in (("web", web), ("enterprise", enterprise)):
            if not path.is_dir():
                raise SystemExit(f"missing {label} run: {path}")
            if not (path / "aggregated_metrics.json").exists():
                raise SystemExit(f"incomplete {label} run (no aggregated_metrics.json): {path}")
        run(
            [
                sys.executable,
                "leaderboard/build_submission_step_1_single_operating_point.py",
                str(web),
                str(enterprise),
                args.submission,
                profile,
                args.tier,
                "--method",
                "memos",
            ],
            cwd=lme,
        )
        operating_points.append(
            lme / "leaderboard" / "submissions" / args.submission / "operating_points" / profile
        )

    run(
        [
            sys.executable,
            "leaderboard/build_submission_step_2_build_package.py",
            args.submission,
            str(Path(args.system_description).expanduser().resolve()),
            str(code_file),
            *[str(path) for path in operating_points],
        ],
        cwd=lme,
    )
    tarball = lme / "leaderboard" / "submissions" / f"{args.submission}.tar.gz"
    print(f"\nPackage: {tarball}")
    print(
        "Inspect it with:\n"
        f"  tar -tzf {tarball} | head\n"
        f"  python -m json.tool "
        f"{lme / 'leaderboard' / 'submissions' / args.submission / 'submission_overview.json'}"
    )


if __name__ == "__main__":
    main()
