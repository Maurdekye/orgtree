# pyright: strict
"""PG-0: PostgreSQL behind the store seam (`ORGTREE_STORE=postgres`).

HOW IT PLUGS IN. store.py's row backend (SQLITE-SPEC §3-§6: lazy load,
compare-on-save, the row differ) is written against a DB-API connection. This
module supplies one: `PgConn`, a thin adapter over a psycopg 3 connection that
runs store.py's own statements against the org's PostgreSQL schema. So the
whole engine runs on PostgreSQL with no change to ledger.py, and nothing in
store.py's differ was re-implemented.

  * Layout (pg_migrations/0001_base.sql): shared `public.orgs` (slug →
    org_id, `revision`), `public.receipts`, `public.schema_migrations`; each
    org's rows in schema `org_<org_id>` with the seam's five tables. `val` is
    TEXT, exactly the serialized JSON the differ compares.
  * Existence: `orgs/<slug>.pg`, a small marker file holding the org_id, is
    what `store._db_path` names under this backend. Every existing
    `os.path.exists(org_path(slug))` check, the directory listings, and
    delete-as-rename-into-the-trash keep working unchanged; putting the marker
    back IS the restore, as it is for a `.db`.
  * Statements: `?` → `%s`; `BEGIN IMMEDIATE` → `BEGIN` (READ COMMITTED; the
    writer's rows are locked by its UPDATEs); a plain `BEGIN` (the seam's
    multi-statement reads) → `BEGIN ISOLATION LEVEL REPEATABLE READ`; PRAGMA →
    nothing; `LIMIT -1` → `LIMIT ALL`; an INSERT into a log table gains
    `RETURNING seq` for `lastrowid`. `json_extract` is a SQL function in 0001.
    psycopg errors surface as sqlite3.OperationalError / IntegrityError (with
    `.sqlstate`), so store.py's existing handlers still apply.
  * Every committed save that changed something bumps `orgs.revision` and
    sends `NOTIFY org_rev, '<slug>:<revision>'` in the same transaction
    (`on_save_commit`, called by store just before COMMIT).
  * Pinning: an `org_tx` holds its row locks on one connection; store's pool
    hands that same connection to the load and the save inside it
    (`store._orgtx_local.pinned`), which swallows their BEGIN/COMMIT so the
    transaction — and its locks — end only when org_tx commits.

The driver is psycopg 3, imported only when this backend is selected.
Connection: `ORGTREE_PG_CONNINFO` (a libpq string set by PG-1's managed-process
bracket), else `ORGTREE_PG_URL` (tests and development).
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import sqlite3
import threading
from collections.abc import Iterable, Iterator, Sequence
from typing import Any

MIGRATIONS_DIR = pathlib.Path(__file__).with_name("pg_migrations")
_MIGRATION_RE = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
_MIGRATE_LOCK_KEY = 0x6f72677472656530      # 'orgtree0': pg_advisory_lock key

MARKER_EXT = ".pg"


class MigrationDrift(RuntimeError):
    """An applied migration file changed on disk, or the database has a
    migration this build does not know. Refuses startup."""


def url() -> str:
    """The engine's connection string: `ORGTREE_PG_CONNINFO` (a libpq keyword
    string set by PG-1's managed-process bracket, used exactly as given — its
    passfile carries the secret), else `ORGTREE_PG_URL` (tests, dev)."""
    u = (os.environ.get("ORGTREE_PG_CONNINFO", "").strip()
         or os.environ.get("ORGTREE_PG_URL", "").strip())
    if not u:
        raise RuntimeError("ORGTREE_STORE=postgres needs ORGTREE_PG_CONNINFO "
                           "(or ORGTREE_PG_URL)")
    return u


def _psycopg() -> Any:
    import psycopg            # noqa: PLC0415  only when this backend runs
    return psycopg


def connect(conninfo: str | None = None) -> Any:
    """A raw psycopg connection in autocommit mode (transactions are
    explicit, as store.py's are)."""
    return _psycopg().connect(conninfo or url(), autocommit=True)


# ----------------------------------------------------------------- migrations

def _sha(data: bytes) -> str:
    # checksum the LF form: `.gitattributes` checks text out as CRLF on this
    # machine and LF elsewhere, and that must not read as drift
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def migration_files(d: pathlib.Path = MIGRATIONS_DIR) -> list[pathlib.Path]:
    files = sorted(p for p in d.iterdir() if _MIGRATION_RE.match(p.name))
    nums = [p.name[:4] for p in files]
    if len(set(nums)) != len(nums):
        raise MigrationDrift(f"duplicate migration numbers in {d}")
    return files


def migrate(target: Any, d: pathlib.Path = MIGRATIONS_DIR) -> dict[str, Any]:
    """Apply every pending migration in order, each in its own transaction,
    under an advisory lock, and refuse on drift. `target` is an open psycopg
    connection or a conninfo string (PG-1 calls it with the ADMIN role's
    conninfo before the API is imported). Returns
    {"folder": <abs pg_migrations path>, "applied": [names applied now],
     "current": [every applied name]}.

    Run as the engine's own (non-owner) role it is a CHECK: nothing pending
    means it only reads; a pending file fails on privileges and refuses."""
    own = isinstance(target, str)
    conn = connect(target) if own else target
    try:
        # the lock first, so two first-boot migrators cannot race to create
        # the bookkeeping table (review N7)
        conn.execute("SELECT pg_advisory_lock(%s)", (_MIGRATE_LOCK_KEY,))
        try:
            if conn.execute("SELECT to_regclass('public.schema_migrations')").fetchone()[0] is None:
                conn.execute("CREATE TABLE public.schema_migrations ("
                             "name text PRIMARY KEY, sha256 text NOT NULL, "
                             "applied_at timestamptz NOT NULL DEFAULT now())")
            applied = {str(n): str(s) for n, s in conn.execute(
                "SELECT name, sha256 FROM public.schema_migrations").fetchall()}
            files = migration_files(d)
            known = {p.name for p in files}
            ahead = sorted(set(applied) - known)
            if ahead:
                raise MigrationDrift(f"database has migrations this build does not: {ahead}")
            done: list[str] = []
            for p in files:
                data = p.read_bytes()
                sha = _sha(data)
                if p.name in applied:
                    if applied[p.name] != sha:
                        raise MigrationDrift(f"{p.name} changed after it was applied")
                    continue
                with conn.transaction():
                    conn.execute(data.decode("utf-8"))
                    conn.execute("INSERT INTO public.schema_migrations(name, sha256) "
                                 "VALUES (%s, %s)", (p.name, sha))
                done.append(p.name)
            return {"folder": str(d.resolve()), "applied": done,
                    "current": sorted(known)}
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (_MIGRATE_LOCK_KEY,))
    finally:
        if own:
            conn.close()


