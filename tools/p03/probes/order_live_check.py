"""The achieved-order comparator on REAL arrived/release frames (p03-lead order, 2026-09-25).

Starts the qualification host (``engine/native/store-trace/tests/live_order.rs``:
WS2's real harness endpoint and channel server, in-process, over an executor on
this agent's WS1 dev cluster), drives schedule ``Q-C4.real_40001`` through
``tools/p03/harness/service_channel.py`` with ``schedule.run_order``, stops the
host, and judges.

``Q-C4.real_40001``: A and B both SERIALIZABLE ``status.set`` on the same agent
row. Both are held at ``status.set.after_claim``: each has taken its snapshot (the
anchor read) and claimed its receipt. A is released and commits; then B is
released, locks the row A changed, and must get a REAL 40001 from PostgreSQL,
retry (its attempt 2 arrives at the same point, ``@2``) and apply. Two orders:

- ``achieved``: the script above. It PASSES only if the achieved order is the
  intended one (B arrived before A was released; A ended before B was released;
  B's attempt 2 arrived and A's never did), B saw SQLSTATE 40001, both applied,
  and the state read back shows two version bumps, two applied receipts and two
  intents. It must actually PASS: a comparator that fails everything proves nothing;
- ``early_release`` (META-CONTROL): the same intended order, but A's hold is
  released before B is even started, so B's snapshot is taken after A's commit
  and there is no conflict. Every script step still runs. The run must come back
  FAILED, for the right reason: ``interleaving not achieved`` and no 40001. A
  pass here, or a failure for some other reason (a service error, a refused
  plan), means the comparator is not what decided it.

The check PASSES only if both hold, the host test itself reports ``1 passed``,
and no other orders were run. Output (records per order, the summary) goes to
``--out``; nothing secret is written: ``host.json`` (loopback ports and per-run
tokens) is deleted by the host on stop and by this script if the host did not.

Usage (under the P03 run lock, cluster up, ``devdb.cmd env`` applied, the host
test already built with ``cargo test --no-run``):
    python -I -B tools/p03/probes/order_live_check.py --crate-dir engine/native/store-trace \
        --out <dir> [--json <file>]
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
from p03.harness.schedule import FAILED, PASSED, Order, Schedule, run_order  # noqa: E402
from p03.harness.service_channel import ChannelClient, ServiceChannel  # noqa: E402

P = "status.set.after_claim"
OPS = {"A": ("status.set", {"status": "one", "serializable": True}),
       "B": ("status.set", {"status": "two", "serializable": True})}
INTENDED = [
    ("before", f"arrived:A:{P}", f"released:A:{P}"),
    ("before", f"arrived:B:{P}", f"released:A:{P}"),   # both snapshots before A moves
    ("before", "end:A", f"released:B:{P}"),             # A committed before B moves
    ("present", f"arrived:B:{P}@2"),                    # B retried ...
    ("absent", f"arrived:A:{P}@2"),                     # ... and A did not
    ("sqlstate", "B", "40001"),
    ("outcome", "A", "applied"),
    ("outcome", "B", "applied"),
]
ACHIEVED = Order("achieved", [
    ("start", "A"), ("arrive", "A", P), ("start", "B"), ("arrive", "B", P),
    ("release", "A", P), ("await_end", "A"), ("release", "B", P),
    ("arrive", "B", P, 2), ("release", "B", P, 2), ("await_end", "B")], INTENDED)
EARLY = Order("early_release", [
    ("start", "A"), ("arrive", "A", P), ("release", "A", P), ("await_end", "A"),
    ("start", "B"), ("arrive", "B", P), ("release", "B", P), ("await_end", "B")], INTENDED)


def pass_condition(records: list[dict], _achieved: list[dict], final: dict) -> bool:
    s = final.get("state") or {}
    commits = [r for r in records if r.get("kind") == "tx_end" and r.get("outcome") == "commit"
               and not r.get("infrastructure")]
    by_tag = {}
    for r in records:
        if r.get("kind") == "op_begin":
            by_tag[r.get("operation_id")] = r.get("op_tag")
    committed = sorted(by_tag.get(r.get("operation_id")) or "?" for r in commits)
    return (s.get("version") == 2 and s.get("applied_receipts") == 2 and s.get("intents") == 2
            and committed == ["A", "B"])


SCHEDULE = Schedule("Q-C4", OPS, [ACHIEVED, EARLY], pass_condition=pass_condition,
                    step_timeout=20.0, plan_timeout=20.0,
                    notes="Q-C4 real 40001 (WS2 tests/pg.rs q_c4_real_serialization_failure...)")


def wait_for(path: Path, proc: subprocess.Popen, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"the host exited ({proc.returncode}) before serving")
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass   # half-written: try again
        time.sleep(0.25)
    raise RuntimeError(f"no {path.name} within {timeout}s")


def check(results: dict, host_log: str) -> list[str]:
    p = []
    a, e = results.get("achieved"), results.get("early_release")
    if a is None or e is None:
        return ["an order did not run"]
    if a["verdict"] != PASSED:
        p.append(f"achieved: the intended order did not pass on the real service: {a['reasons']}")
    if a.get("pass_condition_held") is not True:
        p.append("achieved: the pass condition was not evaluated as held")
    if e["verdict"] != FAILED:
        p.append(f"early_release: the meta-control came back {e['verdict']}, not FAILED")
    if not any(r.startswith("interleaving not achieved") for r in e["reasons"]):
        p.append(f"early_release: it did not fail on the interleaving: {e['reasons']}")
    other = [r for r in e["reasons"] if r.startswith(("the service reported", "invalid plan",
                                                      "incomplete-contact", "the plan"))]
    if other:
        p.append(f"early_release: it failed for a reason other than the order: {other}")
    # --nocapture: the host's own "serving" line lands between "test order_host ..." and
    # "ok", so the per-test line is not matched literally; the summary line is exact
    if "test order_host ..." not in host_log or not re.search(
            r"^test result: ok\. 1 passed; 0 failed;", host_log, re.M):
        p.append("the host test did not report order_host and 'test result: ok. 1 passed; 0 failed'")
    return p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--crate-dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--json")
    ap.add_argument("--serve-timeout", type=float, default=300.0)
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    desc = out / "host.json"
    if desc.exists():
        desc.unlink()
    env = dict(os.environ, P03_WS7_OUT=str(out))
    for name in ("P03_PG_ADMIN_URL", "P03_PG_RUNTIME_URL"):
        if not env.get(name):
            print(f"{name} is not set: nothing ran", file=sys.stderr)
            return 2
    log_path = out / "host-cargo.log"
    # child output to a FILE, never a pipe (WS1: inherited pipe handles hang the parent)
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(
            ["cargo", "test", "--offline", "--features", "sink", "--test", "live_order", "--",
             "--ignored", "--test-threads=1", "--nocapture"],
            cwd=args.crate_dir, env=env, stdout=log, stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL)
    results: dict = {}
    problems: list[str] = []
    try:
        host = wait_for(desc, proc, args.serve_timeout)
        for order in SCHEDULE.orders:
            ch = ServiceChannel(host, run=order.name)
            try:
                r = run_order(ch, SCHEDULE, order)
            finally:
                ch.close()
            results[order.name] = {**r.summary(), "handshake_build": r.handshake.get("build_sha")}
            (out / f"{order.name}.records.jsonl").write_text(
                "".join(json.dumps(x) + "\n" for x in r.records), encoding="utf-8")
            (out / f"{order.name}.achieved.json").write_text(
                json.dumps(r.achieved, indent=1), encoding="utf-8")
    except Exception as ex:   # noqa: BLE001 - any failure to run is a failed check, said plainly
        problems.append(f"the run did not complete: {type(ex).__name__}: {ex}")
    finally:
        try:
            if desc.exists():
                h = json.loads(desc.read_text(encoding="utf-8"))
                c = ChannelClient(h["port"], h["token"], 10.0)
                c.call({"verb": "qual.stop", "org": h["org"], "args": {},
                        "binding": {"principal_kind": "agent", "principal": h["principal"],
                                    "generation": h["generation"], "acting": None, "key": None,
                                    "op_tag": None}})
                c.close()
        except Exception as ex:   # noqa: BLE001
            problems.append(f"could not stop the host: {ex}")
        try:
            proc.wait(timeout=90)
        except subprocess.TimeoutExpired:
            proc.kill()
            problems.append("the host did not exit within 90 s and was killed")
        if desc.exists():
            desc.unlink()
    host_log = log_path.read_text(encoding="utf-8", errors="replace")
    if not problems:
        problems = check(results, host_log)
    report = {"schedule": "Q-C4.real_40001", "orders": results, "problems": problems,
              "host_exit": proc.returncode, "verdict": "PASSED" if not problems else "FAILED"}
    text = json.dumps(report, indent=2)
    if args.json:
        Path(args.json).write_text(text, encoding="utf-8")
    print(text)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
