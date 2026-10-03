"""The engine's runtime view of the org registry (design §2.10, §2.11, §2.13).

Everything engine code needs from the app database's registry, as the runtime role:

  rows()            every registry row, in any state, by org_id
  lookup(slug)      (org_id, database, state, org_uuid) of the org named slug, trashed aside
  exists(slug)      is that org active
  active()          [(slug, org_id, database, org_uuid)] of the active orgs, by slug
  active_slugs()    their slugs
  connection(slug)  a pooled runtime connection to that org's own database
  lifecycle()       this process's Lifecycle, bootstrapped once
  retry(org_id)     Retry of an unavailable org, by the step it failed at

Connections. The registry is read over one shared runtime connection to the app database. An
org's database is reached through a small idle pool per database (``checkout`` and
``release``, which the compatibility view uses too): at most 2 idle connections per database
and 16 in all; one idle for 10 minutes is closed at the next checkout or release (there is no
sweeper thread). Every checkout, of an idle connection or a new one, checks the database's
``org_identity`` against the registry row (one short statement), so a database that is not
this org's is never used: not one restored or renamed under its name since this process last
opened it, and not after a reconnect (review f22). An idle connection the server dropped is
replaced by a new one, which is checked the same way.

Only ``orgdb.lifecycle`` reads the admin conninfo (Q10). ``lifecycle()`` hands out this
process's instance of it, and ``retry`` runs the converter in a child process, which inherits
this process's environment.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence, TypeVar

from .. import pgstore
from . import conn as _conn
from . import names as _names

T = TypeVar("T")


class OrgUnavailable(sqlite3.OperationalError):
    """The org exists but cannot be opened now (not active, or its identity is wrong)."""


#: the converter child's exit codes, besides 0 (finished), that Retry tells apart
EXIT_BUSY = 3
EXIT_NOT_RETRYABLE = 4


def _psycopg() -> Any:
    import psycopg   # noqa: PLC0415
    return psycopg


# ----------------------------------------------------------------- registry reads

_app_lock = threading.Lock()
_app_raw: list[Any] = []


def _on_app(work: Callable[[Any], T]) -> T:
    """``work(connection)`` on the shared registry connection, reconnecting once when the
    server dropped it."""
    psycopg = _psycopg()
    with _app_lock:
        for attempt in (0, 1):
            if not _app_raw or _app_raw[0].closed:
                _app_raw[:] = [_conn.connect(_conn.runtime_base(), _names.app(),
                                             application_name="orgtree-registry")]
            try:
                return work(_app_raw[0])
            except psycopg.OperationalError:
                with contextlib.suppress(Exception):
                    _app_raw[0].close()
                _app_raw.clear()
                if attempt:
                    raise
    raise AssertionError("unreachable")


def query(sql: str, params: Sequence[Any] = ()) -> list[tuple[Any, ...]]:
    """One statement against the app database, as the runtime role."""
    return _on_app(lambda c: list(c.execute(sql, params).fetchall()))


def rows() -> list[dict[str, Any]]:
    """Every registry row (any state), by org_id, under the registry's own column names."""
    def read(c: Any) -> list[dict[str, Any]]:
        cur = c.execute("SELECT * FROM orgtree.orgs ORDER BY org_id")
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    return _on_app(read)


def lookup(slug: str) -> tuple[int, str, str, str] | None:
    """(org_id, database, state, org_uuid) of the org named ``slug`` (trashed orgs aside)."""
    found = query("SELECT org_id, database, state, org_uuid::text FROM orgtree.orgs "
                  "WHERE slug = %s AND state <> 'trashed'", (slug,))
    if not found:
        return None
    org_id, database, state, org_uuid = found[0]
    return int(org_id), str(database), str(state), str(org_uuid)


def exists(slug: str) -> bool:
    row = lookup(slug)
    return row is not None and row[2] == "active"


def active() -> list[tuple[str, int, str, str]]:
    """(slug, org_id, database, org_uuid) of every active org, by slug."""
    return [(str(s), int(i), str(d), str(u)) for s, i, d, u in query(
        "SELECT slug, org_id, database, org_uuid::text FROM orgtree.orgs "
        "WHERE state = 'active' ORDER BY slug")]


def active_slugs() -> list[str]:
    return [slug for slug, _, _, _ in active()]


def close_registry() -> None:
    with _app_lock:
        for raw in _app_raw:
            with contextlib.suppress(Exception):
                raw.close()
        _app_raw.clear()


# ----------------------------------------------------------------- the idle pool

IDLE_PER_DB = 2
IDLE_TOTAL = 16
IDLE_SECONDS = 600.0
#: database -> [(connection, released at (monotonic))], newest last
_idle: dict[str, list[tuple[Any, float]]] = {}
_idle_lock = threading.Lock()


