#!/usr/bin/env python3
"""Validate the MemOS plugin against Hermes' *real* Agent Plugins v1 loader.

`hermes plugins validate` only checks the manifest, and `hermes plugins doctor`
only reports native tool/hook registrations (always 0 for a portable package).
Neither tells you whether your skills were actually discovered. This script
imports `hermes_cli.agent_plugins.load_agent_plugin` — the same function Hermes
calls at startup — and prints what it really sees.

This matters because Hermes loads exactly three things from a portable package:

    plugin.json           manifest
    mcp.json              MCP servers
    skills/<name>/SKILL.md  auto-activating skills

Everything else (`commands/`, `hooks/`) is Claude Code only and is silently
ignored. A skill with a bad frontmatter is also skipped silently, so it is
easy to ship a plugin that appears valid and does nothing.

Usage:
    python scripts/check-hermes-plugin.py [plugin_dir]

    HERMES_SRC=/path/to/hermes-agent python scripts/check-hermes-plugin.py

Requirements: ruamel.yaml (Hermes' own dependency) and a Hermes source
checkout (set HERMES_SRC, or pass --hermes-src). Defaults to
%LOCALAPPDATA%/hermes/hermes-agent on Windows. Run it with Hermes' venv
interpreter (`<hermes>/.venv/Scripts/python.exe` on Windows,
`<hermes>/.venv/bin/python` elsewhere) if your system Python lacks
ruamel.yaml.
Exits non-zero on any loader diagnostic.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path


def default_hermes_src() -> Path:
    env = os.environ.get("HERMES_SRC")
    if env:
        return Path(env)
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "hermes" / "hermes-agent"
    return Path.home() / "AppData" / "Local" / "hermes" / "hermes-agent"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plugin_dir", nargs="?", default="plugin")
    parser.add_argument("--hermes-src", default=str(default_hermes_src()))
    parser.add_argument(
        "--data-root",
        default=None,
        help="simulated ${PLUGIN_DATA} dir (default: a throwaway temp dir)",
    )
    args = parser.parse_args()

    src = Path(args.hermes_src).resolve()
    if not (src / "hermes_cli" / "agent_plugins.py").is_file():
        print(f"error: hermes_cli/agent_plugins.py not found under {src}")
        print("set HERMES_SRC to a Hermes source checkout")
        return 2
    sys.path.insert(0, str(src))

    try:
        import ruamel.yaml  # noqa: F401
    except ImportError:
        venv = src / ".venv"
        hint = venv / "Scripts" / "python.exe" if os.name == "nt" else venv / "bin" / "python"
        print("error: ruamel.yaml is required (Hermes' SKILL.md parser).")
        print(f"try: {hint} scripts/check-hermes-plugin.py")
        return 2

    try:
        from hermes_cli.agent_plugins import load_agent_plugin
    except ImportError as exc:
        print(f"error: cannot import hermes_cli ({exc}). Is the Hermes venv active?")
        return 2

    root = Path(args.plugin_dir).resolve()
    # Deliberately NOT inside the plugin dir: the loader can materialise
    # ${PLUGIN_DATA}, and anything created there would ship with the package.
    if args.data_root:
        data = Path(args.data_root).resolve()
    else:
        data = Path(tempfile.mkdtemp(prefix="memos-plugin-data-"))

    pkg = load_agent_plugin(root, data)

    print(f"name      : {pkg.name} {pkg.version}")
    print(f"root      : {pkg.root}")
    print(f"data_root : {pkg.data_root}")
    print(f"\nskills ({len(pkg.skills)}):")
    for s in pkg.skills:
        print(f"  - {s.name}  (desc {len(s.description or '')} chars)")
    print(f"\nmcp servers ({len(pkg.mcp_servers)}):")
    for name, cfg in pkg.mcp_servers.items():
        print(f"  - {name}: {cfg.get('command')} {' '.join(cfg.get('args', []))}")
        print(f"      cwd: {cfg.get('cwd')}")

    print(f"\ndiagnostics ({len(pkg.diagnostics)}):")
    for d in pkg.diagnostics:
        scope = getattr(d, "scope", None) or getattr(d, "component", "?")
        print(f"  ! {scope}: {getattr(d, 'message', d)}")
    if not pkg.diagnostics:
        print("  (none)")

    # Sanity gates beyond what the loader enforces.
    problems = list(pkg.diagnostics)
    if not pkg.skills:
        print("\nwarning: no skills discovered — Hermes will load only the MCP server.")
    if not pkg.mcp_servers:
        problems.append(type("D", (), {"component": "mcp", "message": "no MCP servers"})())

    code = 1 if problems else 0
    print(
        "\nFAILED"
        if problems
        else "\nOK — plugin loads cleanly under Hermes' Agent Plugins v1 loader."
    )

    if not args.data_root and data.exists():
        shutil.rmtree(data, ignore_errors=True)

    return code


if __name__ == "__main__":
    raise SystemExit(main())
