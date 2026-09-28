"""N=1000 message-burst memory repro for the engine (baseline.py --burst-repro).

N1000 attempt 4 (2026-09-28) stopped at "engine > 5 GB": private memory went
1.41 -> 5.50 GB within ~17 s of the primer's 16-way ordinary-message burst,
with readiness done and history ingest idle. This mode reproduces only that:
seed N=1000 (the N1000 recipe, no history), serve, wait for readiness, run the
same primer burst until it ends or the guard stops it. Nothing else runs. The
controller guard records the engine's private bytes about once a second
(guard.jsonl); that is the default memory series, copied into the outcome.

tracemalloc is OPT-IN (--burst-tracemalloc N) and comes with a warning: at
N=1000 (a ~1 GB heap) a /scale/mem snapshot during the burst blocked the event
loop for minutes and grew memory by itself (mem-leak-probe, 2026-09-28 05:19Z:
0/16 primer acks in 200 s). Use it only if you accept that distortion.

Differences from attempt 4, by design: no history bundle/restore (history was
idle during the climb). Outputs in <root>/receipts/burst/: sql-counts.jsonl,
serve.log, simulated-turns.jsonl (and, with tracemalloc, mem-start.json and
mem-snaps.jsonl, one /scale/mem diff per line); receipts/burst-outcome.json.
"""
import json
import shutil
import sys
import threading
import time

import httpx


def snapshots(origin, token, out, stop, every):
    """/scale/mem?action=snap (diff vs the previous snapshot) every `every` s."""
    with httpx.Client(base_url=origin, headers={"X-Orgtree-Desktop-Token": token}, timeout=300) as client:
        while not stop.is_set():
            t = time.time()
            try:
                row = client.get("/scale/mem", params={"action": "snap"}).raise_for_status().json()
            except httpx.HTTPError as exc:
                row = {"error": f"{type(exc).__name__}: {exc}"}
            with open(out, "a", encoding="utf-8") as target:
                target.write(json.dumps({"at": t, **row}) + "\n")
            stop.wait(max(0.0, every - (time.time() - t)))


def engine_series(guard_path, burst_start):
    """The guard's engine-private samples around the burst (default series)."""
    guard = [json.loads(line) for line in guard_path.read_text(encoding="utf-8").splitlines()]
    before = [g for g in guard if g["at"] < burst_start and g["engine_private"]]
    series = [dict(t=round(g["at"] - burst_start, 1), engine_mb=round(g["engine_private"] / 2**20),
                   free_commit_gib=round(g["free_commit_gib"], 2)) for g in guard if g["at"] >= burst_start]
    return dict(engine_mb_before_burst=round(before[-1]["engine_private"] / 2**20) if before else None,
                engine_mb_peak_burst=max((s["engine_mb"] for s in series), default=None),
                engine_series=series)


def run(ctrl, admin):
    from baseline import REPO, read, write, database_name
    from seed import child_env
    c, run_root = ctrl.config, ctrl.run_root
    frames = c.get("tracemalloc_frames", 0)
    ctrl.script("seed.py", "seed", "--root", run_root, "--agents", c["agents"], "--active-items", c["active_items"],
                "--archived-per-live", 0, "--archived-items-per-live", 0, "--transcript-kb", c["transcript_kb"],
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 12, "--no-profile-item")
    desc = read(run_root / "scale-descriptor.json")
    outcome = dict(tracemalloc_frames=frames)
    try:
        ctrl.script("prepare_steady.py", "prepare-simulator", "--root", run_root, "--seconds", 10,
                    "--output-bytes", 256)
        env = child_env(run_root, desc["pg_url"])
        server = ctrl.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"), "--root", str(run_root),
                             *(["--tracemalloc", str(frames)] if frames else []),
                             "--env", "ORGTREE_SCALE_SIMULATED_PROVIDER=1", "--env", "ORGTREE_SCALE_SQL_COUNTS=1"],
                            "burst-serve")
        stop, sampler = threading.Event(), None
        try:
            ctrl.phase = "burst-serve"
            deadline = time.monotonic() + c["readiness_s"]
            while True:
                ctrl.check()
                if server.poll() is not None:
                    raise RuntimeError("server exited during startup")
                desc = read(run_root / "scale-descriptor.json")
                ctrl.engine_pid = desc.get("serve", {}).get("pid")
                if desc.get("serve", {}).get("state") == "ready":
                    break
                if time.monotonic() > deadline:
                    raise RuntimeError("startup deadline expired")
                time.sleep(.2)
            t0 = time.monotonic()
            ctrl.script("baseline.py", "burst-readiness", "--child", "ready", "--root", ctrl.root, "--arm", "burst",
                        env=env, timeout=max(1, deadline - time.monotonic()))
            outcome["readiness_s"] = round(time.monotonic() - t0, 1)
            if frames:
                with httpx.Client(base_url=desc["origin"], headers={"X-Orgtree-Desktop-Token": desc["token"]},
                                  timeout=300) as client:
                    start = client.get("/scale/mem", params={"action": "start",
                                                             "frames": frames}).raise_for_status().json()
                write(run_root / "metrics/mem-start.json", start)
                sampler = threading.Thread(target=snapshots, name="burst-mem-snaps", daemon=True,
                                           args=(desc["origin"], desc["token"], run_root / "metrics/mem-snaps.jsonl",
                                                 stop, c["snap_every_s"]))
                sampler.start()
            t0, burst_start = time.monotonic(), time.time()
            try:
                ctrl.script("baseline.py", "burst-prime", "--child", "prime", "--root", ctrl.root, "--arm", "burst",
                            env=env, timeout=max(1, deadline - time.monotonic()))
                outcome["burst"] = "completed"
            finally:
                outcome["burst_s"] = round(time.monotonic() - t0, 1)
                stop.set()
                if sampler:
                    sampler.join(timeout=600)
                outcome.update(engine_series(ctrl.root / "guard.jsonl", burst_start))
        finally:
            stop.set()
            ctrl.kill(server)
            ctrl.engine_pid = None
            shutil.copytree(run_root / "metrics", ctrl.root / "receipts" / "burst", dirs_exist_ok=True)
            write(ctrl.root / "receipts/burst-outcome.json", outcome)
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))
    ctrl.check()
    return outcome
