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
sys.path.insert(0, str(REPO / "tools" / "scale"))
from history_fixture import Recipe, asdict, sha_file, safe_root, regular_file
from seed import child_env
from control import free_commit_gb


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


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


def require_go(args, source):
    if args.small_control:
        return dict(kind="small controller control", agents=10, active_items=8, transcript_kb=1,
                    seconds=.05, warmup=3, measured=8, tool_rate=2, steer_rate=3,
                    recipe=asdict(Recipe(retired_agents=2, archived_items=2, read_mail=2,
                        old_transcripts=2, payload_profile="fixed", node_chars=128,
                        item_chars=128, mail_chars=128, transcript_chars=128)),
                    disk_gib=2, commit_gib=12, readiness_s=90)
    if not args.go_file:
        raise ValueError("large root/seed/run requires coordinator GO file")
    go = read(args.go_file)
    if go.get("source") != source or go.get("go") is not True or not go.get("coordinator_message"):
        raise ValueError("GO must name the exact source and coordinator message")
    return dict(kind="first N1000 baseline; no final qualification", agents=1000, active_items=180,
                transcript_kb=256, seconds=10, warmup=120, measured=600, tool_rate=3.12,
                steer_rate=9.36, recipe=asdict(Recipe()), disk_gib=80, commit_gib=24, readiness_s=900)


