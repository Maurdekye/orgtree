"""Command-line scope diagnostic and external harness reproduction helper."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "engine" / "backend"))

from orgtree import scope_diagnostics as diagnostics  # noqa: E402


def _grant(value: str) -> dict[str, str]:
    path, sep, mode = value.rpartition("=")
    if not sep or mode not in {"ro", "rw"}:
        return {"path": value, "mode": "rw"}
    return {"path": path, "mode": mode}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Explain one effective scope decision; never changes grants or retries failures.")
    parser.add_argument("target")
    parser.add_argument("operation", choices=sorted(diagnostics.OPERATIONS))
    parser.add_argument("--scratch", required=True)
    parser.add_argument("--grant", action="append", default=[], metavar="PATH[=ro|rw]")
    parser.add_argument("--provider")
    parser.add_argument("--provider-restriction", action="append", default=[], metavar="OP=REASON")
    parser.add_argument("--sandbox", action="store_true")
    parser.add_argument("--sandbox-root", action="append", default=[])
    parser.add_argument("--tool-grants", default="{}", help="JSON object such as {\"bash\":false}")
    parser.add_argument("--git-owner")
    parser.add_argument("--command", nargs=argparse.REMAINDER,
                        help="optional command to run after `--`; output is captured, never retried")
    args = parser.parse_args(argv)
    try:
        provider_restrictions = {}
        for item in args.provider_restriction:
            key, sep, reason = item.partition("=")
            if not sep or not key or not reason:
                parser.error("--provider-restriction must be OP=REASON")
            provider_restrictions[key] = reason
        tool_grants = json.loads(args.tool_grants)
        if not isinstance(tool_grants, dict):
            parser.error("--tool-grants must be a JSON object")
        report = diagnostics.diagnose_target(
            args.target, args.operation, scratch=args.scratch,
            grants=[_grant(value) for value in args.grant], provider=args.provider,
            provider_restrictions=provider_restrictions, sandboxed=args.sandbox,
            sandbox_roots=args.sandbox_root, tool_grants=tool_grants,
            git_owner=args.git_owner,
        )
        if args.command:
            command = list(args.command)
            if command and command[0] == "--":
                command = command[1:]
            if not command:
                parser.error("--command requires an executable")
            try:
                completed = subprocess.run(command, check=False, capture_output=True,
                                           text=True, encoding="utf-8", errors="replace")
                result = diagnostics.shell_result(completed.returncode,
                                                   completed.stdout, completed.stderr)
            except OSError as exc:
                result = diagnostics.shell_result(getattr(exc, "errno", None), "", str(exc),
                                                  started=False, boundary=True)
            report["harness"] = diagnostics.reproduction_report(
                result, command=command, owner=str(result["owner"]),
                environment={"os": os.name, "provider": args.provider or "unprovided"},
            )
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0 if report["operation"]["allowed"] and not report.get("harness", {}).get("result", {}).get("blocked", False) else 1
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": str(exc), "blocked": True}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
