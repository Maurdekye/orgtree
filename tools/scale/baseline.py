"""Matched-history controller. Only --small-control is admitted without a GO file.

Run under p03-run (both slots for a large pair). All mutable data stays in
one new C:/Temp root; the same run/ path is restored sequentially. No installed
app, provider CLI, renderer or live root is launched or modified.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
RESTORE_TIMEOUT_S = 5400  # run-only, attempt 8: see the restore call in execute()
sys.path.insert(0, str(REPO / "tools" / "scale"))
from history_fixture import Recipe, asdict, sha_file, safe_root, regular_file
from seed import child_env
from control import free_commit_gb


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def database_name(url):
    from psycopg.conninfo import conninfo_to_dict
    return conninfo_to_dict(url)["dbname"]


def inventory(folder):
    result = {}
    if not folder.exists():
        return result
    for path in sorted(folder.rglob("*")):
        if path.is_symlink() or path.is_junction():
            raise ValueError("reparse point in frozen inventory")
        if path.is_file():
            regular_file(path)
            result[path.relative_to(folder).as_posix()] = dict(bytes=path.stat().st_size, sha256=sha_file(path))
    return result


def copy_inventory(source, target, expected):
    if inventory(source) != expected:
        raise ValueError("frozen file inventory changed")
    for name in expected:
        dst = target / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, dst)
    if inventory(target) != expected:
        raise ValueError("copied file inventory differs")


def paint_config(value):
    """Run-only (attempt 9): renderer-paint clicks as a side process in each
    arm's measured window. The build is made before admission, outside the run."""
    if value is None:
        return None
    build = Path(value.get("build", ""))
    seconds, repeats = value.get("seconds", 15), value.get("repeats", 3)
    if not (build.is_absolute() and (build / "build.json").is_file()):
        raise ValueError("paint build must be an absolute renderer-paint build directory")
    if not (isinstance(seconds, int) and 1 <= seconds <= 600 and isinstance(repeats, int) and 1 <= repeats <= 50):
        raise ValueError("paint seconds 1..600 and repeats 1..50")
    if not shutil.which("node"):
        raise ValueError("paint needs node on PATH")
    return dict(build=str(build), seconds=seconds, repeats=repeats)


def mem_trace_config(value):
    """Run-only (attempt 11 drift): tracemalloc growth attribution in the small
    arm's measured window via serve.py GET /scale/mem. Tracing starts when the
    window starts, so every diff is growth under load, not startup residue."""
    if value is None:
        return None
    interval, frames, top = value.get("interval_s", 300), value.get("frames", 10), value.get("top", 30)
    if not (isinstance(interval, (int, float)) and 5 <= interval <= 900
            and isinstance(frames, int) and 1 <= frames <= 25 and isinstance(top, int) and 1 <= top <= 60):
        raise ValueError("mem_trace: interval_s 5..900, frames 1..25, top 1..60")
    return dict(interval_s=interval, frames=frames, top=top)