# ----------------------------------------------------------------- statements

class _Stmt:
    __slots__ = ("kind", "sql", "returning")

    def __init__(self, kind: str, sql: str = "", returning: bool = False) -> None:
        self.kind, self.sql, self.returning = kind, sql, returning


_STMT_CACHE: dict[str, _Stmt] = {}
_LOG_INSERT = re.compile(r"^\s*INSERT\s+INTO\s+(log_d|log_l)\b", re.I)


def _placeholders(sql: str) -> str:
    """`?` (outside single-quoted literals) → `%s`. When there is at least one
    placeholder psycopg interpolates, so every literal `%` becomes `%%`;
    without one it sends the text as is and `%` must stay single."""
    out: list[str] = []
    quoted = False
    marks = 0
    for ch in sql:
        if ch == "'":
            quoted = not quoted
        elif ch == "?" and not quoted:
            marks += 1
            out.append("%s")
            continue
        out.append(ch)
    s = "".join(out)
    if marks:
        s = s.replace("%", "%%").replace("%%s", "%s")
    return s


def translate(sql: str) -> _Stmt:
    hit = _STMT_CACHE.get(sql)
    if hit is not None:
        return hit
    head = sql.strip().rstrip(";").strip().upper()
    if head.startswith("PRAGMA"):
        st = _Stmt("noop")
    elif head in ("BEGIN IMMEDIATE", "BEGIN EXCLUSIVE", "BEGIN DEFERRED"):
        st = _Stmt("begin", "BEGIN")
    elif head == "BEGIN":
        st = _Stmt("begin", "BEGIN ISOLATION LEVEL REPEATABLE READ")
    elif head in ("COMMIT", "END"):
        st = _Stmt("commit", "COMMIT")
    elif head == "ROLLBACK":
        st = _Stmt("rollback", "ROLLBACK")
    else:
        s = _placeholders(sql)
        s = re.sub(r"\bLIMIT\s+-1\b", "LIMIT ALL", s, flags=re.I)
        ret = bool(_LOG_INSERT.match(s)) and "RETURNING" not in s.upper()
        if ret:
            s = s.rstrip().rstrip(";") + " RETURNING seq"
        st = _Stmt("sql", s, ret)
    if len(_STMT_CACHE) < 4096:
        _STMT_CACHE[sql] = st
    return st


def _as_sqlite_error(e: Exception) -> sqlite3.Error:
    state = str(getattr(e, "sqlstate", "") or "")
    cls = sqlite3.IntegrityError if state.startswith("23") else sqlite3.OperationalError
    err = cls(f"postgres {state}: {e}")
    setattr(err, "sqlstate", state)
    return err


