"""The engine's own PostgreSQL (PYPG PG-1).

THE PROBLEM THIS CLOSES. With ``ORGTREE_STORE=postgres`` the Python engine
keeps its orgs in a private PostgreSQL instance, and that instance has to be
running (and migrated) before the API loads, on every launch path. The
desktop (``engine.ts``) and the background host (``service_host.py``) both
start ``launch.py``, so the bracket lives in ``launch.py``:

    arm_process_lifetime  ->  database up (init / start / strict attach)
    ->  PG-0 migrations  ->  load the API and serve
    ... the engine stops ...  ->  database down (clean ``pg_ctl`` stop)

It reuses WS1's ``pg-custodian`` binary for everything that touches the
cluster (quarantined init, identity-checked attach, handle-pinned stop); this
module only orders the calls and hands the engine a connection string.

WHEN IT ACTS. Only when ``ORGTREE_STORE`` is ``postgres``. Then
``ORGTREE_PG_CUSTODIAN`` must name an existing absolute executable (no PATH
lookup, no fallback) and the data root must pass the checks below, or the
engine does not start. There is never a fallback to SQLite: a postgres store
without a database is a refusal (a raise, plus one Windows Application
event-log line, because the desktop discards the engine's stderr).

SAFETY (PG-1 scope: copied or synthetic roots only). The root must carry
WS1's prototype marker and lie outside every unconditional live location in
the shared list (``engine/native/prototype-guard/live-locations.json``); the
custodian re-checks all of it (marker binding, junctions, UNC) in Rust. So
this cannot run against the user's real data root: how the real root is
unlocked after the PG-2 cutover is a separate ruling.

CONNECTION. The engine receives ``ORGTREE_PG_CONNINFO`` (the runtime role,
libpq keyword form) in its own environment. It names the cluster's owner-only
``pgpass.conf``: no password is ever placed in an environment variable, a log
or a report. The admin connection string is passed to the migrations only.

LIFETIME. The database is started after ``arm_process_lifetime``, so it runs
inside the guardian's Job: a FORCED engine kill also kills PostgreSQL, which
then recovers from its WAL on the next start (WS1 drill "abrupt database
exit"). In return it can never outlive the app as an orphan. A normal quit
(``/api/desktop/shutdown``) stops it cleanly.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Callable, Mapping, MutableMapping

STORE_ENV = "ORGTREE_STORE"
CUSTODIAN_ENV = "ORGTREE_PG_CUSTODIAN"
CONNINFO_ENV = "ORGTREE_PG_CONNINFO"
MARKER_FILE = "orgtree-p03-prototype-root.json"
RUNTIME_ROLE = "orgtree_runtime"
DATABASE = "orgtree"
_ENGINE = Path(__file__).resolve().parent
LIVE_LOCATIONS = _ENGINE / "native" / "prototype-guard" / "live-locations.json"
REFUSAL_MODULE = _ENGINE / "backend" / "orgtree" / "p03_refusal.py"

STATUS_TIMEOUT = 60.0
INIT_TIMEOUT = 300.0
START_TIMEOUT = 420.0
STOP_TIMEOUT = 720.0

#: A migration step: (admin conninfo) -> report. Must include "folder" and
#: "applied"; the bracket adds the folder's file checksums itself.
Migrator = Callable[[str], Mapping[str, Any]]


class BracketError(RuntimeError):
    """The engine must not start."""


def wanted(env: Mapping[str, str]) -> bool:
    return env.get(STORE_ENV, "").strip().lower() == "postgres"


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
    served root itself and is judged by its marker, as in the Rust guard)."""
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


def check_root(root: Path, env: Mapping[str, str]) -> None:
    """UNC/device paths lexically first (never touched), then the marker, then
    the live-location overlap, typed and resolved."""
    if str(root).replace("/", "\\").startswith("\\\\"):
        raise BracketError(f"refusing {root}: UNC and device paths are never served by the private database")
    if not (root / MARKER_FILE).is_file():
        raise BracketError(f"{STORE_ENV}=postgres, but {root} is not a disposable prototype root "
                           f"(no {MARKER_FILE}); the real data root is not unlocked yet")
    candidates = {_canon(root), str(root).replace("/", "\\").casefold().rstrip("\\")}
    for label, loc in live_locations(env):
        for form in {_canon(loc), str(loc).replace("/", "\\").casefold().rstrip("\\")}:
            for c in candidates:
                if _within(c, form) or _within(form, c):
                    raise BracketError(f"refusing to serve {root}: it overlaps protected location {label} ({loc})")


def _executable(env: Mapping[str, str], name: str) -> Path:
    raw = env.get(name, "").strip()
    if not raw:
        raise BracketError(f"{STORE_ENV}=postgres needs {name} (the pg-custodian executable; no fallback)")
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
    elif state != "running":
        raise BracketError(f"the database is {state}; refusing to serve")
    attach = _run_custodian(exe, ["attach", *r], env, STATUS_TIMEOUT, workdir)
    if not attach.get("ok"):
        raise BracketError(f"pg-custodian attach refused: {attach.get('code')}: {attach.get('message')}")
    return {"action": action, "runtime": attach["runtime"]}


def database_down(exe: Path, root: Path, env: Mapping[str, str], workdir: Path) -> dict[str, Any]:
    return _run_custodian(exe, ["stop", "--root", str(root)], env, STOP_TIMEOUT, workdir)


