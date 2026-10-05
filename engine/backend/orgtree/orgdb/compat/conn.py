"""``OrgDbConn``: the connection object store.py uses with the storage switch on.

It has ``pgstore.PgConn``'s surface (``execute``, ``executemany``, ``in_transaction``,
``pinned``, ``commit_armed``, ``last_revision``, ``total_changes``, ``raw``, ``org_id``,
``use``, ``close``), so store.py and orgtx drive it exactly as they drive the legacy
connection. Transaction verbs mean what they mean there: ``BEGIN`` a REPEATABLE READ
snapshot, ``BEGIN IMMEDIATE`` a READ COMMITTED write, both swallowed while an org_tx has the
connection pinned, and COMMIT swallowed too until the org_tx arms it. Every other statement is
store.py's own SQL, answered by ``sql.run`` from the org's database.

Connections. One raw psycopg connection per checkout, to the org's own database as the
runtime role, from the registry module's idle pool (``orgdb.registry.checkout``). Every
checkout checks ``org_identity`` against the registry (design §2.11), so a database that is
not this org's is never written.

Revision. The database's deferred record flush assigns one revision and NOTIFYs
at COMMIT. ``on_save_commit`` only finishes docket writes. After COMMIT we read
this transaction's revision by xid, never another writer's latest revision.

Creating. With ``create`` and no org of that name, the lifecycle builds a staging database
(``Lifecycle.begin_create``); the connection is pinned with its COMMIT armed, as pgstore's
creating connection is, so create_org's one save fills it. After that COMMIT the database is
published and the org is active; after a ROLLBACK (or a failure before COMMIT) it is removed.
"""

from __future__ import annotations

import contextlib
import sqlite3
import threading
from typing import Any, Iterator, Sequence

from ... import pgstore
from .. import conn as _conn
from .. import registry as _reg
from . import rows as R
from . import sql as S


OrgUnavailable = _reg.OrgUnavailable


class OrgExists(sqlite3.OperationalError):
    """A creating open (``only_new``) found an org of that name already registered."""


def _psycopg() -> Any:
    import psycopg   # noqa: PLC0415
    return psycopg


# ----------------------------------------------------------------- the connection

