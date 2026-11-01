#!/usr/bin/env python3
"""Preflight checks before spending hours on an LME-V2 run."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


def check(condition: bool, message: str, failures: list[str]) -> None:
    print(("PASS " if condition else "FAIL ") + message)
    if not condition:
        failures.append(message)


def endpoint_models(
    base_url: str,
    timeout: float = 5.0,
    api_key: str = "",
) -> list[str]:
    url = base_url.rstrip("/") + "/models"
    request = urllib.request.Request(url)
    if api_key:
        request.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        import json

        payload = json.loads(response.read().decode("utf-8"))
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    return [str(item.get("id")) for item in data if isinstance(item, dict)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lme-root", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--reader-base-url", default=os.getenv("READER_BASE_URL", ""))
    parser.add_argument("--embedding-base-url", default=os.getenv("LME_EMBEDDING_BASE_URL", ""))
    parser.add_argument("--sdk-path", default=os.getenv("MEMOS_SDK_PATH", ""))
    parser.add_argument("--tier", choices=["small", "medium"], default="small")
    parser.add_argument(
        "--expect-reader-model",
        default=os.getenv("READER_MODEL", "Qwen/Qwen3.5-9B"),
    )
    parser.add_argument(
        "--expect-embedding-model",
        default=os.getenv("LME_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B"),
        help="Recommended baseline embedding model; not required by the leaderboard.",
    )
    parser.add_argument(
        "--expect-judge-model",
        default=os.getenv("EVALUATOR_MODEL", "gpt-5.2"),
    )
    parser.add_argument(
        "--judge-base-url",
        default=os.getenv("EVALUATOR_BASE_URL") or os.getenv("OPENAI_BASE_URL", ""),
        help=(
            "Judge API base URL. Checked against /models so a retired or "
            "unsupported model fails before a long run starts."
        ),
    )
    parser.add_argument(
        "--skip-judge-model-probe",
        action="store_true",
        help="Do not confirm the judge endpoint actually serves the model.",
    )
    parser.add_argument(
        "--skip-model-name-check",
        action="store_true",
        help="Only check endpoint reachability, not the served model names.",
    )
    args = parser.parse_args()

    failures: list[str] = []
    lme = Path(args.lme_root).expanduser().resolve()
    data = Path(args.data_root).expanduser().resolve()

    check((lme / "evaluation" / "harness.py").exists(), f"LME harness exists: {lme}", failures)
    check(
        (lme / "memory_modules" / "memos_backend.py").exists(),
        "MemOS adapter is installed in memory_modules",
        failures,
    )
    check((data / "trajectories.jsonl").exists(), f"trajectories.jsonl exists: {data}", failures)
    check((data / "trajectories").is_dir(), f"trajectories/ exists: {data}", failures)

    node = shutil.which("node")
    check(node is not None, "Node.js is on PATH", failures)
    if node:
        version = subprocess.run(
            [node, "--version"], capture_output=True, text=True, check=False
        ).stdout.strip()
        print(f"     node {version}")

    if args.sdk_path:
        check(Path(args.sdk_path).exists(), f"MEMOS_SDK_PATH exists: {args.sdk_path}", failures)
    else:
        print("WARN MEMOS_SDK_PATH is unset; the bridge will import @mem-os/sdk from its cwd")

    if args.reader_base_url:
        try:
            models = endpoint_models(args.reader_base_url)
            check(bool(models), f"reader endpoint reachable ({len(models)} models)", failures)
            print(f"     reader models: {', '.join(models[:5])}")
            if models and not args.skip_model_name_check:
                check(
                    any(
                        args.expect_reader_model.lower() in model.lower()
                        for model in models
                    ),
                    f"reader serves {args.expect_reader_model}",
                    failures,
                )
        except Exception as error:  # noqa: BLE001
            check(False, f"reader endpoint: {error}", failures)
    else:
        print("WARN READER_BASE_URL is unset; cannot probe the reader")

    if args.embedding_base_url:
        try:
            models = endpoint_models(args.embedding_base_url)
            check(bool(models), f"embedding endpoint reachable ({len(models)} models)", failures)
            print(f"     embedding models: {', '.join(models[:5])}")
            if models and not args.skip_model_name_check:
                matches = any(
                    args.expect_embedding_model.lower() in model.lower()
                    for model in models
                )
                if matches:
                    print(
                        f"PASS embedding endpoint serves the baseline "
                        f"{args.expect_embedding_model}"
                    )
                else:
                    print(
                        f"WARN embedding model differs from the baseline "
                        f"{args.expect_embedding_model}; this is allowed, but "
                        "numbers are not directly comparable to the official "
                        "embedding-based baselines."
                    )
        except Exception as error:  # noqa: BLE001
            check(False, f"embedding endpoint: {error}", failures)
    else:
        print("WARN LME_EMBEDDING_BASE_URL is unset; MemOS will use Model2Vec (lower accuracy)")

    judge_key_env = os.getenv("EVALUATOR_API_KEY_ENV", "OPENAI_API_KEY")
    check(
        bool(os.getenv(judge_key_env)),
        f"judge credentials are configured ({judge_key_env})",
        failures,
    )
    judge_model = os.getenv("EVALUATOR_MODEL", "gpt-5.2")
    check(
        args.expect_judge_model.lower() in judge_model.lower(),
        f"judge model contains {args.expect_judge_model} (got {judge_model})",
        failures,
    )
    # The model string alone proves nothing: the judge endpoint must actually
    # serve it. gpt-5.2-chat-latest was shut down on 2026-08-10 and many
    # gateways never carried base gpt-5.2, so a run would otherwise fail only
    # after the whole memory build finished.
    if args.judge_base_url and not args.skip_judge_model_probe:
        try:
            judge_models = endpoint_models(
                args.judge_base_url,
                api_key=os.getenv(judge_key_env, ""),
            )
            served = any(
                args.expect_judge_model.lower() in model.lower()
                for model in judge_models
            )
            check(
                served,
                f"judge endpoint serves a {args.expect_judge_model} model",
                failures,
            )
            if not served:
                candidates = sorted(
                    model
                    for model in judge_models
                    if model.lower().startswith(("gpt-5", "gpt-6", "o3", "o4"))
                )
                print(f"     judge models available: {', '.join(candidates[:12])}")
                print(
                    "     The leaderboard requires the evaluator model string to "
                    "contain 'gpt-5.2'. A different judge is not an official "
                    "submission; ask the organizers before substituting."
                )
        except Exception as error:  # noqa: BLE001
            check(False, f"judge endpoint: {error}", failures)
    elif not args.judge_base_url:
        print(
            "WARN judge base URL is unset; set EVALUATOR_BASE_URL or "
            "OPENAI_BASE_URL so preflight can confirm the judge model exists."
        )

    if data.exists():
        free = shutil.disk_usage(data)
        print(f"     free disk: {free.free / 1e9:.1f} GB")
        check(free.free > 5e9, "at least 5 GB free for the SQLite store", failures)

    if failures:
        print(f"\n{len(failures)} preflight failure(s). Fix them before running.")
        sys.exit(1)
    print("\nPreflight OK.")


if __name__ == "__main__":
    main()