def check_root(root):
    root = safe_root(root)
    allowed = Path("C:/Temp").resolve()
    if root.parent != allowed or not root.name.startswith("scale-ui-history-"):
        raise ValueError("controller root must be a new C:/Temp/scale-ui-history-* directory")
    if root.exists():
        raise ValueError("controller root already exists; retries need a new run id")
    return root


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

    def check(self):
        if self.breach:
            raise RuntimeError(self.breach)

    def guard(self):
        import psutil
        while not self.stop_guard.is_set():
            try:
                free = free_commit_gb()
                disk = shutil.disk_usage(self.root).free / 2**30
                engine = psutil.Process(self.engine_pid).memory_info().private if self.engine_pid else 0
                if free < 10 or engine > 5 * 2**30 or disk < (1 if self.args.small_control else 20):
                    raise RuntimeError(f"guard: free commit {free:.2f} GiB, engine {engine}, disk {disk:.2f} GiB")
                with (self.root / "guard.jsonl").open("a", encoding="utf-8") as out:
                    out.write(json.dumps(dict(at=time.time(), phase=self.phase, free_commit_gib=free,
                        engine_private=engine, disk_free_gib=disk)) + "\n")
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
        finally:
            self.kill(proc)

    def script(self, script, name, *args, env=None, timeout=900):
        self.command([sys.executable, "-I", "-B", str(REPO / "tools/scale" / script), *map(str, args)],
                     name, env, timeout)

    def pg(self, action):
        result = subprocess.run([self.args.custodian, action, "--root", str(self.root / "pg"),
            "--pg-bin", self.args.pg_bin], capture_output=True, text=True, timeout=90)
        if result.returncode:
            raise RuntimeError(f"PG {action} failed: {result.stderr[-500:]}")
        value = json.loads(result.stdout)
        write(self.root / "receipts" / ("pg-" + action + ".json"), value)
        return value

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
        guard = threading.Thread(target=self.guard, name="baseline-independent-guard")
        guard.start()
        outcome = {"complete": False}
        try:
            self.pg("init-root")
            self.pg("init")
            # The custodian owns layout. This single setting is a declared
            # private-cluster capacity, not a product default change.
            conf = self.root / "pg/cluster/data/postgresql.conf"
            with conf.open("a", encoding="utf-8") as target:
                target.write("\nmax_connections = 128\n")
            self.pg("start")
            self.pg_started = True
            admin = self.pg("urls")["urls"]["P03_PG_ADMIN_URL"]
            c = self.config
            self.script("seed.py", "seed", "--root", self.run_root, "--agents", c["agents"],
                "--active-items", c["active_items"], "--archived-per-live", 0,
                "--archived-items-per-live", 0, "--transcript-kb", c["transcript_kb"],
                "--seed", 1, "--admin-url", admin, "--min-free-commit-gb", 10)
            write(self.run_root / "controller-owner.json", dict(root=str(self.root), token=self.token))
            self.script("prepare_steady.py", "prepare-simulator", "--root", self.run_root,
                        "--seconds", c["seconds"], "--output-bytes", 256)
            desc = read(self.run_root / "scale-descriptor.json")
            env = child_env(self.run_root, desc["pg_url"])
            self.script("baseline.py", "freeze", "--child", "freeze", "--root", self.root, env=env)
            frozen = read(self.root / "frozen/controller.json")
            reserve = max(c["disk_gib"], frozen["estimate"]["suggested_free_disk_bytes"] / 2**30)
            if shutil.disk_usage(self.root).free / 2**30 < reserve:
                raise RuntimeError(f"actual frozen estimate needs {reserve:.2f} GiB")
            self.script("baseline.py", "bundle", "--child", "bundle", "--root", self.root, env=env)
            plans = self.root / "plans"
            for arm in ("small", "large"):
                self.clear_run()
                from seed import _create_db
                url = _create_db(admin, "orgtree_scale_" + self.token + "_" + arm)
                for name in ("data", "home", "temp"):
                    (self.run_root / name).mkdir(parents=True, exist_ok=True)
                write(self.run_root / "controller-owner.json", dict(root=str(self.root), token=self.token))
                env = child_env(self.run_root, url)
                self.script("baseline.py", arm + "-restore", "--child", "restore", "--root", self.root,
                            "--arm", arm, env=env)
                self.script("history_pg.py", arm + "-fresh-verify", "verify", "--bundle", self.root / "bundle",
                    "--root", self.run_root, "--arm", arm, "--result", self.root / f"receipts/{arm}-verify.json", env=env)
                self.script("baseline.py", arm + "-files", "--child", "files", "--root", self.root,
                            "--arm", arm, env=env)
                server = self.spawn([sys.executable, "-I", "-B", str(REPO / "tools/scale/serve.py"),
                    "--root", str(self.run_root), "--env", "ORGTREE_SCALE_SIMULATED_PROVIDER=1",
                    "--env", "ORGTREE_SCALE_SQL_COUNTS=1"], arm + "-serve")
                try:
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
                    self.script("baseline.py", arm + "-readiness", "--child", "ready", "--root", self.root,
                        "--arm", arm, env=env, timeout=max(1, deadline-time.monotonic()))
                    for label, duration in (("warmup", c["warmup"]), ("measured", c["measured"])):
                        args = ["--root", self.run_root, "--duration", duration, "--rate", c["tool_rate"],
                                "--steer-rate", c["steer_rate"], "--workers", 64, "--windows", 4,
                                "--stream-nodes", 5, "--stream-hz", 4, "--renderer-hooks", "--write-oracle"]
                        # BOTH plans are frozen before the first warmup writes.
                        if arm == "small" and label == "warmup":
                            for phase, seconds in (("warmup", c["warmup"]), ("measured", c["measured"])):
                                prep = list(args)
                                prep[prep.index("--duration")+1] = seconds
                                self.script("load.py", "plan-" + phase, *prep, "--label", "plan-"+phase, "--plan-only")
                                shutil.copytree(self.run_root / "metrics" / ("plan-"+phase), plans / phase)
                        self.script("load.py", arm + "-" + label, *args, "--label", label,
                                    "--plans-dir", plans / label, timeout=duration+240)
                    outcome[arm] = read(self.run_root / "metrics/measured/summary.json")
                finally:
                    self.kill(server)
                    self.engine_pid = None
                    shutil.copytree(self.run_root / "metrics", self.root / "receipts" / arm, dirs_exist_ok=True)
                self.check()
            if outcome["small"]["config"]["plans"] != outcome["large"]["config"]["plans"]:
                raise RuntimeError("unequal demand between arms")
            outcome["complete"] = True
        except BaseException as exc:
            outcome["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            for proc in self.children:
                self.kill(proc)
            self.engine_pid = None
            if self.pg_started:
                self.pg("stop")
            self.stop_guard.set()
            guard.join(timeout=5)
            outcome["cleanup"] = dict(children_exited=all(p.poll() is not None for p in self.children),
                                      pg_stopped=not self.pg_started or self.pg("status")["cluster"]["state"] == "stopped")
            write(self.root / "result.json", outcome)


def child(args):
    root, run = args.root, args.root / "run"
    config = read(root / "controller.json")["config"]
    sys.path.insert(0, str(REPO / "tools"))
    from assert_repo_import import assert_repo_import
    provenance = assert_repo_import(REPO)
    from orgtree import store, pgstore
    if Path(store.DATA_ROOT).resolve() != run / "data":
        raise ValueError("child data root escaped")
    from history_fixture import prepare_base, estimate, build_pair
    from history_pg import authorize_empty_destination, restore
    if args.child == "freeze":
        from orgtree.notification_state import reconcile_attention
        desc = read(run / "scale-descriptor.json")
        org = store.load_org(desc["org"])
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
                             {k: str(frozen / "home" / k) for k in read(frozen / "controller.json")["files"]["home"]})
        provenance.write_result(root / "receipts/bundle.json", manifest)
    elif args.child == "restore":
        desc = read(root / "frozen/descriptor.json")
        authorize_empty_destination(run, desc["org"], pgstore.url())
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
        desc.update(pg_url=pgstore.url(), pg_database=pgstore.url().rsplit("/",1)[-1], origin=None, token=None)
        desc.pop("serve", None)
        write(run / "scale-descriptor.json", desc)
        provenance.write_result(root / f"receipts/{args.arm}-files.json", dict(verified=True, files=receipt["files"]))
    elif args.child == "ready":
        from baseline_readiness import wait_ready
        receipt = wait_ready(run, config["readiness_s"])
        provenance.write_result(root / f"receipts/{args.arm}-readiness.json", receipt)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", required=True, type=Path)
    p.add_argument("--small-control", action="store_true")
    p.add_argument("--go-file", type=Path)
    p.add_argument("--custodian")
    p.add_argument("--pg-bin")
    p.add_argument("--child", choices=("freeze", "bundle", "restore", "files", "ready"))
    p.add_argument("--arm", choices=("small", "large"))
    args = p.parse_args()
    if args.child:
        return child(args)
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    config = require_go(args, source)
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
