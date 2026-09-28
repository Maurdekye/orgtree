"""N=1000 message-burst memory repro for the engine (baseline.py --burst-repro).

N1000 attempt 4 (2026-09-28) stopped at "engine > 5 GB": private memory went
1.41 -> 5.50 GB within ~17 s of the primer's 16-way ordinary-message burst,
with readiness done and history ingest idle. This mode reproduces only that:
seed N=1000 (the N1000 recipe, no history), serve under tracemalloc, wait for
readiness, snapshot, run the same primer burst, and snapshot every few seconds
until it ends or the guard stops it. Nothing else runs.

Differences from attempt 4, by design: no history bundle/restore (history was
idle during the climb), and the engine runs under tracemalloc (more memory).
Outputs in <root>/receipts/burst/: mem-start.json, mem-snaps.jsonl (one
/scale/mem diff per line), sql-counts.jsonl, serve.log, simulated-turns.jsonl.
"""
import json
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


def run(ctrl, admin):
    from baseline import REPO, read, write, database_name
    from seed import child_env
    c, run_root = ctrl.config, ctrl.run_root
    ctrl.script("seed.py", "seed", "--root", run_root, "--agents", c["agents"], "--active-items", c["active_items"],
                "--archived-per-live", 0, "--archived-items-per-live", 0, "--transcript-kb", c["transcript_kb"],
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 12, "--no-profile-item")
    desc = read(run_root / "scale-descriptor.json")
    outcome = {}
    try:
        ctrl.script("prepare_steady.py", "prepare-simulator", "--root", run_root, "--seconds", 10,
                    "--output-bytes", 256)
        env = child_env(run_root, desc["pg_url"])
        server = ctrl.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"), "--root", str(run_root),
                             "--tracemalloc", str(c["tracemalloc_frames"]),
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
            with httpx.Client(base_url=desc["origin"], headers={"X-Orgtree-Desktop-Token": desc["token"]},
                              timeout=300) as client:
                start = client.get("/scale/mem", params={"action": "start",
                                                         "frames": c["tracemalloc_frames"]}).raise_for_status().json()
            write(run_root / "metrics/mem-start.json", start)
            outcome["private_mb_before_burst"] = start.get("private_mb")
            sampler = threading.Thread(target=snapshots, name="burst-mem-snaps", daemon=True,
                                       args=(desc["origin"], desc["token"], run_root / "metrics/mem-snaps.jsonl",
                                             stop, c["snap_every_s"]))
            sampler.start()
            t0 = time.monotonic()
            try:
                ctrl.script("baseline.py", "burst-prime", "--child", "prime", "--root", ctrl.root, "--arm", "burst",
                            env=env, timeout=max(1, deadline - time.monotonic()))
                outcome["burst"] = "completed"
            finally:
                outcome["burst_s"] = round(time.monotonic() - t0, 1)
                stop.set()
                sampler.join(timeout=600)
                snaps = [json.loads(line) for line in
                         (run_root / "metrics/mem-snaps.jsonl").read_text(encoding="utf-8").splitlines()] \
                    if (run_root / "metrics/mem-snaps.jsonl").exists() else []
                outcome["snapshots"] = len(snaps)
                outcome["private_mb_peak_snap"] = max((s.get("private_mb") or 0 for s in snaps), default=None)
        finally:
            stop.set()
            ctrl.kill(server)
            ctrl.engine_pid = None
            import shutil
            shutil.copytree(run_root / "metrics", ctrl.root / "receipts" / "burst", dirs_exist_ok=True)
            write(ctrl.root / "receipts/burst-outcome.json", outcome)
    finally:
        ctrl.drop_database(admin, database_name(desc["pg_url"]))
    ctrl.check()
    return outcome