def require_go(args, source):
    if args.small_control:
        probe_s = getattr(args, "startup_probe_s", None)
        probe = None if not probe_s else dict(seconds=probe_s, engine_cap_gib=5, trace_dump_s=2, trace_frames=6)
        mem = mem_trace_config(None if not getattr(args, "mem_trace_s", None)
                               else dict(interval_s=args.mem_trace_s, frames=6, top=20))
        paint = None if not getattr(args, "paint_build", None) else dict(
            build=str(args.paint_build), seconds=args.paint_seconds, repeats=args.paint_repeats)
        return dict(kind="small controller control", agents=10, active_items=8, transcript_kb=1,
                    seconds=.05, warmup=3, measured=getattr(args, "measured_s", None) or 8, tool_rate=2, steer_rate=3,
                    paint=paint_config(paint),
                    stream_reset_s=getattr(args, "stream_reset_s", 0) or 0,
                    startup_probe=probe, engine_cap_gib=probe["engine_cap_gib"] if probe else 5,
                    mem_trace=mem,
                    arms=("large",) if probe else ("small",) if mem else ("small", "large"),
                    recipe=asdict(Recipe(retired_agents=2, archived_items=2, read_mail=2,
                        old_transcripts=2, payload_profile="fixed", node_chars=128,
                        # Tiny 128-character mail needs ~89k generated rows
                        # to cover the seed's fixed byte tails. Use realistic
                        # 4KiB bodies so this remains a controller control;
                        # the generator still proves BOTH 10x count and bytes.
                        item_chars=128, mail_chars=4096, transcript_chars=128)),
                    disk_gib=2, commit_gib=12, readiness_s=90)
    if getattr(args, "lock_burst", None):
        # One tiny served org and a 16-way message burst: one small slot, no GO.
        return dict(kind="lock burst probe", commit_gib=12, disk_gib=2,
                    lock_burst=args.lock_burst, preflight_only=True)
    if getattr(args, "preflight_only", False):
        # Two tiny seeded orgs only (N=10, N=100): cheap, one small slot, no GO.
        return dict(kind="rows preflight only", commit_gib=12, disk_gib=2,
                    rows_preflight=True, preflight_only=True)
    if not args.go_file:
        raise ValueError("large root/seed/run requires coordinator GO file")
    go = read(args.go_file)
    if go.get("source") != source or go.get("go") is not True or not go.get("coordinator_message"):
        raise ValueError("GO must name the exact source and coordinator message")
    # Run-only: a GO may lower the disk admission (coordinator ruling 2026-09-29
    # 02:38Z, attempt 7). It then replaces BOTH the 80 GiB admission and the
    # frozen estimate's reserve; the continuous 20 GiB guard floor is unchanged.
    disk = go.get("disk_gib")
    if disk is not None and not (isinstance(disk, (int, float)) and disk >= 20):
        raise ValueError("GO disk_gib must be a number >= 20 (the guard floor)")
    # Run-only (attempt 9, coordinator 2026-09-29 06:49Z): a GO may lengthen the
    # measured window (the memory target is judged over 60 minutes). Both arms
    # use the same window, so the 5% pair comparison stays equal-work.
    measured = go.get("measured_s", 600)
    if not (isinstance(measured, int) and 600 <= measured <= 3600):
        raise ValueError("GO measured_s must be an integer 600..3600")
    # Run-only (attempt 11): start a new stream message every N seconds (0 = one
    # message for the whole run, as attempts 1-10 did).
    reset = go.get("stream_reset_s", 0)
    if not (isinstance(reset, (int, float)) and 0 <= reset <= 3600):
        raise ValueError("GO stream_reset_s must be 0..3600")
    # Run-only (10x startup probe, coordinator 2026-09-29 12:44Z): the large arm
    # only, no load; the engine is traced (tracemalloc + thread stacks) for
    # `seconds` after spawn under a raised per-engine guard cap.
    probe = go.get("startup_probe")
    if probe is not None:
        probe = dict(seconds=probe.get("seconds", 600), engine_cap_gib=probe.get("engine_cap_gib", 12),
                     trace_dump_s=probe.get("trace_dump_s", 3), trace_frames=probe.get("trace_frames", 6))
        if not (isinstance(probe["seconds"], int) and 60 <= probe["seconds"] <= 1800
                and isinstance(probe["engine_cap_gib"], (int, float)) and 5 <= probe["engine_cap_gib"] <= 16
                and isinstance(probe["trace_dump_s"], (int, float)) and 1 <= probe["trace_dump_s"] <= 60
                and isinstance(probe["trace_frames"], int) and 0 <= probe["trace_frames"] <= 16):
            raise ValueError("GO startup_probe: seconds 60..1800, engine_cap_gib 5..16, trace_dump_s 1..60, trace_frames 0..16")
    # Run-only (attempt 11 drift, coordinator 2026-09-29 18:29Z): the small arm
    # only, with tracemalloc growth snapshots through the measured window.
    mem = mem_trace_config(go.get("mem_trace"))
    if mem and probe:
        raise ValueError("GO mem_trace and startup_probe are separate runs")
    return dict(kind="first N1000 baseline; no final qualification", agents=1000, active_items=180,
                stream_reset_s=reset, startup_probe=probe, mem_trace=mem,
                engine_cap_gib=probe["engine_cap_gib"] if probe else 5,
                arms=("large",) if probe else ("small",) if mem else ("small", "large"),
                transcript_kb=256, seconds=10, warmup=120, measured=measured, tool_rate=3.12,
                paint=paint_config(go.get("paint")),
                steer_rate=9.36, recipe=asdict(Recipe()), disk_gib=80 if disk is None else disk,
                disk_override=disk is not None, commit_gib=24, readiness_s=3600,
                rows_preflight=True)


def check_root(root):
    root = safe_root(root)
    allowed = Path("C:/Temp").resolve()
    if root.parent != allowed or not root.name.startswith("scale-ui-history-"):
        raise ValueError("controller root must be a new C:/Temp/scale-ui-history-* directory")
    if root.exists():
        raise ValueError("controller root already exists; retries need a new run id")
    return root


def source_files():
    names = subprocess.check_output(["git", "ls-files", "engine", "apps/desktop/renderer", "tools/scale"],
                                     cwd=REPO, text=True).splitlines()
    result = {}
    for name in names:
        path = REPO / name
        if path.is_dir():
            # Gitlinks name submodules, not readable source files. The mailhub
            # is not launched by this baseline; preserve its pinned identity.
            result[name] = "gitlink:" + subprocess.check_output(
                ["git", "rev-parse", "HEAD:" + name], cwd=REPO, text=True).strip()
        else:
            result[name] = sha_file(path)
    return result


def require_slots(small):
    """Do not trust a stale holder file: it must identify a live ancestor."""
    import psutil
    parents = {p.pid for p in psutil.Process().parents()}
    lockdir = REPO.parent.parent / "artifacts/machine-test-run"
    # Worktrees live under the repository's .worktrees directory.
    owned = []
    for name in ("holder.json", "holder2.json"):
        row = read(lockdir / name)
        # The live-ancestor pid proves ownership; any agent may run it (the
        # rows preflight is another owner's acceptance check).
        if not row.get("released") and row.get("pid") in parents and row.get("agent"):
            owned.append(row)
    if len(owned) < (1 if small else 2) or (not small and any(r.get("small") for r in owned)):
        raise ValueError("controller must run inside the owned p03 slots")