def _idle_count() -> int:
    return sum(len(v) for v in _idle.values())


def _expire_idle(now: float) -> list[Any]:
    """Under _idle_lock: take out every idle connection past IDLE_SECONDS."""
    old: list[Any] = []
    for db in list(_idle):
        keep = [(raw, at) for raw, at in _idle[db] if now - at < IDLE_SECONDS]
        old.extend(raw for raw, at in _idle[db] if now - at >= IDLE_SECONDS)
        if keep:
            _idle[db] = keep
        else:
            del _idle[db]
    return old


def _close_all(conns: list[Any]) -> None:
    for raw in conns:
        with contextlib.suppress(Exception):
            raw.close()


def checkout(slug: str, database: str, org_uuid: str) -> Any:
    """A runtime connection (autocommit) to ``database`` whose ``org_identity`` is (slug,
    org_uuid), checked now: an idle one, or a new one. OrgUnavailable when the database holds
    another org's identity."""
    psycopg = _psycopg()
    found = None
    with _idle_lock:
        stale = _expire_idle(time.monotonic())
        lst = _idle.get(database) or []
        while lst:
            raw, _ = lst.pop()
            if not raw.closed and raw.info.transaction_status == psycopg.pq.TransactionStatus.IDLE:
                found = raw
                break
            stale.append(raw)
    _close_all(stale)
    if found is not None:
        try:
            return _identified(found, slug, database, org_uuid)
        except OrgUnavailable:
            raise
        except psycopg.Error:
            pass        # dropped while idle (terminated, server restarted): a new connection
    raw = _conn.connect(_conn.runtime_base(), database, application_name="orgtree-engine")
    return _identified(raw, slug, database, org_uuid)


def _identified(raw: Any, slug: str, database: str, org_uuid: str) -> Any:
    """``raw`` when its database's org_identity is (slug, org_uuid); else it is closed and
    OrgUnavailable (a wrong identity) or the statement's own error is raised."""
    try:
        row = raw.execute("SELECT org_uuid::text, slug FROM orgtree.org_identity").fetchone()
    except Exception:
        with contextlib.suppress(Exception):
            raw.close()
        raise
    if row is None or row[0] != org_uuid or row[1] != slug:
        raw.close()
        raise OrgUnavailable(f"org {slug!r}: {database} holds another org's identity ({row})")
    return raw


def release(raw: Any, database: str) -> None:
    """Give a connection back: kept idle when it is clean, else closed. A revision still
    pending on it was not confirmed by a COMMIT this session answered (pgstore's rule)."""
    psycopg = _psycopg()
    pgstore._settle_revisions(raw, False)
    clean = (not raw.closed
             and raw.info.transaction_status == psycopg.pq.TransactionStatus.IDLE)
    if clean:
        try:
            raw.execute("RESET ALL")
        except Exception:                                   # noqa: BLE001
            clean = False
    if clean:
        with _idle_lock:
            now = time.monotonic()
            stale = _expire_idle(now)
            lst = _idle.setdefault(database, [])
            if len(lst) < IDLE_PER_DB and _idle_count() < IDLE_TOTAL:
                lst.append((raw, now))
                raw = None
        _close_all(stale)
    if raw is not None:
        with contextlib.suppress(Exception):
            raw.close()


def close_idle(database: str | None = None) -> None:
    """Close the pooled idle connections (of one database, or all)."""
    with _idle_lock:
        dbs = [database] if database is not None else list(_idle)
        conns = [raw for db in dbs for raw, _ in _idle.pop(db, [])]
    _close_all(conns)


@contextlib.contextmanager
def connection(slug: str) -> Iterator[Any]:
    """A pooled runtime connection (autocommit) to ``slug``'s own database. A transaction the
    caller leaves open is rolled back. Raises OrgUnavailable when the org is missing or not
    active."""
    row = lookup(slug)
    if row is None or row[2] != "active":
        raise OrgUnavailable(f"org {slug!r} is {'missing' if row is None else row[2]}, "
                             "not open for use")
    _org_id, database, _state, org_uuid = row
    raw = checkout(slug, database, org_uuid)
    try:
        yield raw
    finally:
        if not raw.closed and (raw.info.transaction_status
                               != _psycopg().pq.TransactionStatus.IDLE):
            with contextlib.suppress(Exception):
                raw.rollback()
        release(raw, database)


# ----------------------------------------------------------------- the lifecycle

_lc_lock = threading.Lock()
_lc: list[Any] = []


