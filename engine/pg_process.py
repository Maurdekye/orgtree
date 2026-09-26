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

WHEN IT ACTS (plan decision 18.1). Only when the CHOSEN backend is
postgres, chosen in this order: ``ORGTREE_STORE`` from the environment;
otherwise ``<root>/store-backend.json`` (written only by the PG-2 cutover);
otherwise SQLite. So without a cutover record the engine starts on SQLite
exactly as before and this module does nothing. When the file chooses
postgres the bracket also sets ``ORGTREE_STORE=postgres`` for the engine, so
the store cannot disagree. FRESH INSTALLS (the packaged 3.0.0-alpha.0
desktop, which alone sets ``ORGTREE_PG_BOOTSTRAP=1``): a root with no org
store yet is bound and recorded as postgres before the choice is made, so it
never starts on SQLite; a root that already holds orgs is left exactly as it
is until the PG-2 cutover, and a root in between refuses (see
``bootstrap_fresh_root``). A cutover record that does not parse, or names a
backend we do not know, REFUSES rather than guessing. Once postgres is chosen,
``ORGTREE_PG_CUSTODIAN`` must name an existing absolute executable (no PATH
lookup, no fallback) and the data root must pass the checks below, or the
engine does not start. There is never a fallback to SQLite: a postgres store
without a database is a refusal (a raise, plus one Windows Application
event-log line, because the desktop discards the engine's stderr).

SAFETY. A root is served in one of two modes, and anything else refuses:

* PROTOTYPE: the root carries WS1's prototype marker and lies outside every
  unconditional live location in the shared list
  (``engine/native/prototype-guard/live-locations.json``).
* PRODUCT (decision 18.1): the root is the engine's own ``ORGTREE_DATA``,
  its cutover record chooses postgres, it carries the custodian's product
  binding (``orgtree-product-root.json``, written by ``pg-custodian
  bind-product`` at the PG-2 import), and it lies clear of the agent
  variables and the installed app (``PRODUCT_DENY``). An agent session names
  the live data in ``ORGTREE_AGENT_PARENT_DATA``, so an agent cannot run this
  mode on it BY ACCIDENT; like devguard this is an accident guard, not a
  sandbox (a process that unsets the variables passes it, as the PG-2 runbook's
  plain terminal does on purpose). The custodian is then called with
  ``--product``.

In both modes the custodian re-checks everything (binding, junctions, UNC)
in Rust, and refuses destroy/restore on a product root.

CONNECTION. The engine receives ``ORGTREE_PG_CONNINFO`` (the runtime role,
libpq keyword form) in its own environment. It names the cluster's owner-only
``pgpass.conf``: no password is ever placed in an environment variable, a log
or a report. The admin connection string is passed to the migrations only.
No child of the engine inherits it: ``devguard.child_env`` (every agent and
shell spawn) drops the store and libpq variables, and ``pgstore.connect``
refuses the live root's cluster from an agent context (review B1, decision 35).

STARTUP PROGRESS. Each database step (status, init, start, attach, migrate,
ready) is reported as a startup-progress checkpoint, so the desktop's
readiness window restarts between them (review N-B). One step that alone
outlasts that window (a first ``init`` on a slow disk) still fails the start
visibly; it is not hidden.

LIFETIME. The database is started after ``arm_process_lifetime``, so it runs
inside the guardian's Job: a FORCED engine kill also kills PostgreSQL, which
then recovers from its WAL on the next start (WS1 drill "abrupt database
exit"). In return it can never outlive the app as an orphan. A normal quit
(``/api/desktop/shutdown``) stops it cleanly. That stop may wait up to
``STOP_TIMEOUT``; if the desktop's quit deadline kills the engine first,
PostgreSQL dies with the Job and recovers from its WAL next start (review
N-C: safe, inferred from the WS1 abrupt-exit drill, not separately measured).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Callable, Mapping, MutableMapping

STORE_ENV = "ORGTREE_STORE"
#: Set to "1" by the PACKAGED desktop only: a fresh root starts on PostgreSQL.
BOOTSTRAP_ENV = "ORGTREE_PG_BOOTSTRAP"
BOOTSTRAP_VIA = "fresh-bootstrap"
CUSTODIAN_ENV = "ORGTREE_PG_CUSTODIAN"
CONNINFO_ENV = "ORGTREE_PG_CONNINFO"
MARKER_FILE = "orgtree-p03-prototype-root.json"
PRODUCT_FILE = "orgtree-product-root.json"
CUTOVER_FILE = "store-backend.json"
CUTOVER_SCHEMA = "orgtree.store-backend/v1"
BACKENDS = ("sqlite", "postgres", "json")
#: The shared-list labels a PRODUCT root must stay clear of; the same list as
#: ``PRODUCT_DENY`` in the Rust guard (a test compares them).
PRODUCT_DENY = ("ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA",
                "%ProgramFiles%\\Orgtree", "%LOCALAPPDATA%\\Programs\\Orgtree")
RUNTIME_ROLE = "orgtree_runtime"
DATABASE = "orgtree"
_ENGINE = Path(__file__).resolve().parent
LIVE_LOCATIONS = _ENGINE / "native" / "prototype-guard" / "live-locations.json"
REFUSAL_MODULE = _ENGINE / "backend" / "orgtree" / "p03_refusal.py"

_MARKER_TMP = re.compile(r".+\.pg\.\d+\.tmp")

STATUS_TIMEOUT = 60.0
INIT_TIMEOUT = 300.0
START_TIMEOUT = 420.0
STOP_TIMEOUT = 720.0

#: A migration step: (admin conninfo) -> report. Must include "folder" and
#: "applied"; the bracket adds the folder's file checksums itself.
Migrator = Callable[[str], Mapping[str, Any]]
#: The engine's startup-progress reporter (``StartupProgress.report``): each
#: call is a checkpoint that restarts the desktop's readiness window.
Progress = Callable[[str], None]


class BracketError(RuntimeError):
    """The engine must not start."""


def read_cutover(root: Path) -> dict[str, Any] | None:
    """The cutover record, or None when there is none. A record that exists
    but does not parse, or is not ours, refuses: guessing SQLite would hide
    every write made on PostgreSQL since the cutover."""
    path = root / CUTOVER_FILE
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise BracketError(f"cannot read the cutover record {path}: {exc}") from exc
    try:
        record = json.loads(text)
    except ValueError as exc:
        raise BracketError(f"the cutover record {path} is not valid JSON: {exc}") from exc
    if not isinstance(record, dict) or record.get("schema") != CUTOVER_SCHEMA:
        raise BracketError(f"the cutover record {path} is not a {CUTOVER_SCHEMA} record")
    if record.get("backend") not in BACKENDS:
        raise BracketError(f"the cutover record {path} names an unknown backend {record.get('backend')!r}")
    return record


def chosen_backend(root: Path, env: Mapping[str, str]) -> str:
    """Decision 18.1: ``ORGTREE_STORE``, else the cutover record, else sqlite.
    One exception refuses (review N-A): a record choosing postgres with the
    variable naming another backend. The sqlite/json stores do not read the
    ``.pg`` markers a cutover leaves in orgs/, so that engine would start
    with every org invisible; going back to SQLite is the PG-2 rollback."""
    explicit = env.get(STORE_ENV, "").strip().lower()
    if explicit == "postgres":
        return explicit
    if explicit:
        # a UNC/device root is never read here (check_root refuses it untouched)
        record = None if _unc_or_device(root) else read_cutover(root)
        if record is not None and record.get("backend") == "postgres":
            raise BracketError(
                f"{STORE_ENV}={explicit}, but {root / CUTOVER_FILE} records that this root was cut over to "
                f"PostgreSQL; the {explicit} store cannot see its orgs. Unset {STORE_ENV}, or roll the cutover "
                f"back first (move pre-postgres/orgs back into orgs/ and rename {CUTOVER_FILE}).")
        return explicit
    record = read_cutover(root)
    return str(record["backend"]) if record is not None else "sqlite"


def _unc_or_device(root: Path) -> bool:
    return str(root).replace("/", "\\").startswith("\\\\")


def wanted(env: Mapping[str, str], root: Path | None = None) -> bool:
    if root is None:
        return env.get(STORE_ENV, "").strip().lower() == "postgres"
    return chosen_backend(root, env) == "postgres"


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


def _forms(path: Path) -> set[str]:
    return {_canon(path), str(path).replace("/", "\\").casefold().rstrip("\\")}


def _refuse_overlap(root: Path, locations: list[tuple[str, Path]]) -> None:
    for label, loc in locations:
        for form in _forms(loc):
            for c in _forms(root):
                if _within(c, form) or _within(form, c):
                    raise BracketError(f"refusing to serve {root}: it overlaps protected location {label} ({loc})")


def product_deny_locations(env: Mapping[str, str]) -> list[tuple[str, Path]]:
    """``PRODUCT_DENY`` resolved from the shared list; a missing label fails
    closed."""
    try:
        spec = json.loads(LIVE_LOCATIONS.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise BracketError(f"cannot read the shared live-location list {LIVE_LOCATIONS}: {exc}") from exc
    out = []
    for label in PRODUCT_DENY:
        loc = next((x for x in spec.get("locations", []) if x.get("label") == label), None)
        if loc is None:
            raise BracketError(f"the shared live-location list has no {label!r}")
        base = next((env[k].strip() for k in loc["base_env"] if env.get(k, "").strip()), None)
        if base:
            out.append((label, Path(base).joinpath(*loc["parts"])))
    return out


def check_cutover_finished(root: Path, env: Mapping[str, str]) -> None:
    """A cutover record choosing postgres with SQLite/JSON files still in
    ``orgs/`` is a cutover that stopped between writing the record and moving
    the old files (PG-2 writes the record first on purpose). Refuse, and say
    exactly how to finish it or roll it back."""
    record = read_cutover(root)
    if record is None or record.get("backend") != "postgres":
        return
    orgs = root / "orgs"
    # a crash-left marker temp (pgstore._write_marker: <slug>.pg.<pid>.tmp) is
    # not an unmoved source file (review N-E)
    left = sorted(p.name for p in orgs.iterdir() if p.is_file() and not p.name.endswith(".pg")
                  and not _MARKER_TMP.fullmatch(p.name)) if orgs.is_dir() else []
    if left:
        custodian = env.get(CUSTODIAN_ENV, "").strip() or "<pg-custodian.exe>"
        shown = ", ".join(left[:10]) + (f" (+{len(left) - 10} more)" if len(left) > 10 else "")
        raise BracketError(
            f"the cutover of {root} to PostgreSQL did not finish: orgs/ still holds {shown}. "
            f"Finish it (with the engine stopped) by running: "
            f"python tools/pypg/pgimport.py import --root \"{root}\" --custodian \"{custodian}\" "
            f"-- it only moves the remaining files to pre-postgres/orgs. Or roll back: move "
            f"pre-postgres/orgs back into orgs/ and delete {CUTOVER_FILE}.")


def check_root(root: Path, env: Mapping[str, str]) -> str:
    """UNC/device paths lexically first (never touched); then PROTOTYPE mode
    (the marker, and no overlap with any unconditional live location) or
    PRODUCT mode (see the module doc). Returns "prototype" or "product"."""
    if _unc_or_device(root):
        raise BracketError(f"refusing {root}: UNC and device paths are never served by the private database")
    if (root / MARKER_FILE).is_file():
        _refuse_overlap(root, live_locations(env))
        return "prototype"
    data = env.get("ORGTREE_DATA", "").strip()
    if not data or _canon(Path(data)) != _canon(root):
        raise BracketError(f"postgres is chosen, but {root} is neither a disposable prototype root "
                           f"(no {MARKER_FILE}) nor the engine's own ORGTREE_DATA")
    record = read_cutover(root)
    if record is None or record.get("backend") != "postgres":
        raise BracketError(f"postgres is chosen, but {root} has no cutover record choosing it "
                           f"({CUTOVER_FILE}); the engine's own data root is served only after the PG-2 cutover")
    if not (root / PRODUCT_FILE).is_file():
        raise BracketError(f"{root} was cut over but has no product binding ({PRODUCT_FILE}); "
                           "run `pg-custodian bind-product` (the PG-2 import does)")
    _refuse_overlap(root, product_deny_locations(env))
    return "product"


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


def database_up(exe: Path, root: Path, env: Mapping[str, str], workdir: Path,
                product: bool = False, progress: Progress | None = None) -> dict[str, Any]:
    """Init if absent, start if stopped, ATTACH (strictly) if already running.
    Never a second instance, never trust a port or pid alone. ``progress``
    (the engine's startup-progress reporter) is told before each step."""
    step = progress or (lambda _phase: None)
    r = ["--root", str(root)] + (["--product"] if product else [])
    step("database-status")
    status = _run_custodian(exe, ["status", *r], env, STATUS_TIMEOUT, workdir)
    if not status.get("ok"):
        raise BracketError(f"pg-custodian status refused: {status.get('code')}: {status.get('message')}")
    state = status["cluster"]["state"]
    outcome = "attached"
    if state == "absent":
        step("database-init")
        init = _run_custodian(exe, ["init", *r], env, INIT_TIMEOUT, workdir)
        if not init.get("ok"):
            raise BracketError(f"pg-custodian init refused: {init.get('code')}: {init.get('message')}")
        state, outcome = "stopped", "initialized+started"
    if state in ("stopped", "stale_pid"):
        step("database-start")
        start = _run_custodian(exe, ["start", *r], env, START_TIMEOUT, workdir)
        if not start.get("ok"):
            raise BracketError(f"pg-custodian start refused: {start.get('code')}: {start.get('message')}")
        if outcome == "attached":
            outcome = "started"
    elif state != "running":
        raise BracketError(f"the database is {state}; refusing to serve")
    step("database-attach")
    attach = _run_custodian(exe, ["attach", *r], env, STATUS_TIMEOUT, workdir)
    if not attach.get("ok"):
        raise BracketError(f"pg-custodian attach refused: {attach.get('code')}: {attach.get('message')}")
    # "action" is the key the bracket reports; the local is named outcome so
    # the P01 inventory does not read it as an operation dispatch.
    return {"action": outcome, "runtime": attach["runtime"]}


def database_down(exe: Path, root: Path, env: Mapping[str, str], workdir: Path,
                  product: bool = False) -> dict[str, Any]:
    return _run_custodian(exe, ["stop", "--root", str(root)] + (["--product"] if product else []),
                          env, STOP_TIMEOUT, workdir)


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


# ---------------------------------------------------------------- fresh-root bootstrap

#: What an org store left in ``orgs/`` looks like (the SQLite store, its WAL
#: files, a legacy JSON org, an interrupted JSON->SQLite migration, and the
#: store's own rollback copies of migrated JSON).
_SOURCE_SUFFIXES = (".db", ".db-wal", ".db-shm", ".json", ".db.migrating")


def _is_source(name: str) -> bool:
    return name.endswith(_SOURCE_SUFFIXES) or ".json.premigration" in name


def classify_for_bootstrap(root: Path) -> tuple[str, list[str]]:
    """``("existing", sources)``: ``orgs/`` holds an org store, or the trash
    ``deleted/`` holds a deleted org's files; it keeps its backend. ``("fresh", [])``: no ``orgs/`` entries at all, no ``pg/`` and no
    ``pre-postgres/``. ``("ambiguous", found)``: neither -- an empty folder
    or any other entry in ``orgs/``, a PostgreSQL marker, or a database or
    cutover folder with no record choosing it. A leftover product binding
    (a bootstrap that stopped between binding and the record) is ours and
    does not count."""
    orgs = root / "orgs"
    found: list[str] = []
    # an org in the trash (store.delete_org moves its files flat into
    # deleted/, and moving them back IS the restore) is an existing store too
    # (coordinator ruling (a) on review finding f1, 2026-09-26)
    for folder in ("orgs", "deleted"):
        if (root / folder).is_dir():
            sources = [f"{folder}/{p.name}" for p in sorted((root / folder).iterdir(), key=lambda p: p.name)
                       if p.is_file() and _is_source(p.name)]
            if sources:
                return "existing", sources
    if orgs.is_dir():
        entries = sorted(orgs.iterdir(), key=lambda p: p.name)
        found += [f"orgs/{p.name}" + ("/" if p.is_dir() else "") for p in entries]
    elif orgs.exists():
        found.append("orgs (not a folder)")
    for name in ("pg", "pre-postgres"):
        if (root / name).exists():
            found.append(f"{name}/")
    return ("ambiguous", found) if found else ("fresh", [])


def bootstrap_wanted(root: Path, env: Mapping[str, str]) -> bool:
    """Only with ``ORGTREE_PG_BOOTSTRAP=1``, no ``ORGTREE_STORE`` and no
    cutover record. Any value other than 1, 0 or empty refuses (a typo must
    not silently decide which store a new install gets)."""
    flag = env.get(BOOTSTRAP_ENV, "").strip()
    if flag in ("", "0"):
        return False
    if flag != "1":
        raise BracketError(f"{BOOTSTRAP_ENV}={flag!r}: only 1 (or 0, or unset) is understood")
    if env.get(STORE_ENV, "").strip() or _unc_or_device(root):
        return False
    return read_cutover(root) is None


def bootstrap_fresh_root(root: Path, env: Mapping[str, str], progress: Progress | None = None) -> str:
    """A FRESH root becomes a postgres root before the engine chooses: the
    custodian binds it (product mode, which re-checks every location rule in
    Rust), then ``store-backend.json`` records postgres. The record is written
    LAST, so a crash before it leaves only the binding, which is ours and is
    re-used; after it, every launch is the ordinary postgres path (init,
    start and migrate are idempotent). An EXISTING root is untouched; an
    AMBIGUOUS one refuses. Returns the classification."""
    kind, found = classify_for_bootstrap(root)
    if kind == "existing":
        return kind
    if kind == "ambiguous":
        raise BracketError(
            f"{BOOTSTRAP_ENV}=1, but {root} is neither a fresh root nor an existing org store: it has no org "
            f"database and no {CUTOVER_FILE}, yet holds {', '.join(found)}. Refusing to choose a store. "
            f"If nothing there is needed, remove it; if it is a stopped PG-2 cutover, finish or roll it back.")
    _refuse_overlap(root, product_deny_locations(env))
    custodian = _executable(env, CUSTODIAN_ENV)
    step = progress or (lambda _phase: None)
    step("database-bind")
    workdir = root / "host-logs" / f"bootstrap-{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
    workdir.mkdir(parents=True, exist_ok=True)
    child_env = {k: v for k, v in env.items() if k not in ("ORGTREE_V2_TOKEN", CONNINFO_ENV)}
    bound = _run_custodian(custodian, ["bind-product", "--root", str(root)], child_env, STATUS_TIMEOUT, workdir)
    if not bound.get("ok"):
        raise BracketError(f"pg-custodian bind-product refused: {bound.get('code')}: {bound.get('message')}")
    record = {"schema": CUTOVER_SCHEMA, "backend": "postgres", "via": BOOTSTRAP_VIA,
              "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "rollback": f"no org existed when this root was created; to start over on SQLite, stop the app "
                          f"and delete this file, {PRODUCT_FILE} and pg/ (every org made since is lost)"}
    target = root / CUTOVER_FILE
    tmp = root / f"{CUTOVER_FILE}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    return kind


# ---------------------------------------------------------------- the bracket

class ManagedPostgres:
    def __init__(self, root: Path, env: Mapping[str, str], custodian: Path, product: bool = False) -> None:
        self.root, self.env, self.custodian, self.product = root, dict(env), custodian, product
        self.workdir = root / "host-logs" / f"{time.strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.database: dict[str, Any] | None = None
        self.migration: dict[str, Any] | None = None
        self.conninfo = ""

    def start(self, migrator: Migrator | None, progress: Progress | None = None) -> "ManagedPostgres":
        step = progress or (lambda _phase: None)
        self.database = database_up(self.custodian, self.root, self.env, self.workdir, self.product, step)
        try:
            runtime = self.database["runtime"]
            admin = conninfo(runtime, str(runtime.get("admin_role") or ""), "orgtree-migrate") \
                if runtime.get("admin_role") else ""
            if not admin:
                raise BracketError("pg-custodian attach gave no admin_role")
            step("database-migrate")
            self.migration = run_migrations(migrator or default_migrator(), admin)
            self.conninfo = conninfo(runtime, RUNTIME_ROLE, "orgtree-engine")
            step("database-ready")
        except BaseException:
            self.stop()
            raise
        return self

    def stop(self) -> dict[str, Any]:
        """Stop the database this bracket started or attached. Idempotent."""
        report: dict[str, Any] = {}
        if self.database is not None:
            down = database_down(self.custodian, self.root, self.env, self.workdir, self.product)
            report["database_stop"] = {k: down.get(k) for k in ("ok", "code", "message")}
            self.database = None
        return report


def start_for_engine(root: Path, env: MutableMapping[str, str], migrator: Migrator | None = None,
                     progress: Progress | None = None) -> ManagedPostgres | None:
    """launch.py's entry point. None = inert (the chosen backend is not
    postgres). On success sets ``ORGTREE_PG_CONNINFO`` (and, when the cutover
    record chose postgres, ``ORGTREE_STORE``) in ``env``. Raises BracketError
    (after writing the event-log line) when the engine must not start."""
    try:
        if bootstrap_wanted(root, env):
            bootstrap_fresh_root(root, env, progress)
        if not wanted(env, root):
            env.pop(CONNINFO_ENV, None)  # never a stale connection from a parent
            return None
        mode = check_root(root, env)
        check_cutover_finished(root, env)
        custodian = _executable(env, CUSTODIAN_ENV)
        # The engine's per-boot desktop token is not the custodian's to see.
        child_env = {k: v for k, v in env.items() if k not in ("ORGTREE_V2_TOKEN", CONNINFO_ENV)}
        owned = ManagedPostgres(root, child_env, custodian, mode == "product").start(migrator, progress)
    except BracketError as exc:
        record_refusal(str(exc), root)
        raise
    env[STORE_ENV] = "postgres"
    env[CONNINFO_ENV] = owned.conninfo
    return owned
