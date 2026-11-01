#!/usr/bin/env python3
"""Install the MemOS backend into a LongMemEval-V2 checkout."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lme-root", required=True, help="Path to LongMemEval-V2")
    parser.add_argument(
        "--unbundled",
        action="store_true",
        help="Copy memos_backend.py and bridge.mjs instead of the single-file bundle",
    )
    args = parser.parse_args()

    root = Path(args.lme_root).expanduser().resolve()
    target_dir = root / "memory_modules"
    if not target_dir.is_dir():
        raise SystemExit(f"Not a LongMemEval-V2 checkout: {target_dir} is missing")

    if args.unbundled:
        shutil.copy2(HERE / "memos_backend.py", target_dir / "memos_backend.py")
        shutil.copy2(HERE / "bridge.mjs", target_dir / "bridge.mjs")
        print(f"copied unbundled adapter to {target_dir}")
    else:
        bundle = HERE / "memos_backend_bundled.py"
        if not bundle.exists():
            raise SystemExit(
                "memos_backend_bundled.py is missing; run `python lme-v2/build_bundle.py` first"
            )
        shutil.copy2(bundle, target_dir / "memos_backend.py")
        print(f"copied bundled adapter to {target_dir / 'memos_backend.py'}")

    print(
        "\nNext:\n"
        "  export DATA_ROOT=/path/to/longmemeval-v2/data/longmemeval-v2\n"
        "  export MEMOS_SDK_PATH=/path/to/memos/dist/index.js   # or npm i @mem-os/sdk\n"
        "  python /path/to/memos/lme-v2/run_memos.py --lme-root . "
        '--data-root "$DATA_ROOT" --domain web --tier small --profile balanced '
        "--output-dir runs/memos_web_small\n"
    )


if __name__ == "__main__":
    main()
