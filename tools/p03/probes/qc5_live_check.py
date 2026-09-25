"""The verdict on the REAL Q-C5 control (engine/native/store-trace tests/live_qc5.rs).

For each scenario the Rust test wrote ``<name>.records.jsonl`` (the collector's
trace) and ``<name>.meta.json`` (its marker nonce, the admin session to exclude,
the armed controls). This script takes the server-log lines strictly between that
scenario's two marker statements, drops the harness's own admin session, and
reconciles them with the trace (``serverlog.reconcile``).

It PASSES only if all of these hold:
- both traces are complete-contact (``trace.stream_health``);
- ``clean`` (nothing armed): the log reconciles with the trace, no control
  record appears. Without this positive control a "detection" could be noise;
- ``hidden`` (``Q-C5.hidden_pooled_statement`` armed): the control recorded
  ``control_executed`` (r7 §8.1: a control must record that it ran), and the
  reconciler FAILS with hidden access on exactly the executor's pooled session,
  and with nothing else.

Usage (under the P03 run lock, after the Rust test):
    python -I -B tools/p03/probes/qc5_live_check.py --out <dir> --log-dir <qual-logs> [--json <file>]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from p03.harness import serverlog  # noqa: E402
from p03.harness.trace import stream_health  # noqa: E402

CONTROL = "Q-C5.hidden_pooled_statement"
FACTORIES = ["executor", "lookup"]


def log_lines(log_dir: Path) -> list[str]:
    lines: list[str] = []
    for f in sorted(log_dir.glob("*.json"), key=lambda p: p.stat().st_mtime):
        lines += f.read_text(encoding="utf-8", errors="replace").splitlines()
    return lines


def window(lines: list[str], meta: dict) -> "tuple[list[str] | None, str]":
    start = f"p03-ws7-qc5-start-{meta['scenario']}-{meta['nonce']}"
    end = f"p03-ws7-qc5-end-{meta['scenario']}-{meta['nonce']}"
    s = [i for i, ln in enumerate(lines) if start in ln]
    e = [i for i, ln in enumerate(lines) if end in ln]
    if len(s) != 1 or len(e) != 1 or not s[0] < e[0]:
        return None, f"markers not found exactly once in order (start {len(s)}, end {len(e)})"
    out = []
    for ln in lines[s[0] + 1:e[0]]:
        try:
            if json.loads(ln).get("session_id") == meta["admin_session"]:
                continue
        except json.JSONDecodeError:
            pass
        out.append(ln)
    return out, ""


def check(out_dir: Path, log_dir: Path) -> dict:
    lines = log_lines(log_dir)
    report: dict = {"limit": serverlog.LIMIT, "scenarios": {}, "problems": []}
    for name in ("clean", "hidden"):
        meta = json.loads((out_dir / f"{name}.meta.json").read_text(encoding="utf-8"))
        records = [json.loads(ln) for ln in
                   (out_dir / f"{name}.records.jsonl").read_text(encoding="utf-8").splitlines() if ln]
        health = stream_health(records, [meta["stream"]])
        win, why = window(lines, meta)
        executed = [r for r in records if r.get("kind") == "control_executed"
                    and r.get("control_id") == CONTROL]
        exec_sessions = {(r["backend_start"] // 1_000_000, r["backend_pid"]) for r in records
                         if r.get("kind") == "conn_opened" and r.get("factory") == "executor"
                         and isinstance(r.get("backend_pid"), int)
                         and isinstance(r.get("backend_start"), int)}
        verdict = serverlog.reconcile(records, win, FACTORIES) if win is not None else None
        s = {"records": len(records), "complete_contact": health["complete"],
             "log_lines_in_window": None if win is None else len(win),
             "control_executed": len(executed), "executor_sessions": sorted(map(list, exec_sessions)),
             "reconcile": verdict}
        report["scenarios"][name] = s
        p = report["problems"]
        if not health["complete"]:
            p.append(f"{name}: incomplete-contact trace: {health['problems'][:3]}")
        if win is None:
            p.append(f"{name}: {why}")
            continue
        if not win:
            p.append(f"{name}: no server-log lines in the window: the run left no evidence")
        if len(exec_sessions) != 1:
            p.append(f"{name}: expected one pooled executor session, saw {len(exec_sessions)}")
        if name == "clean":
            if executed:
                p.append("clean: a control fired although none was armed")
            if verdict["verdict"] != "PASSED":
                p.append(f"clean: the log does not reconcile with the trace: {verdict['failures']}")
        else:
            if not executed:
                p.append("hidden: control did not run: no control_executed record")
            if verdict["verdict"] != "FAILED":
                p.append("hidden: the hidden pooled statement was NOT detected")
            session = next(iter(exec_sessions)) if len(exec_sessions) == 1 else None
            hidden = [f for f in verdict["failures"]
                      if session and f.startswith(f"session {session}: hidden access")]
            other = [f for f in verdict["failures"] if f not in hidden]
            if not hidden:
                p.append(f"hidden: no hidden-access failure on the executor session {session}")
            if other:
                p.append(f"hidden: failures other than the hidden statement: {other}")
    report["verdict"] = "PASSED" if not report["problems"] else "FAILED"
    return report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--log-dir", required=True)
    ap.add_argument("--json")
    args = ap.parse_args(argv)
    report = check(Path(args.out), Path(args.log_dir))
    text = json.dumps(report, indent=2)
    if args.json:
        Path(args.json).write_text(text, encoding="utf-8")
    print(json.dumps({"verdict": report["verdict"], "problems": report["problems"],
                      **{n: {k: v for k, v in s.items() if k != "reconcile"}
                         | {"reconcile": (s["reconcile"] or {}).get("verdict"),
                            "failures": (s["reconcile"] or {}).get("failures")}
                         for n, s in report["scenarios"].items()}}, indent=2))
    return 0 if report["verdict"] == "PASSED" else 1


if __name__ == "__main__":
    sys.exit(main())