class OrgDbConn:
    """The sqlite3.Connection surface store.py uses, over an org database."""

    #: store/pgstore/orgtx test for this to take their org-database branches
    orgdb = True

    def __init__(self, raw: Any, slug: str, org_id: int, database: str) -> None:
        self.raw = raw
        self.slug = slug
        self.org_id = org_id
        self.database = database
        self.total_changes = 0
        self.pinned = False
        self.commit_armed = False
        self.last_revision: int | None = None
        #: (lifecycle, build) while this connection's transaction creates the org
        self.creating: tuple[Any, Any] | None = None
        self.create_lock: threading.Lock | None = None
        self.path_holder = None
        self.tx = R.Tx()

    def use(self) -> None:
        """Nothing to point at: the database is the org."""

    @property
    def in_transaction(self) -> bool:
        if self.raw is None or self.raw.closed:
            return False
        pq = _psycopg().pq
        return bool(self.raw.info.transaction_status != pq.TransactionStatus.IDLE)

    @contextlib.contextmanager
    def atomic(self, *, write: bool = False) -> Iterator[None]:
        """One handler's statements in one transaction: the caller's when one is open, else
        a short one of its own (a READ ONLY snapshot for a read, as one legacy statement was
        its own snapshot; READ COMMITTED for a write)."""
        if self.in_transaction:
            yield
            return
        self.tx = R.Tx()
        self.last_revision = None
        self.raw.execute("BEGIN" if write else "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        try:
            yield
            R.docket_finish(self.raw,self.tx)
            self._commit()
        except BaseException:
            with contextlib.suppress(Exception):
                self.raw.execute("ROLLBACK")
            raise
        finally:
            self.tx = R.Tx()

    def revision(self) -> int:
        return int(self.raw.execute("SELECT rev FROM orgtree.org_revision").fetchone()[0])

    def execute(self, sql: str, params: Sequence[Any] = ()) -> S.Result:
        head = sql.strip().rstrip(";").strip().upper()
        if head.startswith("PRAGMA"):
            return S.Result()
        if head in ("BEGIN", "BEGIN IMMEDIATE", "BEGIN EXCLUSIVE", "BEGIN DEFERRED"):
            if self.pinned:
                return S.Result()
            self.raw.execute("BEGIN ISOLATION LEVEL REPEATABLE READ" if head == "BEGIN" else "BEGIN")
            self.tx = R.Tx()
            self.last_revision = None
            return S.Result()
        if head in ("COMMIT", "END"):
            if self.pinned and not self.commit_armed:
                return S.Result()
            self._finish(commit=True)
            return S.Result()
        if head == "ROLLBACK":
            self._finish(commit=False)
            return S.Result()
        try:
            res = S.run(self, sql, params)
        except Exception as e:
            if isinstance(e, _psycopg().Error):
                raise pgstore._as_sqlite_error(e) from e
            raise
        if res.is_write and res.rowcount > 0:
            self.total_changes += res.rowcount
        return res

    def executemany(self, sql: str, seq: Any) -> S.Result:
        n = 0
        for params in seq:
            r = self.execute(sql, params)
            n += max(0, r.rowcount)
        return S.Result((), n, write=True)

    def executescript(self, script: str) -> None:
        raise NotImplementedError("the org database's schema comes from pg_migrations/org")

    def _finish(self, *, commit: bool) -> None:
        tx, self.tx = self.tx, R.Tx()
        if tx.item_ord and commit:
            # a header named an item no row was written for: the save is inconsistent
            self._rollback_quietly()
            self._end_create(committed=False)
            raise R.CompatError(f"docket header names items never written: {sorted(tx.item_ord)}")
        try:
            if commit:
                R.docket_finish(self.raw,tx)
            done = self._commit() if commit else self.raw.execute("ROLLBACK")
        except BaseException as e:
            self._rollback_quietly()
            self._end_create(committed=False)
            # a constraint checked at commit (work_items_slug is deferred) fails HERE, and
            # store.py and orgtx read it as the legacy store raised it: sqlite3-shaped, with
            # its sqlstate, like every statement's error above
            if isinstance(e, _psycopg().Error):
                raise pgstore._as_sqlite_error(e) from e
            raise
        ok = commit and getattr(done, "statusmessage", None) == "COMMIT"
        self._end_create(committed=ok)

    def _commit(self) -> Any:
        """Commit without an early revision lock; retain only our committed stamp."""
        xid = self.raw.execute('SELECT pg_current_xact_id_if_assigned()').fetchone()[0]
        done = self.raw.execute('COMMIT')
        self.last_revision = None
        if xid is not None and getattr(done, 'statusmessage', None) == 'COMMIT':
            row = self.raw.execute('SELECT rev FROM orgtree.revisions WHERE xid=%s', (xid,)).fetchone()
            if row is not None:
                self.last_revision = int(row[0])
        return done

    def _rollback_quietly(self) -> None:
        if self.in_transaction:
            with contextlib.suppress(Exception):
                self.raw.execute("ROLLBACK")

    def _end_create(self, *, committed: bool) -> None:
        if self.creating is None:
            return
        lc, build = self.creating
        self.creating = None
        self.pinned = self.commit_armed = False
        with contextlib.suppress(Exception):
            self.raw.close()
        if committed:
            lc.mark_filled(build)
            lc.publish(build)
        else:
            lc.cancel_create(build)

    def on_save_commit(self, changed: bool, *, work_changed: bool = False) -> None:
        """Finish source writes before COMMIT; the record flush owns the revision."""
        try:
            # Pending permanent deletes can lock item/event rows. Finish them before
            # the revision singleton, which is the save's last ordinary row lock.
            R.docket_finish(self.raw, self.tx)
        except Exception as e:
            if isinstance(e, _psycopg().Error):
                raise pgstore._as_sqlite_error(e) from e
            raise

    def close(self) -> None:
        if self.creating is not None:
            self._rollback_quietly()
            self._end_create(committed=False)
            return
        if self.raw is not None and not self.raw.closed:
            _reg.release(self.raw, self.database)


def open_conn(slug: str, *, create: bool = False, only_new: bool = False) -> OrgDbConn:
    """A connection to ``slug``'s database. A missing org raises like a missing SQLite file
    unless ``create`` (only save_org passes it, exactly as for SQLite). ``only_new`` is
    create_org's creating save: an org registered under the name meanwhile (another create
    of the same name, being made or made) raises OrgExists instead of being written into."""
    row = _reg.lookup(slug)
    if row is not None:
        if only_new:
            raise OrgExists(f"org {slug!r} exists")
        org_id, database, state, org_uuid = row
        if state != "active":
            raise OrgUnavailable(f"org {slug!r} is {state}, not open for use")
        return OrgDbConn(_reg.checkout(slug, database, org_uuid), slug, org_id, database)
    if not create:
        raise sqlite3.OperationalError(f"unable to open database file: no org {slug!r}")
    lc = _reg.lifecycle()
    build = lc.begin_create(slug)
    try:
        raw = _conn.connect(_conn.runtime_base(), build.database, application_name="orgtree-create")
        raw.execute("BEGIN")
    except BaseException:
        lc.cancel_create(build)
        raise
    conn = OrgDbConn(raw, slug, build.claim.org_id, build.final)
    # the save's BEGIN is swallowed (this transaction is already open); its COMMIT goes
    # through and publishes the org
    conn.pinned = True
    conn.commit_armed = True
    conn.creating = (lc, build)
    return conn
