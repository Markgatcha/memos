#!/usr/bin/env python3
"""
Run LongMemEval-V2 with the MemOS backend.

This mirrors the official `evaluation/run_eval.py` setup (runtime questions,
haystack, reader/judge args) but selects `memory_type=memos` and does not
require patching the official method registry. Run it from the LongMemEval-V2
checkout after `install_adapter.py`.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

PROFILES = {
    # state_chars follows the measured truncation curve: at 3k chars, 27% of
    # answer spans begin past the cut; at 6k, 9%. Larger states cost budget,
    # so the fast point trades some of that recall for latency.
    "fast": {"token_budget": 40_000, "top_k": 12, "state_chars": 4_000},
    "balanced": {"token_budget": 120_000, "top_k": 20, "state_chars": 6_000},
    "accurate": {"token_budget": 200_000, "top_k": 40, "state_chars": 8_000},
}


def parse_question_ids(values: list[str] | None) -> list[str] | None:
    if not values:
        return None
    out: list[str] = []
    for value in values:
        for item in value.split(","):
            item = item.strip()
            if item:
                out.append(item)
    return out or None


def main() -> None:
    parser = argparse.ArgumentParser(description="Run LME-V2 with MemOS")
    parser.add_argument("--lme-root", default=".", help="LongMemEval-V2 checkout")
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--domain", choices=["web", "enterprise"], required=True)
    parser.add_argument("--tier", choices=["small", "medium"], default="small")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--question-ids", nargs="*", default=None)
    parser.add_argument("--profile", choices=sorted(PROFILES), default="balanced")
    parser.add_argument("--token-budget", type=int, default=None)
    parser.add_argument("--top-k", type=int, default=None)
    parser.add_argument("--state-chars", type=int, default=None)
    parser.add_argument(
        "--neighbor-radius",
        type=int,
        default=int(os.getenv("MEMOS_LME_NEIGHBOR_RADIUS", "1")),
        help=(
            "Include +/-N neighbouring states around each retrieved seed. "
            "The official RAG baseline uses radius 1; 0 disables."
        ),
    )
    parser.add_argument(
        "--strip-preamble",
        action="store_true",
        default=os.getenv("MEMOS_LME_STRIP_PREAMBLE") == "1",
        help="Drop the leading 'I am working with ...' sentence from queries.",
    )
    parser.add_argument(
        "--no-env-filter",
        dest="env_filter",
        action="store_false",
        help=(
            "Do not partition retrieval by the site named in the question. "
            "On by default; harmless when the corpus has no site tags."
        ),
    )
    parser.set_defaults(env_filter=True)
    parser.add_argument(
        "--multi-query",
        dest="multi_query",
        action="store_true",
        help=(
            "Fuse a deterministic keyword variant with the full question. "
            "Off by default: on the small tier it cost 2.5x latency for no "
            "gain in answer recall."
        ),
    )
    parser.add_argument(
        "--no-ui-elements",
        dest="ui_elements",
        action="store_false",
        default=None,
        help=(
            "Do not index per-state UI label nodes. Default is 'auto': on "
            "for web, off for enterprise, which is what the small-tier "
            "ablation supports (+1.4pp web, -4.9pp enterprise)."
        ),
    )
    parser.add_argument(
        "--ui-elements",
        dest="ui_elements",
        action="store_true",
        help="Force UI label nodes on for both domains.",
    )
    parser.set_defaults(multi_query=False)
    parser.add_argument(
        "--rescue",
        dest="rescue",
        action="store_true",
        help=(
            "Add states from already-selected trajectories via a tag-filtered "
            "search. Off by default: on the small tier each extra search "
            "re-scans the corpus and pushed queries past 30s."
        ),
    )
    parser.set_defaults(rescue=False)
    parser.add_argument(
        "--low-confidence-note",
        action="store_true",
        help=(
            "Add a short 'no direct match' note when the top fused score is "
            "below --confidence-threshold. Off by default: the score does "
            "not separate abstention questions on LME-V2 (AUC 0.55)."
        ),
    )
    parser.add_argument("--confidence-threshold", type=float, default=0.0)
    parser.add_argument(
        "--controller-notes",
        action="store_true",
        help="Write procedure/hint notes with the controller at ingest time.",
    )
    parser.add_argument(
        "--controller-decompose",
        action="store_true",
        help="Let the controller turn the question into up to 3 retrieval queries.",
    )
    parser.add_argument(
        "--controller-premise",
        action="store_true",
        help="Ask the controller whether the evidence supports the premise.",
    )
    parser.add_argument("--controller-model", default=os.getenv("MEMOS_CONTROLLER_MODEL", ""))
    parser.add_argument(
        "--controller-base-url", default=os.getenv("MEMOS_CONTROLLER_BASE_URL", "")
    )
    parser.add_argument(
        "--checkpoint-every",
        type=int,
        default=int(os.getenv("MEMOS_LME_CHECKPOINT_EVERY", "25")),
        help="Snapshot the DB every N inserted trajectories (0 disables).",
    )
    parser.add_argument(
        "--embedding-provider",
        choices=["auto", "model2vec", "openai-compatible"],
        default="auto",
    )
    parser.add_argument(
        "--embedding-base-url",
        default=os.getenv("LME_EMBEDDING_BASE_URL", ""),
    )
    parser.add_argument(
        "--embedding-model",
        default=os.getenv("LME_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-8B"),
    )
    parser.add_argument(
        "--embedding-dimensions",
        type=int,
        default=int(os.getenv("MEMOS_EMBEDDING_DIMENSIONS", "4096")),
    )
    parser.add_argument(
        "--reader-model", default=os.getenv("READER_MODEL", "Qwen/Qwen3.5-9B")
    )
    parser.add_argument(
        "--reader-base-url",
        default=os.getenv("READER_BASE_URL", "http://localhost:8023/v1"),
    )
    parser.add_argument("--reader-api-key-env", default="OPENAI_API_KEY")
    parser.add_argument("--reader-temperature", type=float, default=0.6)
    parser.add_argument("--reader-top-p", type=float, default=0.95)
    parser.add_argument("--reader-top-k", type=int, default=20)
    parser.add_argument("--reader-max-completion-tokens", type=int, default=20_000)
    parser.add_argument("--reader-max-concurrent-requests", type=int, default=16)
    parser.add_argument("--memory-context-max-tokens", type=int, default=200_000)
    parser.add_argument("--reader-disable-thinking", action="store_true")
    parser.add_argument("--evaluator-model", default=os.getenv("EVALUATOR_MODEL", "gpt-5.2"))
    parser.add_argument(
        "--evaluator-base-url",
        default=os.getenv("EVALUATOR_BASE_URL", ""),
        help=(
            "Judge API base URL. Defaults to EVALUATOR_BASE_URL, then the "
            "OpenAI SDK's OPENAI_BASE_URL."
        ),
    )
    parser.add_argument("--evaluator-api-key-env", default="OPENAI_API_KEY")
    parser.add_argument(
        "--evaluator-reasoning-effort",
        choices=["low", "medium", "high"],
        default="medium",
    )
    args = parser.parse_args()

    lme_root = Path(args.lme_root).expanduser().resolve()
    data_root = Path(args.data_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    runtime_dir = output_dir / "runtime_inputs"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    if str(lme_root) not in sys.path:
        sys.path.insert(0, str(lme_root))

    # Register the backend before importing the harness, which builds the
    # memory registry at import time.
    import memory_modules.memos_backend  # noqa: F401
    from data.public_data import (  # type: ignore[import-not-found]
        materialize_runtime_haystack,
        materialize_runtime_questions,
        write_json,
    )

    selected = materialize_runtime_questions(
        data_root=data_root,
        domain=args.domain,
        question_ids=parse_question_ids(args.question_ids),
        limit=args.limit,
        output_path=runtime_dir / "questions.json",
    )
    materialize_runtime_haystack(
        data_root=data_root,
        tier=args.tier,
        selected_questions=selected,
        output_path=runtime_dir / "haystack.json",
    )

    profile = PROFILES[args.profile]
    token_budget = args.token_budget or profile["token_budget"]
    top_k = args.top_k or profile["top_k"]
    state_chars = args.state_chars or profile["state_chars"]
    ui_elements = (
        args.ui_elements if args.ui_elements is not None else args.domain == "web"
    )
    memory_params = {
        "workspace_dir": str(output_dir / "memory_workspace"),
        "namespace": f"lme-v2:{args.domain}:{args.tier}",
        "token_budget": min(token_budget, args.memory_context_max_tokens),
        "top_k": top_k,
        "state_chars": state_chars,
        "neighbor_radius": args.neighbor_radius,
        "strip_preamble": args.strip_preamble,
        "env_filter": args.env_filter,
        "multi_query": args.multi_query,
        "ui_elements": ui_elements,
        "within_trajectory_rescue": args.rescue,
        "controller_notes": args.controller_notes,
        "controller_decompose": args.controller_decompose,
        "controller_premise": args.controller_premise,
        "controller_model": args.controller_model,
        "controller_base_url": args.controller_base_url,
        "low_confidence_note": args.low_confidence_note,
        "confidence_threshold": args.confidence_threshold,
        "checkpoint_every": args.checkpoint_every,
        "trajectories_root_dir": str(data_root / "trajectories"),
        "embedding_provider": (
            "openai-compatible"
            if args.embedding_base_url and args.embedding_provider != "model2vec"
            else "model2vec"
        ),
        "embedding_model": args.embedding_model,
        "embedding_dimensions": args.embedding_dimensions,
    }
    if args.embedding_provider == "openai-compatible":
        if not args.embedding_base_url:
            raise SystemExit(
                "--embedding-provider=openai-compatible needs --embedding-base-url "
                "or LME_EMBEDDING_BASE_URL"
            )
        memory_params["embedding_base_url"] = args.embedding_base_url
    elif args.embedding_provider == "model2vec":
        memory_params["embedding_base_url"] = ""
    elif args.embedding_base_url:
        memory_params["embedding_base_url"] = args.embedding_base_url

    memory_config = {"memory_type": "memos", "memory_params": memory_params}
    memory_config_path = runtime_dir / "memory_config.json"
    write_json(memory_config_path, memory_config)

    harness_argv = [
        "evaluation.harness",
        "--domain",
        args.domain,
        "--questions-path",
        str(runtime_dir / "questions.json"),
        "--haystack-path",
        str(runtime_dir / "haystack.json"),
        "--trajectories-path",
        str(data_root / "trajectories.jsonl"),
        "--memory-config-path",
        str(memory_config_path),
        "--output-dir",
        str(output_dir),
        "--model",
        args.reader_model,
        "--base-url",
        args.reader_base_url,
        "--api-key-env",
        args.reader_api_key_env,
        "--temperature",
        str(args.reader_temperature),
        "--top-p",
        str(args.reader_top_p),
        "--top-k",
        str(args.reader_top_k),
        "--max-completion-tokens",
        str(args.reader_max_completion_tokens),
        "--memory-context-max-tokens",
        str(args.memory_context_max_tokens),
        "--reader-max-concurrent-requests",
        str(args.reader_max_concurrent_requests),
        "--prompt-build-max-workers",
        "1",
        "--evaluator-model",
        args.evaluator_model,
        "--evaluator-api-key-env",
        args.evaluator_api_key_env,
        "--evaluator-reasoning-effort",
        args.evaluator_reasoning_effort,
        "--evaluator-max-completion-tokens",
        "4096",
    ]
    if args.evaluator_base_url:
        harness_argv.extend(["--evaluator-base-url", args.evaluator_base_url])
    if args.reader_disable_thinking:
        harness_argv.append("--reader-disable-thinking")

    print(
        json.dumps(
            {
                "method": "memos",
                "domain": args.domain,
                "tier": args.tier,
                "profile": args.profile,
                "token_budget": memory_params["token_budget"],
                "top_k": top_k,
                "output_dir": str(output_dir),
                "sdk": os.getenv("MEMOS_SDK_PATH", "@mem-os/sdk"),
            },
            indent=2,
        )
    )
    old_argv = sys.argv
    try:
        sys.argv = harness_argv
        from evaluation.harness import main as harness_main

        harness_main()
    finally:
        sys.argv = old_argv


if __name__ == "__main__":
    main()
