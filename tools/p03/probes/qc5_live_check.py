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
from p03.harness import oracle, serverlog  # noqa: E402
from p03.harness.trace import stream_health  # noqa: E402

CONTROL = "Q-C5.hidden_pooled_statement"
NO_BASELINE = "Q-C5.no_xact_baseline"
FACTORIES = ["executor", "lookup"]
#: the declared contacts of the two commands live_qc5.rs runs (their SQL is in that file)
DECLARED = {
    "status.set": {"relations": {
        "authority_epoch": {"modes": ["read", "for_share"], "required": True},
        "runtime_state": {"modes": ["read", "for_no_key_update", "write"], "required": True},
        "outgoing_intents": {"modes": ["write"], "required": True},
        "operation_receipts": {"modes": ["read", "write"], "required": True}},
        "p01_contract": None, "source": "live_qc5.rs SetStatus (WS2 tests/pg.rs shape)"},
    "probe.read_agent": {"relations": {
        "agents": {"modes": ["read"], "required": True},
        "operation_receipts": {"modes": ["read", "write"], "required": True}},
        "p01_contract": None, "source": "live_qc5.rs ReadAgent"},
}


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
    for name in ("clean", "hidden", "mixed", "mixed_nobaseline"):
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
        if name in ("mixed", "mixed_nobaseline"):
            # decision 6: two DIFFERENT kinds on one pooled connection; the full Q-C5
            # oracle with the server log as the hidden-access ground truth
            fired = [r for r in records if r.get("kind") == "control_executed"]
            q = oracle.q_c5(DECLARED, records, FACTORIES, server_log=win)
            s["q_c5"] = {k: q[k] for k in ("verdict", "failures", "over_declared")}
            s["control_executed"] = len([r for r in fired if r.get("control_id") == NO_BASELINE])
            if verdict["verdict"] != "PASSED":
                p.append(f"{name}: the log does not reconcile with the trace: {verdict['failures']}")
            if name == "mixed":
                if fired:
                    p.append("mixed: a control fired although none was armed")
                if q["verdict"] != "PASSED":
                    p.append(f"mixed: Q-C5 failed with the baseline difference in place: {q['failures']}")
            else:
                if not s["control_executed"]:
                    p.append("mixed_nobaseline: control did not run: no control_executed record")
                charged = [f for f in q["failures"] if f.startswith("probe.read_agent")
                           and "server observed undeclared relation" in f]
                other = [f for f in q["failures"] if f not in charged]
                if not charged:
                    p.append("mixed_nobaseline: without the baseline the second operation was NOT "
                             "charged with the first operation's relations: the mutation survived")
                if other:
                    p.append(f"mixed_nobaseline: failures other than the carried-over relations: {other}")
            continue
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