def lifecycle() -> Any:
    """This process's Lifecycle (the engine host's), bootstrapped once. Its runtime role is
    the one the engine's conninfo logs in as; its build, this engine's boot commit."""
    from . import lifecycle as L   # noqa: PLC0415
    from .. import workitems       # noqa: PLC0415
    with _lc_lock:
        if not _lc:
            role = _conn.role_of(_conn.runtime_base()) or L.RUNTIME_ROLE
            # an unknown build is 'unknown', as the converter children record it
            lc = L.Lifecycle(runtime_role=role, build=workitems.build_identity() or "unknown")
            lc.bootstrap()
            _lc.append(lc)
        return _lc[0]


def use_lifecycle(lc: Any) -> None:
    """Hand this process an already bootstrapped lifecycle (the host, tests)."""
    with _lc_lock:
        _lc[:] = [lc]


# ----------------------------------------------------------------- Retry

def retry(org_id: int, *, data_root: str | None = None,
          env: dict[str, str] | None = None) -> dict[str, Any]:
    """Retry an unavailable org (design §2.13). Blocks until done, and returns {"org_id",
    "outcome", "reason", "report_path"}: the outcome is the org's state afterwards ('active',
    'trashed' for a converted legacy trashed org, or 'unavailable' again with the new reason).

    The step the org failed at decides who retries it: 'migration' and 'identity' the
    lifecycle, in this process; 'conversion' and 'import' the converter, in a child process
    (it points the legacy loader at a root of its own, which must not leak into this one).
    ``data_root`` and ``env`` are the converter child's data root and environment (default:
    the store's root and this process's environment); the engine's start passes them, since
    it runs before the store is configured. Raises lifecycle.Busy, before anything runs, when
    another operation holds the org, and lifecycle.LifecycleError when the org is missing or
    not unavailable.

    A Retry that fails before it reached the org (the converter child could not be started,
    or stopped before claiming it) raises its error and still records this build's attempt
    (``Lifecycle.note_retry_failure``, fenced on the row as read here), so the automatic Retry
    at start runs it once per build, not at every start (review f2)."""
    from . import lifecycle as L   # noqa: PLC0415
    lc = lifecycle()
    row = lc.row(org_id)
    if row["state"] != "unavailable":
        raise L.LifecycleError(f"org {org_id} is {row['state']}, not unavailable")
    if row["op_kind"] is not None:
        raise L.Busy(f"org {org_id} is busy with another operation")
    try:
        if row["unavailable_step"] in ("migration", "identity"):
            lc.retry_in_place(org_id)
        else:
            _convert_retry(org_id, lc, data_root=data_root, env=env)
    except Exception as e:
        # the attempt recorded its own outcome if it reached the org (the fence then writes
        # nothing); a failure to record this one must not hide the error itself
        with contextlib.suppress(Exception):
            lc.note_retry_failure(org_id, row_version=int(row["row_version"]),
                                  reason=f"Retry could not run: {type(e).__name__}: {e}")
        raise
    finally:
        # the fence closed this org's sessions, and a conversion replaces its database: no
        # idle connection from before is any use
        close_idle(str(row["database"]))
    row = lc.row(org_id)
    return {"org_id": org_id, "outcome": str(row["state"]), "reason": row["state_reason"] or "",
            "report_path": row["report_path"]}


def _convert_retry(org_id: int, lc: Any, *, data_root: str | None = None,
                   env: dict[str, str] | None = None) -> None:
    import subprocess   # noqa: PLC0415
    import sys          # noqa: PLC0415
    from . import lifecycle as L   # noqa: PLC0415
    if data_root is None:
        from .. import store        # noqa: PLC0415
        data_root = store.DATA_ROOT
    backend = Path(__file__).resolve().parents[2]
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_dir = Path(data_root) / "conversion" / f"{stamp}-{os.getpid()}"
    # this checkout's engine first, whatever the interpreter's own path file lists
    code = ("import sys; sys.path.insert(0, sys.argv[1]); "
            "from orgtree.orgdb.convert.__main__ import main; sys.exit(main(sys.argv[2:]))")
    # the admin conninfo goes to this child only (the host does not keep it in its own
    # environment, so its agents never inherit it)
    child_env = lc.child_env(dict(os.environ) if env is None else env)
    r = subprocess.run([sys.executable, "-c", code, str(backend), "retry", "--org-id", str(org_id),
                        "--data-root", str(data_root), "--report-dir", str(report_dir),
                        "--build", lc.build or "unknown"],
                       env=child_env, cwd=str(backend), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=3600,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode == 0:
        return
    lines = [ln.strip() for ln in (r.stderr or "").splitlines() if ln.strip()]
    last = lines[-1][:500] if lines else f"the converter exited {r.returncode}"
    if r.returncode == EXIT_BUSY:
        raise L.Busy(last)
    raise L.LifecycleError(f"the converter could not retry org {org_id}: {last}")
