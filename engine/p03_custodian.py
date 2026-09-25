"""P03 private-service bracket for the boot host (WS1).

THE PROBLEM THIS CLOSES. On a P03 prototype data root the engine needs two
owned dependencies before it starts: the private PostgreSQL instance (owned by
the WS1 custodian, ``pg-custodian``) and the WS2 store service. v6
BUNDLED-DATABASE-SERVICE puts the process manager in the HOST, not in the
engine process (an engine restart is not a database restart), so the bracket
lives in ``engine/service_host.py`` only (lead ruling 2026-09-25, recorded as a
decision on docket item p03-ws1-private-postgresql-service-custodian-and):

    database up (or attach)  ->  store service up  ->  launch.py
    ... engine exits ...     ->  store service down ->  database down

WHEN IT ACTS. Only on a prototype root: the data root carries the P03 marker
``orgtree-p03-prototype-root.json``. Then BOTH ``ORGTREE_P03_CUSTODIAN`` and
``ORGTREE_P03_STORE_SERVICE`` must name existing executables (no PATH lookup,
no fallback), or the host refuses to start. On any other root with neither
variable set it does nothing at all. A marker without the variables, or the
variables without a marker, is a misconfiguration and is refused: the host
never guesses which kind of root it is serving.

SAFETY. The custodian itself enforces the prototype-root guard (the shared
``orgtree-prototype-guard`` crate). This module re-checks the root against the
SAME live-location list (``engine/native/prototype-guard/live-locations.json``)
before running anything, so a misconfigured host fails here first. No password
travels through this module: the store service reads the custodian's
owner-only secrets itself. Child output goes to files, never pipes a
long-lived descendant could hold open; every step has a timeout.

P03 LIMITS (stated where a reader will look): the desktop (``engine.ts``) path
is untouched in P03; a desktop-window attach is recorded as
``environment_limited`` and moves to P10. A ``.py`` store-service path is run
with this interpreter so tests can use a stub.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Mapping

MARKER_FILE = "orgtree-p03-prototype-root.json"
CUSTODIAN_ENV = "ORGTREE_P03_CUSTODIAN"
STORE_SERVICE_ENV = "ORGTREE_P03_STORE_SERVICE"
STORE_DESCRIPTOR = "p03-store-service.json"
LIVE_LOCATIONS = Path(__file__).resolve().parent / "native" / "prototype-guard" / "live-locations.json"

STATUS_TIMEOUT = 60.0
INIT_TIMEOUT = 300.0
START_TIMEOUT = 420.0
STOP_TIMEOUT = 720.0
STORE_READY_TIMEOUT = 120.0
STORE_STOP_TIMEOUT = 30.0


class BracketError(RuntimeError):
    """The host must not start the engine."""


# ---------------------------------------------------------------- the root check

def _canon(path: Path) -> str:
    """Resolve (follows junctions), drop \\\\?\\, fold case, trim trailing
    dots/spaces per component: the shared guard's rule, in Python."""
    text = str(Path(path).resolve()).replace("/", "\\")
    if text.startswith("\\\\?\\"):
        text = text[4:]
    parts = [p.rstrip(". ") for p in text.split("\\")]
    return "\\".join(p for p in parts if p != "").casefold()


def _within(a: str, b: str) -> bool:
    return a == b or a.startswith(b.rstrip("\\") + "\\")


