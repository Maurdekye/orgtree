"""Produce a verification receipt for a command, from ANY checkout.

WHY THIS IS A STANDALONE TOOL AND NOT A BACKEND ROUTE. The thing a reviewer
needs is to run the implementer's check against a tree of the reviewer's own
choosing and get back a record that says what was run, where, and what came of
it. Agents described the gap exactly:

  "their probes import from a private `snapshot-<sha>` export, so I could not
   run their exact script — I HAD TO TRANSCRIBE IT into my own tree. Worth
   considering: a convention (or a tool) for 'here is a probe, run it against
   YOUR checkout', since the snapshot is only there to pin the SHA."   (WE07)

  "source verification and artifact preflight NEED EXPLICIT CHECKOUT PATHS in
   their receipts … a first-class same-commit artifact verification receipt
   would avoid either rebuilding unrelated shared outputs or IMPLYING THAT A
   CHECK RAN SOMEWHERE IT DID NOT."                                    (AP18)

So: `--repo-root` is explicit and required, the receipt records the tree it
actually measured, and the whole thing runs with no data root, no org document
and no backend — which is what lets it be handed to a peer as a command line.

    python tools/verification-receipt.py --repo-root E:/wt/mine \
        --candidate fb04313 --execution independent \
        -- python -m unittest tests.test_work_evidence_receipts

    # a negative control: the check is SUPPOSED to fail, and a receipt that
    # called that a failure would be wrong
    python tools/verification-receipt.py --repo-root . --candidate fb04313 \
        --expect-fail -- python tools/prove-the-guard-fires.py

    # a rebase, recorded with all four endpoints
    python tools/verification-receipt.py --repo-root . --range-diff \
        baedd33 c09e88f 9567715 fb04313

EXIT STATUS IS THE RECEIPT'S VERDICT, not the command's: 0 when the result is
green (`passed` or a negative control that fired as designed), 1 otherwise. A
crash and a failed assertion are both 1, but they are DIFFERENT in the receipt,
which is the distinction that matters to whoever reads it.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any, Sequence

HERE = pathlib.Path(__file__).resolve().parent


def _load_workevidence(repo_root: pathlib.Path) -> Any:
    """Import `workevidence` FROM THE CHECKOUT BEING MEASURED.

    Deliberately not from whatever tree this script happens to live in: a
    receipt describing checkout X should be built by X's own rules, so a probe
    replayed against an older or newer candidate reports that candidate's
    behaviour rather than this one's.
    """
    backend = repo_root / "engine" / "backend"
    if not (backend / "orgtree" / "workevidence.py").is_file():
        raise SystemExit(
            f"{repo_root} does not look like an orgtree checkout: no "
            f"engine/backend/orgtree/workevidence.py under it. Pass the "
            f"--repo-root of the worktree you want measured")
    # ⚠ A MEASURING TOOL MUST NOT MODIFY WHAT IT MEASURES. Importing from the
    # target checkout writes `__pycache__` into it, which makes the tree DIRTY
    # — and the receipt then honestly reports a dirty tree that the receipt
    # itself dirtied. Found by the "it measures the checkout it was pointed at"
    # test, which asserted `clean` against a tree this import had just soiled.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(backend))
    from orgtree import workevidence          # noqa: PLC0415
    return workevidence


def _classify(code: int | None, *, expect_fail: bool, crashed: bool) -> str:
    if crashed or code is None:
        return "crashed"
    if expect_fail:
        # a negative control that PASSED is a failure of the control: the thing
        # it exists to catch was not caught, and reporting that as green is the
        # single worst outcome this tool can produce
        return "expected_negative" if code != 0 else "failed"
    return "passed" if code == 0 else "failed"


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo-root", required=True,
                    help="the checkout to measure — recorded in the receipt")
    ap.add_argument("--candidate", default="",
                    help="the commit this check is about (defaults to the "
                         "checkout's HEAD)")
    ap.add_argument("--base", default="", help="the commit the candidate sits on")
    ap.add_argument("--execution", default="independent",
                    choices=("independent", "owner_report", "source_inspection"))
    ap.add_argument("--result", default="",
                    help="record this result instead of running anything "
                         "(passed|expected_negative|failed|crashed|not_executed)")
    ap.add_argument("--expect-fail", action="store_true",
                    help="this command is a NEGATIVE CONTROL: a nonzero exit is "
                         "`expected_negative` (a pass) and a zero exit is "
                         "`failed` (the control did not fire)")
    ap.add_argument("--log", action="append", default=[],
                    help="a captured log file to attach, decoded BOM-aware "
                         "(repeatable)")
    ap.add_argument("--range-diff", nargs=4, metavar=("OLD_BASE", "OLD_TIP",
                                                      "NEW_BASE", "NEW_TIP"),
                    help="record a rebase comparison instead of running a "
                         "command")
    ap.add_argument("--note", default="")
    ap.add_argument("--timeout", type=float, default=1800.0)
    ap.add_argument("--json-output", help="also write the receipt to this path")
    ap.add_argument("command", nargs=argparse.REMAINDER,
                    help="-- then the command to run")
    args = ap.parse_args(argv)

    repo_root = pathlib.Path(os.path.realpath(os.path.abspath(args.repo_root)))
    we = _load_workevidence(repo_root)
    checkout = str(repo_root)

    if args.range_diff:
        rd = we.range_diff(checkout, *args.range_diff)
        rc = we.receipt(
            candidate=rd["new_tip"], checkout=checkout,
            command=["git", "range-diff",
                     f"{rd['old_base']}..{rd['old_tip']}",
                     f"{rd['new_base']}..{rd['new_tip']}"],
            execution="independent",
            result=("passed" if rd["identical"] is True
                    else "crashed" if rd["identical"] is None else "failed"),
            runner={"tool": "git range-diff"}, note=args.note,
            base=rd["new_base"])
        rc = {**rc, "range_diff": rd}
        return _emit(rc, args.json_output)

    tree = we.tree_state(checkout, base_of=args.candidate or None)
    candidate = args.candidate or str(tree.get("commit") or "")
    if not candidate:
        raise SystemExit(
            f"no --candidate given and HEAD does not resolve in {checkout} "
            f"({tree.get('detail') or 'no detail'}) — a receipt must name the "
            f"commit it is about")

    cmd = [a for a in args.command if a != "--"]
    logs = []
    for p in args.log:
        try:
            logs.append({**we.read_log(p), "path": p})
        except OSError as e:
            logs.append({"text": "", "encoding": "", "had_bom": False,
                         "replacements": 0, "bytes": 0, "sha256": "",
                         "path": p, "unreadable": str(e)})

    runner: dict[str, Any] = {"interpreter": sys.version.split()[0],
                              "executable": sys.executable,
                              "platform": sys.platform,
                              "cwd": checkout}
    if args.result:
        result = args.result
    elif not cmd:
        raise SystemExit(
            "nothing to do: pass a command after `--`, or `--result` to record "
            "an execution you are reporting rather than running (and then use "
            "--execution owner_report or source_inspection, which is what makes "
            "that honest)")
    else:
        started = time.time()
        crashed = False
        code: int | None = None
        out = err = b""
        try:
            r = subprocess.run(cmd, cwd=checkout, capture_output=True,
                               timeout=args.timeout, shell=False)
            code, out, err = r.returncode, r.stdout, r.stderr
        except FileNotFoundError as e:
            crashed, err = True, f"the command could not start: {e}".encode()
        except subprocess.TimeoutExpired:
            crashed = True
            err = f"timed out after {args.timeout:g}s".encode()
        except OSError as e:
            crashed, err = True, f"the command could not run: {e}".encode()
        runner["exit_code"] = code
        runner["duration_ms"] = int((time.time() - started) * 1000)
        result = _classify(code, expect_fail=args.expect_fail, crashed=crashed)
        # stdout and stderr go in as LOGS, decoded by detection like any other
        # captured output — a suite that prints UTF-16 is still readable here
        for name, raw in (("stdout", out), ("stderr", err)):
            if raw:
                logs.append({**we.decode_log(raw), "path": f"<{name}>"})

    rc = we.receipt(candidate=candidate, checkout=checkout, command=cmd,
                    execution=args.execution, result=result, runner=runner,
                    logs=logs, note=args.note,
                    base=(args.base or None), tree=tree)
    return _emit(rc, args.json_output)


def _emit(rc: dict[str, Any], out_path: str | None) -> int:
    text = json.dumps(rc, indent=2, sort_keys=True, ensure_ascii=False)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    print(text)
    if out_path:
        pathlib.Path(out_path).write_text(text + "\n", encoding="utf-8")
    tree = rc.get("tree") or {}
    if tree.get("in_progress"):
        print(f"⚠ {tree['in_progress']} in progress in {tree.get('checkout')}: "
              f"this tree is a MIXTURE of two commits and the receipt says so",
              file=sys.stderr)
    elif tree.get("state") == "dirty":
        print(f"⚠ measured on a dirty tree ({tree.get('dirty_count')} "
              f"uncommitted path(s)) — recorded, not hidden", file=sys.stderr)
    return 0 if rc.get("green") else 1


if __name__ == "__main__":
    raise SystemExit(main())
