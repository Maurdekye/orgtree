"""Verify an already-running Orgtree engine and optional Python modules.

This is a read-only verifier. It never provisions, installs, starts, stops, or
deploys an engine. A boot-host run authenticates ``engine-attach.json``; a
desktop-owned run receives its authenticated endpoint from the desktop launch
handshake because a persisted port file is not an identity proof.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys


# The embedded interpreter does not add this directory for a script launched
# by absolute path. Bootstrap the verifier's own directory before importing
# its sibling runner (and any sibling release guards used by verifier modules).
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
SPEC = importlib.util.spec_from_file_location("orgtree_python_verification", TOOLS / "run-python-verification.py")
if not SPEC or not SPEC.loader:
    raise RuntimeError("verification runner is missing")
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("modules", nargs="*", help="optional Python verifier modules")
    parser.add_argument("--repo-root", default=str(TOOLS.parent), help="checkout or package root")
    parser.add_argument("--data-root", required=True, help="isolated engine data root to inspect")
    parser.add_argument("--endpoint", help="desktop-owned endpoint from the launch handshake")
    parser.add_argument("--token", help="desktop token from the launch handshake")
    parser.add_argument("--pid", type=int, dest="expected_pid")
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--descriptor", type=Path)
    parser.add_argument("--python", dest="python_path")
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args(argv)

    repo_root = runner._canonical(Path(args.repo_root))
    try:
        engine = runner.discover_engine(
            Path(args.data_root), endpoint=args.endpoint, token=args.token,
            expected_pid=args.expected_pid, expected_runtime_root=args.runtime_root,
            descriptor=args.descriptor,
        )
        modules = []
        if args.modules:
            interpreter = runner.select_interpreter(repo_root, args.python_path or engine.python_executable)
            run_root, temporary = runner.make_data_root(repo_root, None)
            try:
                modules = [runner.asdict(item) for item in runner.run_modules(
                    args.modules, repo_root=repo_root, interpreter=interpreter,
                    data_root=run_root,
                )]
            finally:
                if temporary:
                    runner._cleanup(run_root)
        receipt = {"schema": "orgtree.installed-runtime/v1", "engine": runner.asdict(engine), "modules": modules}
        encoded = json.dumps(receipt, indent=2, sort_keys=True)
        print(encoded)
        if args.json_output:
            args.json_output.write_text(encoded + "\n", encoding="utf-8")
        return 0 if all(item.get("phase") in {"pass", "skip"} for item in modules) else 1
    except (runner.RuntimeDiscoveryError, ValueError) as exc:
        receipt = {"schema": "orgtree.installed-runtime/v1", "status": "FAIL", "diagnostic": str(exc)}
        encoded = json.dumps(receipt, indent=2, sort_keys=True)
        print(encoded)
        if args.json_output:
            args.json_output.write_text(encoded + "\n", encoding="utf-8")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