def live_locations(env: Mapping[str, str]) -> list[tuple[str, Path]]:
    """The UNCONDITIONAL locations from the shared list (ORGTREE_DATA is the
    served root itself here and is judged by the marker, as in the Rust guard)."""
    try:
        spec = json.loads(LIVE_LOCATIONS.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BracketError(f"cannot read the shared live-location list {LIVE_LOCATIONS}: {exc}") from exc
    if spec.get("schema") != "orgtree.p03.live-locations/v1":
        raise BracketError(f"unexpected live-location schema in {LIVE_LOCATIONS}")
    out = []
    for loc in spec.get("locations", []):
        if not loc.get("unconditional"):
            continue
        base = next((env[k].strip() for k in loc["base_env"] if env.get(k, "").strip()), None)
        if base:
            out.append((loc["label"], Path(base).joinpath(*loc["parts"])))
    return out


def is_prototype_root(root: Path) -> bool:
    return (root / MARKER_FILE).is_file()


def check_root(root: Path, env: Mapping[str, str]) -> None:
    """Refuse a root inside or containing any unconditional live location,
    typed or resolved (the Rust guard re-checks everything, including the
    marker binding and reparse points)."""
    candidates = {_canon(root), str(root).replace("/", "\\").casefold().rstrip("\\")}
    for label, loc in live_locations(env):
        for form in {_canon(loc), str(loc).replace("/", "\\").casefold().rstrip("\\")}:
            for c in candidates:
                if _within(c, form) or _within(form, c):
                    raise BracketError(f"refusing to serve {root}: it overlaps protected location {label} ({loc})")


def _executable(env: Mapping[str, str], name: str) -> Path:
    raw = env.get(name, "").strip()
    if not raw:
        raise BracketError(f"{name} is not set; a prototype root needs it (no fallback)")
    path = Path(raw)
    if not path.is_absolute() or not path.is_file():
        raise BracketError(f"{name}={raw!r} is not an existing absolute file")
    return path


# ---------------------------------------------------------------- the custodian

def _run_custodian(exe: Path, args: list[str], env: Mapping[str, str], timeout: float, workdir: Path) -> dict[str, Any]:
    """Run pg-custodian with stdout/stderr to FILES and return its JSON."""
    out_path = workdir / f"custodian-{args[0]}-{os.getpid()}-{time.monotonic_ns()}.json"
    err_path = out_path.with_suffix(".err")
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
        try:
            proc = subprocess.run([str(exe), *args], stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                  env=dict(env), timeout=timeout,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as exc:
            raise BracketError(f"pg-custodian {args[0]} did not finish within {timeout:.0f}s") from exc
    try:
        value = json.loads(out_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {"ok": False, "code": "bracket.bad_output", "message": err_path.read_text(encoding="utf-8", errors="replace")[:2000]}
    finally:
        for p in (out_path, err_path):
            try:
                p.unlink()
            except OSError:
                pass
    value["_exit"] = proc.returncode
    return value


def database_up(exe: Path, root: Path, env: Mapping[str, str], workdir: Path) -> dict[str, Any]:
    """Init if absent, start if stopped, ATTACH (strictly) if already running.
    Never a second instance, never trust a port or pid alone."""
    r = ["--root", str(root)]
    status = _run_custodian(exe, ["status", *r], env, STATUS_TIMEOUT, workdir)
    if not status.get("ok"):
        raise BracketError(f"pg-custodian status refused: {status.get('code')}: {status.get('message')}")
    state = status["cluster"]["state"]
    action = "attached"
    if state == "absent":
        init = _run_custodian(exe, ["init", *r], env, INIT_TIMEOUT, workdir)
        if not init.get("ok"):
            raise BracketError(f"pg-custodian init refused: {init.get('code')}: {init.get('message')}")
        state, action = "stopped", "initialized+started"
    if state in ("stopped", "stale_pid"):
        start = _run_custodian(exe, ["start", *r], env, START_TIMEOUT, workdir)
        if not start.get("ok"):
            raise BracketError(f"pg-custodian start refused: {start.get('code')}: {start.get('message')}")
        if action == "attached":
            action = "started"
    elif state != "running" and action == "attached":
        raise BracketError(f"the database is {state}; refusing to serve")
    attach = _run_custodian(exe, ["attach", *r], env, STATUS_TIMEOUT, workdir)
    if not attach.get("ok"):
        raise BracketError(f"pg-custodian attach refused: {attach.get('code')}: {attach.get('message')}")
    return {"action": action, "runtime": attach["runtime"]}


def database_down(exe: Path, root: Path, env: Mapping[str, str], workdir: Path) -> dict[str, Any]:
    return _run_custodian(exe, ["stop", "--root", str(root)], env, STOP_TIMEOUT, workdir)


# ---------------------------------------------------------------- the store service

class StoreService:
    """WS2's store service (call shape agreed with p03-ws2-storecore 2026-09-25):
    ``--root``; one ready line on stdout after it wrote its owner-only
    descriptor; exits on stdin EOF; nothing but that line on stdout."""

    def __init__(self, exe: Path, root: Path, env: Mapping[str, str], workdir: Path) -> None:
        cmd = [sys.executable, str(exe)] if exe.suffix.lower() == ".py" else [str(exe)]
        self.err_path = workdir / f"store-service-{os.getpid()}.log"
        self.err = open(self.err_path, "ab")
        self.proc = subprocess.Popen([*cmd, "--root", str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.err, env=dict(env),
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.ready: dict[str, Any] = {}
        self.root = root

    def wait_ready(self, timeout: float = STORE_READY_TIMEOUT) -> dict[str, Any]:
        box: dict[str, Any] = {}

        def read() -> None:
            assert self.proc.stdout is not None
            raw = self.proc.stdout.readline(65537)
            box["line"] = raw
            for _ in self.proc.stdout:  # drain: the service never blocks on a full pipe
                pass

        threading.Thread(target=read, daemon=True).start()
        deadline = time.monotonic() + timeout
        while "line" not in box and time.monotonic() < deadline and self.proc.poll() is None:
            time.sleep(0.02)
        line = box.get("line", b"")
        if not line:
            raise BracketError(f"store service did not report ready (exit {self.proc.poll()}); see {self.err_path}")
        try:
            value = json.loads(line.decode("utf-8", "replace"))
        except ValueError as exc:
            raise BracketError("store service readiness is not JSON") from exc
        if not isinstance(value, dict) or value.get("type") != "ready" or value.get("pid") != self.proc.pid:
            raise BracketError(f"store service readiness is wrong: {value!r}")
        descriptor = Path(str(value.get("descriptor", "")))
        if _canon(descriptor) != _canon(self.root / STORE_DESCRIPTOR) or not descriptor.is_file():
            raise BracketError(f"store service descriptor {descriptor} is not {self.root / STORE_DESCRIPTOR}")
        self.ready = value
        return value

    def stop(self, timeout: float = STORE_STOP_TIMEOUT) -> bool:
        """Close stdin (the service exits on EOF), wait, kill as a last
        resort. True when the exit is confirmed."""
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                return False
        finally:
            self.err.close()
        return True


# ---------------------------------------------------------------- the bracket

class OwnedServices:
    def __init__(self, root: Path, env: Mapping[str, str], custodian: Path, store_exe: Path) -> None:
        self.root, self.env, self.custodian, self.store_exe = root, dict(env), custodian, store_exe
        self.workdir = Path(tempfile.mkdtemp(prefix="orgtree-p03-host-"))
        self.database: dict[str, Any] | None = None
        self.store: StoreService | None = None

    def start(self) -> "OwnedServices":
        self.database = database_up(self.custodian, self.root, self.env, self.workdir)
        try:
            self.store = StoreService(self.store_exe, self.root, self.env, self.workdir)
            self.store.wait_ready()
        except BaseException:
            self.stop()
            raise
        return self

    def stop(self) -> dict[str, Any]:
        """Reverse order: store service, then database. Returns what happened."""
        report: dict[str, Any] = {}
        if self.store is not None:
            report["store_service_exited"] = self.store.stop()
            self.store = None
        if self.database is not None:
            down = database_down(self.custodian, self.root, self.env, self.workdir)
            report["database_stop"] = {k: down.get(k) for k in ("ok", "code", "message")}
            self.database = None
        return report


def start_for_host(root: Path, env: Mapping[str, str]) -> OwnedServices | None:
    """The host's entry point. None = inert (not a prototype root and no P03
    variables). Raises BracketError when the host must not start the engine."""
    marked = is_prototype_root(root)
    configured = bool(env.get(CUSTODIAN_ENV, "").strip() or env.get(STORE_SERVICE_ENV, "").strip())
    if not marked and not configured:
        return None
    if not marked:
        raise BracketError(f"{CUSTODIAN_ENV}/{STORE_SERVICE_ENV} are set but {root} is not a P03 prototype root")
    check_root(root, env)
    custodian = _executable(env, CUSTODIAN_ENV)
    store = _executable(env, STORE_SERVICE_ENV)
    # The engine's per-boot desktop token is not theirs to see.
    child_env = {k: v for k, v in env.items() if k != "ORGTREE_V2_TOKEN"}
    return OwnedServices(root, child_env, custodian, store).start()