class _Cursor:
    def __init__(self, rows: list[tuple[Any, ...]], rowcount: int,
                 lastrowid: int | None) -> None:
        self._rows = rows
        self._i = 0
        self.rowcount = rowcount
        self.lastrowid = lastrowid

    def fetchone(self) -> tuple[Any, ...] | None:
        if self._i >= len(self._rows):
            return None
        r = self._rows[self._i]
        self._i += 1
        return r

    def fetchall(self) -> list[tuple[Any, ...]]:
        r = self._rows[self._i:]
        self._i = len(self._rows)
        return r

    def __iter__(self) -> Iterator[tuple[Any, ...]]:
        while True:
            r = self.fetchone()
            if r is None:
                return
            yield r


_EMPTY = _Cursor([], -1, None)


class PgConn:
    """The sqlite3.Connection surface store.py uses, over psycopg."""

    def __init__(self, raw: Any, slug: str, org_id: int) -> None:
        self.raw = raw
        self.slug = slug
        self.org_id = org_id
        self.total_changes = 0
        #: set while an org_tx owns the transaction (see module docstring)
        self.pinned = False
        #: the org_tx's own final COMMIT goes through when this is set
        self.commit_armed = False
        #: the revision the last committed save bumped to
        self.last_revision: int | None = None
        #: set while this connection's transaction is CREATING the org: the
        #: marker path to write once its COMMIT succeeds (`_begin_create`)
        self.creating: str | None = None
        #: set when several orgs share ONE server connection (a multi-org
        #: org_tx): holds the org_id whose schema the search_path names now,
        #: and every statement switches it first when it is another org's
        self.path_holder: list[int | None] | None = None

    def use(self) -> None:
        """Point the shared connection's search_path at this org's schema."""
        h = self.path_holder
        if h is not None and h[0] != self.org_id:
            self.raw.execute(f"SET search_path TO org_{int(self.org_id)}, public")
            h[0] = self.org_id

    @property
    def in_transaction(self) -> bool:
        pq = _psycopg().pq
        return bool(self.raw.info.transaction_status != pq.TransactionStatus.IDLE)

    def execute(self, sql: str, params: Sequence[Any] = ()) -> _Cursor:
        st = translate(sql)
        if st.kind == "noop":
            return _EMPTY
        if st.kind == "begin" and self.pinned:
            return _EMPTY
        if st.kind == "commit" and self.pinned and not self.commit_armed:
            return _EMPTY
        try:
            if st.kind != "sql":
                self.raw.execute(st.sql)
                if self.creating is not None and st.kind in ("commit", "rollback"):
                    marker, self.creating = self.creating, None
                    self.pinned = self.commit_armed = False
                    if st.kind == "commit":
                        _write_marker(marker, self.slug, self.org_id)
                return _EMPTY
            self.use()
            cur = self.raw.execute(st.sql, tuple(params) if params else None)
            rows: list[tuple[Any, ...]] = cur.fetchall() if cur.description else []
        except Exception as e:
            if isinstance(e, _psycopg().Error):
                raise _as_sqlite_error(e) from e
            raise
        n = cur.rowcount if cur.rowcount is not None else -1
        if n > 0 and not st.sql.lstrip().upper().startswith("SELECT"):
            self.total_changes += n
        last = int(rows[0][0]) if st.returning and rows else None
        return _Cursor(rows if not st.returning else [], n, last)

    def executemany(self, sql: str, seq: Iterable[Sequence[Any]]) -> _Cursor:
        for params in seq:
            self.execute(sql, params)
        return _EMPTY

    def executescript(self, script: str) -> None:
        raise NotImplementedError("schema comes from pg_migrations, not _DDL")

    def close(self) -> None:
        """Return the server connection to the process-wide idle pool (when
        it is clean), else close it. store's per-slug pool does not keep
        postgres connections idle: that multiplied by the org count and ran a
        40-connection server out of slots (`too many clients`)."""
        _release(self.raw)


# ----------------------------------------------------------------- orgs

#: idle server connections shared by every org (search_path is set on each
#: checkout). Bounded: beyond it a released connection is closed.
_IDLE_CAP = int(os.environ.get("ORGTREE_PG_POOL_IDLE", "8") or 8)
_idle: list[tuple[str, Any]] = []
_idle_lock = threading.Lock()


def _checkout() -> Any:
    target = url()
    with _idle_lock:
        while _idle:
            u, raw = _idle.pop()
            if u == target and not raw.closed:
                return raw
            _close_quietly(raw)
    return connect(target)


def _release(raw: Any) -> None:
    pq = _psycopg().pq
    clean = (not raw.closed
             and raw.info.transaction_status == pq.TransactionStatus.IDLE)
    if clean:
        try:
            # every session setting, not just search_path: nothing a checkout
            # SET may reach the next one (review B3)
            raw.execute("RESET ALL")
        except Exception:                                   # noqa: BLE001
            clean = False
    if clean:
        with _idle_lock:
            if len(_idle) < _IDLE_CAP:
                _idle.append((url(), raw))
                return
    _close_quietly(raw)


