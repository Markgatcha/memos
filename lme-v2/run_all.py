#!/usr/bin/env python3
"""Run all LME-V2 operating points and build the submission package."""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(command: list[str], *, dry_run: bool, cwd: Path | None = None) -> None:
    print("$ " + " ".join(command))
    if dry_run:
        return
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lme-root", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--tier", choices=["small", "medium"], default="small")
    parser.add_argument(
        "--profiles",
        default="fast,balanced,accurate",
        help="Comma-separated operating points",
    )
    parser.add_argument("--runs-root", default="runs")
    parser.add_argument("--submission", default="memos_submission")
    parser.add_argument(
        "--system-description",
        default=str(HERE / "SYSTEM_DESCRIPTION.md"),
    )
    parser.add_argument(
        "--code-file",
        default="",
        help="Defaults to <lme-root>/memory_modules/memos_backend.py",
    )
    parser.add_argument("--skip-preflight", action="store_true")
    parser.add_argument("--skip-package", action="store_true")
    parser.add_argument("--force", action="store_true", help="Re-run existing operating points")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--extra",
        nargs=argparse.REMAINDER,
        default=[],
        help="Extra args passed to run_memos.py (must be last)",
    )
    args = parser.parse_args()

    lme = Path(args.lme_root).expanduser().resolve()
    data = Path(args.data_root).expanduser().resolve()
    runs = lme / args.runs_root
    profiles = [item.strip() for item in args.profiles.split(",") if item.strip()]
    if not profiles:
        raise SystemExit("no profiles supplied")

    if not args.skip_preflight:
        run(
            [
                sys.executable,
                str(HERE / "preflight.py"),
                "--lme-root",
                str(lme),
                "--data-root",
                str(data),
                "--tier",
                args.tier,
            ],
            dry_run=args.dry_run,
        )

    for profile in profiles:
        for domain in ("web", "enterprise"):
            output_dir = runs / f"memos_{profile}_{domain}_{args.tier}"
            if output_dir.exists() and not args.force:
                print(f"SKIP existing {output_dir} (use --force to re-run)")
                continue
            run(
                [
                    sys.executable,
                    str(HERE / "run_memos.py"),
                    "--lme-root",
                    str(lme),
                    "--data-root",
                    str(data),
                    "--domain",
                    domain,
                    "--tier",
                    args.tier,
                    "--profile",
                    profile,
                    "--output-dir",
                    str(output_dir),
                    *args.extra,
                ],
                dry_run=args.dry_run,
            )

    if args.skip_package:
        return
    code_file = (
        Path(args.code_file).expanduser().resolve()
        if args.code_file
        else lme / "memory_modules" / "memos_backend.py"
    )
    if not code_file.exists():
        raise SystemExit(
            f"code file not found: {code_file}\n"
            "Run install_adapter.py first or pass --code-file."
        )
    if code_file.is_dir():
        raise SystemExit("code file must be a single file, not a directory")
    run(
        [
            sys.executable,
            str(HERE / "package_submission.py"),
            "--lme-root",
            str(lme),
            "--runs-root",
            args.runs_root,
            "--submission",
            args.submission,
            "--tier",
            args.tier,
            "--profiles",
            ",".join(profiles),
            "--system-description",
            str(Path(args.system_description).expanduser().resolve()),
            "--code-file",
            str(code_file),
        ],
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