class Controller:
    def __init__(self, root, config, args):
        self.root, self.config, self.args = root, config, args
        self.run_root = root / "run"
        self.phase = "admission"
        self.children = []
        self.lock = threading.Lock()
        self.stop_guard = threading.Event()
        self.breach = None
        self.pg_started = False
        self.engine_pid = None
        self.pg_pid = None

    def check(self):
        if self.breach:
            raise RuntimeError(self.breach)

    def guard(self):
        import psutil
        while not self.stop_guard.is_set():
            try:
                free = free_commit_gb()
                disk = shutil.disk_usage(self.root).free / 2**30
                try:
                    engine = psutil.Process(self.engine_pid).memory_info().private if self.engine_pid else 0
                except psutil.NoSuchProcess:
                    # The pid read from the descriptor can vanish while the engine
                    # starts or stops; a real engine exit is caught by server.poll().
                    engine = 0
                family = {p.pid: p for p in [psutil.Process(), *psutil.Process().children(recursive=True)]}
                if self.pg_pid:
                    pg = psutil.Process(self.pg_pid)
                    family.update({p.pid: p for p in [pg, *pg.children(recursive=True)]})
                total = 0
                for process in family.values():
                    try:
                        total += process.memory_info().private
                    except psutil.NoSuchProcess:
                        pass
                if free < 12 or engine > self.config.get("engine_cap_gib", 5) * 2**30 or disk < (1 if self.args.small_control or self.args.preflight_only else 20):
                    raise RuntimeError(f"guard: free commit {free:.2f} GiB, engine {engine}, disk {disk:.2f} GiB")
                with (self.root / "guard.jsonl").open("a", encoding="utf-8") as out:
                    out.write(json.dumps(dict(at=time.time(), phase=self.phase, free_commit_gib=free,
                        engine_private=engine, owned_private=total, owned_processes=len(family), disk_free_gib=disk)) + "\n")
            except BaseException as exc:
                self.breach = f"{type(exc).__name__}: {exc}"
                write(self.root / "GUARD-STOP.json", dict(phase=self.phase, reason=self.breach, at=time.time()))
                with self.lock:
                    owned = list(self.children)
                for proc in owned:
                    self.kill(proc)
                return
            self.stop_guard.wait(1)

    def kill(self, proc):
        import psutil
        if proc.poll() is not None:
            return
        try:
            parent = psutil.Process(proc.pid)
            children = parent.children(recursive=True)
            for child in reversed(children):
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
            proc.kill()
            proc.wait(timeout=30)
            _, alive = psutil.wait_procs(children, timeout=20)
            if alive:
                raise RuntimeError("owned child process survived cleanup")
        except psutil.NoSuchProcess:
            proc.wait(timeout=30)

    def spawn(self, command, name, env=None):
        self.check()
        log = (self.root / (name + ".log")).open("w", encoding="utf-8")
        try:
            proc = subprocess.Popen(command, cwd=REPO, env=env, stdout=log, stderr=subprocess.STDOUT)
        finally:
            log.close()
        with self.lock:
            self.children.append(proc)
        return proc

    def command(self, command, name, env=None, timeout=900):
        self.phase = name
        proc = self.spawn(command, name, env)
        try:
            result = proc.wait(timeout=timeout)
            self.check()
            if result:
                raise RuntimeError(f"{name} exited {result}; retained {name}.log")
            if (self.run_root / "metrics/qualification-invalid.json").exists():
                raise RuntimeError(f"unexpected process launch during {name}")
        finally:
            self.kill(proc)

    def script(self, script, name, *args, env=None, timeout=900):
        self.command([sys.executable, "-I", "-B", str(REPO / "tools/scale" / script), *map(str, args)],
                     name, env, timeout)

    def probe_env(self):
        p = self.config.get("startup_probe")
        if not p:
            return []
        return ["--env", f"ORGTREE_SCALE_TRACE_DUMP={p['trace_dump_s']}",
                "--env", f"ORGTREE_SCALE_TRACE_FRAMES={p['trace_frames']}"]

    def startup_probe(self, server, probe):
        """Run-only: watch a freshly spawned engine for probe['seconds'] with no
        load. serve.py writes metrics/trace-dump.jsonl (tracemalloc top sites,
        thread stacks, private MB); the guard keeps its 1 s timeline."""
        t0 = time.monotonic()
        ready_s = None
        while time.monotonic() - t0 < probe["seconds"]:
            self.check()
            if server.poll() is not None:
                raise RuntimeError("server exited during startup probe")
            try:
                serve = read(self.run_root / "scale-descriptor.json").get("serve", {})
            except (OSError, ValueError):
                serve = {}
            self.engine_pid = serve.get("pid") or self.engine_pid
            if ready_s is None and serve.get("state") == "ready":
                ready_s = round(time.monotonic() - t0, 1)
                print(f"startup probe: engine ready at {ready_s} s", flush=True)
            time.sleep(.5)
        self.check()
        return dict(startup_probe=probe, ready_s=ready_s, observed_s=probe["seconds"])

    def paint_side(self, arm, label, c, result):
        """Run-only (attempt 9): start renderer-paint once the load reports its
        label running, early enough that Electron starts during the warmup and
        the clicks land in the measured window. Samples the painter's whole
        process tree (node + Electron) every 5 s. A paint failure is recorded,
        never raised: it must not cost the arm its load measurement."""
        import psutil
        try:
            descriptor = self.run_root / "scale-descriptor.json"
            waited = time.monotonic() + c["warmup"] + 60
            while True:
                try:
                    load = read(descriptor).get("load") or {}
                except (OSError, ValueError):
                    load = {}
                if load.get("running") and load.get("label") == label:
                    break
                if time.monotonic() > waited:
                    raise RuntimeError("load never reported its label running")
                time.sleep(1)
            start_at = load["since"] + max(0, c["warmup"] - 90)
            time.sleep(max(0, start_at - time.time()))
            out = self.root / "paint" / arm
            out.parent.mkdir(parents=True, exist_ok=True)
            p = c["paint"]
            result.update(output=str(out), started=time.time(), load_since=load["since"],
                          measured_from=load["since"] + c["warmup"], seconds=p["seconds"], repeats=p["repeats"])
            proc = self.spawn([shutil.which("node"), str(REPO / "tools/scale/renderer-paint.mjs"), "run",
                "--build", p["build"], "--descriptor", str(descriptor), "--label", label, "--output", str(out),
                "--seconds", str(p["seconds"]), "--repeats", str(p["repeats"])], arm + "-paint")
            samples = self.root / "receipts" / arm / "paint-memory.jsonl"
            samples.parent.mkdir(parents=True, exist_ok=True)
            peak_rss = peak_private = 0
            with samples.open("a", encoding="utf-8") as log:
                while proc.poll() is None:
                    rss = private = n = 0
                    try:
                        tree = [psutil.Process(proc.pid)] + psutil.Process(proc.pid).children(recursive=True)
                    except psutil.NoSuchProcess:
                        tree = []
                    for q in tree:
                        try:
                            m = q.memory_info()
                            rss += m.rss
                            private += getattr(m, "private", 0)
                            n += 1
                        except psutil.NoSuchProcess:
                            pass
                    peak_rss, peak_private = max(peak_rss, rss), max(peak_private, private)
                    log.write(json.dumps(dict(t=time.time(), processes=n, rss=rss, private=private)) + "\n")
                    log.flush()
                    time.sleep(5)
            result.update(run_exit=proc.returncode, ended=time.time(),
                          peak_rss_mb=round(peak_rss / 2**20, 1), peak_private_mb=round(peak_private / 2**20, 1))
        except BaseException as exc:
            result["error"] = f"{type(exc).__name__}: {exc}"

    def mem_side(self, arm, label, c, stop, result):
        """Run-only (attempt 11 drift): once the measured window starts, start
        tracemalloc in the engine (GET /scale/mem?action=start) and take a diff
        snapshot every interval until the load ends. Each row goes to
        receipts/<arm>/mem-trace.jsonl. A failure is recorded, never raised."""
        import httpx
        m = c["mem_trace"]
        out = self.root / "receipts" / arm / "mem-trace.jsonl"
        out.parent.mkdir(parents=True, exist_ok=True)
        result.update(output=str(out), snaps=0, errors=[])
        try:
            descriptor = self.run_root / "scale-descriptor.json"
            waited = time.monotonic() + c["warmup"] + 60
            while True:
                try:
                    desc = read(descriptor)
                except (OSError, ValueError):
                    desc = {}
                load = desc.get("load") or {}
                if load.get("running") and load.get("label") == label:
                    break
                if time.monotonic() > waited or stop.is_set():
                    raise RuntimeError("load never reported its label running")
                time.sleep(1)
            t0 = load["since"] + c["warmup"]
            if stop.wait(max(0, t0 - time.time())):
                raise RuntimeError("load ended before the measured window")
            with httpx.Client(base_url=desc["origin"], headers={"X-Orgtree-Desktop-Token": desc["token"]},
                              timeout=600) as client, out.open("a", encoding="utf-8") as log:
                def call(action):
                    started = time.time()
                    body = client.get("/scale/mem", params=dict(action=action, frames=m["frames"],
                                                                top=m["top"])).raise_for_status().json()
                    body.update(action=action, t=round(started - t0, 1), took_s=round(time.time() - started, 2))
                    log.write(json.dumps(body) + "\n")
                    log.flush()
                    return body
                call("start")
                result["started"] = time.time()
                while not stop.wait(m["interval_s"]):
                    try:
                        call("snap")
                        result["snaps"] += 1
                    except Exception as exc:                       # noqa: BLE001
                        result["errors"].append(f"{type(exc).__name__}: {exc}"[:300])
                        if len(result["errors"]) > 5:
                            break
        except BaseException as exc:
            result["error"] = f"{type(exc).__name__}: {exc}"

    def paint_finish(self, arm, painter, result):
        """After the load has written summary.json: wait for the painter, then
        run renderer-paint report (no engine access) and keep its verdict."""
        painter.join(timeout=1800)
        if painter.is_alive():
            result["error"] = "painter still running 1800 s after the load ended"
            return
        if "run_exit" not in result:
            return
        proc = None
        try:
            proc = self.spawn([shutil.which("node"), str(REPO / "tools/scale/renderer-paint.mjs"), "report",
                               "--output", result["output"]], arm + "-paint-report")
            result["report_exit"] = proc.wait(timeout=300)
            report = Path(result["output"]) / "report.json"
            if report.is_file():
                result["report"] = read(report)
        except BaseException as exc:
            result["report_error"] = f"{type(exc).__name__}: {exc}"
        finally:
            if proc is not None:
                self.kill(proc)

    def pg(self, action):
        path = self.root / ("pg-" + action + ".log")
        with path.open("w", encoding="utf-8") as log:
            proc = subprocess.Popen([self.args.custodian, action, "--root", str(self.root / "pg"),
                "--pg-bin", self.args.pg_bin], stdout=log, stderr=subprocess.STDOUT)
        with self.lock:
            self.children.append(proc)
        try:
            code = proc.wait(timeout=90)
        finally:
            self.kill(proc)
        if code:
            raise RuntimeError(f"PG {action} failed: see {path.name}")
        value = read(path)
        write(self.root / "receipts" / ("pg-" + action + ".json"), value)
        return value

    def drop_database(self, admin, name):
        import psycopg
        from psycopg import sql
        if not name.startswith("orgtree_scale_") or any(p.poll() is None for p in self.children):
            raise ValueError("database removal requires owned disposable name and stopped children")
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        write(self.root / "receipts" / ("dropped-" + name + ".json"), dict(database=name, dropped=True))

    def clear_run(self):
        """Only the exact owned run path, after every engine/stage child exits."""
        if any(p.poll() is None for p in self.children):
            raise RuntimeError("cannot recreate run path with live owned children")
        path = self.run_root.resolve()
        if path.parent != self.root.resolve() or path.name != "run":
            raise ValueError("run path escaped controller")
        if not path.exists():
            return
        if read(path / "controller-owner.json") != dict(root=str(self.root), token=self.token):
            raise ValueError("run ownership marker mismatch")
        inventory(path)  # rejects every nested reparse point before removal
        quoted = str(path).replace("'", "''")
        self.command(["powershell", "-NoProfile", "-Command",
            f"Remove-Item -LiteralPath '{quoted}' -Recurse -Force -ErrorAction Stop"], "remove-owned-run")
        if path.exists():
            raise RuntimeError("run cleanup incomplete")

    def execute(self):
        self.token = uuid.uuid4().hex
        self.root.mkdir()
        write(self.root / "controller.json", dict(token=self.token, config=self.config, source=self.source))
        capsule = source_files()
        write(self.root / "source-files.json", capsule)
        guard = threading.Thread(target=self.guard, name="baseline-independent-guard")
        guard.start()
        outcome = {"complete": False}
        try:
            self.pg("init-root")
            self.pg("init")
            # The custodian owns layout. This single setting is a declared
            # private-cluster capacity, not a product default change.
            conf = self.root / "pg/pg/cluster/data/postgresql.conf"
            with conf.open("a", encoding="utf-8") as target:
                target.write("\nmax_connections = 128\n")
            self.pg_started = True
            self.pg("start")
            self.pg_pid = int((self.root / "pg/pg/cluster/data/postmaster.pid").read_text().splitlines()[0])
            admin = self.pg("urls")["urls"]["P03_PG_ADMIN_URL"]
            c = self.config
            if c.get("lock_burst"):
                from lock_burst import burst
                outcome["lock_burst"] = burst(self, admin, c["lock_burst"])
            if c.get("rows_preflight"):
                from rows_preflight import preflight
                outcome["rows_preflight"] = preflight(self, admin, large=getattr(self.args, "preflight_large", False))
            if c.get("preflight_only"):
                outcome["complete"] = True
                return
            self.script("seed.py", "seed", "--root", self.run_root, "--agents", c["agents"],
                "--active-items", c["active_items"], "--archived-per-live", 0,
                "--archived-items-per-live", 0, "--transcript-kb", c["transcript_kb"],
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 10, "--no-profile-item")
            write(self.run_root / "controller-owner.json", dict(root=str(self.root), token=self.token))
            self.script("prepare_steady.py", "prepare-simulator", "--root", self.run_root,
                        "--seconds", c["seconds"], "--output-bytes", 256)
            desc = read(self.run_root / "scale-descriptor.json")
            env = child_env(self.run_root, desc["pg_url"])
            self.script("baseline.py", "freeze", "--child", "freeze", "--root", self.root, env=env)
            frozen = read(self.root / "frozen/controller.json")
            estimate = frozen["estimate"]["suggested_free_disk_bytes"] / 2**30
            reserve = c["disk_gib"] if c.get("disk_override") else max(c["disk_gib"], estimate)
            print(f"disk reserve {reserve:.2f} GiB (frozen estimate {estimate:.2f}, "
                  f"override {bool(c.get('disk_override'))})", flush=True)
            if shutil.disk_usage(self.root).free / 2**30 < reserve:
                raise RuntimeError(f"actual frozen estimate needs {reserve:.2f} GiB")
            self.script("baseline.py", "bundle", "--child", "bundle", "--root", self.root, env=env)
            self.drop_database(admin, desc["pg_database"])
            plans = self.root / "plans"
            for arm in c.get("arms", ("small", "large")):
                if source_files() != capsule:
                    raise RuntimeError("source changed between baseline phases")
                self.clear_run()
                from seed import _create_db
                url = _create_db(admin, "orgtree_scale_" + self.token + "_" + arm)
                from history_pg import authorize_empty_destination
                authorize_empty_destination(self.run_root, desc["org"], url)
                for name in ("data", "home", "temp"):
                    (self.run_root / name).mkdir(parents=True, exist_ok=True)
                write(self.run_root / "controller-owner.json", dict(root=str(self.root), token=self.token))
                env = child_env(self.run_root, url)
                # Run-only (attempt 8): the 900 s step default stopped the large
                # restore in attempt 7b. The small restore took 385.6 s for ~1.79 GB
                # of SQL input; the large one is ~8.66 GB (linear ~1870 s, inferred),
                # so allow 5400 s (~2.9x). The guard's floors still apply throughout.
                restore_t0 = time.monotonic()
                self.script("baseline.py", arm + "-restore", "--child", "restore", "--root", self.root,
                            "--arm", arm, env=env, timeout=RESTORE_TIMEOUT_S)
                outcome.setdefault("restore_s", {})[arm] = round(time.monotonic() - restore_t0, 1)
                print(f"{arm} restore {outcome['restore_s'][arm]} s", flush=True)
                self.script("history_pg.py", arm + "-fresh-verify", "verify", "--bundle", self.root / "bundle",
                    "--root", self.run_root, "--arm", arm, "--result", self.root / f"receipts/{arm}-verify.json", env=env)
                self.script("baseline.py", arm + "-files", "--child", "files", "--root", self.root,
                            "--arm", arm, env=env)
                server = self.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"),
                    "--root", str(self.run_root), "--env", "ORGTREE_SCALE_SIMULATED_PROVIDER=1",
                    "--env", "ORGTREE_SCALE_SQL_COUNTS=1", *self.probe_env()], arm + "-serve")
                sampler = None
                try:
                    if c.get("startup_probe"):
                        outcome[arm] = self.startup_probe(server, c["startup_probe"])
                        continue  # the finally below still kills the engine and keeps metrics
                    deadline = time.monotonic() + c["readiness_s"]
                    while time.monotonic() < deadline:
                        self.check()
                        if server.poll() is not None:
                            raise RuntimeError("server exited during startup")
                        desc = read(self.run_root / "scale-descriptor.json")
                        self.engine_pid = desc.get("serve", {}).get("pid")
                        if desc.get("serve", {}).get("state") == "ready":
                            break
                        time.sleep(.2)
                    else:
                        raise RuntimeError("startup deadline expired")
                    ready_t0, ready_m0 = time.time(), time.monotonic()
                    self.script("baseline.py", arm + "-readiness", "--child", "ready", "--root", self.root,
                        "--arm", arm, env=env, timeout=max(1, deadline-time.monotonic()))
                    # Readiness covers ACTIVE sources only; history ingest keeps
                    # running during traffic and is sampled read-only.
                    ready = read(self.root / f"receipts/{arm}-readiness.json")
                    from baseline_readiness import HistorySampler
                    sampler = HistorySampler(ready["database"], ready["history"],
                        self.run_root / "metrics/history-ingest.jsonl", ready_t0, lambda: self.phase)
                    sampler.start()
                    self.script("baseline.py", arm + "-prime", "--child", "prime", "--root", self.root,
                        "--arm", arm, env=env, timeout=max(1, deadline-time.monotonic()))
                    for label, duration in (("measured", c["measured"]),):
                        args = ["--root", self.run_root, "--duration", duration, "--rate", c["tool_rate"],
                                "--steer-rate", c["steer_rate"], "--workers", 64, "--windows", 4,
                                "--stream-nodes", 5, "--stream-hz", 4, "--renderer-hooks", "--write-oracle",
                                # Run-only (attempt 9): in-engine feed producer, no HTTP hop per frame.
                                "--stream-inproc", "--stream-reset-s", c.get("stream_reset_s", 0),
                                "--warmup", c["warmup"]]
                        if arm == "small":
                            self.script("load.py", "plan", *args, "--label", "plan", "--plan-only")
                            shutil.copytree(self.run_root / "metrics/plan", plans / label)
                        # Exact history state as traffic starts (the 10 s cadence alone
                        # can miss history that finishes early in the window).
                        sampler.sample(arm + "-" + label)
                        paint = {}
                        painter = None
                        if c.get("paint"):
                            painter = threading.Thread(target=self.paint_side, name=arm + "-paint",
                                args=(arm, label, c, paint), daemon=True)
                            painter.start()
                        tracer, trace_stop, trace = None, threading.Event(), {}
                        if c.get("mem_trace"):
                            tracer = threading.Thread(target=self.mem_side, name=arm + "-mem",
                                args=(arm, label, c, trace_stop, trace), daemon=True)
                            tracer.start()
                        load_error = None
                        try:
                            self.script("load.py", arm + "-" + label, *args, "--label", label,
                                        "--plans-dir", plans / label, timeout=duration+c["warmup"]+240)
                        except RuntimeError as exc:
                            # Run-only (attempt 10, coordinator 2026-09-29 08:52Z): a load that
                            # finished its window and wrote summary.json but exited nonzero
                            # (unclean workload) is recorded, and the pair continues. A guard
                            # stop, timeout or a load without a summary still ends the run.
                            if (f"{arm}-{label} exited" not in str(exc)
                                    or (self.run_root / "metrics/qualification-invalid.json").exists()
                                    or not (self.run_root / "metrics" / label / "summary.json").is_file()):
                                raise
                            load_error = str(exc)
                            print(f"{arm} load not clean, recorded: {exc}", flush=True)
                        finally:
                            trace_stop.set()
                        if tracer is not None:
                            tracer.join(timeout=900)
                            if tracer.is_alive():
                                trace["error"] = "mem trace still running 900 s after the load ended"
                        if painter is not None:
                            self.paint_finish(arm, painter, paint)
                    outcome[arm] = read(self.run_root / "metrics/measured/summary.json")
                    if c.get("paint"):
                        outcome[arm]["paint"] = paint
                    if c.get("mem_trace"):
                        outcome[arm]["mem_trace"] = trace
                    outcome[arm]["load_exit_error"] = load_error
                    outcome[arm]["active_ready"] = dict(seconds=ready["seconds"], sources=ready["sources"],
                        bytes=ready["bytes"], events=ready["events"], startup_s=ready_m0 - (deadline - c["readiness_s"]))
                    outcome[arm]["history_ingest"] = sampler.summary(arm + "-measured")
                    sampler = None
                    counters = [json.loads(line) for line in
                        (self.run_root / "metrics/sql-counts.jsonl").read_text(encoding="utf-8").splitlines()]
                    if (not any(row["rows"] for row in counters) or
                            not any(row["write_parameter_bytes"] for row in counters) or
                            any(row["unsupported_operations"] for row in counters)):
                        raise RuntimeError("SQL row/byte coverage unavailable or incomplete")
                    outcome[arm]["sql_counter_coverage"] = dict(requests=len(counters),
                        statements=sum(r["statements"] for r in counters), rows=sum(r["rows"] for r in counters),
                        value_bytes=sum(r["value_bytes"] for r in counters),
                        write_parameter_bytes=sum(r["write_parameter_bytes"] for r in counters),
                        unsupported_operations=0)
                    if source_files() != capsule:
                        raise RuntimeError("source changed during baseline arm")
                finally:
                    if sampler is not None:
                        sampler.summary(arm + "-measured")
                    self.kill(server)
                    self.engine_pid = None
                    shutil.copytree(self.run_root / "metrics", self.root / "receipts" / arm, dirs_exist_ok=True)
                    # Run-only (attempt 8): keep the engine's slow-request log;
                    # clear_run() deletes run/data before the next arm.
                    diag = self.run_root / "data" / "diagnostics"
                    if diag.is_dir():
                        shutil.copytree(diag, self.root / "receipts" / arm / "diagnostics", dirs_exist_ok=True)
                self.check()
                self.drop_database(admin, database_name(url))
            if (tuple(c.get("arms", ("small", "large"))) == ("small", "large")
                    and outcome["small"]["config"]["plans"] != outcome["large"]["config"]["plans"]):
                raise RuntimeError("unequal demand between arms")
            outcome["complete"] = True
        except BaseException as exc:
            outcome["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            errors = []
            for proc in self.children:
                try:
                    self.kill(proc)
                except BaseException as exc:
                    errors.append(str(exc))
            self.engine_pid = None
            self.pg_pid = None
            stopped = not self.pg_started
            try:
                if self.pg_started:
                    self.pg("stop")
                    stopped = self.pg("status")["cluster"]["state"] == "stopped"
            except BaseException as exc:
                errors.append(str(exc))
            finally:
                self.stop_guard.set()
                guard.join(timeout=5)
            outcome["cleanup"] = dict(children_exited=all(p.poll() is not None for p in self.children),
                                      pg_stopped=stopped, errors=errors)
            if errors or not stopped:
                outcome["complete"] = False
            write(self.root / "result.json", outcome)
            if errors or not stopped:
                raise RuntimeError("controller cleanup incomplete: " + repr(outcome["cleanup"]))


def child(args):
    root, run = args.root, args.root / "run"
    config = read(root / "controller.json")["config"]
    sys.path.insert(0, str(REPO / "tools"))
    from assert_repo_import import assert_repo_import
    provenance = assert_repo_import(REPO)
    from launch_guard import LaunchAudit, pin_git
    git = shutil.which("git")
    subprocess.Popen = pin_git(subprocess.Popen, git)
    (run / "metrics").mkdir(exist_ok=True)
    sys.addaudithook(LaunchAudit(run, git=git, providers=[]))
    from orgtree import store, pgstore
    if Path(store.DATA_ROOT).resolve() != run / "data":
        raise ValueError("child data root escaped")
    from history_fixture import prepare_base, estimate, build_pair
    from history_pg import authorize_empty_destination, restore
    if args.child == "freeze":
        from orgtree.notification_state import reconcile_attention
        desc = read(run / "scale-descriptor.json")
        org = store.load_org(desc["org"])
        if len(org.d.get("work_items", [])) != config["active_items"]:
            raise ValueError("active work count differs from recipe")
        reconcile_attention(org.d)
        store.save_org(org)
        org = store.load_org(desc["org"])
        base = prepare_base(org.d)
        frozen = root / "frozen"
        write(frozen / "base.json", base)
        files = {}
        for name in ("home", "data"):
            found = inventory(run / name)
            copy_inventory(run / name, frozen / name, found)
            files[name] = found
        shutil.copyfile(run / "simulated-provider.json", frozen / "simulated-provider.json")
        write(frozen / "descriptor.json", desc)
        est = estimate(base, Recipe(**config["recipe"]), sum(v["bytes"] for f in files.values() for v in f.values()))
        provenance.write_result(frozen / "controller.json", dict(files=files, estimate=est,
            simulated_sha256=sha_file(frozen / "simulated-provider.json"), active_sha256=sha_file(frozen / "base.json")))
    elif args.child == "bundle":
        frozen = root / "frozen"
        manifest = build_pair(read(frozen / "base.json"), root / "bundle", Recipe(**config["recipe"]),
                             {k: str(frozen / "home" / k) for k in read(frozen / "controller.json")["files"]["home"]},
                             reserve_bytes=config["disk_gib"] * 2**30 if config.get("disk_override") else None)
        provenance.write_result(root / "receipts/bundle.json", manifest)
    elif args.child == "restore":
        desc = read(root / "frozen/descriptor.json")
        store.claim_data_root()  # ordinary bootstrap/migrations on the new DB
        receipt = restore(root / "bundle", args.arm, run)
        provenance.write_result(root / f"receipts/{args.arm}-restore.json", receipt)
    elif args.child == "files":
        frozen = root / "frozen"
        receipt = read(frozen / "controller.json")
        # Exact HOME verification already ran in a fresh process. Data-root
        # settings/journals are frozen separately and copied only afterwards.
        copy_inventory(frozen / "data", run / "data", receipt["files"]["data"])
        if sha_file(frozen / "simulated-provider.json") != receipt["simulated_sha256"]:
            raise ValueError("simulated provider manifest changed")
        shutil.copyfile(frozen / "simulated-provider.json", run / "simulated-provider.json")
        desc = read(frozen / "descriptor.json")
        desc.update(pg_url=pgstore.url(), pg_database=database_name(pgstore.url()), origin=None, token=None)
        desc.pop("serve", None)
        write(run / "scale-descriptor.json", desc)
        provenance.write_result(root / f"receipts/{args.arm}-files.json", dict(verified=True, files=receipt["files"]))
    elif args.child == "ready":
        from baseline_readiness import wait_ready
        receipt = wait_ready(run, config["readiness_s"])
        provenance.write_result(root / f"receipts/{args.arm}-readiness.json", receipt)
    elif args.child == "prime":
        from baseline_prime import prime
        receipt = prime(run, config["readiness_s"])
        provenance.write_result(root / f"receipts/{args.arm}-prime.json", receipt)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--small-control", action="store_true")
    # Run-only (attempt 9): small-control smoke of the paint side process.
    p.add_argument("--measured-s", type=int, help="small control only: measured window seconds")
    p.add_argument("--paint-build", type=Path, help="small control only: renderer-paint build dir")
    p.add_argument("--paint-seconds", type=int, default=15)
    p.add_argument("--stream-reset-s", type=float, default=0, help="small control only: stream message reset")
    p.add_argument("--startup-probe-s", type=int, help="small control only: large-arm startup probe seconds")
    p.add_argument("--mem-trace-s", type=float, help="small control only: small-arm tracemalloc snapshot interval")
    p.add_argument("--paint-repeats", type=int, default=3)
    p.add_argument("--preflight-only", action="store_true", help="only the N=10/N=100 rows preflight")
    p.add_argument("--preflight-large", action="store_true",
                   help="also seed N=1000 and judge chat/message from N=100 to N=1000 (opt-in, heavy)")
    p.add_argument("--lock-burst", type=int, help="small lock-wait burst probe at N agents (lock_burst.py)")
    p.add_argument("--go-file", type=Path)
    p.add_argument("--custodian")
    p.add_argument("--pg-bin")
    p.add_argument("--child", choices=("freeze", "bundle", "restore", "files", "ready", "prime"))
    p.add_argument("--arm", choices=("small", "large"))
    args = p.parse_args()
    if args.child:
        return child(args)
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    if subprocess.check_output(["git", "status", "--porcelain", "-uno"], cwd=REPO, text=True).strip():
        raise ValueError("commit tracked source before any controller probe")
    config = require_go(args, source)
    require_slots(args.small_control or args.preflight_only or bool(args.lock_burst))
    root = check_root(args.root)
    if free_commit_gb() < config["commit_gib"] or shutil.disk_usage(root.parent).free < config["disk_gib"] * 2**30:
        raise RuntimeError("insufficient free commit or disk for admission")
    if not args.custodian or not args.pg_bin:
        raise ValueError("explicit custodian and PG binaries required")
    c = Controller(root, config, args)
    c.source = source
    c.execute()


if __name__ == "__main__":
    main()
