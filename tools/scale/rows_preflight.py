"""Fail fast when per-request PG rows grow with the number of agents.

The N1000 attempt 3 (2026-09-28) spent 25 minutes of readiness before its
primer showed that every request read ~4133 rows / 60 MB (a whole-org load)
and one ordinary message read ~16.5k rows / 197 MB. This preflight seeds tiny
N=10 and N=100 orgs on the controller's own PG cluster, serves each with SQL
counters on, sends the same calls, and refuses to continue when a judged call
reads more than THRESHOLD times the rows at N=100 than at N=10.

Judged (PRODUCT routes only): one ordinary orgtree_message POST (the primer's
call), the desk chat read and the docket foreground read that ui_hooks polls.
Recorded, not judged: the harness routes /scale/tokens, /scale/workload and
/scale/settlement (serve.py; they load the whole org on purpose), and the
foreground tree, whose payload covers the visible agents by design.
"""
import json
import os
import sys
import time

import httpx

SIZES = (10, 100)
THRESHOLD = 2.0
JUDGED = ("work_items", "chat", "message")
KIND = "rows-preflight"


def verdict(results, threshold=THRESHOLD):
    """results: {n: {call: {"rows": int, ...}}} -> (passed, per-call rows ratios)."""
    small, large = (results[n] for n in SIZES)
    ratios = {}
    for call in JUDGED:
        if call not in small or call not in large or not small[call]["rows"]:
            raise ValueError(f"rows preflight did no measurable work for {call}")
        ratios[call] = large[call]["rows"] / small[call]["rows"]
    return all(r <= threshold for r in ratios.values()), ratios


def fallbacks(results):
    """Judged calls that had to decode every node row (ORGTREE_LAZY_ROWS
    fallbacks). A fallback is a whole-org read: any at all fails."""
    return {f"{n}:{call}": results[n][call].get("lazy_fallbacks", 0)
            for n in SIZES for call in JUDGED if results[n][call].get("lazy_fallbacks", 0)}


def calls(desc):
    """The fixed call sequence; returns the call labels in order."""
    headers = {"X-Orgtree-Desktop-Token": desc["token"], "X-Scale-Kind": KIND}
    labels = []
    with httpx.Client(base_url=desc["origin"], headers=headers, timeout=120) as client:
        tokens = client.get("/scale/tokens").raise_for_status().json(); labels.append("tokens")
        parents = client.get("/scale/workload").raise_for_status().json()["parents"]; labels.append("workload")
        client.get("/scale/settlement").raise_for_status(); labels.append("settlement")
        base, target = f"/api/orgs/{desc['org']}", sorted(desc["live_agents"])[0]
        for label, url in (("foreground_tree", base + "/foreground-tree"),
                           ("work_items", base + "/work-items-foreground?backlogged=0&archive_limit=0"),
                           ("chat", f"{base}/nodes/{target}/chat?last=8")):
            client.get(url).raise_for_status(); labels.append(label)
        actor = parents.get(target) or next(n for n, p in parents.items() if p == target)
        client.post("/api/agent", json=dict(org=desc["org"], node=actor, tool="orgtree_message",
            args=dict(to=target, kind="message", body="[rows-preflight] synthetic readiness message.")),
            headers={"X-Orgtree-Agent-Token": tokens[actor]}).raise_for_status()
        labels.append("message")
    return labels


def arm(ctrl, admin, n):
    from baseline import REPO, read, write, database_name
    root = ctrl.root / f"preflight-{n}"
    name = f"preflight-{n}"
    ctrl.script("seed.py", name + "-seed", "--root", root, "--agents", n, "--active-items", 20,
                "--archived-per-live", 0, "--archived-items-per-live", 0, "--transcript-kb", 1,
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 12, "--no-profile-item")
    desc = read(root / "scale-descriptor.json")
    try:
        ctrl.script("prepare_steady.py", name + "-prepare", "--root", root, "--seconds", .25, "--output-bytes", 256)
        ctrl.phase = name + "-serve"
        server = ctrl.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"),
            "--root", str(root), "--env", "ORGTREE_SCALE_SIMULATED_PROVIDER=1",
            "--env", "ORGTREE_SCALE_SQL_COUNTS=1",
            *(a for k in ("ORGTREE_LAZY_ROWS",) if k in os.environ
              for a in ("--env", f"{k}={os.environ[k]}"))], name + "-serve")
        try:
            deadline = time.monotonic() + 300
            while True:
                ctrl.check()
                if server.poll() is not None:
                    raise RuntimeError(f"{name} server exited during startup")
                desc = read(root / "scale-descriptor.json")
                ctrl.engine_pid = desc.get("serve", {}).get("pid")
                if desc.get("serve", {}).get("state") == "ready":
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError(f"{name} startup deadline expired")
                time.sleep(.2)
            labels = calls(desc)
        finally:
            ctrl.kill(server)
            ctrl.engine_pid = None
        if (root / "metrics/qualification-invalid.json").exists():
            raise RuntimeError(f"{name}: unexpected process launch")
        rows = [json.loads(line) for line in (root / "metrics/sql-counts.jsonl").read_text(
            encoding="utf-8").splitlines()]
        rows = [r for r in rows if r["kind"] == KIND]
        if len(rows) != len(labels):
            raise RuntimeError(f"{name}: {len(rows)} counted requests for {len(labels)} calls")
        # Boundary rows are appended at response end; the calls are sequential.
        result = {label: row for label, row in zip(labels, sorted(rows, key=lambda r: r["at"]))}
        write(ctrl.root / "receipts" / f"{name}.json", result)
        return result
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))


def preflight(ctrl, admin):
    results = {n: arm(ctrl, admin, n) for n in SIZES}
    passed, ratios = verdict(results)
    fell = fallbacks(results)
    passed = passed and not fell
    summary = dict(passed=passed, threshold=THRESHOLD, ratios=ratios, sizes=SIZES,
                   lazy_rows=os.environ.get("ORGTREE_LAZY_ROWS", ""), lazy_fallbacks=fell,
                   rows={n: {k: v["rows"] for k, v in r.items()} for n, r in results.items()},
                   value_bytes={n: {k: v["value_bytes"] for k, v in r.items()} for n, r in results.items()})
    from baseline import write
    write(ctrl.root / "receipts" / "rows-preflight.json", summary)
    if not passed:
        raise RuntimeError(f"rows preflight: per-request rows grow with N (N=100/N=10 {ratios}) "
                           f"or judged calls fell back to whole reads ({fell})")
    return summary
