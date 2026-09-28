"""Small-N lock-wait reproduction of the N1000 message burst
(n1000-burst-27-of-messages-fail-with-locktimeout).

Seeds one tiny org (N agents, 20 items, 1 KB transcripts), serves it with the
simulated provider (turns run and END while mail is in flight), SQL counters
and the lock-wait recorder (lock_waits.py) on, then sends the primer's
16-way ordinary messages to every live agent for ROUNDS rounds without waiting
for turns. Receipt: which locks waited, on which holders, for how long, and
how many sends failed (HTTP status, 55P03 per request).

Knobs (environment, recorded in the receipt): LOCK_BURST_ROUNDS (3),
LOCK_BURST_TURN_S (simulated turn seconds, .25), LOCK_BURST_SETTLE_S (10),
ORGTREE_ORGTX_LOCK_TIMEOUT_S passed to the engine when set.
"""
import collections
import concurrent.futures
import json
import os
import statistics
import sys
import time

import httpx

KIND = "lock-burst"


def _knobs():
    return dict(rounds=int(os.environ.get("LOCK_BURST_ROUNDS", "3")),
                turn_s=float(os.environ.get("LOCK_BURST_TURN_S", ".25")),
                settle_s=float(os.environ.get("LOCK_BURST_SETTLE_S", "10")),
                lock_timeout_s=os.environ.get("ORGTREE_ORGTX_LOCK_TIMEOUT_S"))


def _send_all(desc, rounds):
    headers = {"X-Orgtree-Desktop-Token": desc["token"]}
    results = []
    with httpx.Client(base_url=desc["origin"], headers=headers, timeout=120) as client:
        tokens = client.get("/scale/tokens").raise_for_status().json()
        parents = client.get("/scale/workload").raise_for_status().json()["parents"]
        plan = []
        for target in desc["live_agents"]:
            actor = parents.get(target) or next(n for n, p in parents.items() if p == target)
            plan.append((actor, target))

        def send(job):
            actor, target = job
            t0 = time.monotonic()
            r = client.post("/api/agent", json=dict(org=desc["org"], node=actor, tool="orgtree_message",
                            args=dict(to=target, kind="message", body="[lock-burst] synthetic turn.")),
                            headers={"X-Orgtree-Agent-Token": tokens[actor], "X-Scale-Kind": KIND})
            return dict(actor=actor, target=target, status=r.status_code,
                        seconds=round(time.monotonic() - t0, 3),
                        error=None if r.status_code < 400 else r.text[:300])

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            for _ in range(rounds):
                for start in range(0, len(plan), 16):
                    results.extend(pool.map(send, plan[start:start + 16]))
    return results


def summarize(waits, counts, sends):
    """Episodes: one per (waiter pid, lock) run of samples; the max waited_s
    seen is that episode's wait (sampling resolution INTERVAL_S)."""
    episodes = {}
    for w in waits:
        if "pid" not in w:
            continue
        key = (w["pid"], w["lock"], round(w["at"] - (w["waited_s"] or 0), 1))
        e = episodes.setdefault(key, dict(lock=w["lock"], waited_s=0, waiter=w["waiter_site"],
                                          blockers=collections.Counter(), blocker_age_s=0))
        e["waited_s"] = max(e["waited_s"], w["waited_s"] or 0)
        for b in w["blockers"]:
            e["blockers"][" < ".join(b.get("site") or ["(not org_tx)"])] += 1
            e["blocker_age_s"] = max(e["blocker_age_s"], b.get("xact_s") or 0)
    by_lock = collections.defaultdict(list)
    by_blocker = collections.defaultdict(list)
    for e in episodes.values():
        by_lock[e["lock"]].append(e["waited_s"])
        for site in e["blockers"]:
            by_blocker[site].append(e["blocker_age_s"])

    def dist(xs):
        xs = sorted(xs)
        return dict(n=len(xs), max=round(xs[-1], 3), p50=round(statistics.median(xs), 3),
                    p95=round(xs[int(.95 * (len(xs) - 1))], 3))

    secs = [s["seconds"] for s in sends]
    return dict(
        sends=len(sends), failed=sum(s["status"] >= 400 for s in sends),
        statuses=dict(collections.Counter(s["status"] for s in sends)),
        send_s=dist(secs) if secs else None,
        lock_timeouts_55P03=sum(c.get("lock_timeout_55P03", 0) for c in counts),
        errors=sorted({s["error"][:160] for s in sends if s["error"]})[:5],
        wait_episodes=len(episodes),
        by_lock={k: dist(v) for k, v in sorted(by_lock.items(), key=lambda kv: -max(kv[1]))},
        by_blocker_site_xact_age_s={k: dist(v) for k, v in sorted(by_blocker.items(),
                                                                   key=lambda kv: -max(kv[1]))})


def burst(ctrl, admin, n):
    from baseline import REPO, read, write, database_name
    knobs = _knobs()
    name = f"lockburst-{n}"
    root = ctrl.root / name
    ctrl.script("seed.py", name + "-seed", "--root", root, "--agents", n, "--active-items", 20,
                "--archived-per-live", 0, "--archived-items-per-live", 0, "--transcript-kb", 1,
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 12, "--no-profile-item")
    desc = read(root / "scale-descriptor.json")
    try:
        ctrl.script("prepare_steady.py", name + "-prepare", "--root", root, "--seconds",
                    knobs["turn_s"], "--output-bytes", 256)
        env = ["ORGTREE_SCALE_SIMULATED_PROVIDER=1", "ORGTREE_SCALE_SQL_COUNTS=1",
               "ORGTREE_SCALE_LOCK_WAITS=1"]
        if knobs["lock_timeout_s"]:
            env.append(f"ORGTREE_ORGTX_LOCK_TIMEOUT_S={knobs['lock_timeout_s']}")
        ctrl.phase = name + "-serve"
        server = ctrl.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"),
                             "--root", str(root), *(a for e in env for a in ("--env", e))],
                            name + "-serve")
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
            sends = _send_all(desc, knobs["rounds"])
            time.sleep(knobs["settle_s"])          # turns end with locks held
        finally:
            ctrl.kill(server)
            ctrl.engine_pid = None
        counts = [json.loads(line) for line in (root / "metrics/sql-counts.jsonl").read_text(
            encoding="utf-8").splitlines()]
        counts = [c for c in counts if c["kind"] == KIND]
        waits_path = root / "metrics/lock-waits.jsonl"
        waits = [json.loads(line) for line in waits_path.read_text(encoding="utf-8").splitlines()] \
            if waits_path.exists() else []
        summary = dict(agents=n, knobs=knobs, **summarize(waits, counts, sends))
        write(ctrl.root / "receipts" / f"{name}.json", dict(summary, sends=sends))
        write(ctrl.root / "receipts" / f"{name}-summary.json", summary)
        print(json.dumps(summary, indent=1)[:6000])
        return summary
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))
