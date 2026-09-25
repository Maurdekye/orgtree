"""PG-5: the 8-agent load test, before (SQLite) and after (PostgreSQL).

THE PROBLEM. PYPG replaces DOC_LOCK with row transactions. The one before/after
measurement the user asked for (decisions 30-31; the coordinator's ruling of
2026-09-25 17:32Z on pg-5-python-race-test-hooks-the-10-race-tests-an) is:

  * the qualify-v3 backend adapter (tools/v3_qualification/backend.py: the
    production TokenGate + /api/agent + dispatcher over a runner-owned
    synthetic root; no lifespan, no providers, no external process);
  * 8 synthetic agents, a MIXED workload: mail send, status, work evidence
    and an org/tree read;
  * arm "before" on ORGTREE_STORE=sqlite, arm "after" on postgres against a
    DISPOSABLE database that this tool creates and drops;
  * headline at EQUAL WORK (fixed-work: the same operations, all offered at
    once), second arm at FIXED DEMAND (the same operations offered at a
    fixed rate);
  * a STRESS LEVEL: 8 agents all issuing calls back to back is far above the
    observed fleet, which the report states beside it.

Each arm runs in its own child interpreter with the qualification runner's
isolation: a fresh temp root carrying a nonce marker, every ORGTREE_* and
provider variable cleared before import, HOME/APPDATA/TEMP redirected, and
the runner's audit hook refusing every external process except read-only git.

The report withholds no counter: offered, completed, failed, refused per
operation kind, and the correctness check after each arm (every evidence
ref present, every mail landed in its recipient's inbox, the reads all
answered). An arm whose counters did not advance, or whose correctness
check failed, is reported as failed and its latencies are not the headline.

Usage (HEAVY: only through the run lock, exclusive):
  python tools/pg5_load.py --arms sqlite postgres --pg-admin-url <disposable>
      --pydeps <folder with psycopg> --output artifacts/pg5/load.json
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / "tools")]

from v3_qualification import runner  # noqa: E402
from v3_qualification.evidence import distribution  # noqa: E402

SCHEMA = "orgtree.pg5-load/v1"
KINDS = ("mail", "status", "evidence", "read")
AGENTS = 8

#: Relayed, not measured by PG-5: the coordinator's standing charter records the
#: real fleet peaking at 0.936 Hz aggregate with a MEDIAN OF ZERO concurrent turns.
OBSERVED_FLEET = {"aggregate_peak_hz": 0.936, "median_concurrent_turns": 0,
                  "source": "coordinator-opus standing charter (relayed, not measured here)"}


# ---------------------------------------------------------------- child side

def _plan(operations: int) -> list[tuple[int, str, int]]:
    """(index, kind, actor) — the kinds interleave evenly across the agents."""
    return [(i, KINDS[i % len(KINDS)], i % AGENTS) for i in range(operations)]


def child(root: Path, nonce: str, config: dict) -> None:
    root = root.resolve()
    marker = json.loads((root / "qualification-root.json").read_text(encoding="utf-8"))
    if marker != {"schema": SCHEMA, "nonce": nonce, "root": str(root)}:
        raise RuntimeError("not a pg5-load-owned synthetic root")
    if Path(os.environ.get("ORGTREE_DATA", "")).resolve() != root / "data":
        raise RuntimeError("child environment/root mismatch")
    if any((root / "data").iterdir()):
        raise RuntimeError("an arm needs empty synthetic data")
    if config.get("pydeps"):
        sys.path.insert(0, config["pydeps"])
    sys.path[:0] = [str(REPO / "engine/backend"), str(REPO / "tools"), str(REPO)]
    from v3_qualification.backend import Backend
    adapter = Backend(REPO, root)
    try:
        store = adapter.store
        if store.STORE_BACKEND != config["arm"]:
            raise RuntimeError(f"store backend {store.STORE_BACKEND!r} is not the arm {config['arm']!r}")
        if config["arm"] == "postgres":
            store.claim_data_root()           # migrates the disposable database
        adapter.fixture(AGENTS)
        slug, _ = adapter.item("pg5 load", AGENTS)
        rows = [measure(adapter, slug, mode, config) for mode in config["modes"]]
        result = {"arm": config["arm"], "store_backend": store.STORE_BACKEND,
                  "provenance": list(adapter.provenance), "workloads": rows}
        (root / "arm.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    finally:
        adapter.close()


def measure(adapter, slug: str, mode: str, config: dict) -> dict:
    operations, rate = config["operations"], config["rate"]
    tag = f"{mode}-{uuid.uuid4().hex[:8]}"
    plan = _plan(operations)
    samples: list[dict] = []
    guard = threading.Lock()
    adapter.probe.snapshot(reset=True)
    start = time.perf_counter()

    def call(kind: str, i: int, actor: str):
        if kind == "mail":
            to = f"worker-{(int(actor.split('-')[1]) + 1) % AGENTS}"
            return adapter.request("orgtree_message", {"to": to, "kind": "message",
                                   "body": f"{tag} mail {i}"}, actor=actor), to
        if kind == "status":
            return adapter.request("orgtree_status", {"status": "working" if i % 2 else "idle",
                                   "summary": f"{tag} status {i}"}, actor=actor), None
        if kind == "evidence":
            return adapter.request("orgtree_work", {"action": "evidence", "slug": slug, "kind": "note",
                                   "ref": f"{tag}-{i}", "note": "pg5 load"}, actor=actor), None
        return adapter.request("orgtree_chart", {}, actor=actor), None

    def one(i: int, kind: str, a: int, due: float, enqueued: float) -> None:
        actor = f"worker-{a}"
        begun = time.perf_counter()
        status, error, to = None, None, None
        try:
            response, to = call(kind, i, actor)
            status = response.status_code
            if status != 200 or response.json().get("state") == "running":
                error = f"HTTP {status}: {response.text[:300]}"
        except Exception as exc:                                 # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
        ended = time.perf_counter()
        with guard:
            samples.append({"id": i, "kind": kind, "actor": actor, "to": to, "status": status,
                            "error": error, "executor_queue_ms": (begun - enqueued) * 1000,
                            "http_asgi_ms": (ended - begun) * 1000,
                            "offered_to_complete_ms": (ended - due) * 1000})

    with concurrent.futures.ThreadPoolExecutor(max_workers=AGENTS) as pool:
        futures = []
        for i, kind, a in plan:
            due = start if mode == "fixed-work" else start + i / rate
            delay = due - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            futures.append(pool.submit(one, i, kind, a, due, time.perf_counter()))
        for f in futures:
            f.result()
    duration = time.perf_counter() - start
    probe = adapter.probe.snapshot(reset=True)

    # correctness, read back through the same public door
    item = adapter.work("get", slug=slug)["item"]
    want_refs = {f"{tag}-{i}" for i, k, _ in plan if k == "evidence"}
    got_refs = {e.get("ref") for e in item.get("evidence", [])} & want_refs
    sent_to: dict[str, int] = {}
    for s in samples:
        if s["kind"] == "mail" and s["error"] is None:
            sent_to[s["to"]] = sent_to.get(s["to"], 0) + 1
    landed = _mail_landed(adapter, tag)
    errors = []
    if len(got_refs) != len(want_refs):
        errors.append(f"evidence: {len(want_refs) - len(got_refs)} of {len(want_refs)} refs missing")
    for w, n in sent_to.items():
        if landed[w]["found"] < n:
            errors.append(f"mail: {w} has {landed[w]['found']} of {n} (boxed or archived)")
    by_kind = {}
    for kind in KINDS:
        ks = [s for s in samples if s["kind"] == kind]
        ok = [s for s in ks if s["error"] is None]
        by_kind[kind] = {"offered": sum(1 for _, k, _ in plan if k == kind), "completed": len(ok),
                         "failed": len(ks) - len(ok),
                         "refused": sum(s["status"] in (403, 409, 422) for s in ks),
                         "first_errors": [s["error"] for s in ks if s["error"]][:3],
                         "http_asgi_ms": distribution([s["http_asgi_ms"] for s in ok]),
                         "offered_to_complete_ms": distribution([s["offered_to_complete_ms"] for s in ok])}
        if len(ok) == 0:
            errors.append(f"{kind}: no call completed — its counters did not advance")
    completed = sum(v["completed"] for v in by_kind.values())
    if completed != operations:
        errors.append(f"{operations - completed} of {operations} calls failed")
    return {"mode": mode, "agents": AGENTS, "operations": operations,
            "offered_rate_per_s": rate if mode == "fixed-demand" else None,
            "mix": {k: v["offered"] for k, v in by_kind.items()},
            "classification": "passed" if not errors else "failed", "errors": errors,
            "duration_s": duration, "completed_per_s": completed / duration if duration else None,
            "latency_all": {m: distribution([s[m] for s in samples if s["error"] is None])
                            for m in ("executor_queue_ms", "http_asgi_ms", "offered_to_complete_ms")},
            "by_kind": by_kind, "mail_landed": landed, "mail_sent": sent_to,
            "stateprobe": {"operations": probe["operations"],
                           "lazy_materializations": probe["lazy_materializations"]}}


def _mail_landed(adapter, tag: str) -> dict[str, dict[str, int]]:
    """Per recipient: how many DISTINCT mails of this run (body carries the tag)
    are still boxed, or already taken for delivery but archived in its
    `mail_log`. A mail in neither place is lost."""
    org = adapter.store.load_org(adapter.slug)
    out = {}
    for a in range(AGENTS):
        w = f"worker-{a}"
        boxed = {str(m.get("body")) for m in org.mailbox_in_receive_order(w)
                 if tag in str(m.get("body", ""))}
        logged = {str(m.get("body")) for m in ((org.d.get("mail_log") or {}).get(w) or [])
                  if tag in str(m.get("body", ""))}
        out[w] = {"found": len(boxed | logged), "boxed": len(boxed), "archived": len(logged)}
    return out


# ---------------------------------------------------------------- parent side

def _free_commit_gb() -> float | None:
    if os.name != "nt":
        return None
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command",
                              "(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory"],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return round(int(out) / 1024 / 1024, 2)
    except Exception:                                            # noqa: BLE001
        return None


def _disposable_db(admin: str) -> str:
    import psycopg
    if not re.search(r"@(127\.0\.0\.1|localhost|\[::1\]):", admin):
        raise RuntimeError("the PostgreSQL admin URL must be a loopback (disposable) server")
    db = f"orgtree_pg5load_t{os.getpid()}"
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {db}")
    p = urlsplit(admin)
    return urlunsplit((p.scheme, p.netloc, "/" + db, p.query, p.fragment))


def _drop_db(admin: str, url: str) -> None:
    import psycopg
    db = urlsplit(url).path.lstrip("/")
    if not db.startswith("orgtree_pg5load_t"):
        raise RuntimeError(f"refusing to drop {db!r}")
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {db} WITH (FORCE)")


def run_arm(arm: str, interpreter: str, args, config: dict) -> dict:
    tmp = tempfile.TemporaryDirectory(prefix=f"orgtree-pg5load-{arm}-")
    root = Path(tmp.name).resolve()
    url = None
    try:
        for d in ("data", "home", "temp"):
            (root / d).mkdir()
        nonce = uuid.uuid4().hex
        (root / "qualification-root.json").write_text(
            json.dumps({"schema": SCHEMA, "nonce": nonce, "root": str(root)}), encoding="utf-8")
        env = runner.child_env(root)
        env["ORGTREE_STORE"] = arm
        if arm == "postgres":
            if args.pydeps:
                sys.path.insert(0, args.pydeps)
            url = _disposable_db(args.pg_admin_url)
            env["ORGTREE_PG_URL"] = url
        cfg = dict(config, arm=arm, pydeps=args.pydeps or "")
        cmd = [interpreter, "-I", "-B", str(Path(__file__).resolve()), "--child",
               "--root", str(root), "--nonce", nonce, "--config", json.dumps(cfg)]
        free_before = _free_commit_gb()
        if free_before is not None and free_before < args.min_free_commit_gb:
            raise RuntimeError(f"free commit {free_before} GB < {args.min_free_commit_gb} GB floor")
        r = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=args.timeout)
        if r.returncode:
            raise RuntimeError(f"{arm} arm failed ({r.returncode}): {r.stdout[-1000:]} {r.stderr[-4000:]}")
        out = json.loads((root / "arm.json").read_text(encoding="utf-8"))
        out["free_commit_gb"] = {"before": free_before, "after": _free_commit_gb()}
        if url:
            out["pg_database"] = urlsplit(url).path.lstrip("/")
        return out
    finally:
        if url:
            _drop_db(args.pg_admin_url, url)
        tmp.cleanup()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--arms", nargs="+", choices=["sqlite", "postgres"], default=["sqlite", "postgres"])
    p.add_argument("--modes", nargs="+", choices=["fixed-work", "fixed-demand"],
                   default=["fixed-work", "fixed-demand"])
    p.add_argument("--operations", type=int, default=160)
    p.add_argument("--rate", type=float, default=8.0, help="fixed-demand offered calls/s")
    p.add_argument("--pg-admin-url", default=os.environ.get("ORGTREE_TEST_PG_ADMIN_URL", ""))
    p.add_argument("--pydeps", default=os.environ.get("ORGTREE_TEST_PYDEPS", ""))
    p.add_argument("--python", help="interpreter (selected via run-python-verification)")
    p.add_argument("--timeout", type=float, default=900)
    p.add_argument("--min-free-commit-gb", type=float, default=8.0)
    p.add_argument("--output")
    p.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--root", help=argparse.SUPPRESS)
    p.add_argument("--nonce", help=argparse.SUPPRESS)
    p.add_argument("--config", help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    if args.child:
        child(Path(args.root), args.nonce, json.loads(args.config))
        return 0
    if not 8 <= args.operations <= 2000 or args.operations % len(KINDS):
        p.error("operations must be 8..2000 and a multiple of 4")
    if "postgres" in args.arms and not args.pg_admin_url:
        p.error("the postgres arm needs --pg-admin-url (a DISPOSABLE loopback server)")
    interpreter = runner.verification_module(REPO).select_interpreter(REPO, args.python).path
    config = {"operations": args.operations, "rate": args.rate, "modes": args.modes}
    report = {"schema": SCHEMA, "candidate": runner.identity(REPO), "config": config,
              "agents": AGENTS, "label": "STRESS LEVEL: 8 synthetic agents issuing calls back to back",
              "observed_fleet": OBSERVED_FLEET, "arms": [], "errors": []}
    for arm in args.arms:
        try:
            report["arms"].append(run_arm(arm, interpreter, args, config))
        except Exception as exc:                                 # noqa: BLE001
            report["errors"].append(f"{arm}: {type(exc).__name__}: {exc}")
    report["candidate_unchanged"] = runner.identity(REPO) == report["candidate"]
    report["passed"] = (not report["errors"] and report["candidate_unchanged"]
                        and len(report["arms"]) == len(args.arms)
                        and all(w["classification"] == "passed" for a in report["arms"] for w in a["workloads"]))
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(encoded, encoding="utf-8")
    print(encoded)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