def _quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def conninfo(runtime: Mapping[str, Any], user: str, application: str) -> str:
    """libpq keyword form that REQUIRES SCRAM and reads the password from the
    custodian's owner-only passfile. Never contains a password."""
    for key in ("host", "port", "pgpass_file"):
        if not runtime.get(key):
            raise BracketError(f"pg-custodian attach gave no {key}")
    return (f"host={runtime['host']} port={int(runtime['port'])} dbname={DATABASE} user={user} "
            f"passfile={_quote(str(runtime['pgpass_file']))} require_auth=scram-sha-256 sslmode=disable "
            f"connect_timeout=10 application_name={application}")


# ---------------------------------------------------------------- migrations

def default_migrator() -> Migrator:
    """PG-0's entry point, ``orgtree.pgstore.migrate(conninfo)``. Its absence
    is a refusal, never a skip: the engine must not run on an unmigrated
    database. The backend is always the bundled ``engine/backend``, as in
    ``launch.load_app``."""
    backend = str(_ENGINE / "backend")
    if backend not in sys.path:
        sys.path.insert(0, backend)
    try:
        from orgtree import pgstore  # noqa: PLC0415
    except ImportError as exc:
        raise BracketError(f"{STORE_ENV}=postgres, but orgtree.pgstore (PG-0) is not importable: {exc}") from exc
    fn = getattr(pgstore, "migrate", None)
    if not callable(fn):
        raise BracketError("orgtree.pgstore has no migrate(conninfo) entry point")
    return fn


def folder_checksums(folder: Path) -> dict[str, str]:
    """sha256 of every *.sql in the migrations folder, recorded with the run."""
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.glob("*.sql"))}


def run_migrations(migrator: Migrator, admin: str) -> dict[str, Any]:
    try:
        report = dict(migrator(admin))
    except BracketError:
        raise
    except Exception as exc:  # noqa: BLE001  any failure is a refusal to serve
        raise BracketError(f"migrations failed: {type(exc).__name__}: {exc}") from exc
    folder = report.get("folder")
    if not folder or not Path(str(folder)).is_dir():
        raise BracketError(f"the migrations report names no existing folder: {folder!r}")
    report["folder"] = str(Path(str(folder)).resolve())
    report["checksums"] = folder_checksums(Path(report["folder"]))
    return report


# ---------------------------------------------------------------- the refusal line

def record_refusal(reason: str, root: Path) -> bool:
    """One Application event-log line (WS2's helper, loaded by path so the
    orgtree package is not imported before its time). Best effort."""
    try:
        spec = importlib.util.spec_from_file_location("_orgtree_p03_refusal", REFUSAL_MODULE)
        if spec is None or spec.loader is None:
            return False
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return bool(module.record_refusal("p03_bracket", reason, data_root=str(root), store="postgres"))
    except Exception:  # noqa: BLE001  the refusal itself is raised regardless
        return False


# ---------------------------------------------------------------- the bracket

class ManagedPostgres:
    def __init__(self, root: Path, env: Mapping[str, str], custodian: Path) -> None:
        self.root, self.env, self.custodian = root, dict(env), custodian
        self.workdir = root / "host-logs" / f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.database: dict[str, Any] | None = None
        self.migration: dict[str, Any] | None = None
        self.conninfo = ""

    def start(self, migrator: Migrator | None) -> "ManagedPostgres":
        self.database = database_up(self.custodian, self.root, self.env, self.workdir)
        try:
            runtime = self.database["runtime"]
            admin = conninfo(runtime, str(runtime.get("admin_role") or ""), "orgtree-migrate") \
                if runtime.get("admin_role") else ""
            if not admin:
                raise BracketError("pg-custodian attach gave no admin_role")
            self.migration = run_migrations(migrator or default_migrator(), admin)
            self.conninfo = conninfo(runtime, RUNTIME_ROLE, "orgtree-engine")
        except BaseException:
            self.stop()
            raise
        return self

    def stop(self) -> dict[str, Any]:
        """Stop the database this bracket started or attached. Idempotent."""
        report: dict[str, Any] = {}
        if self.database is not None:
            down = database_down(self.custodian, self.root, self.env, self.workdir)
            report["database_stop"] = {k: down.get(k) for k in ("ok", "code", "message")}
            self.database = None
        return report


def start_for_engine(root: Path, env: MutableMapping[str, str], migrator: Migrator | None = None) -> ManagedPostgres | None:
    """launch.py's entry point. None = inert (``ORGTREE_STORE`` is not
    postgres). On success sets ``ORGTREE_PG_CONNINFO`` in ``env``. Raises
    BracketError (after writing the event-log line) when the engine must not
    start."""
    if not wanted(env):
        env.pop(CONNINFO_ENV, None)  # never a stale connection from a parent
        return None
    try:
        check_root(root, env)
        custodian = _executable(env, CUSTODIAN_ENV)
        # The engine's per-boot desktop token is not the custodian's to see.
        child_env = {k: v for k, v in env.items() if k not in ("ORGTREE_V2_TOKEN", CONNINFO_ENV)}
        owned = ManagedPostgres(root, child_env, custodian).start(migrator)
    except BracketError as exc:
        record_refusal(str(exc), root)
        raise
    env[CONNINFO_ENV] = owned.conninfo
    return owned