def _close_quietly(raw: Any) -> None:
    try:
        raw.close()
    except Exception:                                       # noqa: BLE001
        pass


def close_idle() -> None:
    """Close every pooled idle connection (tests; shutdown)."""
    with _idle_lock:
        conns, _idle[:] = list(_idle), []
    for _, raw in conns:
        _close_quietly(raw)


def read_marker(path: str) -> int | None:
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return None
    return int(data["org_id"])


def _write_marker(path: str, slug: str, org_id: int) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        f.write(json.dumps({"org_id": org_id, "slug": slug}).encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _begin_create(raw: Any, slug: str) -> int:
    """Open the ONE transaction an org is created in (lead decision 20.2):
    the orgs row and its schema here, then the caller's save writes the rows,
    bumps the revision, NOTIFYs and COMMITs it; the `.pg` marker is written
    only after that COMMIT (PgConn.execute). A crash anywhere before leaves
    nothing: no row, no schema, no marker. Serialized per slug by an advisory
    transaction lock; the caller re-checks the marker under it."""
    raw.execute("BEGIN")
    raw.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("create:" + slug,))
    # a live row with no marker is an org whose marker went to the trash
    # (delete_org): retire its slug so the name is free, keep its rows
    raw.execute("UPDATE public.orgs SET slug = slug || '@deleted-' || org_id, "
                "deleted_at = now() WHERE slug = %s", (slug,))
    row = raw.execute("INSERT INTO public.orgs(slug) VALUES (%s) RETURNING org_id",
                      (slug,)).fetchone()
    org_id = int(row[0])
    raw.execute("SELECT orgtree_create_org_schema(%s)", (org_id,))
    return org_id


def retire_unmarked(orgs_dir: str) -> list[str]:
    """At claim: a live orgs row whose `<slug>.pg` marker is not in orgs/ is
    not an org the engine can see (its marker was deleted to the trash, or a
    crash fell between an old non-atomic create's commit and its marker).
    Retire its slug — rows kept, restorable from a trash marker, which names
    the org_id — so the name is free and nothing half-made stays live."""
    out: list[str] = []
    with connect() as c:
        for org_id, slug in c.execute(
                "SELECT org_id, slug FROM public.orgs WHERE deleted_at IS NULL").fetchall():
            if read_marker(os.path.join(orgs_dir, f"{slug}{MARKER_EXT}")) != int(org_id):
                c.execute("UPDATE public.orgs SET slug = slug || '@unmarked-' || org_id, "
                          "deleted_at = now() WHERE org_id = %s", (org_id,))
                out.append(str(slug))
    return out


def open_conn(slug: str, marker: str, *, create: bool = False) -> PgConn:
    """A connection whose search_path is `slug`'s schema. A missing marker
    raises like a missing SQLite file unless `create` (only save_org and
    create_org pass it, exactly as for SQLite)."""
    raw = _checkout()
    try:
        org_id = read_marker(marker)
        if org_id is None:
            if not create:
                raise sqlite3.OperationalError(f"unable to open database file: {marker}")
            org_id = _begin_create(raw, slug)
            if read_marker(marker) is not None:     # created while we waited
                raw.execute("ROLLBACK")
                _release(raw)
                return open_conn(slug, marker, create=False)
            raw.execute(f"SET search_path TO org_{int(org_id)}, public")
            conn = PgConn(raw, slug, org_id)
            # the save's BEGIN is swallowed (we are already in the creating
            # transaction); its COMMIT goes through and then writes the marker
            conn.pinned = True
            conn.commit_armed = True
            conn.creating = marker
            return conn
        raw.execute(f"SET search_path TO org_{int(org_id)}, public")
        return PgConn(raw, slug, org_id)
    except BaseException:
        _release(raw)
        raise


def on_save_commit(conn: PgConn, changed: bool) -> None:
    """Just before a save's COMMIT: bump the org revision and NOTIFY, in the
    same transaction, when the save changed anything."""
    if not changed:
        return
    conn.use()
    try:
        row = conn.raw.execute(
            "UPDATE public.orgs SET revision = revision + 1 WHERE org_id = %s "
            "RETURNING revision", (conn.org_id,)).fetchone()
        rev = int(row[0])
        conn.raw.execute("SELECT pg_notify('org_rev', %s)", (f"{conn.slug}:{rev}",))
    except Exception as e:
        if isinstance(e, _psycopg().Error):
            raise _as_sqlite_error(e) from e
        raise
    conn.last_revision = rev


def revision(conn: PgConn) -> int:
    row = conn.raw.execute("SELECT revision FROM public.orgs WHERE org_id = %s",
                           (conn.org_id,)).fetchone()
    return int(row[0])
